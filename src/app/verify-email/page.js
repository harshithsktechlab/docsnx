'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { clientVerifyOtp, clientResendOtp } from '@/lib/clientAuth';
import {
  readChallengeView, codeBoxes, boxLabel, challengeHeadline,
  isComplete, verifyPayload, applyChallengeUpdate,
} from '@/lib/otpForm';
import { ShieldCheck, Mail, MessageCircle, ArrowRight, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import OtpInput from '@/app/components/OtpInput';
import { toast } from 'sonner';
import { setFlash } from '@/lib/flashToast';
import { VERIFIED_TAG } from '@/lib/arrivalNotice';

function VerifyEmailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // `identifier` is what the person actually signed in with — an email address
  // or a mobile number. `email` is the older param name; still read so a link
  // from a previous session or a bookmarked URL keeps working.
  const identifier = searchParams.get('identifier') || searchParams.get('email') || '';
  /**
   * ── A LEGACY PAIR, KEPT FOR THE SIGN-UPS ALREADY IN FLIGHT ────────────────
   * /register used to ask for a plan and a discount code and carry both through
   * here into checkout. It no longer does — plans and codes belong to /billing —
   * so nothing in the current bundle writes these params.
   *
   * They are still read because an installed PWA holds an older bundle for a
   * while (public/sw.js caches this app): someone who registered on it minutes
   * ago is sitting on a /verify-email URL with a plan and possibly a discount in
   * it, and dropping them would quietly lose the code they were promised.
   * Delete this once no cached bundle can still be producing the links.
   */
  const planParam = searchParams.get('plan') || '';
  const discountParam = searchParams.get('discount') || '';

  // Which codes this account owes and where they went — computed server-side and
  // carried here as params. See src/lib/otpForm.ts for the cold-start fallback.
  const [view, setView] = useState(() => readChallengeView((k) => searchParams.get(k)));
  const [codes, setCodes] = useState({ single: '', email: '', phone: '' });
  const [loading, setLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [countdown, setCountdown] = useState(60);

  const boxes = codeBoxes(view);

  useEffect(() => {
    let timer;
    if (countdown > 0) {
      timer = setTimeout(() => setCountdown(countdown - 1), 1000);
    }
    return () => clearTimeout(timer);
  }, [countdown]);

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    if (!isComplete(view, codes)) {
      // One id for both wordings: a second attempt on a still-incomplete form
      // replaces the message rather than stacking another copy behind it.
      toast.error(
        boxes.length > 1
          ? 'Please enter both 6-digit codes'
          : 'Please enter the complete 6-digit verification code',
        { id: 'verify-code' }
      );
      return;
    }

    setLoading(true);
    const res = await clientVerifyOtp(identifier, verifyPayload(view, codes));
    setLoading(false);

    if (res.success) {
      // ── SAID ON THE PAGE THAT FOLLOWS, NOT THIS ONE ────────────────────────
      // Both branches below navigate immediately, so this was only ever read on
      // the next screen — arriving part-expired and underneath whatever that
      // screen had to say. It is handed over instead (src/lib/flashToast.ts).
      //
      // Unpinned, and tagged: the destination is /billing today, but Shell's
      // gates may divert the navigation, and a gate that does takes the slot
      // over — `arrivalNotice` reads this tag so a just-verified admin sent to
      // the wizard is greeted once, not told twice.
      //
      // The sentence names the NEXT step, not only the one just finished:
      // "verified" alone, read on a page full of plan cards, left people
      // unsure whether they were meant to do anything there.
      if (planParam) {
        setFlash({
          message: 'Account verified — complete your payment to activate your workspace.',
          type: 'success',
          tag: VERIFIED_TAG,
        });
        const discountQuery = discountParam ? `&discount=${encodeURIComponent(discountParam)}` : '';
        router.push(`/billing?autoCheckout=${planParam}${discountQuery}`);
      } else {
        setFlash({
          message: 'Account verified — choose a plan to activate your workspace.',
          type: 'success',
          tag: VERIFIED_TAG,
        });
        // ── BILLING IS THE NEXT STEP, NOT THE DASHBOARD ────────────────────
        // A new account arrives with no plan, and Shell.js locks a plan-less
        // tenant to /billing ahead of the onboarding gate. Sending them
        // straight there skips a visible double redirect, and `welcome=1` is
        // what tells billing this is a first run rather than a lapsed plan —
        // otherwise a brand-new admin is greeted by an expiry notice for a
        // plan they never had.
        router.push('/billing?welcome=1');
      }
    } else if (res.alreadyVerified) {
      // No challenge outstanding — the route no longer hands out a session here,
      // so the only way forward is the sign-in form.
      setFlash({
        message: res.error || 'This account is already verified. Please sign in.',
        type: 'info',
        pin: '/login',
        tag: 'verify-already',
      });
      router.push('/login');
    } else {
      // A rejection can still be PROGRESS: a correct email code is banked even
      // when the WhatsApp one was wrong, and the response says what is left. So
      // the view is folded forward and the cleared box's digits are dropped —
      // leaving them would ask for a code that has already been redeemed.
      const next = applyChallengeUpdate(view, res);
      setView(next);
      setCodes((prev) => ({
        single: '',
        email: next.needsEmailCode ? prev.email : '',
        phone: next.needsPhoneCode ? prev.phone : '',
      }));
      // Stays here, where the boxes are — and shares `verify-code` with the
      // incomplete-form message above, since both are about this one attempt.
      toast.error(res.error || 'Invalid verification code', { id: 'verify-code' });
    }
  };

  const handleResend = async () => {
    if (countdown > 0 || resendLoading) return;
    setResendLoading(true);
    const res = await clientResendOtp(identifier);
    setResendLoading(false);

    if (res.success) {
      // The route answers the same way for an unknown identifier as for a real
      // one, so this toast must not claim more than it knows. It names the
      // channels only when the response actually carried destinations.
      const next = applyChallengeUpdate(view, res);
      setView(next);
      toast.success(
        next.needsEmailCode && next.needsPhoneCode
          ? 'New codes sent to your email and WhatsApp.'
          : next.needsPhoneCode
            ? 'New code sent to your WhatsApp.'
            : next.needsEmailCode
              ? 'New code sent to your email.'
              : 'New verification code sent.',
        { id: 'verify-resend' }
      );
      setCountdown(60);
    } else {
      toast.error(res.error || 'Failed to resend code', { id: 'verify-resend' });
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4 py-10 relative overflow-hidden">
      {/* Ambient glows */}
      <div className="absolute top-0 left-0 w-[500px] h-[500px] rounded-full bg-primary/5 blur-[120px] pointer-events-none -translate-x-1/2 -translate-y-1/2" />
      <div className="absolute bottom-0 right-0 w-[400px] h-[400px] rounded-full bg-accent/5 blur-[100px] pointer-events-none translate-x-1/4 translate-y-1/4" />

      <div className="w-full max-w-[440px] animate-scale-in relative z-10">
        <Card className="border-border/50 shadow-glass backdrop-blur-xl">
          <CardContent className="p-8">
            <div className="flex flex-col items-center text-center mb-8">
              <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-4 shadow-sm">
                <ShieldCheck className="w-7 h-7 text-primary animate-pulse" />
              </div>
              <h1 className="text-2xl font-extrabold tracking-tight mb-2 text-foreground">
                Verify Your Account
              </h1>
              <p className="text-muted-foreground text-sm max-w-xs">
                {challengeHeadline(view)}
              </p>

              {/*
                Reached when this page was opened directly rather than through a
                login redirect, so no hints came with it. Names what they typed
                rather than guessing a channel — a member verified over WhatsApp
                alone must never be sent to an inbox that will receive nothing.
              */}
              {boxes.includes('single') && identifier && (
                <span className="mt-4 text-sm text-muted-foreground break-all">
                  for {identifier}
                </span>
              )}
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-6">
              {boxes.map((box) => (
                <div key={box} className="flex flex-col gap-2">
                  {box !== 'single' && (
                    <span className="flex items-center justify-center gap-2 text-xs font-semibold text-muted-foreground">
                      {box === 'email'
                        ? <Mail className="w-3.5 h-3.5 shrink-0" />
                        : <MessageCircle className="w-3.5 h-3.5 shrink-0" />}
                      <span className="break-all">{boxLabel(box, view)}</span>
                    </span>
                  )}
                  <OtpInput
                    value={codes[box]}
                    onChange={(next) => setCodes((prev) => ({ ...prev, [box]: next }))}
                    autoFocus={box === boxes[0]}
                    ariaLabel={boxLabel(box, view)}
                  />
                </div>
              ))}

              <Button
                type="submit"
                disabled={loading}
                className="w-full h-11 text-base font-semibold shadow-md transition-transform active:scale-[0.99]"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  <>
                    Verify &amp; Continue
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </>
                )}
              </Button>
            </form>

            <div className="mt-8 pt-6 border-t border-border/40 text-center flex flex-col items-center gap-2">
              <p className="text-sm text-muted-foreground">
                {boxes.length > 1 ? "Didn't receive both codes?" : "Didn't receive the code?"}
              </p>
              <button
                type="button"
                onClick={handleResend}
                disabled={countdown > 0 || resendLoading}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80 disabled:text-muted-foreground disabled:cursor-not-allowed transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${resendLoading ? 'animate-spin' : ''}`} />
                {countdown > 0
                  ? `Resend code in ${countdown}s`
                  : resendLoading
                  ? 'Sending...'
                  : 'Resend Verification Code'}
              </button>
            </div>

            <div className="mt-4 flex items-center justify-center gap-3 text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() => router.push('/login')}
                className="hover:text-foreground transition-colors"
              >
                Back to Sign In
              </button>
              <span aria-hidden="true" className="opacity-40">•</span>
              {/*
                Only honest since /api/auth/register learned to replace a
                sign-up that never proved a single channel. Before that this
                link led straight back to "Email already registered" — the dead
                end that stranded anyone whose codes never arrived.
              */}
              <button
                type="button"
                onClick={() => router.push('/register')}
                className="hover:text-foreground transition-colors"
              >
                Use different details
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-background" />}>
      <VerifyEmailContent />
    </Suspense>
  );
}
