/**
 * AI Key Manager — Multi-provider API key rotation for DocsNX
 * Supports Gemini (Google) and OpenAI keys.
 */

import { db } from './db';
import { apiKeys, tenants, tenantAiUsages } from '../db/schema';
import { eq, asc, sql } from 'drizzle-orm';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { decryptField } from './fieldCrypto';
import { spendTenantCredits } from './planProvisioning';
import { AI_ACTION_TO_REASON, CREDIT_REASONS, formatCreditReason } from './creditLedger';
import { DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_MODEL, getModelRates } from './aiModels';

// ─── Error Codes ──────────────────────────────────────────────────────────────
//
// Declared in `./aiErrors` and re-exported here, unchanged, so the ~10 server
// modules that import them from this file keep working. They had to move
// because this file imports `db`, `openai` and `@google/genai`, which makes it
// unimportable from a client component — and a page that cannot read the
// vocabulary invents its own. See the header of aiErrors.ts.

import { AI_ERROR_CODES, AI_ERROR_MESSAGES, AI_STATUS } from './aiErrors';

export { AI_ERROR_CODES, AI_ERROR_MESSAGES, AI_STATUS };
export type { AiErrorCode } from './aiErrors';

// ─── Credit Costs (Dynamic) ───────────────────────────────────────────────────
// Costs are now fetched dynamically from systemConfigs and multiplied by allowed members.

// ─── Error Classification ─────────────────────────────────────────────────────

export function classifyAIError(error: any) {
  const msg = (error?.message || error?.toString() || '').toLowerCase();
  const status = error?.status || error?.statusCode || error?.code;

  if (
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('exceeded your current quota') ||
    msg.includes('you exceeded your') ||
    msg.includes('billing') ||
    status === 429
  ) {
    if (msg.includes('rate') || msg.includes('too many requests')) {
      return AI_ERROR_CODES.RATE_LIMITED;
    }
    return AI_ERROR_CODES.QUOTA_EXHAUSTED;
  }

  if (
    msg.includes('invalid api key') ||
    msg.includes('api_key_invalid') ||
    msg.includes('api key not valid') ||
    status === 401 ||
    status === 403
  ) {
    return AI_ERROR_CODES.INVALID_KEY;
  }

  // A retired or misspelled model id. Distinct from INVALID_KEY because the
  // key is fine and from the 503s because waiting changes nothing — the stored
  // `model` column has to change. Google's wording, verbatim:
  //   {"error":{"code":404,"message":"This model models/gemini-2.5-flash is no
  //    longer available to new users. Please update your code to use
  //    models/gemini-3.6-flash ...","status":"NOT_FOUND"}}
  // Placed above the overload branch so a future 404 that also says "try again
  // later" is not mistaken for capacity pressure.
  if (
    status === 404 ||
    msg.includes('"status":"not_found"') ||
    msg.includes('"status": "not_found"') ||
    msg.includes('no longer available') ||
    msg.includes('is not found for api version')
  ) {
    return AI_ERROR_CODES.MODEL_NOT_FOUND;
  }

  // Checked BEFORE the bare-503 branch below, because Gemini reports model
  // capacity pressure as a 503 too and the two need different handling: an
  // overloaded model is a queue to wait out, a genuinely unavailable service is
  // not. The wording is Google's own —
  //   {"error":{"code":503,"message":"This model is currently experiencing high
  //    demand. Spikes in demand are usually temporary. Please try again
  //    later.","status":"UNAVAILABLE"}}
  // — and arrives as the JSON blob in `error.message`, so `status: "UNAVAILABLE"`
  // is matched out of the string rather than off a field.
  if (
    msg.includes('overloaded') ||
    msg.includes('model_overloaded') ||
    msg.includes('high demand') ||
    msg.includes('try again later') ||
    msg.includes('"status":"unavailable"') ||
    msg.includes('"status": "unavailable"')
  ) {
    return AI_ERROR_CODES.MODEL_OVERLOADED;
  }

  if (msg.includes('service unavailable') || status === 503) {
    return AI_ERROR_CODES.SERVICE_UNAVAILABLE;
  }

  if (
    msg.includes('network') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('timeout') ||
    msg.includes('fetch failed')
  ) {
    return AI_ERROR_CODES.NETWORK_ERROR;
  }

  return AI_ERROR_CODES.UNKNOWN;
}

