/**
 * The growth chart behind the dashboard, for ONE workspace.
 *
 * `?companyId=` selects it, exactly as on `/api/dashboard` — the two are read
 * together by one page component and would be describing different accounts if
 * only one of them took the parameter.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { documents } from '@/db/schema';
import { eq, gte, and } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { inCompany } from '@/lib/records/handler';
import { resolveUtilityCompany } from '@/lib/records/companyScope';
import { serverError } from '@/lib/routeError';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    // Proven, not taken off the URL — the same gate `/api/dashboard` uses.
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    const { tenantId } = user;

    // Get date for 4 months ago
    const fourMonthsAgo = new Date();
    fourMonthsAgo.setMonth(fourMonthsAgo.getMonth() - 3); // 0-indexed offset for current month + 3 prev months
    fourMonthsAgo.setDate(1);
    fourMonthsAgo.setHours(0, 0, 0, 0);

    // Fetch documents created in the last 4 months
    const docs = await db.query.documents.findMany({
      where: and(
        eq(documents.tenantId, tenantId),
        // ONE workspace's line. Counting a company's records on the household's
        // chart would plot documents shown nowhere else on that page — and
        // leave the company's own chart unable to say anything different.
        inCompany(scope.companyId),
        visibleDocument(),
        gte(documents.createdAt, fourMonthsAgo)
      ),
      columns: {
        createdAt: true,
      }
    });

    // Bucket into months
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    
    // Initialize buckets for the last 4 months (including current)
    const growthBuckets: Record<string, number> = {};
    for (let i = 3; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const key = `${monthNames[d.getMonth()]}`;
      growthBuckets[key] = 0;
    }

    // Populate buckets
    docs.forEach(doc => {
      if (doc.createdAt) {
        const monthKey = monthNames[doc.createdAt.getMonth()];
        if (growthBuckets[monthKey] !== undefined) {
          growthBuckets[monthKey]++;
        }
      }
    });

    // Format for Recharts [{ name: 'Jan', value: 5 }, ...]
    const growthData = Object.keys(growthBuckets).map(key => ({
      name: key,
      value: growthBuckets[key]
    }));

    return NextResponse.json({ success: true, growthData });
  } catch (error) {
    return serverError(error, 'loading growth');
  }
}
