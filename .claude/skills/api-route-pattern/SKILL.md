---
name: api-route-pattern
description: >-
  The canonical Next.js App Router route-handler pattern for docsnx API routes
  (src/app/api/**/route.ts). Read BEFORE creating or editing any route handler.
  Covers the auth → permission → zod → withTenant → encrypt → audit → strip-
  secrets pipeline, the pagination helper, soft-delete, and error shape. Triggers
  on: "route.ts", "API route", "GET/POST/PUT/DELETE handler", "NextResponse",
  "new endpoint".
---

# docsnx API route pattern

Every route handler is an exported named function (`GET`/`POST`/`PUT`/`DELETE`).
Follow this exact order. Reference implementation: `src/app/api/passwords/route.ts`.

## Skeleton

```ts
import { NextRequest, NextResponse } from 'next/server';
import { db, withTenant } from '@/lib/db';
import { passwords, auditLogs } from '@/db/schema';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import { encrypt } from '@/lib/encryption';
import { eq, and, isNull, count } from 'drizzle-orm';
import { parseQueryParams, buildListQueryHelper } from '@/lib/api-pagination';
import { z } from 'zod';

const bodySchema = z.object({
  title: z.string().min(1).max(255),
  password: z.string().min(1),
  userId: z.string().uuid().optional().nullable(),
});

export async function POST(req: NextRequest) {
  try {
    // 1. AuthN
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // 2. AuthZ — before any data access
    if (!(await hasPermission(user, 'passwords', 'add')))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // 3. Validate
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success)
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

    // 4. Encrypt sensitive fields
    const passwordEncrypted = encrypt(parsed.data.password);

    // 5. Tenant-scoped write (RLS + explicit predicate) + 6. audit, same tx
    const created = await withTenant(user.tenantId, async (tx) => {
      const [row] = await tx.insert(passwords).values({
        tenantId: user.tenantId,               // from session, NEVER the body
        userId: parsed.data.userId ?? user.id,
        title: parsed.data.title,
        passwordEncrypted,
      }).returning();
      await tx.insert(auditLogs).values({
        tenantId: user.tenantId, userId: user.id,
        action: 'password.create', details: `Created password ${row.id}`,
      });
      return row;
    });

    // 7. Strip secrets from the response
    const { passwordEncrypted: _omit, ...safe } = created;
    return NextResponse.json({ success: true, password: safe }, { status: 201 });
  } catch (error) {
    console.error('Create password error:', error);          // server-side only
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
```

## List (GET) specifics
- Parse with `parseQueryParams(req)` + `buildListQueryHelper(table, params, [searchable cols])`.
- `where = and(eq(table.tenantId, user.tenantId), isNull(table.deletedAt), …filters)`.
- Return `{ success: true, <items>, pagination: { page, limit, totalCount, totalPages } }`.
- Do NOT decrypt secrets in list views; strip `passwordEncrypted`/`cards`/etc.

## `[id]` routes
Scope by id AND tenantId (`and(eq(t.id, params.id), eq(t.tenantId, user.tenantId))`).
Deletes are soft (`set deletedAt = now()`), still tenant-scoped, still audited.

## Hard rules
- tenant/user scoping comes from `user`, never the request payload.
- never return `passwordHash`, `passwordEncrypted`, `cards`, tokens, OTPs.
- never leak internal error text/stack to the client.
- validate every body with zod; coerce query params.

See also: `tenant-isolation`, `field-encryption`, `zero-trust-privacy` skills.
