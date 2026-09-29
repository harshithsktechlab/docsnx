'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { APP_MARK, APP_NAME } from '@/lib/brand';
import BrandWordmark from '@/app/components/BrandWordmark';
import { clientRegister } from '@/lib/clientAuth';
import { Mail, KeyRound, User, Sparkles, ArrowLeft, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { setFlash } from '@/lib/flashToast';
import { cn } from '@/lib/utils';
import { validateRegisterForm, firstInvalidField } from '@/lib/registerFormValidation';
import { resolveRegisterOutcome } from '@/lib/registerOutcome';

/**
 * The same three things every invalid field in this app does — `aria-invalid`,
 * a `border-destructive` outline, and the message where the hint would be —
 * matching the record forms (src/app/components/CategoryFieldInputs.jsx). The
 * message REPLACES the hint rather than stacking under it: a hint describes the
 * field in general, the error describes this attempt at filling it, and only
 * one of those is worth the reader's attention while it is wrong.
 */
const InputField = ({ label, id, icon: Icon, hint, isPassword, error, action, ...props }) => {
  const invalid = Boolean(error);
  const controlClass = cn(
    'pl-10',
    invalid && 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive',
  );

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground flex z-10">
          <Icon size={16} />
        </span>
        {isPassword ? (
          <PasswordInput
            id={id}
            aria-invalid={invalid}
            className={controlClass}
            {...props}
          />
        ) : (
          <Input
            id={id}
            aria-invalid={invalid}
            className={controlClass}
            type={props.type}
            {...props}
          />
        )}
      </div>
      {error ? (
        /*
          `action` rides INSIDE the message rather than under it. A refusal the
          reader can act on — "that address already has an account" — needs its
          way out within the same sentence they are reading; a separate line
          below reads as unrelated page furniture and gets skipped.
        */
        <p className="text-xs font-medium text-danger-text">
          {error}
          {action ? <> · {action}</> : null}
        </p>
      ) : hint ? (
        <p className="text-xs text-faint">{hint}</p>
      ) : null}
    </div>
  );
};

/**
 * The group-level equivalent, for the two answers that are not text inputs —
 * the account type and the consent box. Without it those failed with a toast and
 * nothing on screen, which is the half of this form people reported as "it just
 * does not submit".
 */
const FieldError = ({ children }) => (
  children ? <p className="mt-1.5 text-xs font-medium text-danger-text">{children}</p> : null
);

/**
 * The three account shapes. Wording matters more than it looks: "Both" was the
 * option people misread as "I am not sure", so it now says what it actually is,
 * in the words the price list already uses — the paid tier is called "Combo
 * (Personal + Business)", and someone who came from the pricing page should meet
 * the same name here.
 *
 * The VALUES do not change. 'both' is the tenant's stored `account_type`, read
 * by the register route, `getDefaultPlan`, `planStatus` and the onboarding step
 * list, and already written on every existing tenant.
 */
const ACCOUNT_TYPES = [
  { value: 'personal', label: 'Personal', hint: 'My family\u2019s documents' },
  { value: 'business', label: 'Business', hint: 'My company\u2019s documents' },
  { value: 'both', label: 'Combo (Personal + Business)', hint: 'Switch between the two' },
];

