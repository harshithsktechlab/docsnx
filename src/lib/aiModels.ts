/**
 * Single source of truth for AI model ids, their prices, and the options the
 * AI Settings pickers offer.
 *
 * Written after Google retired `gemini-2.5-flash` mid-flight and every AI
 * feature in the platform went down at once. The model id was copy-pasted into
 * a dozen files — four code fallbacks, two Drizzle column defaults, two picker
 * lists and several form initialisers — so there was no single place to change
 * and no way to tell which of them mattered. Import from here instead; the
 * Drizzle defaults in src/db/schema.ts are the only legitimate duplicates,
 * because Drizzle bakes a default into the SQL and cannot read a TS constant.
 */

export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

/** The model Google retired. Kept as a named constant so the migration, the
 *  picker's "retired" label and the tests all refer to the same string. */
export const RETIRED_GEMINI_MODEL = 'gemini-2.5-flash';

export type AiProvider = 'gemini' | 'openai';

export function defaultModelFor(provider: string | null | undefined): string {
  return provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_GEMINI_MODEL;
}

// ─── Pricing ──────────────────────────────────────────────────────────────────

/**
 * USD per 1,000,000 tokens, as published on
 * https://ai.google.dev/gemini-api/docs/pricing and OpenAI's pricing page.
 *
 * Stated per-million because that is the unit the vendors publish and the unit
 * a human can check against the page. `getModelRates` converts to per-token.
 *
 * Adding a picker option without adding its rate here silently bills the
 * fallback rate into `tenant_ai_usages`, so tests/aiModels.test.ts asserts that
 * every option in AI_MODEL_OPTIONS has an entry.
 */
export interface ModelRate {
  /** USD per 1M input tokens (text / image / video). */
  inputPerMillion: number;
  /** USD per 1M output tokens. */
  outputPerMillion: number;
}

const RATES_PER_MILLION: Record<string, ModelRate> = {
  // Gemini 3 series.
  'gemini-3.1-flash-lite': { inputPerMillion: 0.25, outputPerMillion: 1.5 },
  // Promotional pricing through 2026-12-31; doubles to 1.50 / 7.50 on
  // 2027-01-01. Revisit then — this table is the only place to change.
  'gemini-3.6-flash': { inputPerMillion: 0.75, outputPerMillion: 3.75 },

  // Retired, but historical rows and any tenant still pinned to it are priced
  // with the rates this codebase has always assumed for it, so past numbers in
  // tenant_ai_usages stay reproducible.
  [RETIRED_GEMINI_MODEL]: { inputPerMillion: 0.075, outputPerMillion: 0.3 },

  // OpenAI.
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
};

/**
 * Per-token input/output rates for a model id.
 *
 * An unknown id bills at the default model's rate rather than at zero: an
 * under-reported cost of zero looks like a free feature on the billing screens
 * and hides the fact that the table is stale. The warning is the signal to add
 * the row.
 */
export function getModelRates(modelName: string | null | undefined): { input: number; output: number } {
  const key = (modelName || '').toLowerCase().trim();
  let rate = RATES_PER_MILLION[key];

  if (!rate) {
    console.warn(
      `[AI] No published rate for model "${modelName}" — billing it at ${DEFAULT_GEMINI_MODEL} rates. Add it to RATES_PER_MILLION in src/lib/aiModels.ts.`,
    );
    rate = RATES_PER_MILLION[DEFAULT_GEMINI_MODEL];
  }

  return {
    input: rate.inputPerMillion / 1_000_000,
    output: rate.outputPerMillion / 1_000_000,
  };
}

// ─── Generation config ────────────────────────────────────────────────────────

/**
 * Gemini 3 models reason by default. Every AI action in docsnx is structured
 * extraction or summarisation over a document the user already has — parsing,
 * not open-ended reasoning — so the default spends output tokens (billed at
 * 6x the input rate on Flash-Lite) and latency on thinking nobody reads.
 *
 * Returns undefined for Gemini 2.x, which has no thinkingLevel and would reject
 * or ignore the field depending on the endpoint.
 */
export function thinkingConfigFor(modelName: string | null | undefined) {
  const key = (modelName || '').toLowerCase();
  if (!/^gemini-3/.test(key)) return undefined;
  return { thinkingLevel: 'LOW' as const };
}

// ─── Picker options ───────────────────────────────────────────────────────────

export interface ModelOption {
  value: string;
  label: string;
  /** Retired ids stay selectable so existing rows render, but are labelled. */
  retired?: boolean;
}

export const AI_MODEL_OPTIONS: Record<AiProvider, ModelOption[]> = {
  gemini: [
    { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite (Fast, most economical)' },
    { value: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash (Highest quality, higher cost)' },
    { value: RETIRED_GEMINI_MODEL, label: 'Gemini 2.5 Flash (Retired by Google — do not select)', retired: true },
  ],
  openai: [
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast, economical)' },
    { value: 'gpt-4o', label: 'GPT-4o (Highest quality, higher cost)' },
  ],
};

/** Flat list for the pages that render one combined <select>. */
export const ALL_MODEL_OPTIONS: ModelOption[] = [
  ...AI_MODEL_OPTIONS.gemini,
  ...AI_MODEL_OPTIONS.openai,
];
