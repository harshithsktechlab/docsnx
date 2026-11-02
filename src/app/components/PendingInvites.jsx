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

/**
 * Accept / decline an invitation. Shared by the banner and the bell so both
 * answer the same way: toast, then `onAnswered` (the shell reloads to pick up
 * the new switcher).
 */
export function useInviteResponder(onAnswered) {
  const [busy, setBusy] = useState(null);

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

  return { busy, answer };
}

export default function PendingInvites({ invites = [], onAnswered }) {
  const { busy, answer } = useInviteResponder(onAnswered);

  if (!invites.length) return null;

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