export default function RegisterPage() {
  const router = useRouter();
  /**
   * Which workspaces this account gets. 'personal' is the default because it is
   * what every account was before this existed, and because it is the answer
   * for most people — a household filing its own documents.
   */
  const [accountType, setAccountType] = useState('personal');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  /**
   * Asked because the answer cannot be checked anywhere else: the confirmation
   * is never posted, and a typo in a password nobody can read back is otherwise
   * discovered at the NEXT sign-in — on an account whose one-time codes have
   * already been spent getting in.
   */
  const [confirmPassword, setConfirmPassword] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [loading, setLoading] = useState(false);
  /**
   * `field → message`, keyed by input id — the SAME map POST /api/auth/register
   * now answers with, so a server refusal lands on the input that caused it
   * without any translation here. Filled from `validateRegisterForm` before the
   * request and from `res.fieldErrors` after one.
   */
  const [fieldErrors, setFieldErrors] = useState({});
  /**
   * `/login?identifier=…`, set ONLY when the route refuses because this address
   * (or number) already belongs to a finished account. It renders beside that
   * field's error as the way out, replacing the `router.push('/login')` this
   * page used to answer with — see src/lib/registerOutcome.ts for why leaving
   * the form was the wrong answer.
   *
   * Cleared alongside the error it belongs to: a link built from an address the
   * person has since edited would sign them in as somebody else's account.
   */
  const [signInHref, setSignInHref] = useState('');

  const [consentData, setConsentData] = useState(false);

  /** Stop marking a field the moment the person starts fixing it. */
  const clearFieldError = (key) => {
    setFieldErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
    setSignInHref('');
  };

  /**
   * Put the first problem in front of them, in the order they read the form —
   * a message under a field below the fold changes nothing they can see. Every
   * key is an element id on this page, including the non-input groups, which is
   * why no ref plumbing is needed.
   */
  const showFieldErrors = (errors) => {
    setFieldErrors(errors);
    const first = firstInvalidField(errors);
    if (!first || typeof document === 'undefined') return;
    const element = document.getElementById(first);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element?.focus?.({ preventScroll: true });
  };

  /**
   * Stable identity on purpose: PhoneInput's parsing effect lists `onChange` in
   * its dependencies, so a fresh arrow function every render would re-run it
   * every render.
   */
  const handlePhoneChange = React.useCallback((val) => {
    setPhoneNumber(val);
    setFieldErrors((prev) => (prev.phoneNumber ? { ...prev, phoneNumber: undefined } : prev));
    // The number can be the contact that already has an account, so the sign-in
    // link is this field's to drop too.
    setSignInHref('');
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Whatever the last attempt concluded, this one has not concluded it yet.
    setSignInHref('');
    // ── ONE VALIDATOR, EVERY MESSAGE ON ITS OWN INPUT ───────────────────────
    // This used to be three blanket toasts — "Please fill in all required
    // fields and select a plan" — which named none of them and marked nothing.
    // `validateRegisterForm` (src/lib/registerFormValidation.ts) carries the
    // route's own sentences and reuses `validateUserContacts` for the contact
    // rules, so nothing accepted here can be refused by the API for a reason
    // the form did not already say. It lives in a .ts module rather than in
    // this file because a page component cannot be imported by a test.
    const errors = validateRegisterForm({
      name, email, password, confirmPassword, phoneNumber, accountType, consentData,
    });
    if (Object.keys(errors).length > 0) {
      showFieldErrors(errors);
      // A stable id, so a second and third click on a form still carrying the
      // same mistakes replace this message instead of stacking copies of it.
      toast.error('Please correct the highlighted fields', { id: 'register-validation' });
      return;
    }
    setFieldErrors({});

    setLoading(true);
    const res = await clientRegister({
      name, email, password, phoneNumber, accountType,
      consentDataProcessing: consentData,
      // ── NO tenantName, NO companyName, NO planCode ────────────────────────
      // All three are asked for after this form now — the workspace name and
      // the first company in the onboarding wizard, the plan in /billing — and
      // the route is written to expect their absence: it derives a workspace
      // name from `name` (src/lib/workspaceName.ts) and provisions the default
      // plan for `accountType`. Sending them from here again would make this
      // form the authority on three answers it no longer asks for.
    });
    setLoading(false);

    // ── WHICH OF THE FIVE ANSWERS THIS IS ───────────────────────────────────
    // The route distinguishes a finished account from a sign-up still waiting
    // on its codes from an outright failure, and only some of those have
    // anywhere to send the person. That decision — including the /verify-email
    // query, which two outcomes build — lives in src/lib/registerOutcome.ts so
    // it can be held to account in a test; this file's JSX puts it out of
    // Vitest's reach. Everything below is only the doing.
    const outcome = resolveRegisterOutcome(res, email);

    // Handed to the destination rather than raised here: it is read on that
    // screen either way — this page is gone a frame later — and firing it here
    // only meant it arrived already part-expired, underneath whatever the next
    // screen had to say. See src/lib/flashToast.ts.
    if (outcome.kind === 'verify' || outcome.kind === 'billing' || outcome.kind === 'pending') {
      setFlash(outcome.flash);
      router.push(outcome.href);
      return;
    }

    // ── A REFUSAL ANSWERED WHERE IT HAPPENED ────────────────────────────────
    // This branch used to push to /login, which threw away the name, the
    // number, the password, the account type and the consent tick on the way
    // out — a brutal answer to a mistyped address. It stays here now: the
    // route already names the field at fault, and `signInHref` is the way out
    // for someone who really does have an account.
    if (outcome.kind === 'exists') {
      showFieldErrors(outcome.fieldErrors);
      setSignInHref(outcome.signInHref);
      toast.error(outcome.message, { id: 'register-exists' });
      return;
    }

    // The route names the field for everything it can attribute — a taken
    // address, an unusable number. Anything it cannot (no default plan
    // configured) still gets the toast.
    if (outcome.fieldErrors) showFieldErrors(outcome.fieldErrors);
    // Stays a toast, and keeps an id: nothing is navigating, so this belongs
    // to the form the reader is still sitting in front of.
    toast.error(outcome.message, { id: 'register-failed' });
  };

  /**
   * The way out of "that contact already has an account", rendered beside the
   * field that caused it — so it is read as part of the refusal rather than as
   * page furniture. `Link` so it prefetches and navigates like the rest of the
   * app; it inherits the error's size and sits on the destructive colour with
   * an underline, which is what distinguishes it from the sentence around it.
   */
  const signInLink = signInHref ? (
    <Link href={signInHref} className="underline underline-offset-2 hover:no-underline">
      Sign in instead →
    </Link>
  ) : null;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4 py-10">
      {/* Ambient glows */}
      <div className="fixed top-0 left-0 w-[500px] h-[500px] rounded-full bg-primary/5 blur-[120px] pointer-events-none -translate-x-1/2 -translate-y-1/2" />
      <div className="fixed bottom-0 right-0 w-[400px] h-[400px] rounded-full bg-accent/5 blur-[100px] pointer-events-none translate-x-1/4 translate-y-1/4" />

      <div className="w-full max-w-2xl animate-scale-in">
        <Card className="border-border/50 shadow-glass">
          <CardContent className="p-8">
            {/* Back */}
            <button
              onClick={() => router.push('/login')}
              className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground text-sm font-semibold mb-6 transition-colors bg-transparent border-none cursor-pointer"
            >
              <ArrowLeft size={15} />
              Back to Sign In
            </button>

            {/* Header */}
            <div className="flex flex-col items-center text-center mb-7">
              <Link href="/" aria-label="DocsNX home" className="rounded-lg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                <img src={APP_MARK} alt={APP_NAME} className="w-auto h-14 object-contain mb-4" />
              </Link>
              <h1 className="text-2xl font-extrabold tracking-tight mb-1">
                Set Up <BrandWordmark />
              </h1>
              <p className="text-muted-foreground text-sm">Create your account</p>
            </div>



            <form onSubmit={handleSubmit} className="flex flex-col gap-6">
              {/*
                No section headings any more. There were five — Workspace
                Information, Admin Credentials, Select Plan, Discount, Legal
                Consent — and three of those sections have moved: the workspace
                name and the first company into the onboarding wizard, the plan
                and the discount code into /billing. Numbering the two that are
                left would read as a form that failed to finish loading.
              */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <InputField
                  id="name"
                  label="Full Name *"
                  icon={User}
                  placeholder="e.g. Amit Sharma"
                  value={name}
                  onChange={(e) => { setName(e.target.value); clearFieldError('name'); }}
                  disabled={loading}
                  autoComplete="name"
                  error={fieldErrors.name}
                />
                <InputField
                  id="email"
                  label="Email Address *"
                  icon={Mail}
                  type="email"
                  placeholder="amit@sharma.com"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); clearFieldError('email'); }}
                  disabled={loading}
                  autoComplete="email"
                  error={fieldErrors.email}
                  action={fieldErrors.email ? signInLink : null}
                />
                <div className="sm:col-span-2">
                  <PhoneInput
                    id="phoneNumber"
                    label="Phone Number *"
                    required
                    value={phoneNumber}
                    onChange={handlePhoneChange}
                    disabled={loading}
                    error={fieldErrors.phoneNumber}
                  />
                  {/*
                    Outside PhoneInput rather than through it: the number is the
                    OTHER contact that can already belong to an account, so this
                    branch has to be reachable too, and PhoneInput is shared with
                    forms that have no sign-in to offer.
                  */}
                  {fieldErrors.phoneNumber && signInLink ? (
                    <p className="mt-1.5 text-xs font-medium text-danger-text">{signInLink}</p>
                  ) : null}
                </div>
                {/*
                  Side by side deliberately: the second box is only useful while
                  the first one is still in view, and a confirmation a row below
                  its password reads as another field to fill rather than as the
                  same answer twice.
                */}
                <InputField
                  id="password"
                  label="Security Password *"
                  icon={KeyRound}
                  isPassword={true}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    clearFieldError('password');
                    // The confirmation is judged against THIS value, so a
                    // "Passwords do not match" left over from an earlier
                    // keystroke may already be untrue.
                    clearFieldError('confirmPassword');
                  }}
                  disabled={loading}
                  autoComplete="new-password"
                  error={fieldErrors.password}
                />
                <InputField
                  id="confirmPassword"
                  label="Confirm Password *"
                  icon={KeyRound}
                  isPassword={true}
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => { setConfirmPassword(e.target.value); clearFieldError('confirmPassword'); }}
                  disabled={loading}
                  autoComplete="new-password"
                  error={fieldErrors.confirmPassword}
                />
              </div>

              {/*
                Asked at signup rather than later because it decides the shape
                of the whole account: which taxonomy the nav renders, whether
                onboarding demands a company, and whether the workspace switcher
                exists at all. Changeable afterwards in Settings, so this is not
                a one-way door.

                The company itself is NOT asked for here — the wizard's
                Companies step collects it, and /api/onboarding/complete refuses
                to finish a business account without one.
              */}
              <div>
                <label className="mb-2 block text-sm font-medium">
                  What will you use DocsNX for? *
                </label>
                <div id="accountType" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {ACCOUNT_TYPES.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      disabled={loading}
                      onClick={() => {
                        setAccountType(option.value);
                        clearFieldError('accountType');
                      }}
                      aria-pressed={accountType === option.value}
                      className={cn(
                        'rounded-lg border p-3 text-left transition-colors disabled:opacity-50',
                        accountType === option.value
                          ? 'border-primary bg-primary/10 ring-1 ring-primary'
                          : 'border-border hover:border-primary/50',
                        fieldErrors.accountType && accountType !== option.value && 'border-danger-border',
                      )}
                    >
                      <span className="block text-sm font-semibold">{option.label}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {option.hint}
                      </span>
                    </button>
                  ))}
                </div>
                <FieldError>{fieldErrors.accountType}</FieldError>
              </div>

              {/*
                One consent, unchanged in wording, and still compulsory — an
                unticked box refuses the registration here and again at the
                route. The second box that used to sit beside it asked
                separately about third-party AI processing; it and its column
                are gone (0060), because nothing in the product ever read the
                answer.
              */}
              <div className="flex flex-col gap-1">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    id="consentData"
                    checked={consentData}
                    onChange={(e) => { setConsentData(e.target.checked); clearFieldError('consentData'); }}
                    aria-invalid={Boolean(fieldErrors.consentData)}
                    className={cn(
                      'mt-1 w-4 h-4 text-primary border-border rounded focus:ring-primary',
                      fieldErrors.consentData && 'border-danger-border ring-1 ring-danger-border',
                    )}
                  />
                  <label htmlFor="consentData" className="text-sm text-muted-foreground leading-snug cursor-pointer">
                    I consent to the collection, processing, and storage of my personal and sensitive data as outlined in the <a href="/privacy" target="_blank" className="text-primary hover:underline">Privacy Policy</a> and <a href="/terms" target="_blank" className="text-primary hover:underline">Terms of Service</a>, in compliance with the DPDPA 2023.
                  </label>
                </div>
                <FieldError>{fieldErrors.consentData}</FieldError>
              </div>

              <Button type="submit" disabled={loading} className="w-full h-11 text-base">
                {loading ? (
                  <><Loader2 size={17} className="animate-spin" /> Creating account...</>
                ) : (
                  <><Sparkles size={17} /> Create Account</>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
