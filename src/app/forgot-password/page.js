'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { APP_MARK, APP_NAME } from '@/lib/brand';
import { Mail, AlertCircle, ArrowRight, Loader2, Shield, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { apiCall } from '@/lib/net/apiRequest';

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // "This account was deleted on <date>" — kept on screen, not only toasted,
  // because a reset link is the one thing that can never arrive for it.
  const [erased, setErased] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email) {
      toast.error('Please enter your email address', { id: 'forgot-validation' });
      return;
    }

    setLoading(true);
    setErased('');

    try {
      const { res: response, json: data } = await apiCall('/api/auth/forgot-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email }),
      });

      setLoading(false);

      if (response.ok && data.success) {
        toast.success(data.message || 'Password reset link sent! Check your inbox.', { id: 'forgot-sent' });
        setEmail('');
      } else if (data?.accountErased) {
        // 410: the account was erased. Nothing to reset, and the generic
        // "if the email exists" sentence would send them to wait on an
        // inbox for a link that cannot come.
        setErased(data.error || 'This account was permanently deleted.');
        toast.error(data.error || 'This account was permanently deleted.', { id: 'forgot-sent', duration: 8000 });
      } else {
        toast.error(data.error || 'Failed to request password reset. Please try again.', { id: 'forgot-sent' });
      }
    } catch (err) {
      setLoading(false);
      toast.error('An unexpected error occurred. Please try again.', { id: 'forgot-sent' });
      console.error('Forgot password submission error:', err);
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
                Enter your email to receive a password reset link
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

            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">Email Address</Label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground flex">
                    <Mail size={16} />
                  </span>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={loading}
                    className="pl-10"
                    autoComplete="email"
                  />
                </div>
              </div>

              <Button type="submit" disabled={loading} className="w-full h-11 text-base mt-1">
                {loading ? (
                  <>
                    <Loader2 size={17} className="animate-spin" />
                    Sending link...
                  </>
                ) : (
                  <>
                    Send Reset Link
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