function shouldRotateKey(errorCode: string) {
  return (
    errorCode === AI_ERROR_CODES.QUOTA_EXHAUSTED ||
    errorCode === AI_ERROR_CODES.RATE_LIMITED ||
    errorCode === AI_ERROR_CODES.MODEL_OVERLOADED ||
    errorCode === AI_ERROR_CODES.INVALID_KEY ||
    // A retired model is pinned per key (apiKeys.model), so the next key may
    // well be on a live one — and the OpenAI key certainly is. Breaking here is
    // what took every AI feature down when Google retired gemini-2.5-flash.
    errorCode === AI_ERROR_CODES.MODEL_NOT_FOUND ||
    // A provider outage is the whole reason to keep a second provider's key in
    // the pool. Leaving these off the list made the loop `break` on the first
    // key, so a healthy OpenAI key was never reached.
    errorCode === AI_ERROR_CODES.SERVICE_UNAVAILABLE ||
    errorCode === AI_ERROR_CODES.NETWORK_ERROR
  );
}

/**
 * Faults that are the upstream provider's, not this key's.
 *
 * Two consequences: they are worth retrying on the SAME key (rotation cannot
 * help — every Gemini key queues against the same shared model capacity), and
 * they must not be written to the key's health columns. `errorCount` is a sort
 * input in `getAvailableKeys`, so charging a key for Google's bad minute
 * permanently demotes a perfectly good key.
 */
function isTransient(errorCode: string) {
  return (
    errorCode === AI_ERROR_CODES.RATE_LIMITED ||
    errorCode === AI_ERROR_CODES.MODEL_OVERLOADED ||
    errorCode === AI_ERROR_CODES.SERVICE_UNAVAILABLE ||
    errorCode === AI_ERROR_CODES.NETWORK_ERROR
  );
}

/**
 * Upstream faults must not touch the key's health columns. See isTransient.
 *
 * MODEL_NOT_FOUND is absent for a different reason: the key is healthy, its
 * `model` column is stale. Charging errorCount would demote a key that works
 * the moment an admin picks a live model.
 */
function isKeyAtFault(errorCode: string) {
  return (
    errorCode === AI_ERROR_CODES.QUOTA_EXHAUSTED ||
    errorCode === AI_ERROR_CODES.RATE_LIMITED ||
    errorCode === AI_ERROR_CODES.INVALID_KEY
  );
}

// ─── Transient Retry ──────────────────────────────────────────────────────────

// Three attempts at ~1s / 2s, i.e. ~3s of added latency in the worst case per
// key. Deliberately small: a bulk scan already holds an HTTP request open for
// the OCR round-trip, and the pool may hold several keys to walk after this.
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const JITTER = 0.25;

function backoffDelay(attempt: number) {
  const base = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
  // Jitter so that a burst of scans that all failed together does not retry in
  // lockstep and re-create the spike being waited out.
  return Math.round(base * (1 + (Math.random() * 2 - 1) * JITTER));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one AI call against one key, absorbing transient provider faults.
 *
 * Google's own 503 says "spikes in demand are usually temporary", and before
 * this existed the platform took that at face value exactly zero times: the
 * first 503 became a red toast in the user's face. Non-transient errors are
 * rethrown on the first attempt so a bad key still rotates immediately.
 */
async function runWithBackoff(clientInfo: any, callFn: any, keyLabel: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await callFn(clientInfo);
    } catch (error: any) {
      const errorCode = classifyAIError(error);
      if (!isTransient(errorCode) || attempt >= MAX_ATTEMPTS) {
        error.errorCode = errorCode;
        throw error;
      }
      const delay = backoffDelay(attempt);
      console.warn(
        `[AI Retry] ${keyLabel} returned ${errorCode} (attempt ${attempt}/${MAX_ATTEMPTS}). Retrying in ${delay}ms...`,
      );
      await sleep(delay);
    }
  }
}

export function getErrorMessage(errorCode: string) {
  return (AI_ERROR_MESSAGES as any)[errorCode] || AI_ERROR_MESSAGES.UNKNOWN;
}

// ─── Daily Reset Logic ────────────────────────────────────────────────────────

function needsDailyReset(lastResetAt: Date | null | undefined) {
  if (!lastResetAt) return true;
  const reset = new Date(lastResetAt);
  const now = new Date();
  return reset.toDateString() !== now.toDateString();
}

// ─── Key Selection ────────────────────────────────────────────────────────────

