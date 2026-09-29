/**
 * DocsNX AI Library — Gemini + OpenAI with automatic key rotation.
 * All AI calls go through executeTenantWithRotation() for quota management.
 */

import { executeTenantWithRotation, AI_ERROR_CODES, AI_ERROR_MESSAGES } from './aiKeyManager';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { maskSensitiveText, prepareAiPayload } from './aiPrivacyMasker';
import { getAIProfile } from './aiProfiles';
import { thinkingConfigFor } from './aiModels';
import { categoryLabel, isBusinessModule, UNCATEGORIZED } from './documentCategories';
import { buildLiveAiCategoryList, knownCategory } from './taxonomyRegistry';
import { ocrFieldKeys } from './documentCategoryFields';
import { coerceExtracted } from './records/autofillCoerce';
import { scanCategoryForKey } from './records/scanCategoryModule';

// ─── HUF Helper ───────────────────────────────────────────────────────────────

/**
 * `record` is the whole proposed record — `holderName` is its own key, a sibling
 * of `extractedData`, so the suffix cannot be applied from inside the extracted
 * half alone. Passing the record keeps both halves reachable.
 */
function applyHufSuffixIfApplicable(record, checkText) {
  const extractedData = record?.extractedData;
  if (!extractedData) return;
  const hufRegex = /\bhuf\b|hindu\s+undivided\s+family/i;
  const isHuf = hufRegex.test(checkText || '') || hufRegex.test(JSON.stringify(extractedData));
  if (!isHuf) return;

  const appendHuf = (val) => {
    if (typeof val === 'string' && val.trim()) {
      const trimmed = val.trim();
      if (!trimmed.toUpperCase().endsWith('(HUF)') && !trimmed.toUpperCase().endsWith('H.U.F.')) {
        return `${trimmed} (HUF)`;
      }
    }
    return val;
  };

  if (extractedData.metadata) {
    if (extractedData.metadata.idHolderName) {
      extractedData.metadata.idHolderName = appendHuf(extractedData.metadata.idHolderName);
    }
  }
  if (extractedData.patientName) extractedData.patientName = appendHuf(extractedData.patientName);
  if (extractedData.ownerName) extractedData.ownerName = appendHuf(extractedData.ownerName);
  if (extractedData.insuredPerson) extractedData.insuredPerson = appendHuf(extractedData.insuredPerson);
  // The universal holder name every category now returns, treated like the
  // per-category ones above. `normalizeName` strips the suffix again before
  // matching, so this is for what the UI displays, not for the match itself.
  if (record.holderName) record.holderName = appendHuf(record.holderName);
}

// ─── Prompt Helpers ───────────────────────────────────────────────────────────

function stripMarkdownJson(text) {
  let t = (text || '').trim();
  if (t.startsWith('```json')) t = t.substring(7, t.length - 3).trim();
  else if (t.startsWith('```')) t = t.substring(3, t.length - 3).trim();
  return t;
}

/**
 * Gemini 3 models think by default. Every call in this file is structured
 * extraction or summarisation over a document the user already holds, so the
 * default spends output tokens — billed at 6x the input rate on Flash-Lite —
 * and latency on reasoning nobody reads. `thinkingConfigFor` returns undefined
 * on Gemini 2.x, which has no thinkingLevel, so these spread to nothing there.
 */
function geminiThinking(model) {
  const thinkingConfig = thinkingConfigFor(model);
  return thinkingConfig ? { thinkingConfig } : {};
}

function configFor(model) {
  const config = geminiThinking(model);
  return Object.keys(config).length ? { config } : {};
}

/**
 * Unified content generation helper that works with both Gemini and OpenAI clients.
 * Returns { text, promptTokens, completionTokens }
 */
