import { describe, it, expect } from 'vitest';
import {
  LEVELS,
  PRESETS,
  CUSTOM_LEVEL,
  levelToFlags,
  flagsToLevel,
  levelLabel,
  levelDescription,
  permissionsForLevel,
  summarizePermissions,
  matchingPreset,
} from '../src/lib/permissionLevels';
import {
  DEFAULT_PERSONAL_PERMISSIONS,
  PERSONAL_PERMISSION_KEYS,
} from '../src/lib/moduleRegistry';

describe('access levels', () => {
  it('round-trips every rung', () => {
    for (const level of LEVELS) {
      expect(flagsToLevel(levelToFlags(level.key))).toBe(level.key);
    }
  });

  it('reads a combination the ladder cannot express as custom', () => {
    // delete-without-edit: legal in the DB, on no rung.
    expect(
      flagsToLevel({ canView: true, canAdd: true, canEdit: false, canDelete: true, canShare: false }),
    ).toBe(CUSTOM_LEVEL);
    // share-without-add.
    expect(
      flagsToLevel({ canView: true, canAdd: false, canEdit: false, canDelete: false, canShare: true }),
    ).toBe(CUSTOM_LEVEL);
    expect(levelLabel(CUSTOM_LEVEL)).toBe('Custom');
  });

  it('never invents a grant from a missing or unknown level', () => {
    expect(flagsToLevel(null)).toBe('none');
    expect(flagsToLevel(undefined)).toBe('none');
    expect(flagsToLevel({})).toBe('none');
    expect(levelToFlags('nonsense' as never)).toEqual(levelToFlags('none'));
  });

  it('keeps delete and share out of every rung below full', () => {
    for (const level of LEVELS) {
      if (level.key === 'full') continue;
      expect(level.flags.canDelete).toBe(false);
      expect(level.flags.canShare).toBe(false);
    }
  });

  it('implies canView on every rung that grants anything', () => {
    for (const level of LEVELS) {
      const granted = Object.entries(level.flags).filter(([k, v]) => k !== 'canView' && v);
      if (granted.length > 0) expect(level.flags.canView).toBe(true);
    }
  });
});

describe('presets', () => {
  it('expands to module defaults only — never a sub-category row', () => {
    for (const preset of PRESETS) {
      if (!preset.level) continue;
      const rows = permissionsForLevel(PERSONAL_PERMISSION_KEYS, preset.level);
      expect(rows).toHaveLength(PERSONAL_PERMISSION_KEYS.length);
      expect(rows.every((r) => r.documentKey === null)).toBe(true);
    }
  });

  // The level-less entry is no longer a card — the module list is always on
  // screen — but it is still what the "Custom" readback chip is named from.
  it('carries exactly one level-less entry, the custom readback', () => {
    expect(PRESETS.filter((p) => p.level === null).map((p) => p.key)).toEqual(['custom']);
  });
});

describe('level descriptions', () => {
  it('gives every rung a description the screen can print', () => {
    for (const level of LEVELS) {
      expect(levelDescription(level.key)).toBe(level.description);
      expect(levelDescription(level.key).length).toBeGreaterThan(0);
    }
  });

  it('describes a row between rungs without claiming a rung', () => {
    expect(levelDescription(CUSTOM_LEVEL)).toBe('Mixed — set per action below');
    expect(levelDescription('nonsense' as never)).toBe(levelDescription(CUSTOM_LEVEL));
  });
});

describe('summarizePermissions', () => {
  const defaults = permissionsForLevel(PERSONAL_PERMISSION_KEYS, 'contribute');

  it('counts module defaults by rung and ignores them for the override tally', () => {
    const summary = summarizePermissions(defaults);
    expect(summary.total).toBe(PERSONAL_PERMISSION_KEYS.length);
    expect(summary.byLevel.contribute).toBe(PERSONAL_PERMISSION_KEYS.length);
    expect(summary.overrides).toBe(0);
    expect(summary.hidden).toBe(0);
  });

  it('counts sub-category rows as overrides, never as modules', () => {
    const summary = summarizePermissions([
      ...defaults,
      { module: PERSONAL_PERMISSION_KEYS[0], documentKey: 'aadhaar', ...levelToFlags('none') },
      { module: PERSONAL_PERMISSION_KEYS[0], documentKey: 'pan', ...levelToFlags('full') },
    ]);
    expect(summary.total).toBe(PERSONAL_PERMISSION_KEYS.length);
    expect(summary.overrides).toBe(2);
  });

  it('separates hidden modules and rows that sit between rungs', () => {
    const summary = summarizePermissions([
      { module: 'a', documentKey: null, ...levelToFlags('none') },
      { module: 'b', documentKey: null, ...levelToFlags('full') },
      { module: 'c', documentKey: null, canView: true, canAdd: false, canEdit: false, canDelete: false, canShare: true },
    ]);
    expect(summary.hidden).toBe(1);
    expect(summary.byLevel.full).toBe(1);
    expect(summary.byLevel[CUSTOM_LEVEL]).toBe(1);
    expect(summary.byLevel.view).toBeUndefined();
  });
});

describe('matchingPreset', () => {
  it('names the preset while the permissions still match it', () => {
    for (const preset of PRESETS) {
      if (!preset.level) continue;
      expect(matchingPreset(permissionsForLevel(PERSONAL_PERMISSION_KEYS, preset.level))).toBe(
        preset.key,
      );
    }
  });

  it('drops to custom as soon as one module differs', () => {
    const rows = permissionsForLevel(PERSONAL_PERMISSION_KEYS, 'view').map((r, i) =>
      i === 0 ? { ...r, ...levelToFlags('full') } : r,
    );
    expect(matchingPreset(rows)).toBe('custom');
  });

  it('drops to custom for a single sub-category override', () => {
    const rows = [
      ...permissionsForLevel(PERSONAL_PERMISSION_KEYS, 'full'),
      { module: PERSONAL_PERMISSION_KEYS[0], documentKey: 'pan', ...levelToFlags('none') },
    ];
    expect(matchingPreset(rows)).toBe('custom');
  });

  it('does not name a preset for a rung no card offers, or for nothing at all', () => {
    expect(matchingPreset(permissionsForLevel(PERSONAL_PERMISSION_KEYS, 'manage'))).toBe('custom');
    expect(matchingPreset(permissionsForLevel(PERSONAL_PERMISSION_KEYS, 'none'))).toBe('custom');
    expect(matchingPreset([])).toBe('custom');
  });
});

describe('registry defaults', () => {
  // The registry default and the level the UI calls "Contributor" are the same
  // object by construction; this pins the value so a rung edit cannot silently
  // widen what every new member gets.
  it('grants new members view + add on every permission key, nothing more', () => {
    // The PERSONAL list: a member added without an account named is a
    // personal one, and is deliberately given no business modules.
    expect(DEFAULT_PERSONAL_PERMISSIONS).toHaveLength(PERSONAL_PERMISSION_KEYS.length);
    for (const row of DEFAULT_PERSONAL_PERMISSIONS) {
      expect(row.documentKey).toBeNull();
      expect(row.canView).toBe(true);
      expect(row.canAdd).toBe(true);
      expect(row.canEdit).toBe(false);
      expect(row.canDelete).toBe(false);
      expect(row.canShare).toBe(false);
    }
  });

  it('matches the contribute rung exactly', () => {
    expect(DEFAULT_PERSONAL_PERMISSIONS).toEqual(
      permissionsForLevel(PERSONAL_PERMISSION_KEYS, 'contribute'),
    );
  });
});
