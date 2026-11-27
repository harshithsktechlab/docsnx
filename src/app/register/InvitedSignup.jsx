'use client';

import React, { useEffect, useState } from 'react';
import { Mail, MessageCircle, ArrowRight, Loader2, RefreshCw, Users, PlusCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import OtpInput from '@/app/components/OtpInput';
import { toast } from 'sonner';
import { setFlash } from '@/lib/flashToast';
import { cn } from '@/lib/utils';
import { clientRegister, clientVerifyInvite, clientCompleteInvite } from '@/lib/clientAuth';
import { boxLabel, codeBoxes } from '@/lib/otpForm';
import { resolveRegisterOutcome } from '@/lib/registerOutcome';
import {
  invitedCodePayload, alreadyAddedSentence, invitedDestination,
} from '@/lib/invitedSignupForm';

const RESEND_SECONDS = 60;

/**
 * What /register shows to someone an admin already added: first the code that
 * proves the invited contact, then the choice between that workspace and an
 * account of their own.
 *
 * Shown IN PLACE of the form rather than on a page of its own, so the password
 * they typed stays in memory and is sent only once they have proved who they
 * are. A reload starts again from the form.
 *
 * @param details     what the register form posted
 * @param initialView which codes went out and where
 * @param onBack      return to the form, optionally saying why
 */
export default function InvitedSignup({ details, initialView, onBack }) {
  const [view, setView] = useState(initialView);
  const [codes, setCodes] = useState({ email: '', phone: '' });
  /** `{ token, invitations }` once a code has been accepted. */
  const [claim, setClaim] = useState(null);
  const [selected, setSelected] = useState('');
  /** Which request is in flight: 'verify' | 'workspace' | 'own' | ''. */
  const [busy, setBusy] = useState('');
  const [resending, setResending] = useState(false);
  const [countdown, setCountdown] = useState(RESEND_SECONDS);
  const [error, setError] = useState('');

  useEffect(() => {
    if (countdown <= 0) return undefined;
    const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const boxes = codeBoxes(view).filter((box) => box !== 'single');

  const handleVerify = async (e) => {
    e.preventDefault();
    const payload = invitedCodePayload(view, codes);
    if (!payload) {
      setError('Enter the complete 6-digit code.');
      return;
    }
    setError('');
    setBusy('verify');
    const res = await clientVerifyInvite({
      email: details.email, phoneNumber: details.phoneNumber, ...payload,
    });
    setBusy('');
    if (!res.success) {
      setError(res.error || 'Could not check that code.');
      return;
    }
    setClaim({ token: res.token, invitations: res.invitations });
    setSelected(res.invitations[0]?.seatId || '');
  };

  const handleResend = async () => {
    if (countdown > 0 || resending) return;
    setError('');
    setCodes({ email: '', phone: '' });
    setResending(true);
    // The same request that sent the first code.
    const res = await clientRegister(details);
    setResending(false);
    const outcome = resolveRegisterOutcome(res, details.email);
    if (outcome.kind !== 'invited') {
      setError(res.error || 'Could not send a new code.');
      return;
    }
    setView(outcome.view);
    setCountdown(RESEND_SECONDS);
    toast.success('A new code has been sent.', { id: 'invite-resend' });
  };

  const handleChoose = async (choice) => {
    setError('');
    setBusy(choice);
    const res = await clientCompleteInvite({
      ...details,
      token: claim.token,
      choice,
      seatId: choice === 'workspace' ? selected : undefined,
    });
    if (!res.success) {
      setBusy('');
      if (res.restart) {
        onBack(res.error);
        return;
      }
      setError(res.error || 'Could not finish signing you up.');
      return;
    }
    const destination = invitedDestination(res, details.email);
    setFlash(destination.flash);
    // A full navigation: the shell loads afresh against the new session.
    window.location.assign(destination.href);
  };

  const errorBox = error ? (
    <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive break-words">
      {error}
    </p>
  ) : null;

  if (claim) {
    const invitation = claim.invitations.find((i) => i.seatId === selected) || claim.invitations[0];
    const several = claim.invitations.length > 1;
    return (
      <div className="flex flex-col gap-5">
        <div className="text-center">
          <h2 className="text-lg font-extrabold tracking-tight">You have already been added</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {several
              ? 'You have already been added as a user of these workspaces.'
              : alreadyAddedSentence(invitation)}
            {' '}Do you want to continue with {several ? 'one of them' : 'that workspace'}, or create
            your own account first?
          </p>
        </div>

        {several && (
          <fieldset className="flex flex-col gap-2" disabled={!!busy}>
            <legend className="sr-only">Workspace to continue with</legend>
            {claim.invitations.map((option) => (
              <label
                key={option.seatId}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 text-sm',
                  option.seatId === selected ? 'border-primary bg-primary/10' : 'border-border/60',
                )}
              >
                <input
                  type="radio"
                  name="invitation"
                  checked={option.seatId === selected}
                  onChange={() => setSelected(option.seatId)}
                />
                <span className="min-w-0">
                  <span className="block font-bold break-words">{option.workspaceName}</span>
                  {option.inviterName && (
                    <span className="block text-xs text-muted-foreground">Added by {option.inviterName}</span>
                  )}
                </span>
              </label>
            ))}
          </fieldset>
        )}

        {errorBox}

        <Button
          type="button"
          onClick={() => handleChoose('workspace')}
          disabled={!!busy}
          className="h-auto min-h-11 w-full whitespace-normal py-2.5 text-base"
        >
          {busy === 'workspace' ? <Loader2 size={17} className="animate-spin" /> : <Users size={17} />}
          Continue with {invitation.workspaceName}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => handleChoose('own')}
          disabled={!!busy}
          className="h-auto min-h-11 w-full whitespace-normal py-2.5 text-base"
        >
          {busy === 'own' ? <Loader2 size={17} className="animate-spin" /> : <PlusCircle size={17} />}
          Create my own account first
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          {several
            ? 'You can reach your other workspaces later from the account menu.'
            : `If you create your own account, you can still switch to ${invitation.workspaceName} from the account menu.`}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleVerify} className="flex flex-col gap-5">
      <div className="text-center">
        <h2 className="text-lg font-extrabold tracking-tight">Enter your verification code</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {boxes.length > 1
            ? 'We sent a code to your email and another to your WhatsApp. Either one is enough.'
            : 'We sent you a 6-digit code.'}
        </p>
      </div>

      {errorBox}

      {boxes.map((box) => (
        <div key={box} className="flex flex-col gap-2">
          <span className="flex items-center justify-center gap-2 text-xs font-semibold text-muted-foreground">
            {box === 'email'
              ? <Mail className="w-3.5 h-3.5 shrink-0" />
              : <MessageCircle className="w-3.5 h-3.5 shrink-0" />}
            <span className="break-all">{boxLabel(box, view)}</span>
          </span>
          <OtpInput
            value={codes[box]}
            onChange={(next) => {
              setError('');
              setCodes((prev) => ({ ...prev, [box]: next }));
            }}
            autoFocus={box === boxes[0]}
            ariaLabel={boxLabel(box, view)}
          />
        </div>
      ))}

      <Button type="submit" disabled={!!busy} className="w-full h-11 text-base">
        {busy ? (
          <><Loader2 size={17} className="animate-spin" /> Verifying...</>
        ) : (
          <>Verify &amp; Continue <ArrowRight size={17} /></>
        )}
      </Button>

      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={handleResend}
          disabled={countdown > 0 || resending}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80 disabled:text-muted-foreground disabled:cursor-not-allowed transition-colors"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', resending && 'animate-spin')} />
          {countdown > 0 ? `Resend code in ${countdown}s` : resending ? 'Sending...' : 'Resend code'}
        </button>
        <button
          type="button"
          onClick={() => onBack()}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Use different details
        </button>
      </div>
    </form>
  );
}
