'use client';

/**
 * `/business/<companyId>/documents/bulk-scan` — Power Scan, for one company.
 *
 * The SAME component as `/documents/bulk-scan`. The company on the path decides
 * three things, all of them server-side: which taxonomy the classifier is shown
 * (so it proposes `biz_*` sub-categories, never Identity or Medical), which
 * categories the review grid offers, and which vault the saved records are
 * sealed into.
 *
 * A company has no `other/uncategorized` catch-all — that module is the
 * household's — so a page the model cannot place comes back with no category
 * for the member to choose one, rather than being filed somewhere nobody will
 * look for it.
 */
import BulkScanPage from '@/app/documents/bulk-scan/page';

export default function BusinessBulkScanPage() {
  return <BulkScanPage />;
}
