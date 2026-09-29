/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   LINKED CARDS — the debit and credit cards that belong to one account   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `cards` is a field on `bank_investments/bank_statements_passbooks`, sealed,
 * and it was a `longtext` textarea: one box, free text, for however many cards
 * a household holds against one bank account. Nothing could be read back out of
 * it — least of all an expiry date, which is the one thing about a card that
 * needs a reminder.
 *
 * So it holds JSON now. The KEY, the data type and the `isPii` flag are all
 * unchanged — `custom_fields` has stored a JSON array under a `longtext` key
 * since 0025, and this is the same trick for the same reason: the encrypt
 * policy names a key, so a nested object would leave half the card in the clear
 * beside the sealed half.
 *
 * ── ONE CARD SHAPE, THREE WRITERS ──────────────────────────────────────────
 * A card object here is EXACTLY `/api/credit-cards`'s payload minus `cardCvv`.
 * That is not a coincidence to be tidied away later: `/bank-info` writes cards
 * into these same records, the Standalone Cards tab writes them as records of
 * their own, and the sub-category form writes them here. Three spellings of one
 * card is how a reader ends up unable to say what it is holding.
 *
 * `cardCvv` is deliberately absent. `cvv` is on `prepareAiPayload`'s forbidden
 * list AND on `NEVER_PRINTED_KEYS` (src/lib/documentCategoryFields.ts), and a
 * CVV is worth nothing without the card it is printed on. `parseLinkedCards`
 * drops one if it finds one rather than carrying it forward.
 *
 * ── WHY THIS FILE IMPORTS NOTHING ──────────────────────────────────────────
 * The same constraint ./reminderPolicy.ts is written under. The browser needs
 * `parseLinkedCards` to seed the editor and `validateLinkedCards` to mark it,
 * the route handlers need `normaliseLinkedCards` to store it, and
 * ./normalize.ts — which pulls in server-only `fieldCrypto` — needs
 * `linkedCardReminders`. A leaf module is the only thing all three can share.
 */

/** The key the cards are stored under. A real dictionary field, not a baseline one. */
export const LINKED_CARDS_KEY = 'cards';

/**
 * The taxonomy key a card's expiry reminder is filed under.
 *
 * `card_expiry` is a real key — `credit_card_statements` declares it and
 * `fieldMap.ts` maps `cardExpiry` onto it — so the lead-time chain in
 * ./reminderPolicy.ts resolves it the same way it resolves every other
 * deadline. A made-up key would silently fall through to the global default.
 */
export const CARD_EXPIRY_REMINDER_KEY = 'card_expiry';

/** What a stored card looks like. Every field optional but `id`. */
export interface LinkedCard {
  /** Stable within the record, so a reminder can name the same card twice. */
  id: string;
  /** The user's own name for it. The ONE field that reaches the open tier. */
  cardName: string;
  /** 'credit' | 'debit' — see CARD_TYPES. */
  cardType: string;
  /** 'visa' | 'mastercard' | … — see CARD_NETWORKS. */
  cardNetwork: string;
  cardHolder: string;
  cardNumber: string;
  /** `YYYY-MM`. Legacy `MM/YY` and `MM/YYYY` are read but rewritten on save. */
  cardExpiry: string;
}

/** Everything a `cards` value holds, once read. */
export interface LinkedCardsValue {
  cards: LinkedCard[];
  /**
   * Whatever was typed into the textarea this field used to be.
   *
   * Carried rather than discarded: it is the user's own writing, and a feature
   * that structures a field must not be the thing that empties it.
   */
  text: string;
}

export const CARD_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'credit', label: 'Credit' },
  { value: 'debit', label: 'Debit' },
  { value: 'prepaid', label: 'Prepaid' },
];

