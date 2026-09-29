/**
 * The linked cards on a bank account: what a stored `cards` value can be, what
 * it becomes on the way back out, and which renewals it raises.
 *
 * The corruption case is the reason several of these exist. `cards` is a sealed
 * key and the seal step is `encryptField(String(value))`, so the ARRAY the
 * /bank-info page posted was stored as the literal "[object Object]" and every
 * card added there was destroyed at write time. Nothing caught it because
 * nothing asserted the round trip.
 */
import { describe, it, expect, vi } from 'vitest';

/**
 * ── THE MOCKS THE FOLLOW-UP SUITE AT THE FOOT OF THIS FILE NEEDS ───────────
 *
 * `remindersForCategory` reads the category's store off Drive and its spec out
 * of Postgres. Hoisted here because `vi.mock` is, and kept to the three seams
 * tests/followUps.test.ts already mocks so the two files agree about what a
 * reminder pass talks to.
 */
const readJsonStore = vi.fn();
vi.mock('@/lib/vault/vaultRecords', () => ({
  readJsonStore: (...a: any[]) => readJsonStore(...a),
}));
vi.mock('@/lib/db', () => ({ db: {}, withTenant: vi.fn() }));
vi.mock('@/lib/records/categorySpec', () => ({
  loadCategoryFieldSpec: vi.fn(async () => []),
}));
vi.mock('@/lib/auth', () => ({
  hasPermission: vi.fn(async () => true),
  hasCompanyAccess: vi.fn(async () => true),
}));

const { remindersForCategory } = await import('@/lib/records/followUps');
const { dedupeKeyFor } = await import('@/lib/followUpNotifications');

import {
  CARD_EXPIRY_REMINDER_KEY,
  cardExpiryDate,
  cardReminderLabel,
  linkedCardReminders,
  linkedCardsError,
  normaliseExpiry,
  normaliseLinkedCards,
  parseLinkedCards,
} from '@/lib/records/linkedCards';

const card = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  cardName: 'HDFC Regalia',
  cardType: 'credit',
  cardNetwork: 'visa',
  cardHolder: 'ARJUN SHARMA',
  cardNumber: '4111111111111111',
  cardExpiry: '2029-09',
  ...over,
});

describe('parseLinkedCards — every shape this field has ever held', () => {
  it('reads what normaliseLinkedCards writes', () => {
    const stored = normaliseLinkedCards({ cards: [card()], text: '' });
    expect(parseLinkedCards(stored).cards[0]).toMatchObject({
      cardName: 'HDFC Regalia', cardType: 'credit', cardExpiry: '2029-09',
    });
  });

  it('reads the bare array /bank-info meant to write', () => {
    const { cards } = parseLinkedCards([card(), card({ id: 'c2', cardName: 'SBI' })]);
    expect(cards.map((c) => c.cardName)).toEqual(['HDFC Regalia', 'SBI']);
  });

  it('reads a legacy card with only the four keys the old page collected', () => {
    const { cards } = parseLinkedCards([
      { cardHolder: 'PRIYA N', cardNumber: '5100000000000000', cardExpiry: '03/28', cardCvv: '123' },
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].cardHolder).toBe('PRIYA N');
    expect(cards[0].cardExpiry).toBe('2028-03');
    // The CVV is not carried forward — it is not a field this shape has.
    expect(Object.keys(cards[0])).not.toContain('cardCvv');
    expect(JSON.stringify(cards[0])).not.toContain('123');
  });

  it('reads "[object Object]" as empty rather than as the user’s own writing', () => {
    expect(parseLinkedCards('[object Object]')).toEqual({ cards: [], text: '' });
    expect(parseLinkedCards('[object Object],[object Object]').text).toBe('');
  });

  it('keeps free text typed into the textarea this field used to be', () => {
    const value = parseLinkedCards('two debit cards, both HDFC');
    expect(value.cards).toEqual([]);
    expect(value.text).toBe('two debit cards, both HDFC');
  });

  it('never throws on a malformed value', () => {
    expect(parseLinkedCards('{not json').text).toBe('{not json');
    expect(parseLinkedCards(null)).toEqual({ cards: [], text: '' });
    expect(parseLinkedCards(42)).toEqual({ cards: [], text: '' });
  });

  /**
   * The bulk-scan grid holds its whole state as the stored STRING and reparses
   * it on every keystroke. A reader that dropped blanks would delete the row
   * "Add card" had just created, before a character could be typed into it.
   */
  it('keeps a blank card on the way in, and drops it on the way out', () => {
    const blank = { id: 'c9', cardName: '', cardType: '', cardNetwork: '', cardHolder: '', cardNumber: '', cardExpiry: '' };
    expect(parseLinkedCards({ cards: [blank] }).cards).toHaveLength(1);
    expect(normaliseLinkedCards({ cards: [blank], text: '' })).toBeNull();
  });
});

