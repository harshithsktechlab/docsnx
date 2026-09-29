'use client';

import React, { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { APP_MARK, APP_NAME } from '@/lib/brand';
import BrandWordmark from '@/app/components/BrandWordmark';
import { clientLogin } from '@/lib/clientAuth';
import { KeyRound, Mail, AlertCircle, ArrowRight, Loader2, Shield, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { setFlash } from '@/lib/flashToast';
function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // An email address OR a registered mobile number — named for what it holds,
  // since it has never been only an email.
  //
  // Seeded from `?identifier=`, which /register appends to its "Sign in
  // instead" link when the address someone tried to sign up with already has
  // an account (src/lib/registerOutcome.ts). Without it that hop hands them an
  // empty box and asks them to type, again, the thing they were just told was
  // taken. Initial value only — it never fights what they type afterwards.
  const [identifier, setIdentifier] = useState(() => (searchParams.get('identifier') || '').trim());
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  // The sentence for an account that no longer exists — "deleted on <date>".
  // Kept on screen under the form rather than only in a toast: the next thing
  // this person does is read it twice and then look for the Register link.
  const [erased, setErased] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!identifier || !password) {
      toast.error('Please fill in all fields', { id: 'login-validation' });
      return;
    }
    setError('');
    setErased('');
    setLoading(true);
    const typed = identifier.trim();
    const res = await clientLogin(typed, password);
    setLoading(false);
    if (res.success) {
      // Pinned to the dashboard on purpose. Shell's gates can divert this
      // navigation — a lapsed plan to /billing, an unfinished workspace to the
      // wizard — and on those arrivals the gate's own sentence is the one worth
      // reading; "Login successful!" would be the second message on top of it.
      // Pinning means it is simply not shown there. See src/lib/flashToast.ts.
      setFlash({ message: 'Login successful!', type: 'success', pin: '/dashboard', tag: 'login-ok' });
      router.push('/dashboard');
    } else if (res.verificationUndeliverable) {
      // The account needs verifying but the code could not be sent — a member
      // whose WhatsApp gateway is down. Sending them to the verify screen would
      // sit them in front of six empty boxes waiting for a message that never
      // left, so they stay here with the error and the one instruction that
      // helps: ask the admin who added them.
      setError(res.error || 'Verification code could not be sent.');
      toast.error(res.error || 'Verification code could not be sent.', { id: 'login-failed' });
    } else if (res.requireVerification) {
      // Read on the verify screen this branch is about to open.
      setFlash({
        message: res.error || 'Please verify your account.',
        type: 'info',
        pin: '/verify-email',
        tag: 'login-verify',
      });
      // Carry the masked destinations through so the verify screen can name
      // where the code went. `identifier` is what they actually typed — that is
      // what verify/resend post back, so a member who signed in with their
      // mobile is never asked for an email address they may not know.
      const query = new URLSearchParams({ identifier: res.email || typed });
      if (res.emailHint) query.set('emailHint', res.emailHint);
      if (res.phoneHint) query.set('phoneHint', res.phoneHint);
      // How MANY code boxes to draw. A tenant admin owes one code per channel
      // since 0052, and without these the verify screen falls back to a single
      // box — which would post one code for a challenge that needs two.
      if (res.needsEmailCode) query.set('needsEmailCode', 'true');
      if (res.needsPhoneCode) query.set('needsPhoneCode', 'true');
      router.push(`/verify-email?${query.toString()}`);
    } else if (res.accountErased) {
      // 410 from the route: no live account, but the retention table says
      // there was one. Not "Invalid credentials" — the password is not the
      // problem and no amount of retyping it will help. The register link is
      // the only useful next step, so it is right under the sentence.
      setErased(res.error || 'This account was permanently deleted.');
      toast.error(res.error || 'This account was permanently deleted.', {
        id: 'login-failed',
        duration: 8000,
      });
    } else {
      const errorMsg = res.error || 'Invalid credentials';
      if (res.reference) {
        toast.error(errorMsg, {
          id: 'login-failed',
          description: `Quote reference ${res.reference} when contacting support.`,
          duration: 6000,
        });
      } else {
        toast.error(errorMsg, { id: 'login-failed' });
      }
    }
  };

  return (
    <main className="min-h-screen w-full flex">
      {/* Login Form */}
      <div className="w-full flex flex-col items-center justify-center bg-background px-4 py-8 relative">
        {/* Ambient glows */}
        <div className="absolute top-0 left-0 w-[500px] h-[500px] rounded-full bg-primary/5 blur-[120px] pointer-events-none -translate-x-1/2 -translate-y-1/2" />
        <div className="absolute bottom-0 right-0 w-[400px] h-[400px] rounded-full bg-accent/5 blur-[100px] pointer-events-none translate-x-1/4 translate-y-1/4" />

        <div className="w-full max-w-[420px] animate-scale-in relative z-10">
        <Card className="border-border/50 shadow-glass">
          <CardContent className="p-8">
            {/* Logo & Title */}
            <div className="flex flex-col items-center text-center mb-8">
              <Link href="/" aria-label="DocsNX home" className="relative mb-5 block rounded-lg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                <img src={APP_MARK} alt={APP_NAME} className="w-auto h-16 object-contain" />
                <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-primary rounded-full flex items-center justify-center">
                  <Shield size={10} className="text-white" />
                </div>
              </Link>
              <h1 className="text-3xl font-extrabold tracking-tight mb-1">
                Welcome to{' '}
                <BrandWordmark />
              </h1>
              <p className="text-muted-foreground text-sm">
                Access your personal &amp; business control center
              </p>
            </div>



            {erased && (
              <div
                role="alert"
                className="mb-5 flex gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3.5 text-sm"
              >
                <AlertCircle size={18} className="mt-0.5 shrink-0 text-destructive" />
                <div className="flex flex-col gap-2">
                  <p className="text-foreground">{erased}</p>
                  <button
                    type="button"
                    onClick={() => router.push('/register')}
                    className="self-start text-primary font-semibold hover:underline underline-offset-4 bg-transparent border-none cursor-pointer p-0"
                  >
                    Create a new account →
                  </button>
                </div>
              </div>
            )}

            {/* Form */}
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="identifier">Email Address or Mobile Number</Label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground flex">
                    <Mail size={16} />
                  </span>
                  <Input
                    id="identifier"
                    type="text"
                    placeholder="you@example.com or 9876543210"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    disabled={loading}
                    className="pl-10"
                    autoComplete="username"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  <button
                    type="button"
                    onClick={() => router.push('/forgot-password')}
                    className="text-xs text-primary font-semibold hover:underline bg-transparent border-none cursor-pointer"
                    disabled={loading}
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground flex">
                    <KeyRound size={16} />
                  </span>
                  <PasswordInput
                    id="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={loading}
                    className="pl-10"
                    autoComplete="current-password"
                  />
                </div>
              </div>

              <Button type="submit" disabled={loading} className="w-full h-11 text-base mt-1">
                {loading ? (
                  <>
                    <Loader2 size={17} className="animate-spin" />
                    Authenticating...
                  </>
                ) : (
                  <>
                    Sign In
                    <ArrowRight size={17} />
                  </>
                )}
              </Button>
            </form>

            {/* Register Link */}
            <div className="mt-6 text-center">
              <p className="text-muted-foreground text-sm">
                New to DocsNX?{' '}
                <button
                  onClick={() => router.push('/register')}
                  className="text-primary font-semibold hover:underline underline-offset-4 transition-colors bg-transparent border-none cursor-pointer font-inherit"
                >
                  Create an Account
                </button>
              </p>
            </div>
            
            <div className="mt-4 text-center text-xs text-muted-foreground">
              By logging in, you agree to our <a href="/terms" className="underline hover:text-primary transition-colors">Terms of Service</a> and <a href="/privacy" className="underline hover:text-primary transition-colors">Privacy Policy</a>.
            </div>
          </CardContent>
        </Card>

        {/* Security Footer */}
        <div className="flex flex-col items-center gap-2 mt-4">
          <p className="text-center text-xs text-muted-foreground flex items-center justify-center gap-1.5">
            <Shield size={10} />
            End-to-end encrypted · Your data stays private
          </p>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <a href="/privacy" className="hover:text-primary transition-colors">Privacy Policy</a>
            <a href="/terms" className="hover:text-primary transition-colors">Terms of Service</a>
          </div>
        </div>
      </div>
      </div>
    </main>
  );
}

/**
 * `useSearchParams` opts a page into client rendering, and Next 15 fails the
 * build unless the boundary is explicit. Same wrapper as /verify-email and
 * /reset-password, which read their query the same way.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-background" />}>
      <LoginContent />
    </Suspense>
  );
}