export const CARD_NETWORKS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'visa', label: 'Visa' },
  { value: 'mastercard', label: 'Mastercard' },
  { value: 'rupay', label: 'RuPay' },
  { value: 'amex', label: 'American Express' },
  { value: 'diners', label: 'Diners Club' },
  { value: 'other', label: 'Other' },
];

const TYPE_LABELS = new Map(CARD_TYPES.map((t) => [t.value, t.label]));
const NETWORK_LABELS = new Map(CARD_NETWORKS.map((n) => [n.value, n.label]));

/**
 * What an array of card objects became on the way into the vault.
 *
 * `storeRecordInVault` seals with `encryptField(String(value))`
 * (src/lib/vault/vaultStore.ts), and `String([{…}])` is this. Every card ever
 * added through `/bank-info` was destroyed at write time and read back as this
 * string, which is why that page's card list was always empty.
 *
 * Recognised HERE rather than left to look like free text, because carrying it
 * forward as the user's own writing — which is what the `text` fallback would
 * otherwise do — would paste "[object Object]" into a box and ask them to keep
 * it. The values behind it are unrecoverable; the least we can do is not
 * pretend they are content.
 */
const CORRUPTION_MARKER = /^(\[object Object\](,\s*)?)+$/;

function str(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** Ids only have to be unique within one record, and only for the UI's benefit. */
let counter = 0;
function nextId(): string {
  counter += 1;
  return `c${Date.now().toString(36)}${counter.toString(36)}`;
}

/**
 * One card object, from whatever shape it arrived in.
 *
 * The legacy 4-key card (`cardHolder`/`cardNumber`/`cardExpiry`/`cardCvv`,
 * written by /bank-info) is simply a card missing three fields, so it needs no
 * branch — `cardCvv` is not read, which is how it is dropped.
 *
 * ── A BLANK CARD IS KEPT HERE AND DROPPED AT `normaliseLinkedCards` ────────
 * Reading is what an editor seeds from, and the row a user has just created by
 * clicking "Add card" is blank by definition. The bulk-scan grid holds its
 * whole state as the stored STRING and re-parses it on every keystroke, so a
 * reader that discarded blanks would delete that row before the first
 * character could be typed into it. Dropping them belongs on the WRITE side,
 * which runs once, at save.
 *
 * Null only for a value that is not a card-shaped object at all.
 */
function toCard(raw: unknown): LinkedCard | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;

  return {
    id: str(row.id) || nextId(),
    cardName: str(row.cardName),
    cardType: str(row.cardType).toLowerCase(),
    cardNetwork: str(row.cardNetwork).toLowerCase(),
    cardHolder: str(row.cardHolder),
    cardNumber: str(row.cardNumber),
    cardExpiry: normaliseExpiry(str(row.cardExpiry)),
  };
}

/** A card nobody filled anything into. Its `id` alone is not content. */
export function isCardBlank(card: LinkedCard): boolean {
  return !card.cardName && !card.cardType && !card.cardNetwork
    && !card.cardHolder && !card.cardNumber && !card.cardExpiry;
}

/**
 * A stored `cards` value, read leniently.
 *
 * Four shapes reach this, and all four are real:
 *   · `{ cards: [...], text }`  what this module writes.
 *   · `[ {...} ]`               what /bank-info MEANT to write, and what a
 *                               hand-edited store or a restored backup holds.
 *   · `"[object Object]"`       what /bank-info actually wrote. Read as empty.
 *   · any other string          what the textarea this field used to be
 *                               produced. Kept verbatim as `text`.
 *
 * Never throws. A malformed value costs the cards, not the form.
 */