describe('normaliseLinkedCards — the storage form', () => {
  it('is a STRING, so the seal step cannot destroy it', () => {
    const stored = normaliseLinkedCards([card()]);
    expect(typeof stored).toBe('string');
    // The exact coercion `storeRecordInVault` applies before encrypting.
    expect(String(stored)).not.toContain('[object Object]');
  });

  it('answers null when there is nothing to store, so the key is omitted', () => {
    expect(normaliseLinkedCards(null)).toBeNull();
    expect(normaliseLinkedCards('')).toBeNull();
    expect(normaliseLinkedCards({ cards: [], text: '' })).toBeNull();
    expect(normaliseLinkedCards('[object Object]')).toBeNull();
  });

  it('round-trips without drift', () => {
    const once = normaliseLinkedCards([card()]);
    expect(normaliseLinkedCards(once)).toBe(once);
  });
});

describe('normaliseExpiry / cardExpiryDate', () => {
  it('reads the three spellings a card expiry arrives in', () => {
    expect(normaliseExpiry('2029-09')).toBe('2029-09');
    expect(normaliseExpiry('09/29')).toBe('2029-09');
    expect(normaliseExpiry('9/2029')).toBe('2029-09');
  });

  it('refuses a month that is not one', () => {
    expect(normaliseExpiry('13/29')).toBe('');
    expect(normaliseExpiry('2029-00')).toBe('');
    expect(normaliseExpiry('next march')).toBe('');
    expect(cardExpiryDate('garbage')).toBeNull();
  });

  /**
   * A card marked 09/29 works through 30 September. Filing the reminder on the
   * 1st would call it overdue for a month it is still usable in.
   */
  it('is the LAST day of the expiry month', () => {
    expect(cardExpiryDate('09/29')).toBe(new Date(Date.UTC(2029, 8, 30)).toISOString());
    expect(cardExpiryDate('02/28')).toBe(new Date(Date.UTC(2028, 1, 29)).toISOString());
  });
});

describe('cardReminderLabel — what reaches the OPEN tier', () => {
  it('prefers the nickname the editor says is shown in reminders', () => {
    expect(cardReminderLabel(card(), 0)).toBe('HDFC Regalia Card Expiry');
  });

  it('falls back to network and type, both isPii:false in the dictionary', () => {
    expect(cardReminderLabel(card({ cardName: '' }), 0)).toBe('Visa Credit Card Expiry');
  });

  it('falls back to the position, which leaks nothing at all', () => {
    const bare = card({ cardName: '', cardNetwork: '', cardType: '' });
    expect(cardReminderLabel(bare, 1)).toBe('Card 2 Expiry');
  });

  /**
   * The guard that matters. A reminder label is stored unencrypted, shipped to
   * the browser with every list read and written to Drive in the clear —
   * `card_last_four` is sealed everywhere else precisely because issuer plus
   * last four narrows a card, and a label must not undo that from the side.
   */
  it('never carries a run of digits from the card number', () => {
    const labels = [
      cardReminderLabel(card(), 0),
      cardReminderLabel(card({ cardName: '' }), 0),
      cardReminderLabel(card({ cardName: '', cardNetwork: '', cardType: '' }), 3),
    ];
    for (const label of labels) {
      expect(label).not.toMatch(/\d{4}/);
      expect(label).not.toContain('1111');
    }
  });
});

describe('linkedCardReminders', () => {
  it('raises one reminder per card, each under the real taxonomy key', () => {
    const reminders = linkedCardReminders(
      [card(), card({ id: 'c2', cardName: 'SBI Debit', cardExpiry: '06/27' })],
      false,
    );
    expect(reminders).toHaveLength(2);
    expect(reminders.every((r) => r.key === CARD_EXPIRY_REMINDER_KEY)).toBe(true);
    expect(reminders.map((r) => r.label))
      .toEqual(['HDFC Regalia Card Expiry', 'SBI Debit Card Expiry']);
  });

  /**
   * `slot` is what keeps three cards on one account three follow-ups. The item
   * id is `${moduleKey}-${key}-${recordId}[-${slot}]` and that id is the
   * notification dedupe key, so equal slots mean two cards silently swallowed.
   */
  it('gives every card a distinct slot', () => {
    const reminders = linkedCardReminders([card(), card({ id: 'c2', cardExpiry: '06/27' })], false);
    expect(new Set(reminders.map((r) => r.slot)).size).toBe(2);
  });

  it('raises nothing for a card with no readable expiry', () => {
    expect(linkedCardReminders([card({ cardExpiry: '' })], false)).toEqual([]);
    expect(linkedCardReminders('two debit cards, both HDFC', false)).toEqual([]);
    expect(linkedCardReminders('[object Object]', false)).toEqual([]);
  });

  it('carries the record’s resolved flag through', () => {
    expect(linkedCardReminders([card()], true)[0].resolved).toBe(true);
  });
});

