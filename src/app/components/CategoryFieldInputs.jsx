'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE SPEC-DRIVEN INPUTS, RENDERED THE SAME WAY WHEREVER THEY APPEAR     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A sub-category's field spec (`GET /api/modules/:m/:d/fields`) turned into
 * inputs. Two forms render the same list and must not drift:
 *
 *   · CategoryRecordForm — the add/edit dialog on /modules/<module>/<sub>,
 *     where the category is fixed by the URL.
 *   · The Documents Manager's upload form, where the category is picked in the
 *     form and the spec is fetched when it changes.
 *
 * Purely presentational: it owns no state. The caller holds `values`, `errors`,
 * `touched` and `aiFilled` and passes them down, because both callers already
 * hold them for their own submit and autofill logic — duplicating that state
 * inside here would give each field two ideas of what it contains.
 *
 * ── WHAT THE MARKUP HAS TO SAY ─────────────────────────────────────────────
 * A field is not just an input. Three things are carried by every one of them,
 * and losing any of them in a refactor is a real regression:
 *   · the lock, on `isPii` — the user is told which values are encrypted;
 *   · the AI badge, on a value nobody typed — a suggestion that looks like a
 *     typed value is a suggestion nobody checks;
 *   · `registerRef`, so the caller can scroll to and focus the first error. A
 *     message under a field below the fold changes nothing the user can see.
 */
import { CreditCard, Lock, Plus, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup } from '@/components/ui/radio-group';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  CUSTOM_FIELDS_KEY, FORM_HIDDEN_KEYS, formFields, parseMultiValue,
} from '@/lib/records/fieldValidation';
import {
  CARD_NETWORKS, CARD_TYPES, LINKED_CARDS_KEY, normaliseExpiry,
} from '@/lib/records/linkedCards';

/** The title field is rendered first and drives the record's name. */
export const TITLE_KEY = 'document_title';

/**
 * The two keys no form renders — `holder_name` (the "Belongs to" picker answers
 * it) and `custom_fields` (rendered as label/value rows by <CustomFieldRows>).
 *
 * DEFINED IN fieldValidation.ts, not here. This module is `'use client'`, so a
 * route handler cannot import it — which is exactly how the server came to
 * validate a field no form renders. Re-exported under the old names so the
 * components that render from this list read the same way they always have.
 */
export const HIDDEN_KEYS = FORM_HIDDEN_KEYS;

/** The fields a form actually renders, in spec order. */
export const visibleFields = formFields;

/** A stored value as the inputs hold it — everything here is a string. */
export function asInputValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** Amounts as typed — `1,25,000`, `₹ 4500` — reduced to a storable number. */
export function normaliseNumeric(value) {
  const cleaned = String(value).replace(/[,\s₹]/g, '');
  return cleaned === '' ? '' : cleaned;
}

/**
 * `<input type>` per data type. Anything absent is plain text.
 *
 * Amounts are deliberately NOT `type="number"`: a number input silently refuses
 * `1,25,000` and `₹4500` — the two ways people actually write money here — so
 * the field simply appeared not to accept typing. The validator judges the
 * value and `normaliseNumeric` strips the formatting on the way out.
 */
const HTML_INPUT_TYPE = {
  date: 'date',
  time: 'time',
  // `type="email"` / `type="url"` would add a SECOND validator — the browser's —
  // with its own message, in its own wording, that `fieldValidation` cannot see
  // and the error line below cannot render. One validator, per this file's
  // sibling contract. The keyboard hint below is the part worth having.
  email: 'text',
  url: 'text',
  phone: 'text',
};

/** The mobile keyboard each type should raise. */
const INPUT_MODE = {
  currency: 'decimal',
  number: 'decimal',
  email: 'email',
  url: 'url',
  phone: 'tel',
};