export function parseLinkedCards(raw: unknown): LinkedCardsValue {
  const empty: LinkedCardsValue = { cards: [], text: '' };
  if (raw === null || raw === undefined) return empty;

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') return empty;
    if (CORRUPTION_MARKER.test(text)) return empty;
    if (!text.startsWith('{') && !text.startsWith('[')) return { cards: [], text };
    try {
      parsed = JSON.parse(text);
    } catch {
      // Free text that happens to open with a brace. Still the user's writing.
      return { cards: [], text };
    }
  }

  if (Array.isArray(parsed)) {
    return { cards: parsed.map(toCard).filter((c): c is LinkedCard => c !== null), text: '' };
  }

  if (parsed && typeof parsed === 'object') {
    const box = parsed as Record<string, unknown>;
    const list = Array.isArray(box.cards) ? box.cards : [];
    return {
      cards: list.map(toCard).filter((c): c is LinkedCard => c !== null),
      text: str(box.text),
    };
  }

  return empty;
}

/**
 * The storage form: JSON text, or null when there is nothing to store.
 *
 * Null rather than `'{"cards":[]}'` so the caller omits the key entirely —
 * `splitRecordFields` skips an absent key, and sealing an empty box would
 * produce ciphertext that decrypts to "the user filled this in and cleared it",
 * which is not what happened. Mirrors `normaliseCustomFields`.
 */
export function normaliseLinkedCards(raw: unknown): string | null {
  const { cards, text } = parseLinkedCards(raw);
  // The write side is where a card nobody filled in stops existing — see the
  // note on `toCard` for why the read side keeps it.
  const filled = cards.filter((card) => !isCardBlank(card));
  if (filled.length === 0 && text === '') return null;
  return JSON.stringify(text ? { cards: filled, text } : { cards: filled });
}

/**
 * `MM/YY`, `MM/YYYY` and `YYYY-MM` → `YYYY-MM`. Anything else → ''.
 *
 * Two-digit years are read as 2000-2099. A card issued in 1998 is long expired
 * and a card expiring in 2100 does not exist, so the window costs nothing and
 * the alternative — a sliding pivot — would silently reinterpret stored values
 * as the years went by.
 */
export function normaliseExpiry(value: string): string {
  const text = value.trim();
  if (text === '') return '';

  const iso = /^(\d{4})-(\d{1,2})$/.exec(text);
  if (iso) {
    const month = Number(iso[2]);
    if (month < 1 || month > 12) return '';
    return `${iso[1]}-${String(month).padStart(2, '0')}`;
  }

  const slash = /^(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})$/.exec(text);
  if (slash) {
    const month = Number(slash[1]);
    if (month < 1 || month > 12) return '';
    const year = slash[2].length === 2 ? 2000 + Number(slash[2]) : Number(slash[2]);
    return `${year}-${String(month).padStart(2, '0')}`;
  }

  return '';
}

/**
 * The DAY a card stops working, as an ISO string — or null.
 *
 * The LAST day of the expiry month, not the first. A card marked 09/29 is good
 * through 30 September 2029; filing the reminder on the 1st would call it
 * overdue for a month it is still usable in.
 */