export async function getAvailableKeys() {
  const keys = await db.query.apiKeys.findMany({
    where: (apiKeys, { eq }) => eq(apiKeys.isActive, true),
    orderBy: (apiKeys, { asc }) => [
      asc(apiKeys.priority),
      asc(apiKeys.dailyUsage),
      asc(apiKeys.errorCount),
    ],
  });

  if (!keys || keys.length === 0) return [];

  const resetPromises = [];
  for (const key of keys) {
    if (needsDailyReset(key.lastResetAt)) {
      resetPromises.push(
        db.update(apiKeys)
          .set({ dailyUsage: 0, errorCount: 0, lastResetAt: new Date() })
          .where(eq(apiKeys.id, key.id))
      );
      key.dailyUsage = 0;
      key.errorCount = 0;
    }
  }
  if (resetPromises.length > 0) await Promise.all(resetPromises);

  return keys.filter(k => k.dailyUsage < k.dailyLimit);
}

// ─── Mark Key State ───────────────────────────────────────────────────────────

export async function markKeyUsed(keyId: string) {
  if (!keyId) return;
  try {
    await db.update(apiKeys)
      .set({ dailyUsage: sql`${apiKeys.dailyUsage} + 1`, lastUsedAt: new Date() })
      .where(eq(apiKeys.id, keyId));
  } catch (e) {
    console.error('Failed to mark key usage:', e);
  }
}

export async function markKeyQuotaExhausted(keyId: string) {
  if (!keyId) return;
  try {
    const key = await db.query.apiKeys.findFirst({ where: (apiKeys, { eq }) => eq(apiKeys.id, keyId) });
    if (key) {
      await db.update(apiKeys)
        .set({
          dailyUsage: key.dailyLimit,
          errorCount: sql`${apiKeys.errorCount} + 1`,
          lastError: 'Quota exhausted — automatically rotated to next key',
        })
        .where(eq(apiKeys.id, keyId));
    }
  } catch (e) {
    console.error('Failed to mark key quota exhausted:', e);
  }
}

export async function markKeyError(keyId: string, errorMessage: any) {
  if (!keyId) return;
  try {
    await db.update(apiKeys)
      .set({
        errorCount: sql`${apiKeys.errorCount} + 1`,
        lastError: String(errorMessage).slice(0, 500),
      })
      .where(eq(apiKeys.id, keyId));
  } catch (e) {
    console.error('Failed to mark key error:', e);
  }
}

// ─── Build Client ─────────────────────────────────────────────────────────────

export function buildClientFromKey(key: any) {
  // Keys from the DB are encrypted at rest; env/tenant keys pass through
  // unchanged (decryptField is a no-op on non-ciphertext).
  const rawKey = decryptField(key.apiKey) || key.apiKey;
  if (key.provider === 'openai') {
    return {
      client: new OpenAI({ apiKey: rawKey }),
      keyId: key.id,
      model: key.model || DEFAULT_OPENAI_MODEL,
      provider: 'openai',
    };
  }
  return {
    client: new GoogleGenAI({ apiKey: rawKey }),
    keyId: key.id,
    model: key.model || DEFAULT_GEMINI_MODEL,
    provider: 'gemini',
  };
}

// ─── Record Tenant AI Usage ───────────────────────────────────────────────────

export async function recordTenantAiUsage(tenantId: string, modelName: string, promptTokens: number, completionTokens: number) {
  try {
    // Rates come from the published price table in aiModels.ts, keyed by the
    // exact model id. The previous substring sniffing ("does it contain gpt-4")
    // hardcoded gemini-2.5-flash's prices as the default for everything else,
    // so moving to any other model silently under-reported spend in
    // tenant_ai_usages while the billing screens kept looking healthy.
    const { input: inputRate, output: outputRate } = getModelRates(modelName);

    const cost = (promptTokens * inputRate) + (completionTokens * outputRate);
    
    await db.insert(tenantAiUsages).values({
      tenantId,
      modelName,
      promptTokens,
      completionTokens,
      cost: cost.toString(), // drizzle decimal expects string
    });
  } catch (err) {
    console.error('Error logging tenant AI usage:', err);
  }
}

// ─── Execute With Rotation ────────────────────────────────────────────────────

