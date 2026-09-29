/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  ACCESS LEVELS — the five permission flags, as one choice                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A permission row carries five independent booleans, but they are not really
 * independent: applyFlag() in the users screen has always forced canView on
 * any grant, because you cannot add to something you cannot see. In practice
 * an admin picks a rung on a ladder, not a subset of a power set.
 *
 * So the UI offers ONE select per row instead of five checkboxes. At the
 * scale this screen now works at — 20 modules and 83 sub-categories — five
 * checkboxes per row is 515 controls and no admin will read them.
 *
 * ── LOSSY, DELIBERATELY, AND SAFELY ─────────────────────────────────────────
 * The ladder cannot express every combination (delete-without-edit, share-
 * without-add). Rows like that already exist in the database and MUST NOT be
 * rewritten just because someone opened the screen. flagsToLevel() returns
 * CUSTOM_LEVEL for them; the UI shows "Custom", leaves the flags untouched,
 * and offers the raw five checkboxes behind a per-row expander. A row only
 * changes when an admin actively changes it.
 */

export type PermissionFlags = {
  canView: boolean;
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canShare: boolean;
};

export type LevelKey = 'none' | 'view' | 'contribute' | 'manage' | 'full';

/** What a row reads as when its flags match no rung. Never written to the DB. */
export const CUSTOM_LEVEL = 'custom';

export type LevelOrCustom = LevelKey | typeof CUSTOM_LEVEL;

/**
 * The rungs, weakest first. Order is the order the select renders them.
 *
 * `full` is the only rung granting delete or share: those two are the
 * destructive/outward-facing pair, and a ladder that let them in earlier would
 * make "give them edit access" quietly mean "let them delete things".
 */
export const LEVELS: ReadonlyArray<{
  key: LevelKey;
  label: string;
  description: string;
  flags: PermissionFlags;
}> = [
  {
    key: 'none',
    label: 'No access',
    description: 'Hidden from this member entirely',
    flags: { canView: false, canAdd: false, canEdit: false, canDelete: false, canShare: false },
  },
  {
    key: 'view',
    label: 'View only',
    description: 'Can open and read, cannot change anything',
    flags: { canView: true, canAdd: false, canEdit: false, canDelete: false, canShare: false },
  },
  {
    key: 'contribute',
    label: 'Contributor',
    description: 'Can read and add new records',
    flags: { canView: true, canAdd: true, canEdit: false, canDelete: false, canShare: false },
  },
  {
    key: 'manage',
    label: 'Manager',
    description: 'Can read, add and edit — but not delete',
    flags: { canView: true, canAdd: true, canEdit: true, canDelete: false, canShare: false },
  },
  {
    key: 'full',
    label: 'Full access',
    description: 'Everything, including delete and share',
    flags: { canView: true, canAdd: true, canEdit: true, canDelete: true, canShare: true },
  },
];

const LEVEL_BY_KEY = new Map(LEVELS.map((l) => [l.key, l]));

/** The five flags of a rung. Unknown keys fall back to `none`, never to a grant. */
export function levelToFlags(level: LevelOrCustom): PermissionFlags {
  const found = LEVEL_BY_KEY.get(level as LevelKey);
  return { ...(found ?? LEVELS[0]).flags };
}

/**
 * Which rung a row sits on, or CUSTOM_LEVEL when it sits between rungs.
 * Coerces loosely-typed rows (undefined/null flags) the way the screen does.
 */
export function flagsToLevel(perm: Partial<PermissionFlags> | null | undefined): LevelOrCustom {
  const f: PermissionFlags = {
    canView: !!perm?.canView,
    canAdd: !!perm?.canAdd,
    canEdit: !!perm?.canEdit,
    canDelete: !!perm?.canDelete,
    canShare: !!perm?.canShare,
  };
  const match = LEVELS.find(
    (l) =>
      l.flags.canView === f.canView &&
      l.flags.canAdd === f.canAdd &&
      l.flags.canEdit === f.canEdit &&
      l.flags.canDelete === f.canDelete &&
      l.flags.canShare === f.canShare,
  );
  return match ? match.key : CUSTOM_LEVEL;
}

