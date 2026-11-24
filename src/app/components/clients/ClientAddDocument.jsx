'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ADD A DOCUMENT FOR THIS CLIENT — which type?                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The client page lists the client's documents in one table, so the document types
 * are no longer a grid of tiles to click. Adding is a button instead: it asks which
 * TYPE (only the ones this company ticked for this kind of client, plus Others),
 * then opens that type's add form — `/clients/<id>/<documentKey>?add=1`, where the
 * ordinary sub-category workspace (its form, its scan, its field rules) takes over.
 *
 * Disabled with the reason while nothing is ticked for this kind of client:
 * configuring comes first, and the server refuses the add as well.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CLIENT_CATCH_ALL_KEY } from '@/lib/clientCategories';

/**
 * @param {{
 *   clientId: string,
 *   companyId: string,
 *   groups: { moduleKey: string, moduleName: string, items: { documentKey: string, documentName: string, enabled: boolean }[] }[],
 *   canAdd: boolean,
 *   blockedMessage?: string | null,
 * }} props
 */
export default function ClientAddDocument({ clientId, companyId, groups, canAdd, blockedMessage = null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  // The types that can take a new document: ticked ones, grouped as everywhere else.
  const choices = useMemo(() => groups
    .map((g) => ({ ...g, items: g.items.filter((i) => i.enabled) }))
    .filter((g) => g.items.length > 0), [groups]);

  const q = filter.trim().toLowerCase();
  const visible = useMemo(() => choices
    .map((g) => ({
      ...g,
      items: q && !g.moduleName.toLowerCase().includes(q)
        ? g.items.filter((i) => i.documentName.toLowerCase().includes(q))
        : g.items,
    }))
    .filter((g) => g.items.length > 0), [choices, q]);

  const go = (documentKey) => {
    setOpen(false);
    router.push(`/business/${companyId}/clients/${clientId}/${documentKey}?add=1`);
  };

  if (!canAdd) return null;

  return (
    <>
      <Button
        className="gap-2"
        onClick={() => { setFilter(''); setOpen(true); }}
        disabled={Boolean(blockedMessage)}
        title={blockedMessage || 'Add a document for this client'}
      >
        <Plus size={15} /> Add document
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined} className="max-w-lg max-h-[85vh] flex flex-col gap-3">
          <DialogHeader>
            <DialogTitle>Add a document</DialogTitle>
            <DialogDescription>Which kind of document is it?</DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find a document type"
              className="pl-9"
              aria-label="Find a document type"
              autoFocus
            />
          </div>

          <div className="flex-1 overflow-y-auto flex flex-col gap-3 pr-1">
            {visible.map((g) => (
              <div key={g.moduleKey} className="flex flex-col gap-1">
                <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{g.moduleName}</h3>
                {g.items.map((i) => (
                  <button
                    key={i.documentKey}
                    type="button"
                    onClick={() => go(i.documentKey)}
                    className="text-left rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:border-primary/50 hover:bg-accent/30 transition-colors"
                  >
                    {i.documentName}
                  </button>
                ))}
              </div>
            ))}
            {(!q || 'others'.includes(q)) && (
              <div className="flex flex-col gap-1">
                <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Other</h3>
                <button
                  type="button"
                  onClick={() => go(CLIENT_CATCH_ALL_KEY)}
                  className="text-left rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:border-primary/50 hover:bg-accent/30 transition-colors"
                >
                  Others
                </button>
              </div>
            )}
            {q && visible.length === 0 && !'others'.includes(q) && (
              <p className="text-sm text-muted-foreground">No document types match.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