export async function executeWithRotation(callFn: any) {
  const dbKeys = await getAvailableKeys();
  const envKey = process.env.GEMINI_API_KEY;

  const keyPool = [...dbKeys];
  if (envKey) {
    const alreadyIn = dbKeys.some(k => (decryptField(k.apiKey) || k.apiKey) === envKey);
    if (!alreadyIn) {
      keyPool.push({
        id: null,
        apiKey: envKey,
        provider: 'gemini',
        model: DEFAULT_GEMINI_MODEL,
        dailyUsage: 0,
        dailyLimit: 9999,
        _isFallback: true,
      } as any);
    }
  }

  if (keyPool.length === 0) {
    const err: any = new Error(AI_ERROR_MESSAGES.NO_KEYS_CONFIGURED);
    err.errorCode = AI_ERROR_CODES.NO_KEYS_CONFIGURED;
    throw err;
  }

  let lastError: any = null;

  for (const keyEntry of keyPool) {
    const clientInfo = buildClientFromKey(keyEntry);
    const keyLabel = clientInfo.keyId
      ? `key "${keyEntry.label || clientInfo.keyId.slice(0, 8)}"`
      : 'env fallback key';

    try {
      const result = await runWithBackoff(clientInfo, callFn, keyLabel);
      if (clientInfo.keyId) await markKeyUsed(clientInfo.keyId);
      return result;
    } catch (error: any) {
      // runWithBackoff already classified it; re-classify only if it came from
      // somewhere else (e.g. a non-AI throw inside callFn).
      const errorCode = error.errorCode || classifyAIError(error);
      lastError = error;
      lastError.errorCode = errorCode;

      if (shouldRotateKey(errorCode)) {
        console.warn(`[AI Rotation] ${keyLabel} returned ${errorCode}. Rotating to next available key...`);
        // Only charge the key when the key is what failed. An upstream 503 says
        // nothing about this key's health and must not demote it in the pool.
        if (clientInfo.keyId && isKeyAtFault(errorCode)) {
          if (errorCode === AI_ERROR_CODES.QUOTA_EXHAUSTED || errorCode === AI_ERROR_CODES.RATE_LIMITED) {
            await markKeyQuotaExhausted(clientInfo.keyId);
          } else {
            await markKeyError(clientInfo.keyId, error.message || error.toString());
          }
        }
        continue;
      }

      console.error(`[AI] Non-rotatable error from ${keyLabel}: ${errorCode} — ${error.message}`);
      if (clientInfo.keyId) {
        await markKeyError(clientInfo.keyId, error.message || error.toString());
      }
      break;
    }
  }

  // Only a genuine quota wall earns the "add more API keys" message. Relabelling
  // a Gemini outage as ALL_KEYS_EXHAUSTED sent admins off to buy keys that would
  // not have helped — MODEL_OVERLOADED and INVALID_KEY now keep their own
  // (accurate, actionable) messages.
  const wasQuotaRelated =
    lastError?.errorCode === AI_ERROR_CODES.QUOTA_EXHAUSTED ||
    lastError?.errorCode === AI_ERROR_CODES.RATE_LIMITED;

  const finalError: any = new Error(
    wasQuotaRelated
      ? AI_ERROR_MESSAGES.ALL_KEYS_EXHAUSTED
      : getErrorMessage(lastError?.errorCode || AI_ERROR_CODES.UNKNOWN)
  );
  finalError.errorCode = wasQuotaRelated
    ? AI_ERROR_CODES.ALL_KEYS_EXHAUSTED
    : (lastError?.errorCode || AI_ERROR_CODES.UNKNOWN);
  finalError.originalError = lastError;

  throw finalError;
}

// ─── Execute Tenant Isolation With Cost Tracking ──────────────────────────────

/**
 * `userId` is optional and only ever used to attribute the credit spend to the
 * member who triggered it on /billing/credits. It is not an authorisation
 * input — the caller has already established the tenant — so a missing one
 * costs an unattributed ledger row, nothing more.
 */
