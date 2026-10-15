'use client';

/**
 * /activate — an invited member sets up their account (0071).
 *
 * Three short steps, each one screen:
 *   1. their registered mobile number or email;
 *   2. the 6-digit code, sent to WhatsApp AND email wherever they have one —
 *      either code works;
 *   3. a password of their own, after which they are signed in.
 *
 * The invite link carries no secret. Owning the number or the inbox is the
 * proof, which is why the link can be forwarded harmlessly.
 */
import React, { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { APP_MARK, APP_NAME } from '@/lib/brand';
import {
  ArrowRight, CheckCircle, KeyRound, Loader2, Lock, MessageCircle, Shield, User,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { apiCall } from '@/lib/net/apiRequest';

const STEP_TITLES = {
  identify: ['Set up your', 'account'],
  code: ['Enter your', 'code'],
  password: ['Choose a', 'password'],
};

export default function ActivatePage() {
  // useSearchParams needs a Suspense boundary for the static build.
  return <Suspense fallback={null}><ActivateFlow /></Suspense>;
}

function ActivateFlow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [step, setStep] = useState('identify');
  // Prefilled when login sent them here with what they typed.
  const [identifier, setIdentifier] = useState(() => searchParams.get('identifier') || '');
  const [hints, setHints] = useState({ emailHint: '', phoneHint: '' });
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [firstName, setFirstName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const post = async (url, body) => {
    setLoading(true);
    setError('');
    try {
      const { res, json } = await apiCall(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { ok: res.ok && json?.success, json: json || {} };
    } finally {
      setLoading(false);
    }
  };

  const sendCode = async (e) => {
    e?.preventDefault();
    if (!identifier.trim()) { setError('Enter your registered mobile number or email.'); return; }
    const { ok, json } = await post('/api/auth/activate/start', { identifier: identifier.trim() });
    if (!ok) { setError(json.error || 'Could not send a code. Please try again.'); return; }
    setHints({ emailHint: json.emailHint || '', phoneHint: json.phoneHint || '' });
    setCode('');
    setStep('code');
    if (e === undefined) toast.success('A new code is on its way.');
  };

  const checkCode = async (e) => {
    e.preventDefault();
    const { ok, json } = await post('/api/auth/activate/verify', { identifier: identifier.trim(), code });
    if (!ok) { setError(json.error || 'That code did not work.'); return; }
    setToken(json.token);
    setFirstName(json.name || '');
    setStep('password');
  };

  const finish = async (e) => {
    e.preventDefault();
    if (password.length < 8) { setError('Use at least 8 characters.'); return; }
    if (password !== confirm) { setError('The two passwords do not match.'); return; }
    const { ok, json } = await post('/api/auth/activate/complete', { token, password });
    if (!ok) {
      setError(json.error || 'Could not save your password.');
      if (json.restart) { setStep('identify'); setToken(''); }
      return;
    }
    toast.success('You are all set — welcome to DocsNX!');
    router.replace('/dashboard');
  };

  const sentTo = [
    hints.phoneHint && `WhatsApp ${hints.phoneHint}`,
    hints.emailHint && hints.emailHint,
  ].filter(Boolean).join(' and ');

  const [lead, accent] = STEP_TITLES[step];

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-background px-4 py-8">
      <div className="fixed top-0 left-0 w-[500px] h-[500px] rounded-full bg-primary/5 blur-[120px] pointer-events-none -translate-x-1/2 -translate-y-1/2" />
      <div className="fixed bottom-0 right-0 w-[400px] h-[400px] rounded-full bg-accent/5 blur-[100px] pointer-events-none translate-x-1/4 translate-y-1/4" />

      <div className="w-full max-w-[420px] animate-scale-in">
        <Card className="border-border/50 shadow-glass">
          <CardContent className="p-8">
            <div className="flex flex-col items-center text-center mb-6">
              <Link href="/" aria-label="DocsNX home" className="relative mb-5 block rounded-lg">
                <img src={APP_MARK} alt={APP_NAME} className="w-auto h-16 object-contain" />
                <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-primary rounded-full flex items-center justify-center">
                  <Shield size={10} className="text-white" />
                </div>
              </Link>
              <h1 className="text-3xl font-extrabold tracking-tight mb-1">
                {lead} <span className="gradient-text">{accent}</span>
              </h1>
              <p className="text-muted-foreground text-sm">
                {step === 'identify' && 'You were added as a member. Enter the mobile number or email your family admin registered for you.'}
                {step === 'code' && (sentTo
                  ? `We sent a 6-digit code to ${sentTo}. Either one works.`
                  : 'If this number or email belongs to an invited member, a 6-digit code is on its way.')}
                {step === 'password' && `${firstName ? `Hi ${firstName}! ` : ''}Pick a password you will use to sign in.`}
              </p>
            </div>

            {/* Progress: three dots, the current one wide. */}
            <div className="mb-6 flex justify-center gap-1.5" aria-hidden>
              {['identify', 'code', 'password'].map((s) => (
                <span
                  key={s}
                  className={`h-1.5 rounded-full transition-all ${s === step ? 'w-8 bg-primary' : 'w-1.5 bg-muted-foreground/30'}`}
                />
              ))}
            </div>

            {error && (
              <p role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground">
                {error}
              </p>
            )}

            {step === 'identify' && (
              <form onSubmit={sendCode} className="flex flex-col gap-5">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="identifier">Mobile number or email</Label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground flex"><User size={16} /></span>
                    <Input
                      id="identifier"
                      placeholder="+91 98765 43210 or you@example.com"
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      disabled={loading}
                      className="pl-10"
                      autoComplete="username"
                      autoFocus
                    />
                  </div>
                </div>
                <Button type="submit" disabled={loading} className="w-full h-11 text-base">
                  {loading ? <><Loader2 size={17} className="animate-spin" /> Sending code…</> : <>Send me a code <ArrowRight size={17} /></>}
                </Button>
              </form>
            )}

            {step === 'code' && (
              <form onSubmit={checkCode} className="flex flex-col gap-5">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="code">6-digit code</Label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground flex"><MessageCircle size={16} /></span>
                    <Input
                      id="code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      placeholder="••••••"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      disabled={loading}
                      className="pl-10 tracking-[0.4em] text-lg"
                      autoFocus
                    />
                  </div>
                </div>
                <Button type="submit" disabled={loading || code.length !== 6} className="w-full h-11 text-base">
                  {loading ? <><Loader2 size={17} className="animate-spin" /> Checking…</> : <>Continue <ArrowRight size={17} /></>}
                </Button>
                <div className="flex justify-between text-sm">
                  <button type="button" className="text-muted-foreground hover:text-foreground bg-transparent border-none cursor-pointer p-0" onClick={() => { setStep('identify'); setError(''); }}>
                    Change number/email
                  </button>
                  <button type="button" disabled={loading} className="text-primary font-semibold hover:underline bg-transparent border-none cursor-pointer p-0" onClick={() => sendCode()}>
                    Resend code
                  </button>
                </div>
              </form>
            )}

            {step === 'password' && (
              <form onSubmit={finish} className="flex flex-col gap-5">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="password">New password</Label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground flex"><Lock size={16} /></span>
                    <Input id="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={loading} className="pl-10" autoFocus />
                  </div>
                  <p className="text-xs text-muted-foreground">At least 8 characters.</p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="confirm">Confirm password</Label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground flex"><KeyRound size={16} /></span>
                    <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={loading} className="pl-10" />
                  </div>
                </div>
                <Button type="submit" disabled={loading} className="w-full h-11 text-base">
                  {loading ? <><Loader2 size={17} className="animate-spin" /> Saving…</> : <>Save and sign in <CheckCircle size={17} /></>}
                </Button>
              </form>
            )}

            <div className="mt-6 text-center">
              <button onClick={() => router.push('/login')} className="text-primary font-semibold hover:underline underline-offset-4 text-sm bg-transparent border-none cursor-pointer">
                Already set up? Sign in
              </button>
            </div>
          </CardContent>
        </Card>
        <p className="text-center text-xs text-muted-foreground mt-4 flex items-center justify-center gap-1.5">
          <Shield size={10} />
          End-to-end encrypted · Your data stays private
        </p>
      </div>
    </main>
  );
}
