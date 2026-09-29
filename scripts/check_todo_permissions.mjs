/**
 * READ-ONLY: what each STANDARD member may do to To-Dos, and how many they hold.
 *
 * The complaint this answers: "a member created a task, assigned it to
 * themself, and cannot tick it off". Ticking is `PUT /api/todos/:id` and used
 * to require `can_edit` on the member's `todos` module-default row — the
 * Contributor rung (view + add, no edit) that every new member is seeded with
 * reproduces the symptom exactly. Since the owner rule landed in that route a
 * member may tick their own task regardless, but this still shows whether a
 * "Full access" grant the admin believes they saved actually reached the row.
 *
 *   node scripts/check_todo_permissions.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const q = async (label, sql) => {
  const { rows } = await client.query(sql);
  console.log(`\n── ${label}`);
  console.table(rows);
};

await q('todos permission per standard member', `
  SELECT t.name AS tenant, u.email, u.account_scope,
         p.document_key, p.can_view, p.can_add, p.can_edit, p.can_delete, p.can_share,
         (SELECT count(*) FROM todos td WHERE td.creator_id = u.id)  AS created,
         (SELECT count(*) FROM todos td WHERE td.assignee_id = u.id) AS assigned
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id
    LEFT JOIN permissions p ON p.user_id = u.id AND p.module = 'todos'
   WHERE u.role = 'STANDARD' AND u.deleted_at IS NULL
   ORDER BY t.name, u.email, p.document_key NULLS FIRST`);

await q('standard members with NO todos row at all (hasPermission denies them outright)', `
  SELECT t.name AS tenant, u.email, u.account_scope
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id
   WHERE u.role = 'STANDARD' AND u.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM permissions p
                      WHERE p.user_id = u.id AND p.module = 'todos' AND p.document_key IS NULL)
   ORDER BY 1, 2`);

await client.end();