describe('linkedCardsError', () => {
  it('passes a card number of a plausible length', () => {
    expect(linkedCardsError([card()])).toBeNull();
  });

  it('names the card that needs fixing, counting from one', () => {
    const bad = [card(), card({ id: 'c2', cardNumber: '4111' })];
    expect(linkedCardsError(bad)).toBe('Card 2: Card number must be 12 to 19 digits');
  });

  it('does not argue with a card nobody finished typing', () => {
    expect(linkedCardsError([card({ cardNumber: '' })])).toBeNull();
  });

  it('accepts the spacing people actually type', () => {
    expect(linkedCardsError([card({ cardNumber: '4111 1111 1111 1111' })])).toBeNull();
  });
});

/**
 * ── THE WIRING ─────────────────────────────────────────────────────────────
 *
 * The helpers above are only useful if the two write paths actually call them
 * and the follow-up builder actually distinguishes what comes back. Both
 * paths write the same field of the same record, so a reminder derived from
 * only one of them would depend on which page the user was standing on.
 */
describe('the write paths emit the card reminders', () => {
  const CARDS = normaliseLinkedCards([card(), card({ id: 'c2', cardName: 'SBI Debit', cardExpiry: '06/27' })]);

  it('the taxonomy path — the sub-category form, uploads and the scan grid', async () => {
    const { toTaxonomyRecordFromFields } = await import('@/lib/records/normalize');
    const specs = [
      { fieldKey: 'bank_name', fieldLabel: 'Bank Name', dataType: 'text', isPii: false },
      { fieldKey: 'cards', fieldLabel: 'Linked Cards', dataType: 'longtext', isPii: true },
    ];
    const out = toTaxonomyRecordFromFields(specs as any, { bank_name: 'HDFC', cards: CARDS });

    expect(out.reminders).toHaveLength(2);
    expect(out.reminders.every((r) => r.key === CARD_EXPIRY_REMINDER_KEY)).toBe(true);
    // The earliest unresolved date drives the follow-up query.
    expect(out.nextDueAt).toBe(cardExpiryDate('06/27'));
  });

  it('the legacy path — /api/bank-info', async () => {
    const { toTaxonomyRecord } = await import('@/lib/records/normalize');
    const key = { moduleKey: 'bank_investments', documentKey: 'bank_statements_passbooks' };
    const out = toTaxonomyRecord('bank_info', key as any, { bankName: 'HDFC', cards: CARDS });

    expect(out.reminders).toHaveLength(2);
    expect(out.reminders.map((r) => r.label))
      .toEqual(['HDFC Regalia Card Expiry', 'SBI Debit Card Expiry']);
  });

  it('the category is told it carries a deadline, so it renders "Alert me before"', async () => {
    const { categoryRaisesReminder } = await import('@/lib/records/reminderPolicy');
    // No date field at all — a bank account has none — and still a deadline.
    expect(categoryRaisesReminder([
      { fieldKey: 'account_number', dataType: 'text' },
      { fieldKey: 'cards', dataType: 'longtext' },
    ])).toBe(true);
    expect(categoryRaisesReminder([{ fieldKey: 'account_number', dataType: 'text' }])).toBe(false);
  });

  it('a card expiry asks for the issuer-in-the-loop window, not the global default', async () => {
    const { ALERT_DAYS_BY_KEY, alertLeadDays } = await import('@/lib/records/reminderPolicy');
    expect(ALERT_DAYS_BY_KEY[CARD_EXPIRY_REMINDER_KEY]).toBe(30);
    expect(alertLeadDays({ fieldKey: CARD_EXPIRY_REMINDER_KEY })).toBe(30);
  });
});

/**
 * ── ONE FOLLOW-UP PER CARD, NOT ONE PER FIELD ──────────────────────────────
 *
 * A follow-up's id is the notification dedupe key
 * (src/lib/followUpNotifications.ts), and until `slot` existed every card on
 * one account produced the same one: `${moduleKey}-${fieldKey}-${recordId}`.
 * Three cards would have meant one row on the page and one buzz — which looks
 * exactly like the feature working.
 */
