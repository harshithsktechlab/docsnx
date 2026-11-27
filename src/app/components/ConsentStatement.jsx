import React from 'react';
import { PRIVACY_PATH, TERMS_PATH } from '@/lib/consent';

/**
 * The consent sentence, with both links. The only place the wording lives, so
 * that signup, invite setup, "open your own account" and the profile card
 * cannot drift apart.
 *
 * New tab: the reader is half way through a form, and following the link in
 * place would throw away what they typed.
 */
export default function ConsentStatement() {
  const link = (href, text) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
      {text}
    </a>
  );

  return (
    <>
      I agree to the {link(PRIVACY_PATH, 'Privacy Policy')} and {link(TERMS_PATH, 'Terms of Service')} and
      consent to the processing of my personal data in accordance with applicable data protection laws.
    </>
  );
}
