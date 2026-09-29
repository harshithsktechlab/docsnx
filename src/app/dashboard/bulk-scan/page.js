/**
 * The scanner moved to /documents/bulk-scan, where the document manager lives.
 *
 * This stub stays because the old path is in the wild: the PWA service worker
 * shipped it, and it was linked from four places for as long as the feature has
 * existed. A redirect is cheaper than a broken bookmark.
 *
 * `/dashboard/bulk-scan` must therefore REMAIN in TENANT_SPECIFIC_PATHS
 * (src/lib/moduleRegistry.js) — the new path needs no entry of its own because
 * `/documents` is already there and the guard matches on prefix.
 */
import { redirect } from 'next/navigation';

export default function BulkScanMoved() {
  redirect('/documents/bulk-scan');
}