describe('every card is its own follow-up', () => {
  const KEY = { moduleKey: 'bank_investments', documentKey: 'bank_statements_passbooks' };
  const ROWS = [{ id: 'r1', title: 'HDFC Savings' }];
  const USER = { id: 'u1', tenantId: 't1', tenant: { id: 't1' } };

  /** Cards expiring in `days`, as `linkedCardReminders` would have written them. */
  function accountWith(...cards: Array<{ name: string; days: number }>) {
    return {
      name: 'HDFC Savings',
      reminders: cards.map(({ name, days }, i) => {
        const due = new Date();
        due.setDate(due.getDate() + days);
        return {
          key: CARD_EXPIRY_REMINDER_KEY,
          label: `${name} Card Expiry`,
          date: due.toISOString(),
          resolved: false,
          slot: `c${i + 1}`,
        };
      }),
    };
  }

  it('keeps three cards on one account three separate items', async () => {
    readJsonStore.mockResolvedValue({
      store: {
        records: {
          r1: accountWith(
            { name: 'HDFC Regalia', days: 10 },
            { name: 'SBI Debit', days: 12 },
            { name: 'Amex Gold', days: 14 },
          ),
        },
      },
    });

    const items = await remindersForCategory(USER as any, KEY as any, ROWS);
    expect(items).toHaveLength(3);
    expect(new Set(items.map((i: any) => i.id)).size).toBe(3);
    expect(items.map((i: any) => i.recordTitle)).toEqual(
      ['HDFC Savings', 'HDFC Savings', 'HDFC Savings'],
    );
    expect(items.map((i: any) => i.title)).toEqual([
      'HDFC Regalia Card Expiry Due', 'SBI Debit Card Expiry Due', 'Amex Gold Card Expiry Due',
    ]);
  });

  it('gives each of them its own notification dedupe key', async () => {
    readJsonStore.mockResolvedValue({
      store: { records: { r1: accountWith({ name: 'A', days: 10 }, { name: 'B', days: 12 }) } },
    });
    const items = await remindersForCategory(USER as any, KEY as any, ROWS);
    const keys = items.map((i: any) => dedupeKeyFor(i, 'first' as any));
    expect(new Set(keys).size).toBe(2);
  });

  /**
   * The other direction, and the reason `slot` is APPENDED rather than
   * substituted: every reminder in the app that has no slot must keep the id it
   * has always had, or the first pass after this change re-notifies every open
   * reminder in every tenant once.
   */
  it('leaves an ordinary date reminder’s id exactly as it was', async () => {
    const due = new Date();
    due.setDate(due.getDate() + 10);
    readJsonStore.mockResolvedValue({
      store: {
        records: {
          r1: {
            name: 'HDFC Savings',
            reminders: [{ key: 'valid_to', label: 'Insurance', date: due.toISOString(), resolved: false }],
          },
        },
      },
    });
    const [item] = await remindersForCategory(USER as any, KEY as any, ROWS);
    expect(item.id).toBe('bank_investments-valid_to-r1');
  });

  it('uses the 30-day card window rather than the global default', async () => {
    // 25 days out: inside `card_expiry`'s own lead, outside the old constant 15.
    readJsonStore.mockResolvedValue({
      store: { records: { r1: accountWith({ name: 'HDFC Regalia', days: 25 }) } },
    });
    const [item] = await remindersForCategory(USER as any, KEY as any, ROWS);
    expect(item.alertWindowDays).toBe(30);
  });
});

/**
 * ── THE PRIVACY SHIELD STILL REFUSES TO CARRY THE BLOB ─────────────────────
 *
 * `cards` was a `longtext` textarea when `prepareAiPayload` was written; it is
 * structured JSON now, and this is the assertion that the change did not turn
 * a stripped key into a payload full of card numbers. The masker matches on the
 * KEY, so it holds whatever the value became — but nothing said so.
 */
describe('prepareAiPayload and the linked cards', () => {
  it('strips the key, whatever it now holds', async () => {
    const { prepareAiPayload } = await import('@/lib/aiPrivacyMasker');
    const cards = normaliseLinkedCards([card()]);
    const { sanitizedData } = prepareAiPayload({ bank_name: 'HDFC', cards });

    expect(sanitizedData.cards).toBeUndefined();
    expect(JSON.stringify(sanitizedData)).not.toContain('4111');
    expect(JSON.stringify(sanitizedData)).not.toContain('HDFC Regalia');
    // and the open, non-identifying half still reaches the model
    expect(sanitizedData.bank_name).toBe('HDFC');
  });
});
