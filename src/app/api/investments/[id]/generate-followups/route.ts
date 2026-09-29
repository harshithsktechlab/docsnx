/**
 * Turn a Investment record's due dates into assignable to-dos.
 *
 * The dates are no longer read from a per-module table with a hardcoded rule
 * per column. A record carries its own `reminders` array — derived when it was
 * written, one entry per date the module marks as a deadline — so this route
 * reads them and creates one to-do per unresolved reminder.
 *
 * Adding a new kind of reminder is a line in the field map; this file does not
 * change.
 */
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { todos } from '@/db/schema';
import { getRecord, withRecordScope } from '@/lib/records/handler';
import { remindersDueOnRecord } from '@/lib/records/followUps';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

const MODULE = 'investments';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Creating to-dos for a record is an edit of that record's follow-ups.
  return withRecordScope(req, MODULE, 'edit', async (ctx) => {
    try {
      const record = await getRecord(ctx, id);
      if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      // Each reminder against ITS OWN window — the record's `alert_days_before`,
      // then the field's configured lead, then the dictionary's. A single
      // hardcoded fifteen days here would disagree with /follow-up, which is
      // reading the same reminders through the same chain.
      const due = await remindersDueOnRecord(record);

      if (due.length === 0) {
        return NextResponse.json({
          success: true, created: 0,
          message: 'Nothing is due yet on this record.',
        });
      }

      const created = await withTenant(ctx.user.tenantId, async (tx) => {
        const rows = [];
        for (const reminder of due) {
          // One to-do per reminder, and not a second one on the next click:
          // the task text is derived, so an identical pending task means this
          // has already been generated.
          const task = `${reminder.label}: ${record.title}`;
          const [existing] = await tx.select({ id: todos.id })
            .from(todos)
            .where(and(
              eq(todos.tenantId, ctx.user.tenantId),
              eq(todos.task, task),
              eq(todos.status, 'PENDING'),
            ))
            .limit(1);
          if (existing) continue;

          const [row] = await tx.insert(todos).values({
            tenantId: ctx.user.tenantId,
            task,
            dueDate: reminder.date ? new Date(reminder.date) : null,
            status: 'PENDING',
            assigneeId: record.holderId ?? record.userId,
            creatorId: ctx.user.id,
            pushNotification: false,
          }).returning();
          rows.push(row);
        }
        return rows;
      });

      await writeAudit({
        tenantId: ctx.user.tenantId,
        userId: ctx.user.id,
        action: ACTIONS.todo.create,
        details: auditSentence('create', {
          kind: `${created.length} follow-up task${created.length === 1 ? '' : 's'}`,
          note: `for the record "${record.title}"`,
        }),
        req,
        entityType: 'documents',
        entityId: id,
      });

      return NextResponse.json({ success: true, created: created.length, tasks: created });
    } catch (error) {
      return serverError(error, 'saving generate followups');
    }
  });
}