export async function executeTenantWithRotation(
  tenantId: string,
  actionName: string,
  callFn: any,
  userId?: string | null,
  /**
   * The workspace the spend belongs to. NULL = the household.
   *
   * Attribution ONLY — there is one wallet, and this decides which tab of
   * /billing/credits the movement appears under, nothing about whether the call
   * is allowed or what it costs. A caller that does not know its workspace may
   * leave it out; the spend then reads as the household's, which is what every
   * caller meant before companies existed.
   */
  companyId?: string | null,
) {
  if (!tenantId) {
    return executeWithRotation(callFn);
  }

  // 1. Fetch Tenant specific AI config
  const tenant = await db.query.tenants.findFirst({
    where: (tenants, { eq }) => eq(tenants.id, tenantId)
  });

  if (!tenant) {
    return executeWithRotation(callFn);
  }

  // Calculate Required Credits dynamically
  const configRes = await db.query.systemConfigs.findFirst();
  let baseCost = 0;
  if (actionName === 'RECORD_ANALYSIS') baseCost = parseFloat(configRes?.aiCostRecordAnalysis as string) || 1.00;
  else if (actionName === 'CATEGORY_ANALYSIS') baseCost = parseFloat(configRes?.aiCostCategoryAnalysis as string) || 2.00;
  else if (actionName === 'PORTFOLIO_ANALYSIS') baseCost = parseFloat(configRes?.aiCostPortfolioAnalysis as string) || 5.00;
  else if (actionName === 'BULK_SCAN') baseCost = parseFloat(configRes?.aiCostBulkScan as string) || 10.00;
  /**
   * Naming ONE document's sub-category — no field extraction, no grouping.
   *
   * A tenth of a scan because it is a tenth of a prompt: the taxonomy list and
   * three keys back, where BULK_SCAN carries seventeen extraction schemas and
   * the grouping rules for a whole batch. Deliberately NOT free — it is still a
   * billed model call on the platform pool — and deliberately not `aiCostBulkScan`,
   * which would price a classify at the same rate as reading forty documents.
   *
   * Derived from `aiCostBulkScan` rather than configured separately so an
   * operator who reprices scanning does not leave this stranded at a default.
   */
  else if (actionName === 'DOC_CLASSIFY') {
    baseCost = (parseFloat(configRes?.aiCostBulkScan as string) || 10.00) / 10;
  }

  const multiplier = (tenant.maxMembers || 1) + (tenant.extraMembers || 0);
  const requiredCredits = Math.ceil(baseCost * multiplier);


  // 2. If tenant has custom key configured, execute with it (no credit cost)
  if (tenant.apiKey) {
    const tenantKey = {
      id: null, // Don't log pool status changes on tenant's private key
      apiKey: tenant.apiKey,
      provider: tenant.aiProvider || 'gemini',
      model: tenant.aiModel || DEFAULT_GEMINI_MODEL,
      dailyUsage: 0,
      dailyLimit: 99999
    };

    const clientInfo = buildClientFromKey(tenantKey);
    try {
      // Same transient absorption as the pool path. There is no second key to
      // rotate to here, so backoff is the ONLY defence a BYO-key tenant has
      // against a provider spike.
      const result = await runWithBackoff(clientInfo, callFn, "tenant's own key");

      // Track usage metrics
      if (result && typeof result === 'object' && result.promptTokens !== undefined) {
        await recordTenantAiUsage(tenantId, clientInfo.model, result.promptTokens, result.completionTokens || 0);
      }
      
      return result;
    } catch (err) {
      console.error(`[AI] Tenant key execution failed:`, err);
      throw err;
    }
  }

  // 3. Check Credit Balance for platform pool
  if (tenant.aiCreditsBalance < requiredCredits) {
    const err: any = new Error(AI_ERROR_MESSAGES.INSUFFICIENT_CREDITS);
    err.errorCode = AI_ERROR_CODES.INSUFFICIENT_CREDITS;
    throw err;
  }

  // 4. Fallback to platform-wide key rotation pool
  return await executeWithRotation(async (clientInfo: any) => {
    const result = await callFn(clientInfo);
    
    // Log usage metrics for this tenant using platform key
    if (result && typeof result === 'object' && result.promptTokens !== undefined) {
      await recordTenantAiUsage(tenantId, clientInfo.model, result.promptTokens, result.completionTokens || 0);
    }
    
    // Deduct credits on success, and record the spend in the same transaction
    // so the tenant's credit history cannot drift from the balance it explains.
    // spendTenantCredits owns the GREATEST floor (the balance check above and
    // this write are not atomic, so concurrent calls can both pass it) and
    // swallows its own errors: the AI call has already succeeded here, so a
    // failed deduction must not become the user's problem.
    await spendTenantCredits(tenantId, {
      amount: requiredCredits,
      reason: AI_ACTION_TO_REASON[actionName] ?? CREDIT_REASONS.spend_record_analysis,
      description: `${formatCreditReason(AI_ACTION_TO_REASON[actionName] ?? actionName)} — ${Math.ceil(requiredCredits)} credits (${baseCost} base × ${multiplier} members).`,
      userId,
      companyId,
    });

    return result;
  });
}
