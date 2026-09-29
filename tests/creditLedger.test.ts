import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  CREDIT_REASONS,
  AI_ACTION_TO_REASON,
  ALL_CREDIT_REASONS,
  formatCreditReason,
  creditAmountVariant,
  creditDirection,
} from '@/lib/creditLedger';

/**
 * The credit ledger's vocabulary and its two structural guarantees:
 *
 *   1. every AI action that can spend credits has a reason to be recorded under
 *      — an unmapped one would land every spend under the same label;
 *   2. the module stays client-importable, because /billing/credits renders
 *      these labels in the browser.
 */

describe('reason vocabulary', () => {
  it('keys every reason to its own value, so no two codes collide', () => {
    const values = Object.values(CREDIT_REASONS);
    expect(new Set(values).size).toBe(values.length);
    for (const [key, value] of Object.entries(CREDIT_REASONS)) {
      expect(value).toBe(key);
    }
  });

  it('gives every reason a display label', () => {
    for (const reason of ALL_CREDIT_REASONS) {
      const label = formatCreditReason(reason);
      expect(label).toBeTruthy();
      // A label that is still the raw code means the LABELS map was not updated
      // when the reason was added.
      expect(label).not.toBe(reason);
    }
  });

  it('title-cases an unknown reason rather than dropping it', () => {
    // The ledger is append-only: rows written by a future build's reason are
    // read by this one forever, so an unrecognised code must stay legible.
    expect(formatCreditReason('spend_future_action')).toBe('Future Action');
  });
});

describe('AI action mapping', () => {
  /**
   * Read from src/lib/ai.js rather than hard-coded, so adding a fifth AI action
   * fails here instead of silently filing its spends under the wrong label.
   */
  function actionNamesInAiModule(): string[] {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'ai.js'),
      'utf8',
    );
    const names = new Set<string>();
    for (const m of src.matchAll(/executeTenantWithRotation\(\s*tenantId,\s*'([A-Z_]+)'/g)) {
      names.add(m[1]);
    }
    return [...names];
  }

  it('maps every action name ai.js actually passes', () => {
    const actions = actionNamesInAiModule();
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(
        AI_ACTION_TO_REASON[action],
        `${action} has no CREDIT_REASONS entry — its spends would be mislabelled`,
      ).toBeTruthy();
    }
  });

  it('maps only to spend reasons — an AI call can never grant credits', () => {
    for (const reason of Object.values(AI_ACTION_TO_REASON)) {
      expect(reason.startsWith('spend_')).toBe(true);
    }
  });
});

describe('direction is derived from the sign', () => {
  it('reads a positive amount as a grant and a negative one as a spend', () => {
    expect(creditDirection(500)).toBe('grant');
    expect(creditDirection(-40)).toBe('spend');
    expect(creditAmountVariant(500)).toBe('success');
    expect(creditAmountVariant(-40)).toBe('secondary');
  });
});

describe('client-importability', () => {
  it('pulls in no server-only module', () => {
    // /billing/credits is a client component and imports this file. A `db` or
    // `pg` import here would drag the driver into the browser bundle — the same
    // constraint that keeps auditActions.ts separate from audit.ts.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'creditLedger.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from ['"](@\/lib\/db|\.\/db|pg|drizzle-orm)['"]/);
    expect(src).not.toMatch(/@\/db\/schema/);
  });
});