export function levelLabel(level: LevelOrCustom): string {
  return LEVEL_BY_KEY.get(level as LevelKey)?.label ?? 'Custom';
}

/**
 * The rung in plain words — "Can read and add new records".
 *
 * The labels alone do not tell an admin what they are granting: "Manager" and
 * "Contributor" are names, not permissions. The screen renders this under every
 * row and inside every option, which is the whole reason the descriptions were
 * written. A row between rungs describes itself by its checkboxes instead.
 */
export function levelDescription(level: LevelOrCustom): string {
  return LEVEL_BY_KEY.get(level as LevelKey)?.description ?? 'Mixed — set per action below';
}

/** The shape the matrix reads: module defaults have a null documentKey. */
type PermissionRow = Partial<PermissionFlags> & { module: string; documentKey?: string | null };

export type PermissionSummary = {
  /** Module-default rows, i.e. one per permission key. */
  total: number;
  /** How many of those grant nothing at all. */
  hidden: number;
  /** Module defaults per rung, CUSTOM_LEVEL included. Zero counts are omitted. */
  byLevel: Partial<Record<LevelOrCustom, number>>;
  /** Sub-category rows — each one a deviation from its module's default. */
  overrides: number;
};

/**
 * What a permission array adds up to, for the summary bar and filter counts.
 * Counting happens here rather than in the component so the arithmetic that the
 * admin reads right before pressing "Create Member" is unit-tested.
 */
export function summarizePermissions(rows: readonly PermissionRow[]): PermissionSummary {
  const byLevel: Partial<Record<LevelOrCustom, number>> = {};
  let total = 0;
  let overrides = 0;
  for (const row of rows) {
    if (row.documentKey) {
      overrides += 1;
      continue;
    }
    total += 1;
    const level = flagsToLevel(row);
    byLevel[level] = (byLevel[level] ?? 0) + 1;
  }
  return { total, hidden: byLevel.none ?? 0, byLevel, overrides };
}

/**
 * Which preset card, if any, currently describes the whole array.
 *
 * Derived rather than remembered: the screen used to hold the clicked preset in
 * state, so changing one module afterwards left the card lit and claiming an
 * access shape that was no longer true. A single override is enough to make it
 * "custom" — an override is by definition a module that no longer matches.
 */
export function matchingPreset(rows: readonly PermissionRow[]): string {
  const { total, byLevel, overrides } = summarizePermissions(rows);
  if (overrides > 0 || total === 0) return 'custom';
  const levels = Object.keys(byLevel) as LevelOrCustom[];
  if (levels.length !== 1) return 'custom';
  return PRESETS.find((p) => p.level === levels[0])?.key ?? 'custom';
}

/**
 * The one-click starting points offered when adding a member.
 *
 * `custom` carries no level: picking it keeps whatever is already in the form
 * and just reveals the matrix, so switching to Custom never discards work.
 */
export const PRESETS: ReadonlyArray<{
  key: string;
  label: string;
  description: string;
  level: LevelKey | null;
}> = [
  { key: 'viewer',      label: 'Viewer',      description: 'See everything, change nothing', level: 'view' },
  { key: 'contributor', label: 'Contributor', description: 'See everything and add new records', level: 'contribute' },
  { key: 'full',        label: 'Full access', description: 'Add, edit, delete and share everywhere', level: 'full' },
  { key: 'custom',      label: 'Custom',      description: 'Choose module by module', level: null },
];

/**
 * A preset expanded into permission rows — one MODULE DEFAULT per key, with
 * `documentKey: null`, and no sub-category rows at all.
 *
 * The absence of sub-category rows is the point, not an omission: a member with
 * only module defaults inherits any sub-category added to the taxonomy later,
 * whereas one seeded with all 83 rows would be frozen out of it. Same reasoning
 * as DEFAULT_USER_PERMISSIONS in moduleRegistry.js.
 */
export function permissionsForLevel(
  moduleKeys: readonly string[],
  level: LevelKey,
): Array<{ module: string; documentKey: null } & PermissionFlags> {
  const flags = levelToFlags(level);
  return moduleKeys.map((module) => ({ module, documentKey: null, ...flags }));
}
