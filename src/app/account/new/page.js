'use client';

/**
 * /account/new — a member opens an account of their own (0082).
 *
 * For someone who was added to somebody's workspace and now wants their own
 * Personal (or Business) account under the SAME mobile number and email. They
 * are already signed in, so there is no password and no code to start: the new
 * account shares their sign-in. If it still owes a verification — an owner must
 * have proved their email as well as their mobile — the code is sent and they
 * finish on the usual verify screen.
 */
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import { clientCreateOwnAccount, clientSwitchTenant } from '@/lib/clientMemberships';

const TYPES = [
  { value: 'personal', label: 'Personal', hint: 'Your own documents and family records.' },
  { value: 'business', label: 'Business', hint: 'A company workspace with its own team.' },
  { value: 'both', label: 'Personal and Business', hint: 'Both, in one account.' },
];

export default function NewOwnAccountPage() {
  const router = useRouter();
  const [accountType, setAccountType] = useState('personal');
  const [companyName, setCompanyName] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Shown only after the server says the person has no email on file.
  const [needsEmail, setNeedsEmail] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!consent) {
      setError('Please accept the data processing consent to continue.');
      return;
    }
    setLoading(true);
    const res = await clientCreateOwnAccount({
      accountType,
      companyName: accountType !== 'personal' ? companyName : undefined,
      email: needsEmail ? email : undefined,
      consentDataProcessing: true,
    });

    if (!res.success) {
      setLoading(false);
      if (res.fieldErrors?.email) setNeedsEmail(true);
      setError(res.error || 'Could not open your account.');
      return;
    }

    if (res.requireVerification) {
      setLoading(false);
      const query = new URLSearchParams({ identifier: res.identifier || '' });
      if (res.emailHint) query.set('emailHint', res.emailHint);
      if (res.phoneHint) query.set('phoneHint', res.phoneHint);
      if (res.needsEmailCode) query.set('needsEmailCode', 'true');
      if (res.needsPhoneCode) query.set('needsPhoneCode', 'true');
      toast.success('Your account is ready. Enter the code we sent to finish verifying it.');
      router.push(`/verify-email?${query.toString()}`);
      return;
    }

    const moved = await clientSwitchTenant(res.userId);
    setLoading(false);
    if (!moved.success) {
      toast.error(moved.error || 'Your account was created. Switch to it from the account menu.');
      router.push('/dashboard');
      return;
    }
    // Full navigation: the whole shell reloads against the new account.
    window.location.assign('/billing?welcome=1');
  };

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-8">
      <Card>
        <CardContent className="p-6">
          <h1 className="text-2xl font-black tracking-tight">Open your own account</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            You&apos;re a member of someone else&apos;s workspace. This opens an account that belongs to you,
            with the same sign-in — no new password.
          </p>

          <form onSubmit={submit} className="mt-6 flex flex-col gap-5">
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-semibold">What will you use it for?</legend>
              {TYPES.map((type) => (
                <label
                  key={type.value}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/60 p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                >
                  <input
                    type="radio"
                    name="accountType"
                    value={type.value}
                    checked={accountType === type.value}
                    onChange={() => setAccountType(type.value)}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm font-semibold">{type.label}</span>
                    <span className="block text-xs text-muted-foreground">{type.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {accountType !== 'personal' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="companyName">Company name</Label>
                <Input id="companyName" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
              </div>
            )}

            {needsEmail && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">Email address</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                <p className="text-xs text-muted-foreground">
                  An account owner needs a verified email. We&apos;ll send a code to confirm it.
                </p>
              </div>
            )}

            <label className="flex items-start gap-3 text-sm">
              <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} className="mt-0.5" />
              <span>I consent to my data being processed to provide this service.</span>
            </label>

            {error && <p role="alert" className="text-sm font-medium text-red-500">{error}</p>}

            <Button type="submit" disabled={loading}>
              {loading ? <Loader2 size={16} className="animate-spin" /> : null}
              Open my account
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
