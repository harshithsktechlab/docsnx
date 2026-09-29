/**
 * The single writer for the `audit_logs` table.
 *
 * AGENTS.md §7 requires an audit row after every mutation. Before this helper
 * existed there were 98 hand-rolled inserts, none of which recorded the client
 * IP and most of which ran outside the mutation's transaction. Use writeAudit()
 * for every new audit row; do not insert into `auditLogs` directly.
 *
 * The pure action vocabulary + parsing helpers live in `./auditActions` so they
 * can also be imported by client components — this module pulls in `db` (and
 * therefore `pg`) and must stay server-only.
 */

import { db } from '@/lib/db';
import { auditLogs } from '@/db/schema';
import { getClientIp } from '@/lib/clientIp';

export {
  ACTIONS,
  parseAuditAction,
  auditActionVariant,
  formatAuditAction,
  auditEntityLabel,
  auditVerbLabel,
  auditSentence,
  categoryPhrase,
  recordAction,
} from './auditActions';
export type { ParsedAuditAction, AuditSubject } from './auditActions';

/** Matches the varchar(500) width of audit_logs.user_agent. */
const MAX_USER_AGENT = 500;

/** Matches the varchar(255) width of audit_logs.action. */
const MAX_ACTION = 255;

/** Matches the varchar(255) width of audit_logs.resource. */
const MAX_RESOURCE = 255;

/** Matches the varchar(100) width of audit_logs.entity_type. */
const MAX_ENTITY_TYPE = 100;

/**
 * Anything that can run the insert: the pooled `db`, or a Drizzle transaction
 * client. Structural (`Pick`) rather than `typeof db` because a real
 * `PgTransaction` is not assignable to `NodePgDatabase` — routes that call
 * `db.transaction()` directly pass one, while `withTenant` casts to `typeof db`.
 */
export type AuditExecutor = Pick<typeof db, 'insert'>;

export interface AuditEntry {
  /** Canonical `<entity>.<verb>` action — import from ACTIONS. */
  action: string;
  /**
   * Human-readable sentence describing what happened. NOT NULL in the schema.
   *
   * BUILD THIS WITH `auditSentence()` — never by hand. One grammar for the whole
   * trail is the only thing that keeps "Uploaded", "Added" and "Created" from
   * all meaning create again, and the builder is what guarantees a record is
   * named by its title and a person by their name rather than by a UUID.
   * tests/auditPhrasing.test.ts enforces it.
   *
   * Keep sensitive values out of this string: audit rows are not encrypted and
   * are never purged, so anything interpolated here outlives and out-scopes the
   * record it came from.
   */
  details: string;
  /**
   * Owning tenant. MUST come from the authenticated `user.tenantId` — never
   * from a request body, query string, or route param (AGENTS.md §6).
   */
  tenantId: string;
  /** Acting user, or null/undefined for system, webhook and cron events. */
  userId?: string | null;
  /**
   * Which workspace this happened in. NULL/omitted = the household.
   *
   * What gives /audit-logs a tab per company. Pass the id the route has ALREADY
   * PROVEN — the one `resolveUtilityCompany` or `companyIdFromRequest` returned
   * — never a value re-read off the request here. This function has no `user`
   * to check it against and must not be the place access is decided.
   *
   * Omitting it on a company-scoped mutation is not a crash, it is a MISFILING:
   * the row lands in the household's tab. That is the failure mode to watch for
   * when adding a call site.
   */
  companyId?: string | null;
  /** Table or module the event concerns, e.g. "documents". */
  entityType?: string | null;
  /** Primary key of the affected record. No FK, so it may dangle by design. */
  entityId?: string | null;
  /** Free-form secondary label, e.g. "GoogleDrive". */
  resource?: string | null;
  /** Source of ipAddress + userAgent. Omit for events with no HTTP request. */
  req?: Request;
}

/**
 * Append a row to the audit trail.
 *
 * Pass the enclosing transaction whenever the audited mutation runs inside
 * `withTenant`, so the audit row commits atomically with the change it
 * describes:
 *
 *   await withTenant(user.tenantId, async (tx) => {
 *     const [doc] = await tx.insert(documents).values(...).returning();
 *     await writeAudit({ ...entry, entityType: 'documents', entityId: doc.id }, tx);
 *   });
 *
 * Failure behaviour is deliberately asymmetric:
 *   - inside a transaction, errors propagate (atomicity is the whole point);
 *   - outside one, errors are logged and swallowed, so a failed audit write
 *     can never fail an already-committed mutation.
 */
export async function writeAudit(entry: AuditEntry, executor: AuditExecutor = db): Promise<void> {
  if (!entry.tenantId) {
    throw new Error('writeAudit: tenantId is required (use the authenticated user.tenantId).');
  }

  const values = {
    tenantId: entry.tenantId,
    userId: entry.userId ?? null,
    companyId: entry.companyId ?? null,
    action: entry.action.slice(0, MAX_ACTION),
    resource: entry.resource ? entry.resource.slice(0, MAX_RESOURCE) : null,
    entityType: entry.entityType ? entry.entityType.slice(0, MAX_ENTITY_TYPE) : null,
    entityId: entry.entityId ?? null,
    details: entry.details,
    ipAddress: entry.req ? getClientIp(entry.req) : null,
    userAgent: entry.req
      ? (entry.req.headers.get('user-agent')?.slice(0, MAX_USER_AGENT) ?? null)
      : null,
  };

  const inTransaction = executor !== db;

  if (inTransaction) {
    await executor.insert(auditLogs).values(values);
    return;
  }

  try {
    await executor.insert(auditLogs).values(values);
  } catch (error) {
    // The mutation this describes has already committed — never rethrow.
    console.error('writeAudit failed (audit row dropped):', entry.action, error);
  }
}
