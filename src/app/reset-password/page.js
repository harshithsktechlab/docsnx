'use client';
import { PasswordInput } from '@/components/ui/password-input';

import React, { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { APP_MARK, APP_NAME } from '@/lib/brand';
import { KeyRound, AlertCircle, ArrowRight, Loader2, Shield, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { setFlash } from '@/lib/flashToast';
import { apiCall } from '@/lib/net/apiRequest';

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!token) {
      toast.error('Password reset token is missing. Please use the link sent to your email.', { id: 'reset-validation' });
      return;
    }
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
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token, newPassword: password }),
      });

      setLoading(false);

      if (response.ok && data.success) {
        // ── SAID ON THE SIGN-IN PAGE, WHICH IS WHERE IT IS ACTED ON ────────
        // The two-second wait existed only so this sentence could be read
        // before the redirect took it away — which is why it had to announce
        // the redirect too. Handing it to /login instead lets the navigation
        // happen at once, and turns "Redirecting to login…" into the one
        // instruction that still applies once they are there.
        setFlash({
          message: 'Password reset. Please sign in with your new password.',
          type: 'success',
          pin: '/login',
          tag: 'reset-done',
        });
        // Latches the form shut so a double submit cannot re-post a spent token.
        setSuccess('done');
        router.push('/login');
      } else {
        toast.error(data.error || 'Invalid or expired token. Please request a new link.', { id: 'reset-failed' });
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
                New <span className="gradient-text">Password</span>
              </h1>
              <p className="text-muted-foreground text-sm">
                Enter your new password below
              </p>
            </div>



            {/* Form */}
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
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
                    disabled={loading || !!success}
                    className="pl-10"
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
                    disabled={loading || !!success}
                    className="pl-10"
                  />
                </div>
              </div>

              <Button type="submit" disabled={loading || !!success} className="w-full h-11 text-base mt-1">
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

            {/* Back to Login Link */}
            <div className="mt-6 text-center">
              <button
                onClick={() => router.push('/login')}
                className="text-primary font-semibold hover:underline underline-offset-4 text-sm transition-colors bg-transparent border-none cursor-pointer"
                disabled={loading}
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

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen flex flex-col items-center justify-center bg-background px-4 py-8">
        <Loader2 className="animate-spin text-primary" size={32} />
      </main>
    }>
      <ResetPasswordForm />
    </Suspense>
  );
}
