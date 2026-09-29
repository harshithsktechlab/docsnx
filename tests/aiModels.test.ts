import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AI_MODEL_OPTIONS,
  ALL_MODEL_OPTIONS,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_MODEL,
  RETIRED_GEMINI_MODEL,
  defaultModelFor,
  getModelRates,
  thinkingConfigFor,
} from '@/lib/aiModels';

/**
 * These exist because of how gemini-2.5-flash's retirement actually played out:
 * the picker went on offering models Google had already shut down, and
 * recordTenantAiUsage went on billing one model's published rate for every
 * model in the catalogue. Both were invisible until something broke.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('model catalogue', () => {
  it('does not default to a model the provider has retired', () => {
    expect(DEFAULT_GEMINI_MODEL).not.toBe(RETIRED_GEMINI_MODEL);
  });

  it('prices every model it offers', () => {
    // The load-bearing invariant. An option with no rate silently bills the
    // fallback into tenant_ai_usages, which reads as a healthy number on the
    // billing screens and is wrong by whatever the two models differ by.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const option of ALL_MODEL_OPTIONS) {
      getModelRates(option.value);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('offers the retired model only as a labelled dead end', () => {
    const retired = AI_MODEL_OPTIONS.gemini.find((o) => o.value === RETIRED_GEMINI_MODEL);
    // Still selectable so existing rows render, but never presented as a choice.
    expect(retired?.retired).toBe(true);
    expect(AI_MODEL_OPTIONS.gemini[0].value).toBe(DEFAULT_GEMINI_MODEL);
  });

  it('picks a provider-appropriate default', () => {
    expect(defaultModelFor('openai')).toBe(DEFAULT_OPENAI_MODEL);
    expect(defaultModelFor('gemini')).toBe(DEFAULT_GEMINI_MODEL);
    // Provider is a free-text column; anything unrecognised falls to Gemini,
    // which is what buildClientFromKey does too.
    expect(defaultModelFor(null)).toBe(DEFAULT_GEMINI_MODEL);
  });
});

describe('getModelRates', () => {
  it('converts the published per-million price to a per-token rate', () => {
    // Flash-Lite is $0.25 / $1.50 per 1M.
    expect(getModelRates('gemini-3.1-flash-lite')).toEqual({
      input: 0.25 / 1_000_000,
      output: 1.5 / 1_000_000,
    });
  });

  it('does not mistake a Gemini 3 id for an OpenAI model', () => {
    // The old implementation keyed off `name.includes('gpt-3')`. It happens not
    // to fire on 'gemini-3.1-flash-lite', but that was luck, not design.
    expect(getModelRates('gemini-3.1-flash-lite')).not.toEqual(getModelRates(DEFAULT_OPENAI_MODEL));
  });

  it('warns and falls back rather than billing an unknown model at zero', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rates = getModelRates('gemini-9.9-imaginary');
    expect(rates).toEqual(getModelRates(DEFAULT_GEMINI_MODEL));
    expect(rates.input).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
  });
});

describe('thinkingConfigFor', () => {
  it('pins Gemini 3 thinking low, because every call here is extraction', () => {
    expect(thinkingConfigFor('gemini-3.1-flash-lite')).toEqual({ thinkingLevel: 'LOW' });
    expect(thinkingConfigFor('gemini-3.6-flash')).toEqual({ thinkingLevel: 'LOW' });
  });

  it('sends nothing to models that have no thinkingLevel', () => {
    expect(thinkingConfigFor(RETIRED_GEMINI_MODEL)).toBeUndefined();
    expect(thinkingConfigFor(DEFAULT_OPENAI_MODEL)).toBeUndefined();
    expect(thinkingConfigFor(null)).toBeUndefined();
  });
});
