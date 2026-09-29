/**
 * The holder contract, enforced across every record module.
 *
 * `holder_id` was written by some paths, dropped by three, and could never be
 * changed by an edit. Each of those was a separate hand-written route doing its
 * own thing, so the fix was to make one helper the only way a holder comes off
 * the wire and one helper the only thing that decides `is_global`. These are the
 * guards that keep it that way.
 *
 * Deliberately source-level rather than DB-level: a route that forgets
 * `holderFrom` is the failure being prevented, and that is visible in the source
 * without a Postgres round trip. The behavioural half — that the value survives
 * to Drive and back — is covered by the manual walkthrough and by
 * `legacyShape.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { holderFrom } from '@/lib/recordRequest';
import { holderDisplayName } from '@/lib/records/docMetadata';
import { RECORD_SCOPE_KEYS } from '@/lib/records/registry';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** `/api/lic-mediclaim` from `lic_mediclaim`. */
const routeDir = (mod: string) => `src/app/api/${mod.replace(/_/g, '-')}`;

const COMPANY = '5bfb3378-b33c-448c-acbe-5d0fd42453bb';

describe('holderFrom — the one place a holder comes off the wire', () => {
  it('distinguishes "not sent" from "all members"', () => {
    // The distinction matters: only `undefined` falls back to the module's own
    // default. Collapsing them would silently change warranty and rentals.
    expect(holderFrom({})).toBeUndefined();
    expect(holderFrom({ holderId: '' })).toBe('');
    expect(holderFrom({ holderId: null })).toBeNull();
  });

  it('passes the sentinels through untouched for the server to interpret', () => {
    // Not normalised here on purpose — one end must own the meaning of 'all',
    // and that end is resolveHolder().
    expect(holderFrom({ holderId: 'all' })).toBe('all');
    expect(holderFrom({ holderId: 'none' })).toBe('none');
  });

  it('reads a uuid unchanged', () => {
    const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(holderFrom({ holderId: id })).toBe(id);
  });

  it('accepts FormData, which ten routes post directly', () => {
    const fd = new FormData();
    expect(holderFrom(fd)).toBeUndefined();
    fd.append('holderId', 'all');
    expect(holderFrom(fd)).toBe('all');
  });

  it('treats a present-but-empty FormData key as a real choice', () => {
    // `get()` returns null for both a missing key and an empty one; using it
    // here would have erased the difference the first test pins down.
    const fd = new FormData();
    fd.append('holderId', '');
    expect(holderFrom(fd)).toBe('');
  });
});