/** Does this type ask the user to pick from a list rather than type? */
function isChoice(dataType) {
  return dataType === 'select' || dataType === 'multiselect';
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A FIELD WHOSE ANSWERS ARE A LIST                                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Four controls, two questions. `select` asks "which one"; `multiselect` asks
 * "which of these" — and `display` decides only how that question is drawn.
 * That split is why validation, AI coercion and the OCR prompt each state the
 * rule once instead of four times; see FieldDataType in
 * src/lib/documentCategoryFields.ts.
 *
 * ── AN OPTION THAT IS NO LONGER OFFERED IS STILL SHOWN ─────────────────────
 * An operator can remove an option from a field that already has records
 * carrying it. Dropping such a value from the control would silently rewrite
 * the record the moment anyone saved it — the user would see a blank, fill in
 * something else, and the original answer would be gone with nothing having
 * said so. It is rendered, marked, and left for them to change deliberately.
 *
 * ── A MULTISELECT VALUE IS A JSON ARRAY STRING ─────────────────────────────
 * Not an array. Everything downstream of an input assumes a string: the
 * encrypt split, `encryptField`, and the form's own `payload()`. See
 * `parseMultiValue`.
 */
function ChoiceInput({ spec, value, disabled, invalid, onChange, onBlur, registerRef }) {
  const { fieldKey, dataType, display, options = [] } = spec;
  const multi = dataType === 'multiselect';

  const chosen = multi ? (parseMultiValue(value) ?? []) : [];
  const single = multi ? '' : String(value ?? '');

  // Values a record holds that the current option list no longer offers.
  const orphans = (multi ? chosen : (single ? [single] : []))
    .filter((v) => !options.some((o) => o.value === v));
  const shown = [
    ...options,
    ...orphans.map((v) => ({ value: v, label: `${v} (no longer offered)` })),
  ];

  const toggle = (optionValue, on) => {
    const next = on
      ? [...chosen, optionValue]
      : chosen.filter((v) => v !== optionValue);
    // Ordered by the option list, not by the order they were clicked, so two
    // records with the same answers store the same string.
    const ordered = shown.map((o) => o.value).filter((v) => next.includes(v));
    onChange(fieldKey, JSON.stringify(ordered));
  };

  // A field whose options an operator has not filled in yet. Free text rather
  // than an empty control — the same degradation `validateField` makes, so the
  // form and the validator agree about a half-built field.
  if (shown.length === 0) {
    return (
      <Input
        id={fieldKey}
        value={String(value ?? '')}
        disabled={disabled}
        aria-invalid={invalid}
        ref={(element) => registerRef?.(fieldKey, element)}
        onBlur={() => onBlur?.(spec)}
        onChange={(e) => onChange(fieldKey, e.target.value)}
        className={cn('text-base sm:text-sm', invalid && 'border-destructive')}
      />
    );
  }

  if (multi) {
    return (
      <div
        className={cn(
          'flex flex-col gap-1.5 py-1',
          display === 'chips' && 'flex-row flex-wrap gap-2',
        )}
        ref={(element) => registerRef?.(fieldKey, element)}
      >
        {shown.map((option) => {
          const id = `${fieldKey}-${option.value}`;
          return (
            <label
              key={option.value}
              htmlFor={id}
              className={cn(
                'flex items-center gap-2 text-sm',
                display === 'chips' && 'rounded-full border px-2.5 py-1',
                disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
              )}
            >
              <Checkbox
                id={id}
                disabled={disabled}
                checked={chosen.includes(option.value)}
                onCheckedChange={(on) => toggle(option.value, on === true)}
              />
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>
    );
  }

  if (display === 'radio') {
    return (
      <RadioGroup
        name={fieldKey}
        value={single}
        options={shown}
        disabled={disabled}
        onChange={(next) => onChange(fieldKey, next)}
        ref={(element) => registerRef?.(fieldKey, element)}
      />
    );
  }

  return (
    <Select
      value={single}
      disabled={disabled}
      onValueChange={(next) => onChange(fieldKey, next)}
    >
      <SelectTrigger
        id={fieldKey}
        aria-invalid={invalid}
        ref={(element) => registerRef?.(fieldKey, element)}
        onBlur={() => onBlur?.(spec)}
        className={cn('text-base sm:text-sm', invalid && 'border-destructive')}
      >
        <SelectValue placeholder="Choose one" />
      </SelectTrigger>
      <SelectContent>
        {shown.map((option) => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * One field of the spec.
 *
 * @param spec        the field's entry in the category's spec
 * @param value       its current value, as a string
 * @param error       the message to show, or undefined — the caller decides
 *                    whether an untouched field shows one
 * @param aiFilled    this value came from a read of the document, not a person
 * @param registerRef (key, element) — for scroll-to-and-focus on submit
 */
function FieldInput({
  spec, value, error, aiFilled, disabled, onChange, onBlur, registerRef,
}) {
  const {
    fieldKey, fieldLabel, dataType, isPii, isRequired, validation, description,
  } = spec;
  const invalid = Boolean(error);

  const common = {
    id: fieldKey,
    value,
    disabled,
    onBlur: () => onBlur?.(spec),
    'aria-invalid': invalid,
    ref: (element) => registerRef?.(fieldKey, element),
    // 16px on mobile: anything smaller and iOS zooms the page on focus.
    className: cn('text-base sm:text-sm', invalid && 'border-destructive'),
  };

  return (
    <div className={cn('flex flex-col gap-1.5', dataType === 'longtext' && 'sm:col-span-2')}>
      <Label htmlFor={fieldKey} className="flex items-center gap-1.5">
        <span>{fieldLabel}</span>
        {isRequired && <span className="text-danger-text" aria-hidden>*</span>}
        {isPii && (
          <span
            title="Encrypted before it is stored — nobody but your workspace can read it"
            className="inline-flex items-center text-faint"
          >
            <Lock size={11} />
          </span>
        )}
        {/* Says out loud that nobody typed this. Cleared the moment the
            user edits the field — see the caller's setValue. */}
        {aiFilled && (
          <span
            title="Read from the document you uploaded — check it against the original"
            className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1 py-px text-2xs font-bold uppercase tracking-wider text-primary"
          >
            <Sparkles size={8} />
            AI
          </span>
        )}
      </Label>

      {isChoice(dataType) ? (
        <ChoiceInput
          spec={spec}
          value={value}
          disabled={disabled}
          invalid={invalid}
          onChange={onChange}
          onBlur={onBlur}
          registerRef={registerRef}
        />
      ) : dataType === 'longtext' ? (
        <Textarea
          {...common}
          rows={3}
          onChange={(e) => onChange(fieldKey, e.target.value)}
          placeholder={validation?.example || ''}
        />
      ) : dataType === 'boolean' ? (
        <div className="flex h-10 items-center gap-2">
          <Switch
            id={fieldKey}
            disabled={disabled}
            checked={value === 'true' || value === true}
            onCheckedChange={(checked) => onChange(fieldKey, checked ? 'true' : 'false')}
          />
          <span className="text-xs text-muted-foreground">
            {value === 'true' || value === true ? 'Yes' : 'No'}
          </span>
        </div>
      ) : (
        <Input
          {...common}
          // Both tables are at the top of this file, with the reasoning for the
          // two entries that look wrong at a glance: amounts are text, and so
          // are emails and URLs.
          type={HTML_INPUT_TYPE[dataType] ?? 'text'}
          inputMode={INPUT_MODE[dataType]}
          maxLength={validation?.maxLength}
          placeholder={validation?.example || ''}
          onChange={(e) => onChange(fieldKey, e.target.value)}
        />
      )}

      {/* An operator's explanation of the field, from /admin/document-fields.
          Above the error and the example because it is true whatever the
          current value is — the other two describe this attempt at filling it
          in. Rendered for dictionary and custom fields alike. */}
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}

      {error ? (
        <p className="text-xs font-medium text-danger-text">{error}</p>
      ) : validation?.example ? (
        <p className="text-xs text-faint">e.g. {validation.example}</p>
      ) : null}
    </div>
  );
}

/**
 * Every visible field of a category, as a responsive grid.
 *
 * `errors` is read directly rather than filtered by `touched` here, so the
 * caller keeps control of when a message appears — the dialog shows one only
 * after a blur, and a server `fieldErrors` response marks everything touched at
 * once so all of them appear together.
 */
export default function CategoryFieldInputs({
  fields,
  values,
  errors = {},
  touched = {},
  aiFilled,
  disabled = false,
  onChange,
  onBlur,
  registerRef,
  className,
}) {
  return (
    <div className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2', className)}>
      {visibleFields(fields).map((spec) => (
        <FieldInput
          key={spec.fieldKey}
          spec={spec}
          value={asInputValue(values?.[spec.fieldKey])}
          error={touched[spec.fieldKey] ? errors[spec.fieldKey] : undefined}
          aiFilled={Boolean(aiFilled?.has(spec.fieldKey))}
          disabled={disabled}
          onChange={onChange}
          onBlur={onBlur}
          registerRef={registerRef}
        />
      ))}
    </div>
  );
}

/**
 * Anything the category did not anticipate, as label/value pairs.
 *
 * Sealed on the way out — `custom_fields` is `isPii` in the baseline spec, and
 * not negotiable: it is the one field whose contents nobody declared, so it is
 * the one most likely to hold an account number someone had nowhere else to
 * put. The lock says so here.
 */
export function CustomFieldRows({ rows, onChange, disabled = false, label = 'Additional details' }) {
  const update = (next) => onChange(next);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-1.5">
          {label}
          <span title="Encrypted before it is stored" className="text-faint">
            <Lock size={11} />
          </span>
        </Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-7 gap-1 text-xs"
          onClick={() => update([...rows, { label: '', value: '' }])}
        >
          <Plus size={12} /> Add field
        </Button>
      </div>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={row.label}
            placeholder="Label"
            disabled={disabled}
            className="text-base sm:text-sm"
            onChange={(e) => update(rows.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))}
          />
          <Input
            value={row.value}
            placeholder="Value"
            disabled={disabled}
            className="text-base sm:text-sm"
            onChange={(e) => update(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            className="shrink-0 text-muted-foreground hover:text-danger-action"
            aria-label="Remove field"
            onClick={() => update(rows.filter((_, j) => j !== i))}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Does this category collect linked cards at all? */
export function hasLinkedCards(fields) {
  return (fields ?? []).some((spec) => spec.fieldKey === LINKED_CARDS_KEY);
}

/** A blank card, ready to type into. Ids only have to be unique in this list. */
function blankCard() {
  return {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    cardName: '', cardType: '', cardNetwork: '',
    cardHolder: '', cardNumber: '', cardExpiry: '',
  };
}

/** "Visa Credit · ends 4821", or as much of it as the card actually has. */
function cardSummary(card, index) {
  const network = CARD_NETWORKS.find((n) => n.value === card.cardNetwork)?.label ?? '';
  const type = CARD_TYPES.find((t) => t.value === card.cardType)?.label ?? '';
  const digits = card.cardNumber.replace(/\D/g, '');
  const tail = digits.length >= 4 ? `ends ${digits.slice(-4)}` : '';
  const parts = [card.cardName, [network, type].filter(Boolean).join(' '), tail]
    .filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : `Card ${index + 1}`;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE DEBIT AND CREDIT CARDS BELONGING TO ONE ACCOUNT                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `cards` was a `longtext` textarea — one box for however many cards a
 * household holds against one bank account, out of which nothing could be read
 * back. It is the same key and the same sealed `longtext` column; what changed
 * is that it now holds JSON, exactly as `custom_fields` above does. See
 * src/lib/records/linkedCards.ts for the shape and for why there is no CVV
 * input here.
 *
 * ── THE NICKNAME IS THE ONE FIELD THAT LEAVES THE VAULT ────────────────────
 * Every card expiry raises a renewal on Follow Up, and a reminder lives in the
 * OPEN tier — so the label naming the card is written in the clear. The
 * nickname is what that label uses, which is why the input SAYS SO rather than
 * leaving the user to discover it on the follow-up page. Nothing else escapes:
 * no number, no last four, no holder name.
 *
 * @param value    `{ cards, text }` from `parseLinkedCards`
 * @param onChange the same shape back
 * @param error    one message for the whole field, from `linkedCardsError`
 */
export function LinkedCardRows({ value, onChange, disabled = false, error }) {
  const cards = value?.cards ?? [];
  const text = value?.text ?? '';
  const setCards = (next) => onChange({ cards: next, text });
  const patch = (i, changes) =>
    setCards(cards.map((c, j) => (j === i ? { ...c, ...changes } : c)));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-1.5">
          Linked Cards
          <span title="Encrypted before it is stored" className="text-faint">
            <Lock size={11} />
          </span>
        </Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-7 gap-1 text-xs"
          onClick={() => setCards([...cards, blankCard()])}
        >
          <Plus size={12} /> Add card
        </Button>
      </div>

      {cards.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Add the debit and credit cards issued against this account. Each card’s
          expiry appears in Follow Up when it is due.
        </p>
      )}

      {cards.map((card, i) => (
        <div key={card.id} className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <CreditCard size={12} className="shrink-0" />
              <span className="truncate">{cardSummary(card, i)}</span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-danger-action"
              aria-label={`Remove ${cardSummary(card, i)}`}
              onClick={() => setCards(cards.filter((_, j) => j !== i))}
            >
              <Trash2 size={14} />
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor={`${card.id}-name`}>Card Name</Label>
              <Input
                id={`${card.id}-name`}
                value={card.cardName}
                disabled={disabled}
                placeholder="HDFC Regalia"
                className="text-base sm:text-sm"
                onChange={(e) => patch(i, { cardName: e.target.value })}
              />
              {/* The one field that reaches the open tier — see the header. */}
              <p className="text-xs text-faint">Shown in renewal reminders</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${card.id}-type`}>Card Type</Label>
              <Select
                value={card.cardType}
                disabled={disabled}
                onValueChange={(next) => patch(i, { cardType: next })}
              >
                <SelectTrigger id={`${card.id}-type`} className="text-base sm:text-sm">
                  <SelectValue placeholder="Credit or debit" />
                </SelectTrigger>
                <SelectContent>
                  {CARD_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${card.id}-network`}>Network</Label>
              <Select
                value={card.cardNetwork}
                disabled={disabled}
                onValueChange={(next) => patch(i, { cardNetwork: next })}
              >
                <SelectTrigger id={`${card.id}-network`} className="text-base sm:text-sm">
                  <SelectValue placeholder="Visa, RuPay…" />
                </SelectTrigger>
                <SelectContent>
                  {CARD_NETWORKS.map((n) => (
                    <SelectItem key={n.value} value={n.value}>{n.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${card.id}-holder`}>Cardholder Name</Label>
              <Input
                id={`${card.id}-holder`}
                value={card.cardHolder}
                disabled={disabled}
                placeholder="As printed on the card"
                className="text-base sm:text-sm"
                onChange={(e) => patch(i, { cardHolder: e.target.value })}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${card.id}-number`}>Card Number</Label>
              <Input
                id={`${card.id}-number`}
                value={card.cardNumber}
                disabled={disabled}
                inputMode="numeric"
                autoComplete="off"
                placeholder="16 digits"
                className="text-base sm:text-sm"
                onChange={(e) => patch(i, { cardNumber: e.target.value })}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${card.id}-expiry`}>Expiry</Label>
              {/*
                A month input, because a card carries a month and not a day —
                and because it is the one control that cannot produce the
                `MM/YY`-vs-`MM/YYYY` ambiguity the parser exists to absorb.
                `normaliseExpiry` still runs on the way in, so a value stored
                as `09/29` by the old page opens here correctly.
              */}
              <Input
                id={`${card.id}-expiry`}
                type="month"
                value={normaliseExpiry(card.cardExpiry)}
                disabled={disabled}
                className="text-base sm:text-sm"
                onChange={(e) => patch(i, { cardExpiry: e.target.value })}
              />
            </div>
          </div>
        </div>
      ))}

      {/*
        Whatever was typed into the textarea this field used to be. Rendered
        only when there IS something, so a record that never had one does not
        grow a box — but never dropped, because it is the user's own writing
        and a change that structures a field must not be the thing that empties
        it.
      */}
      {text && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="linked-cards-text">Other Card Details</Label>
          <Textarea
            id="linked-cards-text"
            rows={3}
            value={text}
            disabled={disabled}
            className="text-base sm:text-sm"
            onChange={(e) => onChange({ cards, text: e.target.value })}
          />
          <p className="text-xs text-faint">
            Kept from before this field collected cards one by one. Move anything
            still useful into a card above and clear the rest.
          </p>
        </div>
      )}

      {error && <p className="text-xs font-medium text-danger-text">{error}</p>}
    </div>
  );
}
