/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   COVERED MEMBERS — the people insured under one group health policy     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `covered_members` on `insurance/corporate_health_insurance`. An employer's
 * mediclaim e-card file carries one card per person — the employee, the spouse,
 * the children — each with its own member ID, insurer ID and date of birth, all
 * under one employer, insurer and validity date.
 *
 * It holds JSON TEXT in a sealed `longtext` key, the same way `cards` does (see
 * ./linkedCards.ts): the encrypt policy names a key, so a nested object would
 * leave half of every member outside the sealed tier.
 *
 * Unlike `cards`, the form's value IS that string. The shared field grid draws
 * the rows from it and writes it back, so no form holds state of its own for
 * this field. That is why `parseCoveredMembers` never trims: it runs on every
 * keystroke, and trimming there would swallow the space between two names as it
 * was typed. Tidying happens once, in `normaliseCoveredMembers`.
 *
 * A leaf module (its one import is pure): the browser, the AI answer coercion
 * and the write path all read it.
 */
import { displayToIso, isoToDisplay } from '@/lib/dateHelper';

/** The key the members are stored under. */
export const COVERED_MEMBERS_KEY = 'covered_members';

export interface CoveredMember {
  /** Stable within the record, for the editor's rows. */
  id: string;
  name: string;
  /** One of MEMBER_RELATIONS, or '' when not stated. */
  relation: string;
  /** `YYYY-MM-DD`, or the raw text of a date still being typed. */
  dateOfBirth: string;
  /** The TPA's member / UHID number on the card. */
  memberId: string;
  /** The insurer's own number for this person, where the card prints one. */
  insurerId: string;
}

export const MEMBER_RELATIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'self', label: 'Self' },
  { value: 'spouse', label: 'Spouse' },
  { value: 'son', label: 'Son' },
  { value: 'daughter', label: 'Daughter' },
  { value: 'father', label: 'Father' },
  { value: 'mother', label: 'Mother' },
  { value: 'father_in_law', label: 'Father-in-law' },
  { value: 'mother_in_law', label: 'Mother-in-law' },
  { value: 'other', label: 'Other' },
];

const RELATION_LABELS = new Map(MEMBER_RELATIONS.map((r) => [r.value, r.label]));

/** Words a card prints that mean one of the values above. */
const RELATION_SYNONYMS: Readonly<Record<string, string>> = {
  employee: 'self',
  primary: 'self',
  wife: 'spouse',
  husband: 'spouse',
};

const MONTH_NAMES = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

/** Row ids only have to be unique within one record. */
let counter = 0;
export function nextMemberId(): string {
  counter += 1;
  return `m${Date.now().toString(36)}${counter.toString(36)}`;
}

export function blankMember(): CoveredMember {
  return {
    id: nextMemberId(), name: '', relation: '', dateOfBirth: '', memberId: '', insurerId: '',
  };
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function toMember(raw: unknown, index: number): CoveredMember | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  return {
    // Positional when absent, so a re-parse of the same text yields the same ids.
    id: str(row.id) || `m${index}`,
    name: str(row.name),
    relation: str(row.relation),
    dateOfBirth: str(row.dateOfBirth),
    memberId: str(row.memberId),
    insurerId: str(row.insurerId),
  };
}

/** A row nobody filled anything into. Its `id` alone is not content. */
export function isMemberBlank(member: CoveredMember): boolean {
  return [member.name, member.relation, member.dateOfBirth, member.memberId, member.insurerId]
    .every((v) => v.trim() === '');
}

/**
 * A stored or in-progress value, read leniently: `{ members: [...] }`, a bare
 * array, or plain text — which becomes one row's name rather than being lost.
 * Never throws.
 */
export function parseCoveredMembers(raw: unknown): CoveredMember[] {
  if (raw === null || raw === undefined) return [];

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') return [];
    const asName = () => [{ ...blankMember(), id: 'm0', name: text }];
    if (!text.startsWith('{') && !text.startsWith('[')) return asName();
    try {
      parsed = JSON.parse(text);
    } catch {
      return asName();
    }
  }

  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { members?: unknown } | null)?.members;
  if (!Array.isArray(list)) return [];
  return list.map(toMember).filter((m): m is CoveredMember => m !== null);
}

/** The editor's string form. '' when there are no rows, so the field clears. */
export function serialiseCoveredMembers(members: readonly CoveredMember[]): string {
  return members.length === 0 ? '' : JSON.stringify({ members });
}

function normaliseRelation(value: string): string {
  const text = value.trim();
  if (text === '') return '';
  const key = text.toLowerCase().replace(/[\s-]+/g, '_');
  if (RELATION_LABELS.has(key)) return key;
  return RELATION_SYNONYMS[key] ?? 'other';
}

/** ISO, DD/MM/YYYY and the card style `09-Jun-1992` → ISO. Else kept as typed. */
function normaliseBirthDate(value: string): string {
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const numeric = displayToIso(text);
  if (numeric) return numeric;
  const named = /^(\d{1,2})[\s/.-]+([A-Za-z]{3,})[\s/.,-]+(\d{4})$/.exec(text);
  if (named) {
    const month = MONTH_NAMES.indexOf(named[2].slice(0, 3).toLowerCase()) + 1;
    const iso = month > 0 ? displayToIso(`${named[1]}/${month}/${named[3]}`) : null;
    if (iso) return iso;
  }
  return text;
}

/**
 * The storage form: tidied JSON text, or null when no row holds anything —
 * null so the caller omits the key rather than sealing an empty box.
 */
export function normaliseCoveredMembers(raw: unknown): string | null {
  const members = parseCoveredMembers(raw)
    .filter((m) => !isMemberBlank(m))
    .map((m) => ({
      id: m.id,
      name: m.name.trim(),
      relation: normaliseRelation(m.relation),
      dateOfBirth: normaliseBirthDate(m.dateOfBirth),
      memberId: m.memberId.trim(),
      insurerId: m.insurerId.trim(),
    }));
  return members.length === 0 ? null : JSON.stringify({ members });
}

/** One member as a readable line. */
export function describeCoveredMember(member: CoveredMember, index: number): string {
  const relation = RELATION_LABELS.get(member.relation) ?? member.relation;
  const name = member.name.trim() || `Member ${index + 1}`;
  return [
    relation ? `${name} (${relation})` : name,
    member.dateOfBirth ? `DOB ${isoToDisplay(member.dateOfBirth)}` : '',
    member.memberId ? `Member ID ${member.memberId}` : '',
    member.insurerId ? `Insurer ID ${member.insurerId}` : '',
  ].filter(Boolean).join(' · ');
}

/** The whole list as text, one member per line. For view, share and print. */
export function formatCoveredMembers(raw: unknown): string {
  return parseCoveredMembers(raw)
    .filter((m) => !isMemberBlank(m))
    .map(describeCoveredMember)
    .join('\n');
}

/**
 * What a list row, share sheet or print-out shows while the value is sealed: a
 * count and nothing else. The usual keep-the-last-four mask would print the
 * tail of the JSON.
 */
export function coveredMembersSummary(raw: unknown): string {
  const count = parseCoveredMembers(raw).filter((m) => !isMemberBlank(m)).length;
  if (count === 0) return '';
  return count === 1 ? '1 member' : `${count} members`;
}