async function generateContent({ client, model, provider }, contents) {
  // Apply AI Privacy Shield: sanitize all text prompts before transmitting to external AI models
  const sanitizedContents = contents.map((item) => {
    if (typeof item === 'string') {
      return maskSensitiveText(item);
    }
    return item;
  });

  if (provider === 'openai') {
    const messages = [];
    for (const item of sanitizedContents) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (item?.inlineData) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${item.inlineData.mimeType};base64,${item.inlineData.data}` },
            },
          ],
        });
      }
    }
    const response = await client.chat.completions.create({ model, messages });
    return {
      text: response.choices[0]?.message?.content || '',
      promptTokens: response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completion_tokens || 0
    };
  }

  // Gemini
  try {
    const tokenCountRes = await client.models.countTokens({ model, contents: sanitizedContents });
    const tokenCount = tokenCountRes.totalTokens || 0;

    if (tokenCount >= 32768) {
      console.log(`[AI] Payload is ${tokenCount} tokens. Creating Context Cache to save costs...`);
      
      let cacheContent = sanitizedContents;
      let generateContentInput = [{ text: 'Please proceed with the analysis.' }];
      
      if (sanitizedContents.length > 1 && typeof sanitizedContents[sanitizedContents.length - 1] === 'string') {
          cacheContent = sanitizedContents.slice(0, -1);
          generateContentInput = [sanitizedContents[sanitizedContents.length - 1]];
      }

      const cache = await client.caches.create({
        model,
        contents: cacheContent,
        ttl: '3600s'
      });

      try {
        const response = await client.models.generateContent({
          model,
          contents: generateContentInput,
          config: { cachedContent: cache.name, ...geminiThinking(model) }
        });
        
        return {
          text: response.text || '',
          promptTokens: response.usageMetadata?.promptTokenCount || 0,
          completionTokens: response.usageMetadata?.candidatesTokenCount || 0
        };
      } finally {
        await client.caches.delete({ name: cache.name }).catch(e => console.error('Cache delete error:', e));
        console.log(`[AI] Context Cache ${cache.name} deleted successfully to prevent storage costs.`);
      }
    } else {
      const response = await client.models.generateContent({
        model,
        contents: sanitizedContents,
        ...configFor(model),
      });
      return {
        text: response.text || '',
        promptTokens: response.usageMetadata?.promptTokenCount || 0,
        completionTokens: response.usageMetadata?.candidatesTokenCount || 0
      };
    }
  } catch (error) {
    console.error('[AI] Gemini generateContent error:', error);
    throw error;
  }
}

// ─── Public API Functions ─────────────────────────────────────────────────────

/**
 * `companyId` on each of these is the workspace the AI SPEND is filed under —
 * null for the household. It reaches `executeTenantWithRotation` and ends up on
 * the `credit_transactions` row, and that is all it does: there is one wallet,
 * and this decides which tab of /billing/credits the movement appears under.
 *
 * It is NOT the taxonomy `scope` two of these already take. `scope` chooses
 * WHICH VOCABULARY the model is given ('personal' vs 'business' categories);
 * `companyId` says WHOSE BILL it was. A tenant with three companies has one
 * business taxonomy and three separate ledgers.
 *
 * Optional and defaulted to null so a caller that does not know its workspace
 * keeps working — the spend then reads as the household's, which is what every
 * caller meant before companies existed.
 */
export async function generateRecordAnalysis(recordCategory, recordData, tenantId, userId, /** @type {string | null} */ companyId = null) {
  const profile = getAIProfile(recordCategory);
  try {
    const prompt = `Analyze this ${profile.name} (${recordCategory.toUpperCase()}) record and provide a hyper-concise JSON analysis.
    Mandatory Analytical Focus Areas:
    ${profile.analyticalCapabilities.map(cap => `- ${cap}`).join('\n')}
    
    You MUST adhere to these strict constraints:
    1. Provide exactly 1-2 bullet points for risks/warnings.
    2. Provide exactly 1-2 bullet points for opportunities/actions.
    3. Provide exactly 1-2 bullet points for general tips/insights.
    4. Keep bullet points extremely short (10-15 words max).
    5. No fluff, no introductory text, just the facts.
    6. Return ONLY valid JSON matching the schema below.

    Record Data:
    ${JSON.stringify(prepareAiPayload(recordData).sanitizedData, null, 2)}
    
    JSON Schema Requirements:
    {
      "risks": ["Risk 1", "Risk 2"],
      "opportunities": ["Opportunity 1"],
      "tips": ["Tip 1"]
    }`;

    const res = await executeTenantWithRotation(
      tenantId,
      'RECORD_ANALYSIS',
      async (clientInfo) => generateContent(clientInfo, [prompt]),
      userId,
      companyId,
    );
    
    const parsed = JSON.parse(stripMarkdownJson(res.text));
    return {
      ...parsed,
      disclaimer: profile.mandatoryDisclaimer
    };
  } catch (error) {
    console.error('AI record analysis error:', error);

    // Callers embed this result into the record they are saving, so throwing
    // would fail the whole save. Instead return a stub that names the real
    // cause, so an exhausted credit balance doesn't read as an AI outage.
    if (error?.errorCode === AI_ERROR_CODES.INSUFFICIENT_CREDITS) {
      return {
        disclaimer: profile.mandatoryDisclaimer,
        errorCode: AI_ERROR_CODES.INSUFFICIENT_CREDITS,
        error: AI_ERROR_MESSAGES.INSUFFICIENT_CREDITS,
        risks: [AI_ERROR_MESSAGES.INSUFFICIENT_CREDITS],
        opportunities: [],
        tips: []
      };
    }

    return {
      disclaimer: profile.mandatoryDisclaimer,
      risks: ["Failed to generate risks."],
      opportunities: ["Failed to generate opportunities."],
      tips: ["Failed to generate tips."]
    };
  }
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   PASS 1 — WHAT IS EACH RECORD, AND WHICH FILES BELONG TO IT             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── ONE TAXONOMY, NOT TWO ──────────────────────────────────────────────────
 * This prompt used to ask two questions about every record: which of seventeen
 * hardcoded scan categories it was, AND — for the one category called
 * `document` — which of the 83 master sub-categories it belonged to. Sixteen
 * of the seventeen therefore had no sub-category at all, which meant:
 *
 *   · the review grid showed them NO "Category / Sub-category" picker (it only
 *     rendered for `document`), so a batch of prescriptions, policies and
 *     salary slips came back with nothing filed and nothing to fix it with;
 *   · pass 2 skipped them — it keys off `extractedData.categoryId` — so their
 *     fields were never read against a real field spec, and every super-admin
 *     Field Configuration was inert for them;
 *   · they fell back to a hardcoded legacy schema whose seven or eight
 *     camelCase keys were a fraction of what the category actually declares.
 *
 * That was the whole of the "power scan found no category and no fields"
 * report: it was not a misclassification, it was sixteen categories that were
 * never asked the question.
 *
 * So the model is asked ONE question now — which master sub-category is this? —
 * and the scan category is DERIVED from the answer by `scanCategoryForKey`,
 * because the fifteen record scopes partition all 83 categories. A prescription
 * lands in `health_medical/records_prescriptions`, which is scope `medical`,
 * which is scan category `medical`. Nothing downstream changed vocabulary; the
 * vocabulary simply stopped being guessed twice.
 *
 * ── IT ASKS FOR THREE ANSWERS, LIKE ITS SINGLE-FILE SIBLING ────────────────
 * `classifyDocument` learnt this the expensive way: a model that answers
 * `identity/pan` or `bank_investments/bank_statements` (a real key under the
 * wrong module) knew exactly what the document was and spelled the pair wrong,
 * and an all-or-nothing check turned that into the catch-all and a blank form.
 * Up to three candidates, best first, first seeded one wins. The extra output
 * tokens are free next to a mis-filed record.
 *
 * ── THE TWO THAT ARE NOT DOCUMENTS ────────────────────────────────────────
 * `todo` and `emergency_contact` own no taxonomy categories and hold no files,
 * so no pair can resolve to them. They stay named directly, with the small
 * legacy schemas they have always had.
 */
export async function scanMultipleFiles(files, tenantId, userId, scope = 'personal', /** @type {string | null} */ companyId = null) {
  // Built from the LIVE document_categories table, so a sub-category an operator
  // added is classifiable and one they retired is not offered. See
  // renderAiCategoryList() for the masking note.
  //
  // `scope` is what keeps a company's scan inside the company's taxonomy: the
  // model is shown only the fourteen `biz_*` modules there, so it cannot propose
  // a household pair in the first place. The default is 'personal', so every
  // caller that predates the business account behaves exactly as before.
  const categoryList = await buildLiveAiCategoryList(scope);

  const systemPrompt = `You are a scanning and record parsing AI assistant for a records vault and SaaS system called DocsNX.
We have uploaded multiple files (images or PDFs). Some of these files represent individual single-page documents, while others might be multiple pages/images belonging to a single logical record (e.g. page 1 and page 2 of a single medical prescription, or page 1 and page 2 of a vehicle insurance policy).

Your tasks are:

1. GROUP THE FILES INTO LOGICAL RECORDS.
   - For standalone single-page identity documents (such as PAN cards, Aadhaar cards, driving licenses), each file MUST be its own separate record. Even if there are 10 PAN cards in the batch, you must output 10 separate records (one for each file index). Do NOT group them together.
   - For multi-page documents (passports, medical reports, utility bills, insurance policies, bank statements, agreements), all pages belonging to the same document must be grouped into a single record by listing all of their file indices in "fileIndices".
   - Every uploaded file must be assigned to exactly one record. Do not drop or miss any file.

2. FILE EACH RECORD AGAINST THE MASTER TAXONOMY BELOW.
   Read the record itself, in this order: the heading or form number printed at the top, the authority, department or company that issued it, any logo or seal, then the body. Those four say what a document IS; the presence of a name or a number does not.

   Return "candidates": the taxonomy pairs this record could be filed under, BEST FIRST, at most three. Each is { "moduleKey": "...", "documentKey": "..." }, where "moduleKey" is the value shown in a module heading below and "documentKey" is one of the quoted keys listed UNDER that same heading. The two MUST come from the same module. Copy both verbatim — do not invent, abbreviate, pluralise or reword them, and never pair a key with a module that does not list it.

   Give a second and third choice whenever the record could reasonably go elsewhere. A near miss is far more useful than the fallback, and answering with two entries is the right response to being unsure between them.

   Use "moduleKey": "${UNCATEGORIZED.moduleKey}", "documentKey": "${UNCATEGORIZED.documentKey}" ONLY when the record genuinely fits nothing below — an unreadable page, a blank scan, a personal letter. A recognisable document always belongs somewhere.

   Do NOT read the record's fields. A second pass reads them against the field list of the exact sub-category you choose here, so choosing well is the whole job.

3. THE TWO EXCEPTIONS. A handwritten task list or reminder note is "kind": "todo". A sheet of emergency contact details (doctors, agents, services) is "kind": "emergency_contact". These two are NOT filed against the taxonomy and take no "candidates" — everything else in the batch does. Use them only for records that are genuinely one of those two things.

4. FOR EVERY RECORD, set "title": a clean concise name for it (e.g. exactly 'PAN Card' or 'Passport'). Do NOT append index suffixes like 'PAN Card - 1' or 'PAN Card 2'.

5. FOR EVERY RECORD, set "holderName": the person the record is about, exactly as printed on the document — the card holder, the patient, the account holder, the policy holder, the consumer named on a bill, the borrower named on a loan. It is the person the record BELONGS TO, never a doctor, dealer, employer, broker, lender or provider. If the document names a Hindu Undivided Family (HUF), append " (HUF)" to that name. If no person is named, use an empty string — do not guess.

${categoryList}

You must return the result strictly in valid JSON format matching this schema:
{
  "proposedRecords": [
    {
      "title": "Clean concise name/title for the record",
      "kind": "record" | "todo" | "emergency_contact",
      "candidates": [{ "moduleKey": "<a moduleKey from a module heading above>", "documentKey": "<a documentKey listed UNDER that same heading>" }],
      "holderName": "<the person this record is about, as printed, or an empty string>",
      "fileIndices": [0, 1],
      "extractedData": {
        // ONLY for "todo": { "task": string, "dueDate": "YYYY-MM-DD", "status": "PENDING"|"COMPLETED" }
        // ONLY for "emergency_contact": { "name": string, "role": string, "phoneNumber": string, "email": string, "address": string, "notes": string }
        // For every other record leave this an empty object {} — the second pass fills it.
      }
    }
  ]
}

- If any document represents a Hindu Undivided Family (HUF) account or card (e.g. contains 'HUF' or 'Hindu Undivided Family' in the scanned text, name, or metadata), make sure to append ' (HUF)' to the holder's name if it is not already present.

Return only the raw JSON. Do not wrap in markdown code blocks.`;

  try {
    const result = await executeTenantWithRotation(tenantId, 'BULK_SCAN', async (clientInfo) => {
      const contents = [systemPrompt];

      for (let i = 0; i < files.length; i++) {
        if (files[i].extractedText) {
          // For text-extracted files (doc, docx, xls, xlsx, txt, csv), send text content
          contents.push(`[File Index ${i}: "${files[i].fileName}" (${files[i].mimeType})]\nExtracted text content:\n${files[i].extractedText}`);
        } else {
          // For image/PDF files, send as inline base64 data
          contents.push({ inlineData: { mimeType: files[i].mimeType, data: files[i].base64 } });
        }
      }

      const fileListText = `Uploaded files in order:\n` + files.map((f, i) => `Index ${i}: filename="${f.fileName}", mimeType="${f.mimeType}", contentType="${f.extractedText ? 'text' : 'image'}"`).join('\n');
      contents.push(fileListText);

      const res = await generateContent(clientInfo, contents);
      const parsed = JSON.parse(stripMarkdownJson(res.text));

      if (parsed && Array.isArray(parsed.proposedRecords)) {
        for (const rec of parsed.proposedRecords) {
          if (!rec || typeof rec !== 'object') continue;
          if (!Array.isArray(rec.fileIndices)) rec.fileIndices = [];
          if (!rec.extractedData || typeof rec.extractedData !== 'object') rec.extractedData = {};

          // `holderName` is asked for as a SIBLING of extractedData, but a model
          // told to emit a key next to a nested object will sometimes put it
          // inside instead. Lift it before anything else reads the record:
          // left where it landed it would be saved as a field of the record,
          // and "Belongs to" already answers that question.
          const nested = rec.extractedData.holderName;
          if (typeof nested === 'string') {
            if (!rec.holderName) rec.holderName = nested;
            delete rec.extractedData.holderName;
          }

          const groupFilesText = rec.fileIndices
            .map((idx) => `${files[idx]?.fileName || ''} ${files[idx]?.originalName || ''}`)
            .join(' ');
          applyHufSuffixIfApplicable(rec, groupFilesText);

          // The two that own no taxonomy categories keep the names the model
          // gave them and their own small legacy bodies.
          if (rec.kind === 'todo' || rec.kind === 'emergency_contact') {
            rec.category = rec.kind;
            delete rec.candidates;
            continue;
          }

          rec.category = await resolveScanCategory(rec, scope);
        }
      }

      // Inject token stats into response object for logging wrapper
      return {
        ...parsed,
        promptTokens: res.promptTokens,
        completionTokens: res.completionTokens
      };
    }, userId, companyId);

    return result;
  } catch (error) {
    console.error('Bulk scan AI error:', error);
    throw error;
  }
}

/**
 * Does a proposed pair belong to the workspace that asked for the scan?
 *
 * The prompt is already built from one taxonomy (see `buildLiveAiCategoryList`),
 * so a cross-taxonomy pair means the model ignored the list — from memory of a
 * key it saw in training, or by pairing a `documentKey` with the wrong module.
 * Cheap to check and expensive to miss: a `biz_*` pair filed with no company
 * cannot satisfy `documents_account_scope_ck`, and a personal pair filed WITH
 * one is refused by the write gate at the end of a long scan.
 */
function inTaxonomy(moduleKey, scope) {
  // `belongsToWorkspace` takes the company; here the caller only has the scope
  // string it was given, so the same rule is expressed against that.
  return isBusinessModule(moduleKey) === (scope === 'business');
}

/**
 * Turn one record's proposed pairs into a filed category and a scan category.
 *
 * Mutates `rec.extractedData.moduleKey` / `.documentKey` and returns the scan
 * category the rest of the pipeline speaks. Shares its rules with
 * `classifyDocument`: try every proposal in the model's own order of
 * confidence, take the first that is REALLY seeded, and log the ones discarded
 * so the rate at which the model invents pairs stays visible rather than being
 * silently absorbed by the catch-all.
 *
 * Checked as a PAIR — each half can be individually valid and the combination
 * still not exist (`registration_certificate` is a real key under both
 * `vehicle` and `business`).
 */
async function resolveScanCategory(rec, scope = 'personal') {
  const proposals = [
    ...(Array.isArray(rec.candidates) ? rec.candidates : []),
    // The shape the prompt asked for until now, and the shape a model still
    // answers often enough to matter. Accepted so neither spelling is a failed
    // classification.
    { moduleKey: rec.extractedData?.moduleKey, documentKey: rec.extractedData?.documentKey },
    { moduleKey: rec.moduleKey, documentKey: rec.documentKey },
  ]
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({
      moduleKey: typeof c.moduleKey === 'string' ? c.moduleKey.trim() : '',
      documentKey: typeof c.documentKey === 'string' ? c.documentKey.trim() : '',
    }))
    .filter((c) => c.moduleKey || c.documentKey)
    // Wrong half of the account: discarded before the taxonomy is even asked,
    // so a stray pair cannot win over a correct one listed after it.
    .filter((c) => inTaxonomy(c.moduleKey, scope));

  // Sequential rather than `.find`, because the question is now asked of the
  // live taxonomy and is therefore async. The ORDER still matters — it is the
  // model's own order of confidence — so this stops at the first pair that
  // really exists rather than resolving all of them and picking.
  //
  // `refused` collects only the pairs this loop actually ASKED about and was
  // told no. Reporting `proposals` minus the winner instead named the
  // candidates that came AFTER the hit and were never tested — which is how the
  // log came to accuse the model of inventing `employment/salary_slips`, an
  // active row in the master table whose only crime was being second choice.
  let hit;
  const refused = [];
  for (const c of proposals) {
    if (await knownCategory(c.moduleKey, c.documentKey)) { hit = c; break; }
    refused.push(categoryLabel(c));
  }

  if (refused.length > 0) {
    const outcome = hit
      ? `using ${categoryLabel(hit)}`
      : `falling back to ${categoryLabel(UNCATEGORIZED)}`;
    console.warn(`[AI] Bulk scan proposed unknown categor${refused.length === 1 ? 'y' : 'ies'} ${refused.map((r) => `"${r}"`).join(', ')} — ${outcome}.`);
  }

  /**
   * ── THE CATCH-ALL IS PERSONAL, SO A COMPANY HAS NONE ─────────────────────
   *
   * `other/uncategorized` is a household module. Falling back to it inside a
   * company would build a record with a personal category and a company id —
   * a pair the write gate refuses, per record, at the very end of the scan.
   *
   * So a company's unplaceable page is returned with NO category at all, which
   * is the path an unresolvable pair has always taken: the review grid shows
   * its "pick a category" placeholder and the member says where it goes. An
   * honest question beats a record filed where nobody will look for it.
   */
  const key = hit ?? (scope === 'business' ? null : UNCATEGORIZED);
  if (!key) {
    rec.extractedData.moduleKey = '';
    rec.extractedData.documentKey = '';
    delete rec.candidates;
    return '';
  }

  rec.extractedData.moduleKey = key.moduleKey;
  rec.extractedData.documentKey = key.documentKey;
  delete rec.candidates;

  // `other/uncategorized` belongs to the `documents` scope, so an unclassified
  // household page still lands somewhere a member can see and re-file it.
  return scanCategoryForKey(key) || 'document';
}

// ─── Single-Document Field Extraction (add-record autofill) ───────────────────

/**
 * How many of a choice field's options are named in the prompt.
 *
 * Every option costs tokens on every page of every scan, and a field with two
 * hundred of them is a lookup table, not a question a document answers. The
 * first fifty cover every real configuration; beyond that the prompt says "…"
 * and `coerceExtracted` still accepts any option the model happens to produce,
 * so the cap costs recall on the tail rather than correctness.
 */
const MAX_PROMPTED_OPTIONS = 50;

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   READ ONE DOCUMENT AGAINST ONE CATEGORY'S FIELD SPEC                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * What the add form calls when a file is attached: the user has ALREADY said
 * which sub-category they are filing under, so unlike `scanMultipleFiles` there
 * is nothing to classify and nothing to group. The only question is "what do
 * these pages say for THESE fields", and the fields are the category's own spec
 * — the same list the form renders and the same list the POST route validates.
 *
 * Driving the prompt from the spec rather than from a hardcoded schema is the
 * whole point: a category added to the taxonomy, or a field added to one, is
 * extracted correctly with no change here. It is also why the answer can be
 * applied to the form directly — the keys are already the form's keys.
 *
 * ── WHAT COMES BACK IS A SUGGESTION ────────────────────────────────────────
 * Nothing here is stored. The values land in the inputs of an unsaved form, the
 * user reviews them, and the ordinary POST does the validating, sealing and
 * audit logging. An unreadable field is omitted rather than guessed — a wrong
 * policy number the user did not notice is worse than an empty box.
 */
export async function extractCategoryFields({ files, category, fields }, tenantId, userId, /** @type {string | null} */ companyId = null) {
  /**
   * The fields worth ASKING for.
   *
   * `ocrFieldKeys` is the one statement of that rule and of why the keys it
   * drops are dropped — see NEVER_PRINTED_KEYS. The same helper materialises
   * `document_category_fields.ocr_fields`, so that column names the fields this
   * prompt actually asks for rather than describing a prompt of its own.
   *
   * Applied to the spec THIS request loaded, not to the stored column: a field
   * an operator retires from `fields` stops being asked for immediately, and a
   * category whose row predates 0034 still gets the right list.
   */
  const ask = new Set(ocrFieldKeys(fields || []));
  const askable = (fields || []).filter((f) => f?.fieldKey && ask.has(f.fieldKey));
  if (askable.length === 0) return { fields: {}, holderName: '' };

  const byKey = new Map(askable.map((f) => [f.fieldKey, f]));

  const fieldList = askable.map((f) => {
    const bits = [`"${f.fieldKey}" — ${f.fieldLabel} (${f.dataType})`];
    if (f.description) bits.push(f.description);
    /**
     * A choice field's PERMITTED ANSWERS, spelled out.
     *
     * Without them the model answers in the document's vocabulary — "Two
     * Wheeler" where the operator's list says "2W" — and `coerceExtracted`
     * then drops an answer that was read perfectly correctly. Listing the
     * values is what makes the answer usable, and the values are what is
     * stored, so they are what is asked for.
     */
    if (Array.isArray(f.options) && f.options.length > 0) {
      const shown = f.options.slice(0, MAX_PROMPTED_OPTIONS)
        .map((o) => `"${o.value}"`).join(', ');
      const more = f.options.length > MAX_PROMPTED_OPTIONS ? ', …' : '';
      bits.push(
        f.dataType === 'multiselect'
          ? `answer with any of these exact values, comma separated: ${shown}${more}`
          : `answer with exactly one of these values: ${shown}${more}`,
      );
    }
    if (f.validation?.example) bits.push(`e.g. ${f.validation.example}`);
    if (f.isRequired) bits.push('usually present on this document');
    return `- ${bits.join('; ')}`;
  }).join('\n');

  const systemPrompt = `You are a document reading assistant for DocsNX, a records vault.

The user has uploaded ONE document and has already told us what it is: "${category.documentName}" (module: "${category.moduleName}"). Do not re-classify it. Every page attached belongs to this single document.

Your only job is to read the document and fill in the fields below with what is actually printed on it.

FIELDS — return these keys and no others:
${fieldList}

RULES
1. Return a key ONLY when the document actually shows that value. Omit anything you cannot read. Never guess, never infer a plausible-looking number, and never copy an example value from the list above.
2. Dates must be "YYYY-MM-DD". If only a month and year are printed, use the first day of that month.
3. Numbers and amounts: digits only, with at most one decimal point. No currency symbols, no thousands separators, no words.
4. Booleans: true or false.
5. Where a field lists permitted values, answer with one of those values COPIED EXACTLY — not the wording printed on the document, and not a value of your own. If the document says something the list does not cover, omit the field.
6. Identifiers (card numbers, policy numbers, registration numbers) must be copied EXACTLY as printed, with spaces removed.
7. Do not translate or reformat names. Copy them as printed.
8. "holderName" is the person the document is about, as printed on it. If the document names a Hindu Undivided Family (HUF), append " (HUF)" to that name.

Return ONLY raw JSON in exactly this shape, with no markdown fences and no commentary:
{
  "fields": { "<fieldKey>": "<value read from the document>" },
  "holderName": "<the person this document is about, or an empty string>"
}`;

  const result = await executeTenantWithRotation(tenantId, 'BULK_SCAN', async (clientInfo) => {
    const contents = [systemPrompt];

    for (const file of files) {
      if (file.extractedText) {
        // Text-bearing formats (.docx, .xlsx, .txt) arrive as a string, which
        // `generateContent` runs through the Privacy Shield's text masker
        // before it leaves the process. That is deliberate and unchanged here:
        // a long number inside a spreadsheet reaches the model as
        // [ACCOUNT-NUM-MASKED] and simply comes back unextracted.
        contents.push(`[Page ${file.pageNumber ?? 1} of "${file.fileName}"]\n${file.extractedText}`);
      } else {
        contents.push({ inlineData: { mimeType: file.mimeType, data: file.base64 } });
      }
    }

    const res = await generateContent(clientInfo, contents);
    const parsed = JSON.parse(stripMarkdownJson(res.text));

    // Keys the spec did not ask for are dropped rather than passed on: the form
    // renders inputs from the spec, so an unknown key has nowhere to land, and
    // an unknown key that happened to collide with a real field elsewhere would
    // land somewhere wrong.
    const out = {};
    for (const [key, raw] of Object.entries(parsed?.fields || {})) {
      const spec = byKey.get(key);
      if (!spec) continue;
      const value = coerceExtracted(spec, raw);
      if (value !== null && value !== '') out[key] = value;
    }

    const holderName = typeof parsed?.holderName === 'string' ? parsed.holderName.trim() : '';

    return {
      fields: out,
      holderName,
      // Read by executeTenantWithRotation for per-tenant usage accounting.
      promptTokens: res.promptTokens,
      completionTokens: res.completionTokens,
    };
  }, userId, companyId);

  return result;
}

// ─── Single-Document Classification (Documents Manager auto-fill) ─────────────

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT IS THIS ONE DOCUMENT? — and nothing else                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The Documents Manager's auto-fill runs on a file whose category nobody has
 * chosen, so something has to name it before `extractCategoryFields` can ask
 * the right questions. This is that something, and it is deliberately the
 * SMALLEST prompt that can answer it: the taxonomy list, a title, a holder.
 *
 * ── WHY NOT scanMultipleFiles ──────────────────────────────────────────────
 * That is what the page used to call, and it is the wrong tool by a wide
 * margin. It carries the seventeen legacy extraction schemas and the grouping
 * rules for a whole batch — hundreds of lines of prompt — to answer a question
 * about ONE file that is not being grouped with anything and whose fields are
 * read by the second pass anyway. Worse, the page then had to upload and
 * rasterise the same file a second time for that second pass. Classifying here
 * lets one `pagesForAi` feed both calls (see records/autofillRun.ts).
 *
 * ── THE PAIR IS CHECKED, NEVER TRUSTED ─────────────────────────────────────
 * Models abbreviate ('pan'), re-case ('PAN_Card'), and pair a documentKey with
 * the wrong module often enough that an unchecked value would reach the DB
 * lookup and resolve to nothing. Checked as a PAIR — each half can be valid and
 * the combination still not exist — against the seeded pairs, else
 * Uncategorized, and logged so the hallucination rate stays visible.
 *
 * ── WHY IT ASKS FOR THREE ANSWERS AND NOT ONE ──────────────────────────────
 * That check used to be all-or-nothing: one pair, and anything not exactly
 * seeded became Uncategorized — which the upload form reads as "could not work
 * out the category" and fills in NOTHING. A model that answers
 * `identity/pan` or `bank_investments/bank_statements` (a real key, wrong
 * module — `business` owns that one) knew perfectly well what the document was;
 * it spelled the pair wrong, and the user paid for that with a blank form.
 *
 * So it asks for up to three, best first, and takes the first that is really
 * seeded. Same call, same document, same tokens — the second and third cost
 * nothing but a few output tokens and they turn a near miss into a filing.
 *
 * ── AND IF IT STILL DOES NOT PLACE IT, IT ASKS AGAIN — ONCE ────────────────
 * Landing in the catch-all is not a filing decision, it is a failed one: the
 * upload form shows a blank sub-category and fills in nothing, and what users
 * then did was press the button a second time and get the right answer. That
 * second press cost a fresh upload, a fresh rasterisation and a fresh billed
 * classify to ask the identical question. So the retry happens HERE instead,
 * inside one `executeTenantWithRotation` — one billed DOC_CLASSIFY, at most two
 * model calls, and only ever on the path that was about to fail.
 *
 * BOTH ways of reaching the catch-all earn it, because they are the same blank
 * form to the user: every proposal refused, and the fallback chosen outright.
 * The second ask names which of the two it is correcting, so it cannot spend
 * the call repeating a pair that was already refused.
 *
 * ── IT IS TOLD THE FILENAME, LIKE THE BATCH SCANNER IS ─────────────────────
 * `scanMultipleFiles` ends its prompt with a manifest naming every file, and
 * this did not — it sent bare page images. A scan called "Salary Slip March"
 * says what it is more plainly than its own letterhead does, and that signal was
 * being thrown away on the one path with no batch around it to compensate.
 * Which is why the SAME document filed correctly through Power Scan and landed
 * in the catch-all here.
 */
export async function classifyDocument(files, tenantId, userId, scope = 'personal', /** @type {string | null} */ companyId = null) {
  // Built from the LIVE document_categories table, so a sub-category an operator
  // added is classifiable and one they retired is not offered. See
  // renderAiCategoryList() for the masking note.
  //
  // Scoped like `scanMultipleFiles` above — the single-document autofill on a
  // company's Document Manager must offer that company's taxonomy, not the
  // household's. Defaults to 'personal'.
  const categoryList = await buildLiveAiCategoryList(scope);

  const systemPrompt = `You are a document filing assistant for DocsNX, a records vault.

The user has uploaded ONE document. Every page attached belongs to that single document. Your ONLY job is to say what it is and who it is about. Do NOT read its fields — another step does that.

HOW TO READ IT
Work from the document itself, in this order: the heading or form number printed at the top, the authority, department or company that issued it, any logo or seal, then the body. Those four say what a document IS; the presence of a name or a number does not. The filename listed after the pages is a hint, not the answer — trust the document over it when they disagree.

Return:
1. "candidates" — the master taxonomy pairs this document could be filed under, BEST FIRST, at most three. Each is { "moduleKey": "...", "documentKey": "..." }, where "moduleKey" is the value shown in a module heading below and "documentKey" is one of the quoted keys listed UNDER that same heading. The two MUST come from the same module. Copy both verbatim — do not invent, abbreviate, pluralise or reword them, and never pair a key with a module that does not list it. Give a second and third choice whenever the document could reasonably go elsewhere — a near miss is far more useful to the user than the fallback. The FIRST candidate must be a real entry from the list below: a document you can read at all has a closest entry, and naming it is the job. Do not answer with the fallback because you are unsure BETWEEN two entries; answer with both.
2. "title" — a clean, concise name for this document (e.g. exactly 'PAN Card' or 'Passport'). No index suffixes like 'PAN Card - 1'.
3. "holderName" — the person this document is ABOUT, exactly as printed on it: the card holder, the patient, the account holder, the policy holder, the consumer named on a bill, the borrower named on a loan. Never a doctor, dealer, employer, broker, lender or provider. If the document names a Hindu Undivided Family (HUF), append " (HUF)" to that name. If no person is named, use an empty string — do not guess.

${categoryList}
   The fallback above is for pages that are blank, unreadable, or genuinely nothing on this list — a personal letter. It is never the answer for a document you were able to read.

Return ONLY raw JSON in exactly this shape, with no markdown fences and no commentary:
{ "candidates": [{ "moduleKey": "...", "documentKey": "..." }], "title": "...", "holderName": "..." }`;

  /**
   * The same manifest `scanMultipleFiles` sends, for one document's pages.
   *
   * A prompt STRING, so it goes through `maskSensitiveText` in generateContent
   * like every other one — a filename carrying a PAN or a phone number is
   * rewritten before it leaves the process, exactly as the batch path's is.
   */
  const pageManifest = `Pages of ONE document, in order:\n${
    files.map((f, i) => `Page ${f.pageNumber ?? i + 1}: filename="${f.fileName || ''}"`).join('\n')
  }`;

  const result = await executeTenantWithRotation(tenantId, 'DOC_CLASSIFY', async (clientInfo) => {
    const contents = [systemPrompt];

    for (const file of files) {
      if (file.extractedText) {
        // Text-bearing formats reach the model through the Privacy Shield's
        // text masker — see the same note in extractCategoryFields.
        contents.push(`[Page ${file.pageNumber ?? 1} of "${file.fileName}"]\n${file.extractedText}`);
      } else {
        contents.push({ inlineData: { mimeType: file.mimeType, data: file.base64 } });
      }
    }

    contents.push(pageManifest);

    /**
     * One ask, parsed and filed against the live taxonomy.
     *
     * Returns the pairs it actually TESTED and refused — not every pair that is
     * not the winner. The loop stops at the first hit, so the candidates after
     * it were never asked about, and reporting them as unknown is how the log
     * came to accuse the model of inventing `employment/salary_slips` — a real,
     * active row that simply came second.
     */
    const ask = async (correction) => {
      const res = await generateContent(
        clientInfo, correction ? [...contents, correction] : contents,
      );
      const parsed = JSON.parse(stripMarkdownJson(res.text));

      /**
       * The answers to try, in the model's own order of confidence.
       *
       * `candidates` is what the prompt asks for; the top-level pair is accepted
       * too, because that is the shape the prompt asked for until now and a model
       * given a JSON schema still answers the shape it was trained on often
       * enough to matter. Both, rather than either, so neither spelling is a
       * failed classification.
       */
      const proposals = [
        ...(Array.isArray(parsed?.candidates) ? parsed.candidates : []),
        { moduleKey: parsed?.moduleKey, documentKey: parsed?.documentKey },
      ]
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({
          moduleKey: typeof c.moduleKey === 'string' ? c.moduleKey.trim() : '',
          documentKey: typeof c.documentKey === 'string' ? c.documentKey.trim() : '',
        }))
        .filter((c) => c.moduleKey || c.documentKey)
        // Same rule as `resolveScanCategory`: a pair from the other half of the
        // account is not a near miss, it is unusable here.
        .filter((c) => inTaxonomy(c.moduleKey, scope));

      // Sequential for the same reason as resolveScanCategory: the live taxonomy
      // is asked asynchronously, and the model's ordering is its confidence.
      let hit;
      const refused = [];
      for (const c of proposals) {
        if (await knownCategory(c.moduleKey, c.documentKey)) { hit = c; break; }
        refused.push(categoryLabel(c));
      }

      return { res, parsed, proposals, hit, refused };
    };

    let out = await ask(null);
    let promptTokens = out.res.promptTokens || 0;
    let completionTokens = out.res.completionTokens || 0;
    const refused = [...out.refused];
    let retried = false;

    /**
     * Did this answer FILE the document, or only decline to?
     *
     * The catch-all is a real seeded pair, so it validates like any other and
     * arrives as a `hit` — but it is not a filing decision, it is the model
     * saying it does not know, and the upload form shows it as a blank
     * sub-category with nothing filled in. Both ways of reaching it — every
     * proposal refused, and the fallback chosen outright — are the same failure
     * to the user, so both earn the retry.
     */
    const placed = (c) => Boolean(c)
      && !(c.moduleKey === UNCATEGORIZED.moduleKey && c.documentKey === UNCATEGORIZED.documentKey);

    /**
     * Ask once more rather than handing the user a blank form — see the header.
     * `contents` is reused as it stands, so the pages are not rasterised,
     * re-uploaded or re-sent from disk; only the correction is new.
     */
    if (!placed(out.hit)) {
      retried = true;
      let named;
      if (refused.length > 0) {
        named = `${refused.map((r) => `"${r}"`).join(', ')}, which ${refused.length === 1 ? 'is not a category' : 'are not categories'} in the list`;
      } else if (out.hit) {
        named = 'the fallback — you said this document fits nothing on the list';
      } else {
        named = 'not a usable pair at all';
      }
      const second = await ask(
        `Your previous answer was ${named}. Look at the pages again and answer with the closest entry that IS listed above, copying its moduleKey and documentKey verbatim from the same module heading. Use the fallback ONLY if the pages are blank or unreadable. Return the same JSON shape.`,
      );

      // Summed, not replaced: `recordTenantAiUsage` reads these off the return
      // value, and reporting one call's tokens for two would under-bill the
      // tenant's own usage screens.
      promptTokens += second.res.promptTokens || 0;
      completionTokens += second.res.completionTokens || 0;
      refused.push(...second.refused);

      // The second answer only replaces the first if it actually filed the
      // document. A second decline leaves the first attempt's title and holder
      // standing — they are true whatever the category turned out to be.
      if (placed(second.hit)) out = second;
    }

    // A company has no catch-all — `other/uncategorized` is a household module
    // — so an unplaced document comes back with no pair and the caller asks the
    // member to choose. See the same reasoning in `resolveScanCategory`.
    const noPair = scope === 'business';
    const moduleKey = out.hit?.moduleKey ?? (noPair ? '' : UNCATEGORIZED.moduleKey);
    const documentKey = out.hit?.documentKey ?? (noPair ? '' : UNCATEGORIZED.documentKey);

    /**
     * The outcome of every classify, in one line.
     *
     * There was no log at all for the case that matters — a document that ended
     * in the catch-all, which is what a blank sub-category on the upload form
     * IS — so how often that happened was invisible from outside the browser.
     *
     * The warning is about the OUTCOME, not about the model's honesty: a page
     * that genuinely fits nothing belongs in the catch-all and naming it here
     * is not an accusation. Refused pairs are appended only when there were
     * some, and only ones actually tested.
     */
    const trail = refused.length > 0
      ? ` (refused ${refused.map((r) => `"${r}"`).join(', ')})`
      : '';
    if (placed(out.hit)) {
      console.log(`[AI] Classify → ${categoryLabel(out.hit)}${retried ? ' on retry' : ''}${trail}.`);
    } else {
      console.warn(`[AI] Classify did not place "${files[0]?.fileName || 'document'}"${retried ? ', asked twice' : ''} — ${noPair ? 'leaving it for the member to place' : `filing as ${categoryLabel(UNCATEGORIZED)}`}${trail}.`);
    }

    // The same suffix rule the batch scanner applies, through the same helper —
    // it reads `record.holderName`, so the answer is shaped as a record for it.
    const record = { holderName: typeof out.parsed?.holderName === 'string' ? out.parsed.holderName.trim() : '', extractedData: {} };
    applyHufSuffixIfApplicable(record, `${out.parsed?.title || ''} ${files.map((f) => f.fileName || '').join(' ')}`);

    return {
      moduleKey,
      documentKey,
      title: typeof out.parsed?.title === 'string' ? out.parsed.title.trim() : '',
      holderName: record.holderName || '',
      // Read by executeTenantWithRotation for per-tenant usage accounting —
      // both attempts' worth when there were two.
      promptTokens,
      completionTokens,
    };
  }, userId, companyId);

  return result;
}

/**
 * Perform AI analysis for a specific category, providing a summary and item-level insights.
 */
export async function generateCategoryAnalysis(category, categoryData, tenantId, userId, /** @type {string | null} */ companyId = null) {
  const profile = getAIProfile(category);
  try {
    const systemPrompt = `You are a professional financial planner and risk analyst assistant for a records vault SaaS platform called DocsNX.
You are analyzing the user's data for category: ${profile.name} (${category.toUpperCase()}).
Mandatory Analytical Focus Areas:
${profile.analyticalCapabilities.map(cap => `- ${cap}`).join('\n')}

CRITICAL INSTRUCTION: Your output MUST be extremely concise ("blink of an eye" readability). Use ultra-short bullet points. No long paragraphs. No conversational filler.

You must return the result strictly in valid JSON format matching this schema:
{
  "summary": "Exactly ONE sentence TL;DR overview of the health and status of these records focusing on the mandatory focus areas.",
  "recommendations": [
    "Max 10 words. Actionable tip 1",
    "Max 10 words. Actionable tip 2"
  ],
  "itemsAnalysis": [
    {
      "itemTitle": "Name of the specific record/item",
      "insights": "Max 10 words. Specific risk or status.",
      "actionRequired": "Max 10 words. Recommended action to take, or 'None'"
    }
  ]
}

Return only the raw JSON. Do not wrap in markdown code blocks.`;

    const userPrompt = `Here is the data for the ${category} category:
${JSON.stringify(prepareAiPayload(categoryData).sanitizedData, null, 2)}

Please perform the analysis.`;

    const result = await executeTenantWithRotation(tenantId, 'CATEGORY_ANALYSIS', async (clientInfo) => {
      const contents = [systemPrompt, userPrompt];
      const res = await generateContent(clientInfo, contents);
      const parsed = JSON.parse(stripMarkdownJson(res.text));
      return {
        ...parsed,
        disclaimer: profile.mandatoryDisclaimer,
        promptTokens: res.promptTokens,
        completionTokens: res.completionTokens
      };
    }, userId, companyId);

    return result;
  } catch (error) {
    console.error(`AI category analysis error for ${category}:`, error);
    // Rethrown, not returned as a placeholder. `/api/analysis` cached the
    // placeholder as though it were an answer and served "Analysis failed" —
    // over the top of the last good analysis — until someone forced a refresh.
    // Its catch already turns a classified error into a message and a status.
    throw error;
  }
}

/**
 * Perform AI portfolio analysis for gaps, investment health, critical expiries, and recommendations.
 */
export async function generatePortfolioAnalysis(portfolioData, tenantId, userId, /** @type {string | null} */ companyId = null) {
  try {
    const systemPrompt = `You are a professional financial planner and risk analyst assistant for a records vault SaaS platform called DocsNX.
Analyze the user's workspace portfolio data (medical records, investments, insurance policies, documents, vehicles, warranties, contract agreements).

CRITICAL INSTRUCTION: Your output MUST be extremely concise ("blink of an eye" readability). Use ultra-short bullet points. No long paragraphs. No conversational filler.

You must return the result strictly in valid JSON format matching this schema:
{
  "gaps": [
    {
      "title": "Short title (e.g. Missing Health Insurance)",
      "severity": "high" | "medium" | "low",
      "description": "Max 10 words. Clear explanation of the gap/risk."
    }
  ],
  "investments": [
    {
      "title": "Investment name",
      "issue": "Max 5 words. Brief issue (e.g. Stagnant returns)",
      "impact": "Max 5 words. Financial impact (e.g. 0% returns)",
      "suggestion": "Max 10 words. Recommended action (e.g. Reallocate to index funds)"
    }
  ],
  "expiry": [
    {
      "item": "Item name (e.g. Honda Civic Insurance)",
      "expiryDate": "YYYY-MM-DD (or N/A)",
      "daysRemaining": number (calculated relative to today or estimated),
      "actionRequired": "Max 10 words. Action to take."
    }
  ],
  "recommendations": [
    "Max 10 words. Financial and health planning tip 1."
  ]
}

Return only the raw JSON. Do not wrap in markdown code blocks.`;

    const userPrompt = `Here is the workspace portfolio data:
${JSON.stringify(prepareAiPayload(portfolioData).sanitizedData, null, 2)}

Please perform the analysis.`;

    const result = await executeTenantWithRotation(tenantId, 'PORTFOLIO_ANALYSIS', async (clientInfo) => {
      const contents = [systemPrompt, userPrompt];
      const res = await generateContent(clientInfo, contents);
      const parsed = JSON.parse(stripMarkdownJson(res.text));
      return {
        ...parsed,
        promptTokens: res.promptTokens,
        completionTokens: res.completionTokens
      };
    }, userId, companyId);

    return result;
  } catch (error) {
    console.error('AI portfolio analysis error:', error);
    const msg = AI_ERROR_MESSAGES[error.errorCode] || AI_ERROR_MESSAGES.UNKNOWN;
    return {
      error: msg,
      gaps: [],
      investments: [],
      expiry: [],
      recommendations: []
    };
  }
}

/**
 * Generate a dynamic fallback analysis when AI is not configured or fails.
 */
function getMockPortfolioAnalysis(portfolioData) {
  const gaps = [];
  const investmentsList = [];
  const expiryList = [];
  const recommendations = [];

  const {
    medicalRecords = [],
    investments = [],
    licMediclaims = [],
    documents = [],
    vehicles = [],
    warrantyAmcs = [],
    contractAgreements = []
  } = portfolioData || {};

  const today = new Date();

  // 1. Gaps analysis
  const hasMediclaim = licMediclaims.some(p => p.policyType === 'mediclaim');
  if (!hasMediclaim) {
    gaps.push({
      title: "Missing Health Insurance",
      severity: "high",
      description: "No mediclaim found. Buy health insurance for your members immediately."
    });
  }

  const licPolicies = licMediclaims.filter(p => p.policyType === 'lic');
  const totalSumAssured = licPolicies.reduce((sum, p) => sum + Number(p.sumAssured || 0), 0);
  if (licPolicies.length > 0 && totalSumAssured < 50000) {
    gaps.push({
      title: "Low Life Insurance",
      severity: "high",
      description: `Sum assured is very low. Target 10-15x annual expenses.`
    });
  } else if (licPolicies.length === 0) {
    gaps.push({
      title: "No Life Insurance",
      severity: "medium",
      description: "No LIC found. Secure term insurance for dependants."
    });
  }

  const uploadedDocTitles = documents.map(d => (d.title || '').toLowerCase());
  const missingCore = [];
  if (!uploadedDocTitles.some(t => t.includes('aadhaar'))) missingCore.push('Aadhaar Card');
  if (!uploadedDocTitles.some(t => t.includes('pan'))) missingCore.push('PAN Card');
  if (!uploadedDocTitles.some(t => t.includes('passport'))) missingCore.push('Passport');

  if (missingCore.length > 0) {
    gaps.push({
      title: "Missing Core Docs",
      severity: "medium",
      description: `Upload missing: ${missingCore.join(', ')}.`
    });
  }

  // 2. Investment Health Insights
  for (const inv of investments) {
    const purchase = Number(inv.purchaseValue || 0);
    const current = Number(inv.currentValue || 0);
    if (purchase > 0) {
      const profitLossPercent = ((current - purchase) / purchase) * 100;
      if (profitLossPercent <= -50) {
        investmentsList.push({
          title: inv.title,
          issue: "Capital Erosion",
          impact: `${Math.abs(profitLossPercent).toFixed(0)}% loss`,
          suggestion: "Evaluate cutting losses and reallocating."
        });
      } else if (profitLossPercent === 0) {
        investmentsList.push({
          title: inv.title,
          issue: "Stagnant Return",
          impact: "0.0% return",
          suggestion: "Review performance vs inflation. Reallocate if needed."
        });
      }
    }
  }

  // 3. Critical Expiry Alerts
  const formatExpiryDate = (d) => {
    try {
      return new Date(d).toISOString().split('T')[0];
    } catch (e) {
      return 'N/A';
    }
  };

  // Vehicles
  for (const vehicle of vehicles) {
    if (vehicle.insuranceExpiry) {
      const insExp = new Date(vehicle.insuranceExpiry);
      const diffTime = insExp - today;
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      if (diffDays < 0 || diffDays <= 30) {
        expiryList.push({
          item: `${vehicle.vehicleName} (${vehicle.vehicleNumber}) Insurance`,
          expiryDate: formatExpiryDate(vehicle.insuranceExpiry),
          daysRemaining: diffDays,
          actionRequired: diffDays < 0 
            ? "Expired! Renew vehicle insurance immediately."
            : `Expiring soon. Schedule insurance renewal.`
        });
      }
    }

    if (vehicle.pucExpiry) {
      const pucExp = new Date(vehicle.pucExpiry);
      const diffTime = pucExp - today;
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      if (diffDays < 0 || diffDays <= 30) {
        expiryList.push({
          item: `${vehicle.vehicleName} (${vehicle.vehicleNumber}) PUC Certificate`,
          expiryDate: formatExpiryDate(vehicle.pucExpiry),
          daysRemaining: diffDays,
          actionRequired: diffDays < 0 
            ? "Expired! Get PUC done immediately."
            : `Expiring soon. Renew PUC certificate.`
        });
      }
    }
  }

  // Policies
  for (const policy of licMediclaims) {
    if (policy.premiumDueDate) {
      const due = new Date(policy.premiumDueDate);
      const diffTime = due - today;
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      if (diffDays < 0 || diffDays <= 30) {
        expiryList.push({
          item: `${policy.companyName} - ${policy.policyName} Premium Payment`,
          expiryDate: formatExpiryDate(policy.premiumDueDate),
          daysRemaining: diffDays,
          actionRequired: diffDays < 0 
            ? "Overdue! Pay immediately to prevent lapse."
            : `Premium due. Arrange payment of INR ${policy.premiumAmount}.`
        });
      }
    }
  }

  // Warranties
  for (const w of warrantyAmcs) {
    if (w.expiryDate) {
      const exp = new Date(w.expiryDate);
      const diffTime = exp - today;
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      if (diffDays < 0 || diffDays <= 30) {
        expiryList.push({
          item: `${w.applianceName} Support (${w.type})`,
          expiryDate: formatExpiryDate(w.expiryDate),
          daysRemaining: diffDays,
          actionRequired: diffDays < 0 
            ? "Expired. Review renewal options."
            : `Expiring soon. Consider AMC renewal.`
        });
      }
    }
  }

  // Agreements
  for (const c of contractAgreements) {
    if (c.endDate) {
      const exp = new Date(c.endDate);
      const diffTime = exp - today;
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      if (diffDays < 0 || diffDays <= 30) {
        expiryList.push({
          item: `${c.name} Contract (${c.type})`,
          expiryDate: formatExpiryDate(c.endDate),
          daysRemaining: diffDays,
          actionRequired: diffDays < 0 
            ? "Expired. Ensure renewal documentation is complete."
            : `Expiring soon. Initiate renewal negotiation.`
        });
      }
    }
  }

  // Recommendations
  if (!hasMediclaim) {
    recommendations.push("Buy health insurance for your members immediately to protect against emergencies.");
  }
  if (licPolicies.length > 0 && totalSumAssured < 50000) {
    recommendations.push("Increase life insurance coverage to at least 10-15x annual income.");
  }
  if (investmentsList.length > 0) {
    recommendations.push("Diversify from single stocks into stable index mutual funds.");
  }
  if (expiryList.some(e => e.item.includes('Insurance') && e.daysRemaining < 0)) {
    recommendations.push("Renew expired vehicle insurance immediately to avoid legal penalties.");
  }
  if (expiryList.some(e => e.item.includes('PUC') && e.daysRemaining < 0)) {
    recommendations.push("Renew expired vehicle PUC certificates immediately to avoid fines.");
  }
  if (missingCore.length > 0) {
    recommendations.push("Upload core documents (Aadhaar, PAN, Passport) to the vault.");
  }

  if (recommendations.length === 0) {
    recommendations.push("Ensure all members have nominee names updated.");
    recommendations.push("Review and rebalance investment portfolio semi-annually.");
    recommendations.push("Store important contacts securely in DocsNX.");
  }

  return {
    gaps,
    investments: investmentsList,
    expiry: expiryList,
    recommendations,
    promptTokens: 0,
    completionTokens: 0
  };
}

