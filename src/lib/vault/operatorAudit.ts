import { basename } from 'path';
import { writeAudit } from '@/lib/audit';
import { ACTIONS, auditSentence } from '@/lib/auditActions';

/**
 * Records that an operator ran a maintenance script against a tenant's Drive.
 *
 * Every other audit row is a tenant acting on their own account. This one is us
 * acting on theirs. Before it, a diagnostic could walk a tenant's entire folder
 * tree and leave no trace that anybody had looked — on a platform holding
 * medical and financial records.
 *
 * ── WHAT THIS IS WORTH, STATED HONESTLY ───────────────────────────────────
 * Accountability, NOT access control. Anyone with shell access on this box can
 * call the Drive API directly and never come near this function. It makes
 * legitimate operator work reviewable after the fact; it prevents nothing. A
 * control that is described as more than it is, is worse than no control,
 * because someone will rely on it.
 *
 * There is deliberately no `--no-audit` flag anywhere: a switch that disables
 * the record of your own access is the one feature this must not have.
 *
 * ── METADATA ONLY ─────────────────────────────────────────────────────────
 * Never a file name, never a path. Drive folder names are category codes
 * (`biz_registration/pan_card`), so they reveal what KINDS of document a tenant
 * holds — a known limitation of the layout that must not be copied into a
 * second table where it would outlive the folder. Counts and script names only.
 *
 * `userId` is null: a script has an operator, not a session, and inventing a
 * user id would make the trail claim more than it knows.
 */
export async function auditOperatorDriveAccess(input: {
  tenantId: string;
  /** Pass `process.argv[1]`; only the basename is stored. */
  scriptPath: string;
  /** Flags the run was given, e.g. `['--apply']`. Values are not inspected. */
  argv: string[];
  /** How many Drive objects were looked at, and how many were changed. */
  inspected: number;
  changed?: number;
}): Promise<void> {
  const script = basename(input.scriptPath);
  const flags = input.argv.filter((arg) => arg.startsWith('--'));

  // A COUNT, not a list. The per-record naming rule the bulk routes follow
  // would mean writing the category of every object touched — the one thing
  // this row must not carry.
  const note = [
    `${script}${flags.length ? ` ${flags.join(' ')}` : ''}`,
    `${input.inspected} object(s) inspected`,
    input.changed ? `${input.changed} changed` : null,
  ].filter(Boolean).join(', ');

  // `writeAudit` already swallows its own failures and never rethrows, which is
  // the behaviour this needs: a dropped audit row must not abort the
  // investigation it was describing.
  await writeAudit({
    tenantId: input.tenantId,
    userId: null,
    action: ACTIONS.google_drive.operator_inspect,
    resource: script,
    entityType: 'google_drive',
    details: auditSentence('operator_inspect', { kind: 'Google Drive', note }),
  });
}
