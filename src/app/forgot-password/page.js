'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { APP_MARK, APP_NAME } from '@/lib/brand';
import { Mail, KeyRound, MessageSquare, AlertCircle, ArrowRight, Loader2, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { setFlash } from '@/lib/flashToast';
import { apiCall } from '@/lib/net/apiRequest';

/** Mirrors the server's resend cooldown (src/lib/passwordResetOtp.ts). */
const RESEND_SECONDS = 60;

const STEP_COPY = {
  request: 'Enter your email or mobile number and we will send you a verification code',
  code: 'Enter the 6-digit code we sent you on WhatsApp or by email',
  password: 'Choose a new password',
};

export default function ForgotPasswordPage() {
  const router = useRouter();
  // 'request' → 'code' → 'password'. Three screens on one page so the person
  // never leaves the flow, and the token from step 2 never touches a URL.
  const [step, setStep] = useState('request');
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // "This account was deleted on <date>" — kept on screen, not only toasted,
  // because a code is the one thing that can never arrive for it.
  const [erased, setErased] = useState('');
  const [loading, setLoading] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (secondsLeft <= 0) return undefined;
    const timer = setTimeout(() => setSecondsLeft((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  /** Ask for a code. Used by the first screen and by Resend. */
  const requestCode = async () => {
    setLoading(true);
    setErased('');
    try {
      const { res: response, json: data } = await apiCall('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: identifier.trim() }),
      });
      setLoading(false);

      if (response.ok && data.success) {
        toast.success(data.message || 'A verification code has been sent.', { id: 'forgot-sent' });
        setCode('');
        setSecondsLeft(RESEND_SECONDS);
        setStep('code');
      } else if (data?.accountErased) {
        // 410: the account was erased. Nothing to reset, and the generic
        // "if an account exists" sentence would send them to wait on a code
        // that cannot come.
        setErased(data.error || 'This account was permanently deleted.');
        toast.error(data.error || 'This account was permanently deleted.', { id: 'forgot-sent', duration: 8000 });
      } else {
        toast.error(data.error || 'Failed to send a code. Please try again.', { id: 'forgot-sent' });
      }
    } catch (err) {
      setLoading(false);
      toast.error('An unexpected error occurred. Please try again.', { id: 'forgot-sent' });
      console.error('Forgot password submission error:', err);
    }
  };

  const handleRequest = (e) => {
    e.preventDefault();
    if (!identifier.trim()) {
      toast.error('Please enter your email or mobile number', { id: 'forgot-validation' });
      return;
    }
    requestCode();
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      toast.error('Enter the 6-digit code', { id: 'forgot-validation' });
      return;
    }
    setLoading(true);
    try {
      const { res: response, json: data } = await apiCall('/api/auth/forgot-password/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: identifier.trim(), otp: code }),
      });
      setLoading(false);

      if (response.ok && data.success && data.token) {
        setResetToken(data.token);
        setStep('password');
      } else {
        toast.error(data.error || 'Invalid or expired code. Please request a new one.', { id: 'forgot-verify' });
      }
    } catch (err) {
      setLoading(false);
      toast.error('An unexpected error occurred. Please try again.', { id: 'forgot-verify' });
      console.error('Forgot password verify error:', err);
    }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    if (!password || !confirmPassword) {
      toast.error('Please fill in all fields', { id: 'reset-validation' });
      return;
    }
    if (password !== confirmPassword) {
      toast.error('Passwords do not match', { id: 'reset-validation' });
      return;
    }
    if (password.length < 8) {
      toast.error('Password must be at least 8 characters long', { id: 'reset-validation' });
      return;
    }
    setLoading(true);
    try {
      const { res: response, json: data } = await apiCall('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, newPassword: password }),
      });
      setLoading(false);

      if (response.ok && data.success) {
        // Said on the sign-in page, which is where it is acted on.
        setFlash({
          message: 'Password reset. Please sign in with your new password.',
          type: 'success',
          pin: '/login',
          tag: 'reset-done',
        });
        // Spent token: drop it so a double submit cannot re-post it.
        setResetToken('');
        router.push('/login');
      } else {
        toast.error(data.error || 'Invalid or expired session. Please start again.', { id: 'reset-failed' });
        setStep('request');
      }
    } catch (err) {
      setLoading(false);
      toast.error('An unexpected error occurred. Please try again.', { id: 'reset-failed' });
      console.error('Reset password submission error:', err);
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-background px-4 py-8">
      {/* Ambient glows */}
      <div className="fixed top-0 left-0 w-[500px] h-[500px] rounded-full bg-primary/5 blur-[120px] pointer-events-none -translate-x-1/2 -translate-y-1/2" />
      <div className="fixed bottom-0 right-0 w-[400px] h-[400px] rounded-full bg-accent/5 blur-[100px] pointer-events-none translate-x-1/4 translate-y-1/4" />

      <div className="w-full max-w-[420px] animate-scale-in">
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
                Reset <span className="gradient-text">Password</span>
              </h1>
              <p className="text-muted-foreground text-sm">
                {STEP_COPY[step]}
              </p>
            </div>



            {/* Form */}
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

            {step === 'request' && (
              <form onSubmit={handleRequest} className="flex flex-col gap-5">
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

                <Button type="submit" disabled={loading} className="w-full h-11 text-base mt-1">
                  {loading ? (
                    <>
                      <Loader2 size={17} className="animate-spin" />
                      Sending code...
                    </>
                  ) : (
                    <>
                      Send Verification Code
                      <ArrowRight size={17} />
                    </>
                  )}
                </Button>
              </form>
            )}

            {step === 'code' && (
              <form onSubmit={handleVerify} className="flex flex-col gap-5">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="code">Verification Code</Label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground flex">
                      <MessageSquare size={16} />
                    </span>
                    <Input
                      id="code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      placeholder="123456"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      disabled={loading}
                      className="pl-10 tracking-[0.4em] text-lg"
                      autoFocus
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">The code expires in 5 minutes.</p>
                </div>

                <Button type="submit" disabled={loading || code.length !== 6} className="w-full h-11 text-base mt-1">
                  {loading ? (
                    <>
                      <Loader2 size={17} className="animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    <>
                      Verify Code
                      <ArrowRight size={17} />
                    </>
                  )}
                </Button>

                <div className="flex items-center justify-between text-sm">
                  <button
                    type="button"
                    onClick={() => { setStep('request'); setCode(''); }}
                    disabled={loading}
                    className="text-muted-foreground hover:underline underline-offset-4 bg-transparent border-none cursor-pointer"
                  >
                    Change number or email
                  </button>
                  <button
                    type="button"
                    onClick={requestCode}
                    disabled={loading || secondsLeft > 0}
                    className="text-primary font-semibold hover:underline underline-offset-4 bg-transparent border-none cursor-pointer disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
                  >
                    {secondsLeft > 0 ? `Resend in ${secondsLeft}s` : 'Resend code'}
                  </button>
                </div>
              </form>
            )}

            {step === 'password' && (
              <form onSubmit={handleReset} className="flex flex-col gap-5">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="password">New Password</Label>
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
                      autoFocus
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="confirmPassword">Confirm Password</Label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground flex">
                      <KeyRound size={16} />
                    </span>
                    <PasswordInput
                      id="confirmPassword"
                      placeholder="••••••••"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      disabled={loading}
                      className="pl-10"
                    />
                  </div>
                </div>

                <Button type="submit" disabled={loading} className="w-full h-11 text-base mt-1">
                  {loading ? (
                    <>
                      <Loader2 size={17} className="animate-spin" />
                      Resetting password...
                    </>
                  ) : (
                    <>
                      Reset Password
                      <ArrowRight size={17} />
                    </>
                  )}
                </Button>
              </form>
            )}

            {/* Back to Login Link */}
            <div className="mt-6 text-center">
              <button
                onClick={() => router.push('/login')}
                className="text-primary font-semibold hover:underline underline-offset-4 text-sm transition-colors bg-transparent border-none cursor-pointer"
              >
                Back to Sign In
              </button>
            </div>
          </CardContent>
        </Card>

        {/* Security Footer */}
        <p className="text-center text-xs text-muted-foreground mt-4 flex items-center justify-center gap-1.5">
          <Shield size={10} />
          End-to-end encrypted · Your data stays private
        </p>
      </div>
    </main>
  );
}