describe('every module route reads the holder', () => {
  // `investments`, `bank_info` and `trading` each hand-wrote a body destructure
  // that omitted holderId entirely, so three modules could never assign one.
  for (const mod of RECORD_SCOPE_KEYS) {
    const dir = routeDir(mod);
    for (const file of ['route.ts', '[id]/route.ts']) {
      const path = `${dir}/${file}`;
      if (!existsSync(join(ROOT, path))) continue;
      const src = read(path);
      if (!/createRecord\(/.test(src)) continue;

      it(`${mod}/${file} passes holderFrom into createRecord`, () => {
        // The failure being prevented is a route that reads the holder off the
        // request ITSELF — `formData.get('holderId') || null`, which collapses
        // "not sent" into "All members" and loses the module default. So either
        // form counts: passed inline (what fourteen routes do), or bound to a
        // `holderId` const first, which /api/documents needs because it also
        // validates the holder against the tenant before writing.
        expect(src).toMatch(
          /holderId: holderFrom\(|const holderId = holderFrom\(/,
        );
      });
    }
  }
});

describe('no add surface asks for a holder it renders no control for', () => {
  /**
   * In a company workspace <HolderSelect> is a STATEMENT naming the company —
   * it never calls `onChange`, so the caller's `holderId` stays '' forever, and
   * it renders no dropdown for an error to land under. Every add surface
   * nevertheless gated on a bare `!holderId`, which refused every business
   * record with a message pointing at a control that had already answered:
   *
   *   · /documents  — "Please choose who this document belongs to", under a
   *     field plainly showing the company;
   *   · the sub-category dialog — "1 field needs attention", nothing marked,
   *     because `holderId` is not a spec field and owns no input;
   *   · Power Scan — every row counted as unassigned, so Save was disabled
   *     permanently and marked no row.
   *
   * Source-level for the same reason the checks above are: the failure IS the
   * missing guard, and it is visible in the source. `holderRequired` is the one
   * place that knows the rule — see src/lib/records/holderScope.ts.
   */
  const SURFACES = [
    'src/app/documents/page.js',
    'src/app/components/CategoryRecordForm.jsx',
  ];

  for (const path of SURFACES) {
    it(`${path} gates the holder on holderRequired()`, () => {
      const src = read(path);
      expect(src).toMatch(/holderRequired\(companyId\) && !holderId/);
    });

    it(`${path} omits the holder rather than sending '' for a company`, () => {
      // `holderPayload` always answers a string, so a call site still using it
      // cannot express "send nothing" — and sending '' sets is_global on a
      // record that belongs to the company, not to the household.
      const src = read(path);
      expect(src).toMatch(/holderForWrite\(companyId,/);
      expect(src).not.toMatch(/holderPayload\(/);
    });
  }

  it('the Power Scan grid does not count business rows as unassigned', () => {
    const src = read('src/app/documents/bulk-scan/page.js');
    expect(src).toMatch(/companyId \? \[\] : proposedRecords\.filter/);
    expect(src).not.toMatch(/holderPayload\(/);
  });
});

describe('is_global is derived, never posted', () => {
  it('no module route READS isGlobal off the request', () => {
    // It used to arrive as `=== 'true' ? true : undefined`, which meant
    // unchecking the box could not set it back to false. Deriving it
    // server-side from the holder is the fix, so this looks for the INPUT
    // patterns only — a route computing it is correct and must still pass.
    const fromRequest = [
      /formData\.get\(['"]isGlobal['"]\)/,     // multipart
      /\bisGlobal\b[^\n]*\}\s*=\s*(body|fields|parsed)/,  // destructured
      /(body|fields)\.isGlobal\b/,             // read off the parsed body
    ];
    const offenders: string[] = [];
    for (const mod of RECORD_SCOPE_KEYS) {
      for (const file of ['route.ts', '[id]/route.ts']) {
        const path = `${routeDir(mod)}/${file}`;
        if (!existsSync(join(ROOT, path))) continue;
        const src = read(path);
        if (fromRequest.some((re) => re.test(src))) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no module page renders an isGlobal control', () => {
    const offenders: string[] = [];
    for (const mod of RECORD_SCOPE_KEYS) {
      const path = `src/app/${mod.replace(/_/g, '-')}/page.js`;
      if (!existsSync(join(ROOT, path))) continue;
      if (/isGlobal/.test(read(path))) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});

describe('the handler write path', () => {
  const handler = read('src/lib/records/handler.ts');

  it('an edit can change the holder', () => {
    // THE regression guard. Update is createRecord({replaceId}), which always
    // lands in onConflictDoUpdate — and that `set` clause omitted holderId and
    // isGlobal, so every module's edit form silently failed to reassign.
    const set = handler.slice(handler.indexOf('onConflictDoUpdate'));
    expect(set).toMatch(/\bholderId,/);
    expect(set).toMatch(/\bisGlobal,/);
  });

  it('validates the holder against the caller\'s tenant before writing', () => {
    // Only /api/documents checked this; the other fourteen took the id from the
    // request body and persisted it, so a uuid from another tenant would stick.
    expect(handler).toMatch(/if \(holderId\) \{\s*await assertHolderInTenant\(user, holderId\)/);
    const assert_ = handler.slice(handler.indexOf('async function assertHolderInTenant'));
    expect(assert_).toMatch(/eq\(users\.tenantId, user\.tenantId\)/);
  });

  it('a record takes only a member of ITS workspace — company or household', () => {
    // The tenant check alone would let a household member's id be filed onto a
    // company record, or a business-only employee's onto a household one — the
    // pickers offer neither, but a request is not the picker. Unconditional:
    // a `companyId &&` guard here once left the household side unchecked.
    expect(handler).toMatch(/if \(!await isWorkspaceMember\(user\.tenantId, holderId, companyId \?\? null\)\)/);
    expect(handler).not.toMatch(/companyId && !await isWorkspaceMember/);
  });

  it('resolves holder and global from ONE control', () => {
    const fn = handler.slice(
      handler.indexOf('function resolveHolder'),
      handler.indexOf('async function assertHolderInTenant'),
    );
    // "all"/"none"/""/null → all members; a uuid → that member, not global.
    expect(fn).toMatch(/holderId: null, isGlobal: true/);
    expect(fn).toMatch(/holderId: raw, isGlobal: false/);
    // Only an absent field consults the module default.
    expect(fn).toMatch(/raw === undefined/);
  });
});

describe('the Holder column names whoever the record belongs to', () => {
  /**
   * A business record belongs to the COMPANY and to nobody else: `holder_id` is
   * null on every one of them by design (records/holderScope.ts), and
   * `is_global` is false because the write omits the holder rather than sending
   * an explicit "All members". So all three member answers came up empty and
   * the Document Manager rendered '-' in the Holder column — directly below an
   * upload form that had just said "Belongs to: <company>".
   */
  const meta = (open: Record<string, unknown> = {}) => ({ open }) as any;

  it('answers with the company for a business row', () => {
    expect(holderDisplayName(
      { companyId: COMPANY, company: { name: 'HSKTechlab' } },
      meta(),
    )).toBe('HSKTechlab');
  });

  it('says so even when the read did not join the name', () => {
    // Better than falling through to a member answer that cannot be right for
    // a record the company owns.
    expect(holderDisplayName({ companyId: COMPANY }, meta())).toBe('This company');
  });

  it('prefers the company over a typed holder_name', () => {
    // The business specs DO declare `holder_name`, so a business record can
    // carry one — but an employee named on a certificate is not who the record
    // belongs to. Ordering matters here, which is why it is pinned.
    expect(holderDisplayName(
      { companyId: COMPANY, company: { name: 'HSKTechlab' } },
      meta({ holder_name: 'Rachana' }),
    )).toBe('HSKTechlab');
  });

  it('leaves the personal answers exactly as they were', () => {
    expect(holderDisplayName({ holder: { name: 'Priya' } }, meta())).toBe('Priya');
    expect(holderDisplayName({}, meta({ holder_name: 'Arjun' }))).toBe('Arjun');
    expect(holderDisplayName({ isGlobal: true }, meta())).toBe('All members');
    expect(holderDisplayName({}, meta())).toBeNull();
  });

  it('a personal row is never called a company', () => {
    // The guard on the guard: `companyId` absent must not read as truthy.
    expect(holderDisplayName({ companyId: null }, meta())).toBeNull();
  });

  it('both Document Manager reads join the company name', () => {
    // `documentDisplay` derives the column, and it can only answer from what
    // the query selected. Source-level for the same reason as the checks above.
    for (const path of ['src/app/api/documents/route.ts', 'src/app/api/documents/[id]/route.ts']) {
      expect(read(path), path).toMatch(/company:\s*\{\s*columns:\s*\{\s*name:\s*true/);
    }
  });
});

describe('bulk scan sends a holder', () => {
  const page = read('src/app/documents/bulk-scan/page.js');

  it('posts one per record', () => {
    // The save route has destructured `holderId` all along; the grid simply
    // never populated it, so every scanned record landed with holder_id NULL.
    // Via `rowHolderForWrite`, which is `holderForWrite` plus the row lookup —
    // the grid is the one surface whose answer is per row rather than per form.
    expect(page).toMatch(/holderId: rowHolderForWrite\(/);
    expect(page).toMatch(/holderForWrite\(companyId, rowHolder\(record\)\)/);
  });

  it('takes each row\'s holder from that row alone', () => {
    // The batch-wide "apply to all" picker is gone — every record answers
    // "Belongs to" on its own row — but what it had to protect still holds.
    // `/api/ai/scan` resolves the OCR'd name to a member and sets `holderId`
    // per record; nothing may overwrite that match, and no unmatched row may be
    // seeded into looking answered when nobody has answered for it.
    expect(page).not.toMatch(/batchHolderId/);
    expect(page).not.toMatch(/holderId: r\.holderId \?\?/);
  });
});

describe('the picker is reachable by every role', () => {
  it('the picker reads /api/members, not the admin-gated /api/users', () => {
    // The fetch lives in the shared store now — one request for however many
    // pickers a page renders — so that is where the route is asserted.
    const store = read('src/hooks/useMembers.ts');
    expect(store).toMatch(/'\/api\/members'/);
    expect(store).not.toMatch(/'\/api\/users'/);

    // The picker itself must not have grown its own fetch back.
    const cmp = read('src/app/components/HolderSelect.jsx');
    expect(cmp).toMatch(/useMembers\(\)/);
    expect(cmp).not.toMatch(/fetch\(/);
    expect(cmp).not.toMatch(/'\/api\/users'/);
  });

  it('gates the add-member button on the same role that gates creating one', () => {
    // The "+" opens the Members add dialog, and POST /api/users is
    // TENANT_ADMIN-only. Rendering it for anyone else offers an action the
    // server will refuse, so the flag is answered by /api/members rather than
    // guessed at in the browser.
    const route = read('src/app/api/members/route.ts');
    expect(route).toMatch(/canAddMembers = user\.role === 'TENANT_ADMIN'/);
    const cmp = read('src/app/components/HolderSelect.jsx');
    expect(cmp).toMatch(/canAddMembers && \(/);
    // It sits inside record <form>s whose submit saves the record.
    expect(cmp).toMatch(/type="button"/);
  });

  it('/api/members is tenant-scoped and returns name only', () => {
    // The query is shared with the scan's matcher and the write-side check,
    // so it lives in records/workspaceMembers.ts and the route calls it.
    const route = read('src/app/api/members/route.ts');
    expect(route).toMatch(/workspaceMembers\(user\.tenantId, scope\.companyId\)/);
    const shared = read('src/lib/records/workspaceMembers.ts');
    expect(shared).toMatch(/withTenant\(tenantId/);
    expect(shared).toMatch(/eq\(users\.tenantId, tenantId\)/);
    // A picker has no business seeing permissions, profile or a password hash.
    // The one extra column is the sign-in flag, and it leaves as a boolean.
    expect(shared).toMatch(/select\(\{ id: users\.id, name: users\.name, signInDisabledAt: users\.signInDisabledAt \}\)/);
    expect(shared).toMatch(/signInDisabled: !!signInDisabledAt/);
    expect(shared).not.toMatch(/passwordHash|permissions|profile/);
  });

  it('every module page uses the shared picker', () => {
    const missing: string[] = [];
    for (const mod of RECORD_SCOPE_KEYS) {
      const path = `src/app/${mod.replace(/_/g, '-')}/page.js`;
      if (!existsSync(join(ROOT, path))) continue;
      if (!/HolderSelect/.test(read(path))) missing.push(path);
    }
    expect(missing).toEqual([]);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A SCAN ANSWERS "BELONGS TO", OR SAYS IT COULD NOT                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Category and sub-category have always arrived pre-selected from a scan.
 * "Belongs to" did not — it sat on a silent "All members" default, so a
 * document belonging to one person was filed against the whole household
 * whenever nobody thought to touch the picker, indistinguishably from a
 * deliberate choice.
 *
 * The rule now, on all three upload surfaces: the scan fills it in when the
 * document names a member, and when it cannot, the control goes red and the
 * save is refused until somebody answers. Source-level, like the guards above —
 * a surface that quietly reintroduces a default is the failure being prevented,
 * and that is visible in the source.
 */
describe('the scan fills "Belongs to" in, or the form refuses', () => {
  const ADD_SURFACES = [
    'src/app/components/CategoryRecordForm.jsx',
    'src/app/documents/page.js',
    'src/app/documents/bulk-scan/page.js',
  ];

  it('every upload surface makes the picker required', () => {
    // The JSX boolean prop on its own line, not merely the word somewhere in
    // the file — a comment about something being required is not the guard.
    const missing = ADD_SURFACES.filter((p) => !/^\s+required$/m.test(read(p)));
    expect(missing).toEqual([]);
  });

  it('no add form opens on a silent "All members" default', () => {
    // `useState(ALL_MEMBERS)` is exactly the default this replaced. The EDIT
    // pickers are a different question — a stored null genuinely means the
    // all members there — so only the add state is pinned.
    const docs = read('src/app/documents/page.js');
    expect(docs).toMatch(/const \[holderId, setHolderId\] = useState\(''\)/);
    // The scan grid has no batch default to open on at all: a row is answered
    // by its own picker, or it reads as unanswered and blocks the save.
    const scan = read('src/app/documents/bulk-scan/page.js');
    expect(scan).toMatch(/const rowHolder = \(record\) => record\?\.holderId \?\? '';/);
  });

  it('names the person it could not place, from one shared wording', () => {
    // The message is built in HolderSelect so the three surfaces cannot each
    // invent their own, and it names the scanned name because "no member
    // is called Rajesh Kumar" is actionable where a red box is not.
    const picker = read('src/app/components/HolderSelect.jsx');
    expect(picker).toMatch(/export function unmatchedHolderError/);
    for (const path of ADD_SURFACES) {
      expect(read(path)).toMatch(/unmatchedHolderError/);
    }
  });

  it('serves that wording from what the routes actually send back', () => {
    // Every read route answers with the name it READ, not only the member it
    // matched — without it the red state has nothing to name.
    expect(read('src/app/api/ai/scan/route.js')).toMatch(/holderNameFromScan = readHolderName\(rec\)/);

    // The trim lives in `runAutofill`, shared by the two single-document
    // routes so they cannot answer differently about the same file.
    expect(read('src/lib/records/autofillRun.ts'))
      .toMatch(/holderName: typeof result\?\.holderName === 'string'/);
    for (const path of [
      'src/app/api/modules/[moduleKey]/[documentKey]/autofill/route.ts',
      'src/app/api/documents/autofill/route.ts',
    ]) {
      expect(read(path)).toMatch(/holderName/);
    }
  });

  it('asks the model for a holder name in EVERY scan category', () => {
    // Seven of the seventeen categories declared a person field; the rest
    // could never pre-select a holder at all until the prompt asked for one.
    const ai = read('src/lib/ai.js');
    expect(ai).toMatch(/"holderName": "<the person this record is about/);
  });

  it('bulk scan refuses to save a record that belongs to nobody', () => {
    const page = read('src/app/documents/bulk-scan/page.js');
    // The pre-flight, for a permission or a picker that changed under a screen
    // left open, and the button, which is the thing the user actually sees.
    expect(page).toMatch(/if \(unassignedRecords\.length > 0\) \{/);
    expect(page).toMatch(/disabled=\{needAttention\.length > 0\}/);
  });

  it('the sub-category form goes red at scan time, not only at save time', () => {
    // Waiting for Save to refuse is late: the fix is a dropdown that is on
    // screen the moment the read comes back.
    const form = read('src/app/components/CategoryRecordForm.jsx');
    expect(form).toMatch(/holderId: unmatchedHolderError\(json\.holderName\)/);
    expect(form).toMatch(/setTouched\(\(prev\) => \(\{ \.\.\.prev, holderId: true \}\)\)/);
  });

  it('a scanned match says it was scanned', () => {
    // A field that fills itself in has to say so, or a holder nobody
    // remembers choosing is a holder nobody thinks to check.
    expect(read('src/app/components/CategoryRecordForm.jsx')).toMatch(/holderFromScan &&/);
    expect(read('src/app/documents/page.js')).toMatch(/holderFromScan &&/);
    expect(read('src/app/documents/bulk-scan/page.js')).toMatch(/holderMatchedFromScan &&/);
  });
});