export function cardExpiryDate(value: unknown): string | null {
  const month = normaliseExpiry(str(value));
  if (month === '') return null;
  const [year, mon] = month.split('-').map(Number);
  // Day 0 of the NEXT month is the last day of this one, leap years included.
  const date = new Date(Date.UTC(year, mon, 0));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * What a follow-up card calls this card.
 *
 * ── THIS STRING LEAVES THE SEALED TIER ─────────────────────────────────────
 * A reminder lives in the OPEN tier — it is read back from the store by the
 * follow-up builder, shipped to the browser with every list read, and written
 * to Drive in the clear. So this must never contain the card number or its last
 * four digits: `credit_card_statements` seals `card_last_four` precisely
 * because issuer plus last four narrows a card, and a reminder label would
 * undo that from the side.
 *
 * What it may contain, in order of how much it tells the reader:
 *   1. the NICKNAME. The user's own name for the card, and the direct analogue
 *      of `cardName`, which fieldMap.ts already maps onto `document_title` — an
 *      `isPii: false` key. The editor says out loud that it is shown here.
 *   2. NETWORK and TYPE. Both are `isPii: false` in the dictionary already.
 *   3. the POSITION. Tells the reader nothing, and leaks nothing, and is
 *      better than an unlabelled date.
 */
export function cardReminderLabel(card: LinkedCard, index: number): string {
  if (card.cardName) return `${card.cardName} Card Expiry`;

  const network = NETWORK_LABELS.get(card.cardNetwork) ?? '';
  const type = TYPE_LABELS.get(card.cardType) ?? '';
  const described = [network, type].filter(Boolean).join(' ');
  if (described) return `${described} Card Expiry`;

  return `Card ${index + 1} Expiry`;
}

/** The reminder shape, restated structurally so this file keeps its no-imports rule. */
export interface CardReminder {
  key: string;
  label: string;
  date: string;
  resolved: boolean;
  slot: string;
}

/**
 * One reminder per card that carries a readable expiry.
 *
 * `slot` is what keeps three cards on one account three separate follow-ups:
 * the item id is `${moduleKey}-${key}-${recordId}` (./followUps.ts) and that id
 * is the notification dedupe key, so without it the second and third cards
 * would be silently swallowed as duplicates of the first.
 */
export function linkedCardReminders(raw: unknown, resolved: boolean): CardReminder[] {
  // Blanks filtered so "Card 2" counts the cards a reader can see. It reads the
  // STORED value, which `normaliseLinkedCards` has already cleaned — this is
  // for the one caller that reaches here with an editor's in-progress state.
  const cards = parseLinkedCards(raw).cards.filter((card) => !isCardBlank(card));
  const out: CardReminder[] = [];

  cards.forEach((card, index) => {
    const date = cardExpiryDate(card.cardExpiry);
    if (!date) return;
    out.push({
      key: CARD_EXPIRY_REMINDER_KEY,
      label: cardReminderLabel(card, index),
      date,
      resolved,
      // The card's own id where it has one, so the follow-up for a card keeps
      // its identity when another card is deleted from the list above it.
      slot: card.id || String(index),
    });
  });

  return out;
}

/**
 * Card-level messages, keyed `cards[<index>].<field>`.
 *
 * Deliberately forgiving, per fieldValidation.ts's own rule: when a rule and
 * reality disagree, reality is right. A card number is judged only on its digit
 * count, and only when one was typed at all — nothing here is required, because
 * a household recording "the blue debit card, expires next March" and nothing
 * else is recording something true.
 */
export function validateLinkedCards(raw: unknown): Record<string, string> {
  const { cards } = parseLinkedCards(raw);
  const errors: Record<string, string> = {};

  cards.forEach((card, index) => {
    if (card.cardNumber) {
      const digits = card.cardNumber.replace(/[\s-]/g, '');
      if (!/^\d+$/.test(digits)) {
        errors[`cards[${index}].cardNumber`] = 'Card number can only contain digits';
      } else if (digits.length < 12 || digits.length > 19) {
        errors[`cards[${index}].cardNumber`] = 'Card number must be 12 to 19 digits';
      }
    }
    // `parseLinkedCards` blanks an expiry it could not read, so an unreadable
    // one is indistinguishable here from one nobody typed. The editor's own
    // month input is what stops a bad value being entered; this catches what
    // arrives from anywhere else.
  });

  return errors;
}

/**
 * The single message the form shows for the whole field.
 *
 * `fieldErrors` is keyed by fieldKey and rendered against one input, and the
 * card rows are not inputs the error map can reach. So the per-card messages
 * above are collapsed into one sentence filed under `cards`, naming the card
 * that needs fixing. Null when every card is fine.
 */
export function linkedCardsError(raw: unknown): string | null {
  const errors = validateLinkedCards(raw);
  const keys = Object.keys(errors);
  if (keys.length === 0) return null;
  const first = keys[0];
  const index = Number(/^cards\[(\d+)\]/.exec(first)?.[1] ?? 0);
  return `Card ${index + 1}: ${errors[first]}`;
}
