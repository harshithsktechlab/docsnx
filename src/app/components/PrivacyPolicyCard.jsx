import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import ConsentStatement from '@/app/components/ConsentStatement';
import { formatDate } from '@/lib/dateHelper';
import { PRIVACY_EMAIL, PRIVACY_PATH, TERMS_PATH } from '@/lib/consent';

const LINK_BUTTON = 'inline-flex h-9 items-center rounded-lg border border-border/60 px-4 text-xs font-semibold text-foreground transition-colors hover:border-primary/50 hover:text-primary';

/**
 * The Privacy Policy section under the profile form: the consent sentence, when
 * this account accepted it, and where to read the documents.
 *
 * `user` is the `/api/auth/me` answer. Accounts created for someone (an admin
 * adding a member, partner sign-on) may have no acceptance on record, and the
 * card says that rather than implying one.
 */
export default function PrivacyPolicyCard({ user }) {
  if (!user) return null;
  const acceptedOn = user.consentDataProcessing ? formatDate(user.consentTimestamp) : '';

  return (
    <Card className="border-border/50 bg-card backdrop-blur shadow-glass animate-fade-in">
      <CardContent className="flex flex-col gap-4 p-6 md:p-8">
        <h3 className="text-lg font-bold text-foreground flex items-center gap-2 border-b border-border pb-3">
          <ShieldCheck size={18} className="text-primary" /> Privacy Policy
        </h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          <ConsentStatement />
        </p>
        <p className="text-sm font-semibold text-foreground">
          {user.consentDataProcessing
            ? `Accepted${acceptedOn ? ` on ${acceptedOn}` : ''}`
            : 'No acceptance is recorded for this account.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <a href={PRIVACY_PATH} target="_blank" rel="noopener noreferrer" className={LINK_BUTTON}>
            Read Privacy Policy
          </a>
          <a href={TERMS_PATH} target="_blank" rel="noopener noreferrer" className={LINK_BUTTON}>
            Read Terms of Service
          </a>
        </div>
        <p className="text-xs text-muted-foreground">
          For privacy questions, or to withdraw your consent, write to{' '}
          <a href={`mailto:${PRIVACY_EMAIL}`} className="text-primary hover:underline">{PRIVACY_EMAIL}</a>.
        </p>
      </CardContent>
    </Card>
  );
}
