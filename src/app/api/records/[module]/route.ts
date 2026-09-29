/**
 * The generic record collection: `GET /api/records/:module`.
 *
 * `:module` is one of the fifteen record modules, validated against the
 * registry BEFORE authentication — the segment decides which rows the request
 * can reach, so an unrecognised one is a 404 rather than a query input.
 *
 * The eighteen legacy routes are thin adapters over this; they exist so the
 * pages keep the field names and envelopes they already read.
 */
import { NextResponse } from 'next/server';
import { parseQueryParams } from '@/lib/api-pagination';
import { LIST_ROW_CEILING, listRecords, withRecordScope } from '@/lib/records/handler';
import { recordScopeConfig } from '@/lib/records/registry';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { driveReauthResponse, storageLimitResponse } from '@/lib/uploadErrors';
import { serverError } from '@/lib/routeError';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ module: string }> },
) {
  const { module } = await params;
  return withRecordScope(req, module, 'view', async (ctx) => {
    try {
      const q = parseQueryParams(req);
      const { records, total, truncated } = await listRecords(ctx, {
        filters: q.filters,
        page: q.page,
        limit: q.limit,
        search: q.search,
      });

      return NextResponse.json({
        success: true,
        records,
        // The envelope each module's page already expects, so an adapter is a
        // rename rather than a reshape.
        [recordScopeConfig(module).legacyEnvelope]: records,
        pagination: {
          page: q.page,
          limit: q.limit,
          totalCount: total,
          totalPages: Math.max(1, Math.ceil(total / q.limit)),
        },
          // Present ONLY when the ceiling was hit, so the shape is unchanged
          // for every normal response. A page that ignores it behaves exactly
          // as before; one that reads it can say the list is partial rather
          // than letting the user believe it is all of them.
          ...(truncated ? { truncated: true, ceiling: LIST_ROW_CEILING } : {}),
      });
    } catch (error) {
      // Drive is the source of truth, so its failures are the interesting ones
      // and carry their own status and retryable flag.
      const vault = vaultErrorResponse(error);
      if (vault) return vault;
      const outOfSpace = storageLimitResponse(error);
      if (outOfSpace) return outOfSpace;
      const reauth = driveReauthResponse(error);
      if (reauth) return reauth;
      return serverError(error, 'loading records');
    }
  });
}
