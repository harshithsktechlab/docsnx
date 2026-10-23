'use client';

/**
 * Invitations to join another account, waiting for this person's answer (0082).
 *
 * An admin added them by a mobile number / email that already has an account
 * here. Nothing is verified again — they are signed in, which is the proof — so
 * the whole interaction is Accept or Decline. Accepting moves them into the
 * other account's switcher; declining gives the seat back to the admin.
 */
import { useState } from 'react';
import { MailPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { clientRespondToInvite } from '@/lib/clientMemberships';

export default function PendingInvites({ invites = [], onAnswered }) {
  const [busy, setBusy] = useState(null);

  if (!invites.length) return null;

  const answer = async (invite, action) => {
    setBusy(invite.userId);
    const res = await clientRespondToInvite(invite.userId, action);
    setBusy(null);
    if (!res.success) {
      toast.error(res.error || 'Could not answer this invitation.');
      return;
    }
    toast.success(action === 'accept' ? `You joined ${invite.tenantName}.` : 'Invitation declined.');
    onAnswered?.();
  };

  return (
    <div role="region" aria-label="Invitations" className="flex flex-col gap-2 border-b border-border bg-primary/5 px-4 py-3">
      {invites.map((invite) => (
        <div key={invite.userId} className="flex flex-wrap items-center gap-3">
          <MailPlus size={16} className="shrink-0 text-primary" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-sm text-foreground">
            You were invited to join <strong className="font-bold">{invite.tenantName}</strong>.
          </p>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" disabled={busy === invite.userId} onClick={() => answer(invite, 'accept')}>
              Accept
            </Button>
            <Button size="sm" variant="outline" disabled={busy === invite.userId} onClick={() => answer(invite, 'decline')}>
              Decline
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
