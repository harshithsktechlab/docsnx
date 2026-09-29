import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import PageContainer from '@/app/components/PageContainer';
import LandingNav from '@/app/components/LandingNav';
import { APP_MARK, APP_NAME, APP_LEGAL_ENTITY } from '@/lib/brand';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   PRIVACY POLICY — the HSK Tech Lab text, with the two promises the code  ║
 * ║   keeps                                                                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The body is the policy supplied by HSK Tech Lab (September 2026), rendered
 * section for section. Two passages are NOT in that text and must survive any
 * future paste-over, because code depends on them:
 *
 *   §7 / §8 / §14 — uploads are read by Gemini/OpenAI. What the page says is
 *   bounded by what `prepareAiPayload` (src/lib/aiPrivacyMasker.ts) actually
 *   does: credential keys stripped, identifiers masked. Do not promise more.
 *
 *   §16 — the erasure mechanics. src/app/api/account/delete/route.ts calls
 *   itself "the DPDPA Right to Erasure promised in /privacy"; the paragraph
 *   here is that promise, in the route's own words (no backup, one retained
 *   name/phone/email row per member).
 *
 * This is a public page (Shell.js PUBLIC_PATHS), so it owns its viewport and
 * brings its own nav and footer. The typography plugin is not installed —
 * `prose` does nothing here — hence the small helpers below.
 */

export const metadata = {
  title: 'Privacy Policy · DocsNX',
  description: 'How HSK Tech Lab Pvt. Ltd. collects, uses and protects information on DocsNX.',
};

const LAST_UPDATED = 'September 2026';
const PRIVACY_EMAIL = 'info@hsktechlab.com';

/* ── typography helpers ─────────────────────────────────────────────────── */

const LINK = 'text-primary underline underline-offset-4 hover:opacity-80 transition-opacity';

function A({ href, children }: { href: string; children: React.ReactNode }) {
  const external = /^https?:/.test(href);
  return (
    <a
      href={href}
      className={LINK}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {children}
    </a>
  );
}

function Mail() {
  return <A href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</A>;
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28">
      <h2 className="text-2xl font-bold tracking-tight mt-10 mb-3">{title}</h2>
      {children}
    </section>
  );
}

function Sub({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-lg font-semibold mt-6 mb-2">{title}</h3>
      {children}
    </div>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground leading-relaxed mb-4">{children}</p>;
}

function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc pl-6 space-y-1.5 text-muted-foreground mb-4">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function Address() {
  return (
    <address className="not-italic text-muted-foreground leading-relaxed mb-4">
      <strong className="text-foreground">HSK Tech Lab Pvt. Ltd.</strong>
      <br />
      H-503, Anshul Casa,
      <br />
      Kasapate Vasti, Wakad,
      <br />
      Pune – 411057, Maharashtra, India
    </address>
  );
}

/* ── table of contents ──────────────────────────────────────────────────── */

const SECTIONS: Array<[string, string]> = [
  ['s1', 'Introduction'],
  ['s2', 'Company Information'],
  ['s3', 'Information We Collect'],
  ['s4', 'Documents and User Content'],
  ['s5', 'Google Drive Integration'],
  ['s6', 'Google API Limited Use Disclosure'],
  ['s7', 'Document Storage and Technical Processing'],
  ['s8', 'How We Use Your Information'],
  ['s9', 'Family Sharing'],
  ['s10', 'Payment Processing'],
  ['s11', 'Subscription Cancellation and Refunds'],
  ['s12', 'Communications and Notifications'],
  ['s13', 'Data Security'],
  ['s14', 'Third-Party Services'],
  ['s15', 'Data Sharing and Disclosure'],
  ['s16', 'Data Retention'],
  ['s17', 'User Rights'],
  ['s18', "Children's Privacy"],
  ['s19', 'Cookies and Similar Technologies'],
  ['s20', 'International Data Processing'],
  ['s21', 'Changes to This Privacy Policy'],
  ['s22', 'Contact Us'],
  ['s23', 'Consent and Acknowledgment'],
];

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <LandingNav />

      <main className="pt-28 pb-20 px-4 sm:px-6 lg:px-8">
        <PageContainer width="narrow" className="space-y-8">
          <header className="space-y-3">
            <h1 className="text-4xl font-extrabold tracking-tight">Privacy Policy</h1>
            <p className="text-sm text-muted-foreground">
              Last Updated: <strong className="text-foreground">{LAST_UPDATED}</strong>
            </p>
            <p className="text-muted-foreground leading-relaxed">
              DocsNX is operated by HSK Tech Lab Pvt. Ltd. Questions about this policy go to <Mail />.
            </p>
          </header>

          <nav aria-label="Contents" className="rounded-2xl border border-border bg-card p-5">
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">Contents</p>
            <ol className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm list-decimal pl-5">
              {SECTIONS.map(([id, title]) => (
                <li key={id}>
                  <a href={`#${id}`} className="hover:text-primary transition-colors">{title}</a>
                </li>
              ))}
            </ol>
          </nav>

          <article>
            <Section id="s1" title="1. Introduction">
              <P>
                Welcome to <strong className="text-foreground">DocsNX</strong> (&ldquo;DocsNX&rdquo;, &ldquo;we&rdquo;, &ldquo;our&rdquo;, or &ldquo;us&rdquo;), a digital document management platform operated by <strong className="text-foreground">HSK Tech Lab Pvt. Ltd.</strong>
              </P>
              <P>DocsNX helps users organize, manage, access, and share personal and family documents in one place.</P>
              <P>
                We are committed to protecting your privacy and safeguarding your personal information. This Privacy Policy explains how we collect, use, process, store, disclose, and protect information when you access or use our website, application, and related services (collectively, the &ldquo;Services&rdquo;).
              </P>
              <P>By accessing or using DocsNX, you acknowledge that you have read and understood this Privacy Policy.</P>
            </Section>

            <Section id="s2" title="2. Company Information">
              <Address />
              <Bullets
                items={[
                  <><strong className="text-foreground">Product Website:</strong> <A href="https://docsnx.com">docsnx.com</A></>,
                  <><strong className="text-foreground">Company Website:</strong> <A href="https://hsktechlab.com">hsktechlab.com</A></>,
                  <><strong className="text-foreground">Privacy Contact:</strong> <Mail /></>,
                ]}
              />
            </Section>

            <Section id="s3" title="3. Information We Collect">
              <P>We collect only the information reasonably necessary to provide, maintain, secure, and improve the Services.</P>

              <Sub title="3.1 Account Information">
                <P>When you create or use a DocsNX account, we may collect:</P>
                <Bullets
                  items={[
                    'Full name',
                    'Email address',
                    'Mobile phone number',
                    'WhatsApp number',
                    'Account credentials',
                    'Account preferences',
                    'Account creation and authentication information',
                  ]}
                />
              </Sub>

              <Sub title="3.2 Authentication Information">
                <P>DocsNX may use email/password authentication and WhatsApp-based OTP authentication.</P>
                <P>
                  When using WhatsApp OTP authentication, we may process your mobile number and authentication-related information to verify your identity and provide secure access to your account.
                </P>
              </Sub>

              <Sub title="3.3 Family Member Information">
                <P>DocsNX allows users to share selected documents with family members.</P>
                <P>If you invite or add a family member, we may collect information such as:</P>
                <Bullets
                  items={[
                    'Name',
                    'Email address',
                    'Mobile number',
                    'Relationship details, if provided',
                    'Access permissions associated with the shared documents',
                  ]}
                />
                <P>You are responsible for ensuring that you have the appropriate authority or permission to provide personal information relating to other individuals.</P>
              </Sub>

              <Sub title="3.4 Subscription and Payment Information">
                <P>DocsNX provides subscription-based services.</P>
                <P>When you purchase a subscription, we may receive and process information such as:</P>
                <Bullets
                  items={[
                    'Subscription plan',
                    'Transaction ID',
                    'Payment status',
                    'Order ID',
                    'Subscription start and expiry dates',
                    'Billing-related information',
                    'Payment-related records required for accounting, support, fraud prevention, or legal compliance',
                  ]}
                />
                <P>
                  Payments are processed through third-party payment providers such as <A href="https://razorpay.com/privacy/">Razorpay</A>.
                </P>
                <P>
                  DocsNX does not intentionally store complete credit/debit card numbers, CVV numbers, UPI PINs, banking passwords, or other sensitive payment credentials on its servers.
                </P>
              </Sub>

              <Sub title="3.5 Communications">
                <P>
                  When you contact us, request support, or communicate with us, we may collect information contained in those communications to respond to your requests and provide customer support.
                </P>
              </Sub>
            </Section>

            <Section id="s4" title="4. Documents and User Content">
              <P>DocsNX is designed to help users manage important personal and family documents.</P>
              <P>Users may store documents including, but not limited to:</P>
              <Bullets
                items={[
                  'Aadhaar cards',
                  'PAN cards',
                  'Passports',
                  'Insurance documents',
                  'Property documents',
                  'Medical records',
                  'Educational certificates',
                  'Financial documents',
                  'Identification documents',
                  'Legal documents',
                  'Family records',
                  'Other personal or family documents',
                ]}
              />
              <P>Users retain ownership and control of the documents and content they upload, organize, or share through DocsNX.</P>
              <P>DocsNX does not claim ownership of your documents or personal content.</P>
            </Section>

            <Section id="s5" title="5. Google Drive Integration">
              <P>
                DocsNX allows users to connect their Google Drive accounts to store, organize, access, and manage documents through the platform.
              </P>
              <P>
                When a user chooses to connect a Google account, DocsNX may request specific Google Drive permissions necessary to provide the requested functionality.
              </P>
              <P>The permissions requested will be limited to what is reasonably required for the Services.</P>
              <P>DocsNX may access, process, and display information from Google Drive for purposes including:</P>
              <Bullets
                items={[
                  'Uploading and storing user documents',
                  'Retrieving and displaying user documents',
                  'Organizing files and folders',
                  'Managing document-sharing functionality',
                  'Enabling document management functionality',
                  'Providing search and access functionality',
                  'Supporting document recovery or related functionality where applicable',
                ]}
              />
              <P>DocsNX does not sell, rent, or share Google user data with third parties for advertising, marketing, or profiling purposes.</P>
              <P>Information obtained from Google APIs is used only to provide the functionality requested by the user within DocsNX.</P>
              <P>
                DocsNX&rsquo;s use and transfer of information received from Google APIs will adhere to the{' '}
                <A href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</A>, including the Limited Use requirements, where applicable.
              </P>
              <P>
                Users may revoke DocsNX&rsquo;s access to their Google account at any time through their{' '}
                <A href="https://myaccount.google.com/permissions">Google Account security settings</A> or by disconnecting their Google account from DocsNX.
              </P>
              <P>Revoking Google Drive access may cause certain DocsNX features that depend on Google Drive to become unavailable.</P>
              <P>
                For more information about Google&rsquo;s privacy practices, users may review{' '}
                <A href="https://policies.google.com/privacy">Google&rsquo;s Privacy Policy</A>.
              </P>
            </Section>

            <Section id="s6" title="6. Google API Limited Use Disclosure">
              <P>
                DocsNX&rsquo;s use of information received from Google APIs complies with the{' '}
                <A href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</A>, including the Limited Use requirements.
              </P>
              <P>DocsNX does not sell Google user data.</P>
              <P>DocsNX does not use Google user data for advertising, marketing, or profiling purposes.</P>
              <P>
                DocsNX does not use Google user data to develop, improve, or train generalized artificial intelligence (AI) or machine learning (ML) models.
              </P>
              <P>Data obtained through Google APIs is used solely to provide user-requested functionality within the DocsNX platform.</P>
            </Section>

            <Section id="s7" title="7. Document Storage and Technical Processing">
              <P>
                Documents connected to or managed through DocsNX are primarily stored in the user&rsquo;s connected cloud storage account, including Google Drive or other supported storage providers.
              </P>
              <P>DocsNX is not intended to act as the primary permanent storage location for users&rsquo; document files.</P>
              <P>
                However, in order to provide, secure, maintain, troubleshoot, and improve the Services, certain information relating to documents may be temporarily processed, transmitted, cached, or stored by DocsNX.
              </P>
              <P>This may include:</P>
              <Bullets
                items={[
                  'File names',
                  'File types',
                  'File sizes',
                  'Folder information',
                  'Document categories',
                  'Upload and modification timestamps',
                  'Sharing permissions',
                  'User activity information',
                  'Authentication logs',
                  'Error logs',
                  'Security logs',
                  'System-generated metadata',
                ]}
              />
              <P>
                Depending on how particular features operate, temporary copies, cached content, thumbnails, processing artifacts, or backups may be created.
              </P>
              <P>
                Such temporary information is retained only for as long as reasonably necessary for operational, security, troubleshooting, performance, disaster recovery, or legal purposes.
              </P>
              <P>
                We do not intentionally retain user documents as a permanent independent document repository where the document is stored in the user&rsquo;s connected cloud storage.
              </P>
              {/* Not in the supplied text — see the file header. Bounded by prepareAiPayload. */}
              <P>
                When you use scanning or extraction features, the content of the document you chose is sent to a third-party AI provider (Google Gemini or OpenAI) to read text and structured details from it. Before anything is sent, DocsNX removes credential fields (such as passwords, card details and login usernames) and masks identifiers (such as PAN, Aadhaar and account numbers, phone numbers and email addresses) from structured records. We do not use your documents or personal data to train AI models.
              </P>
            </Section>

            <Section id="s8" title="8. How We Use Your Information">
              <P>We may use collected information to:</P>
              <Bullets
                items={[
                  'Create and manage user accounts',
                  'Authenticate users',
                  'Provide access to DocsNX',
                  'Connect and interact with supported cloud storage services',
                  'Organize and manage documents',
                  // Not in the supplied text — see the file header.
                  'Extract text and structured details from documents you choose to scan, using third-party AI providers (Google Gemini, OpenAI)',
                  'Facilitate family document sharing',
                  'Manage user permissions',
                  'Process subscription payments',
                  'Manage subscriptions',
                  'Send payment and account notifications',
                  'Send WhatsApp OTPs',
                  'Send service-related WhatsApp notifications',
                  'Send email notifications',
                  'Provide customer support',
                  'Maintain and improve the Services',
                  'Detect and prevent fraud, abuse, unauthorized access, or security incidents',
                  'Troubleshoot technical issues',
                  'Maintain system security',
                  'Comply with applicable laws and regulations',
                  'Fulfill other purposes disclosed to you at the time information is collected',
                ]}
              />
            </Section>

            <Section id="s9" title="9. Family Sharing">
              <P>DocsNX allows users to share selected documents with family members or other individuals chosen by the account owner.</P>
              <P>Depending on the permissions granted by the account owner, an invited family member may be able to:</P>
              <Bullets
                items={[
                  'View shared documents',
                  'Access shared folders',
                  'Download documents',
                  'Edit documents',
                  'Perform other actions permitted by the account owner',
                ]}
              />
              <P>
                The account owner is responsible for determining who receives access to their documents and for reviewing and managing sharing permissions.
              </P>
              <P>DocsNX is not responsible for the actions of individuals to whom a user voluntarily grants access.</P>
              <P>Users should exercise care before sharing sensitive documents.</P>
            </Section>

            <Section id="s10" title="10. Payment Processing">
              <P>DocsNX offers subscription-based services.</P>
              <P>
                Payments are processed through third-party payment service providers, including <A href="https://razorpay.com/privacy/">Razorpay</A>.
              </P>
              <P>When you make a payment, certain information may be shared with the payment provider as necessary to process and complete the transaction.</P>
              <P>This may include:</P>
              <Bullets
                items={[
                  'Name',
                  'Email address',
                  'Mobile number',
                  'Amount payable',
                  'Transaction information',
                  'Subscription information',
                  'Order information',
                ]}
              />
              <P>Payment providers may independently process payment information in accordance with their own terms and privacy policies.</P>
              <P>DocsNX does not intentionally store complete credit/debit card numbers, CVV numbers, UPI PINs, or banking passwords on its servers.</P>
              <P>
                We may retain transaction and subscription records as necessary for accounting, customer support, fraud prevention, dispute resolution, tax, and legal compliance purposes.
              </P>
            </Section>

            <Section id="s11" title="11. Subscription Cancellation and Refunds">
              <P>DocsNX provides subscription-based services.</P>
              <P>
                Subscription cancellation and refund eligibility, if any, will be governed by the applicable terms presented to the user at the time of purchase (see our <Link href="/terms" className={LINK}>Terms of Service</Link>).
              </P>
              <P>
                Where a subscription is cancelled, access to subscription features may continue until the end of the applicable paid subscription period unless otherwise required by law or stated at the time of purchase.
              </P>
              <P>Any legally required refund rights remain unaffected.</P>
            </Section>

            <Section id="s12" title="12. Communications and Notifications">
              <P>We may communicate with users through:</P>
              <Bullets items={['Email', 'WhatsApp', 'In-application notifications']} />
              <P>Communications may include:</P>
              <Bullets
                items={[
                  'Account verification',
                  'WhatsApp OTPs',
                  'Login or security notifications',
                  'Subscription confirmations',
                  'Payment confirmations',
                  'Subscription-related reminders',
                  'Service updates',
                  'Important security notices',
                  'Customer support communications',
                  'Other communications necessary to provide the Services',
                ]}
              />
              <P>Essential service and security communications may continue even if a user has opted out of promotional communications.</P>
            </Section>

            <Section id="s13" title="13. Data Security">
              <P>
                We take reasonable technical, administrative, and organizational measures to protect personal information against unauthorized access, disclosure, alteration, loss, misuse, or destruction.
              </P>
              <P>Security measures may include:</P>
              <Bullets
                items={[
                  'HTTPS/TLS encryption',
                  'Secure authentication',
                  'Access controls',
                  'Permission-based access',
                  'Security monitoring',
                  'Secure third-party infrastructure',
                  'Appropriate data protection practices',
                ]}
              />
              <P>
                Documents stored through supported cloud storage providers, such as Google Drive, are subject to the security mechanisms and policies of those providers.
              </P>
              <P>
                Although we take reasonable measures to protect information, no electronic storage system, transmission method, or online service can be guaranteed to be completely secure.
              </P>
            </Section>

            <Section id="s14" title="14. Third-Party Services">
              <P>DocsNX may use or integrate with third-party service providers to provide certain functionality.</P>
              <P>These may include:</P>
              <Bullets
                items={[
                  'Google Drive and Google APIs',
                  <A key="rzp" href="https://razorpay.com/privacy/">Razorpay</A>,
                  // Not in the supplied text — see the file header.
                  'AI providers (Google Gemini, OpenAI) for document scanning and extraction',
                  'WhatsApp or WhatsApp-based communication providers',
                  'Email service providers',
                  'Cloud infrastructure and hosting providers',
                  'Security and authentication providers',
                  'Other service providers necessary to operate the platform',
                ]}
              />
              <P>Third-party providers may process information only as necessary to provide their services or as otherwise permitted by applicable law.</P>
              <P>Third-party services operate under their respective terms and privacy policies.</P>
            </Section>

            <Section id="s15" title="15. Data Sharing and Disclosure">
              <P>We do not sell your personal information.</P>
              <P>We may disclose or provide access to information to third parties only where reasonably necessary for purposes such as:</P>
              <Bullets
                items={[
                  'Providing the Services',
                  'Processing payments',
                  'Providing cloud storage functionality',
                  'Sending authentication or service notifications',
                  'Providing customer support',
                  'Maintaining security',
                  'Preventing fraud or abuse',
                  'Complying with legal obligations',
                  'Responding to lawful requests from government or regulatory authorities',
                  'Protecting our rights, property, or users',
                ]}
              />
              <P>Where third-party service providers process information on our behalf, we seek to use appropriate contractual and technical safeguards.</P>
            </Section>

            <Section id="s16" title="16. Data Retention">
              <P>We retain personal information only for as long as reasonably necessary for the purposes described in this Privacy Policy, including:</P>
              <Bullets
                items={[
                  'Providing the Services',
                  'Maintaining user accounts',
                  'Processing subscriptions and transactions',
                  'Providing customer support',
                  'Maintaining security',
                  'Resolving disputes',
                  'Preventing fraud and abuse',
                  'Complying with applicable legal, regulatory, accounting, or tax requirements',
                ]}
              />
              <P>
                When you delete your account, we will handle your personal information in accordance with applicable law, including the{' '}
                <strong className="text-foreground">Digital Personal Data Protection Act, 2023 (DPDP Act)</strong> and applicable rules and regulations.
              </P>
              {/* Not in the supplied text — the erasure flow, in the words of
                  src/app/api/account/delete/route.ts. Keep the two in step. */}
              <P>
                <strong className="text-foreground">Account deletion.</strong> You can permanently delete your account from Settings &rarr; Account. Deletion removes every document, record and password belonging to your workspace, both from our database and from the DocsNX folder in your connected Google Drive, and revokes our access to that Google account. We keep no backup of your documents, so nothing can be restored afterwards &mdash; if you want a copy, export your data from Settings before deleting. The only information we retain after deletion is a minimal record of each member (name, phone number and email address), kept as evidence that the erasure took place. That record is also what lets us tell you, if you later try to sign in or reset a password with the same email address or mobile number, that the account was deleted and when. It does not prevent you from signing up again.
              </P>
              <P>
                Certain information may need to be retained for a limited period where required by law, for legitimate security purposes, to resolve disputes, or to meet legal and regulatory obligations.
              </P>
              <P>
                Information that is no longer required may be deleted, anonymized, or securely disposed of in accordance with our applicable data retention practices.
              </P>
            </Section>

            <Section id="s17" title="17. User Rights">
              <P>Subject to applicable law, users may have rights relating to their personal data, including the right to:</P>
              <Bullets
                items={[
                  'Access their personal information',
                  'Request correction of inaccurate or incomplete information',
                  'Request deletion of personal information',
                  'Withdraw consent where processing is based on consent',
                  'Request information regarding processing of personal data',
                  'Raise a grievance regarding the processing of personal information',
                ]}
              />
              <P>
                Requests relating to personal data or privacy may be submitted to: <strong className="text-foreground"><Mail /></strong>
              </P>
              <P>We may need to verify your identity before processing certain requests.</P>
              <P>Your rights may be subject to limitations and exceptions under applicable law.</P>
            </Section>

            <Section id="s18" title="18. Children's Privacy">
              <P>
                DocsNX is not restricted exclusively to adults and may be used to manage documents belonging to families and family members, including minors.
              </P>
              <P>
                Where information relating to a minor is uploaded or managed through the Services, the parent, guardian, or other authorized individual is responsible for ensuring that the collection, sharing, and processing of such information is lawful and appropriate.
              </P>
              <P>
                We do not knowingly seek to collect personal information directly from children in circumstances where parental or guardian consent is required under applicable law.
              </P>
              <P>
                If you believe that a child has provided personal information to us in violation of applicable law, please contact us at <Mail />.
              </P>
            </Section>

            <Section id="s19" title="19. Cookies and Similar Technologies">
              <P>DocsNX may use cookies, session technologies, or similar technical mechanisms that are necessary to operate and secure the Services.</P>
              <P>These technologies may be used for purposes such as:</P>
              <Bullets
                items={[
                  'Maintaining user sessions',
                  'Authentication',
                  'Security',
                  'Remembering user preferences',
                  'Understanding technical usage of the Services',
                  'Improving functionality',
                ]}
              />
              <P>
                We do not use cookies for behavioral advertising or third-party advertising profiling unless this Privacy Policy is updated to reflect such use.
              </P>
            </Section>

            <Section id="s20" title="20. International Data Processing">
              <P>Some third-party service providers used by DocsNX may process information on infrastructure located outside India.</P>
              <P>
                Where personal information is transferred or processed outside India, we will take reasonable steps to ensure that such processing is carried out in accordance with applicable data protection laws and contractual or technical safeguards.
              </P>
            </Section>

            <Section id="s21" title="21. Changes to This Privacy Policy">
              <P>We may update this Privacy Policy from time to time to reflect:</P>
              <Bullets
                items={[
                  'Changes to our Services',
                  'Changes to our technology',
                  'Changes to applicable laws',
                  'Changes to our data processing practices',
                  'Changes required by regulatory or service providers',
                ]}
              />
              <P>When we make material changes, we may provide an appropriate notice through the Services or other available communication channels.</P>
              <P>
                The updated Privacy Policy will be published on this page with a revised <strong className="text-foreground">&ldquo;Last Updated&rdquo;</strong> date.
              </P>
              <P>
                Your continued use of DocsNX after the updated Privacy Policy becomes effective constitutes acknowledgment of the updated policy, to the extent permitted by applicable law.
              </P>
            </Section>

            <Section id="s22" title="22. Contact Us">
              <P>
                If you have questions, concerns, complaints, or requests regarding this Privacy Policy or the way we process personal information, please contact us.
              </P>
              <Address />
              <Bullets
                items={[
                  <><strong className="text-foreground">Email:</strong> <Mail /></>,
                  <><strong className="text-foreground">Product Website:</strong> <A href="https://docsnx.com">docsnx.com</A></>,
                  <><strong className="text-foreground">Company Website:</strong> <A href="https://hsktechlab.com">hsktechlab.com</A></>,
                ]}
              />
            </Section>

            <Section id="s23" title="23. Consent and Acknowledgment">
              <P>By creating an account or using DocsNX, you acknowledge that you have read and understood this Privacy Policy.</P>
              <P>Where applicable law requires consent for a particular processing activity, we will obtain such consent through an appropriate mechanism.</P>
              <P>
                You may withdraw consent where permitted by applicable law; however, withdrawal of consent may affect our ability to provide certain features or Services that depend on that information.
              </P>
            </Section>
          </article>
        </PageContainer>
      </main>

      <footer className="bg-card border-t border-border py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <Link href="/" aria-label="DocsNX home" className="inline-block mb-6 rounded-xl leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
            <Image
              src={APP_MARK}
              alt={APP_NAME}
              width={64}
              height={64}
              className="mx-auto object-contain w-auto h-auto opacity-50 hover:opacity-100 transition-opacity rounded-xl border border-border/50 p-2 bg-background/50 shadow-sm"
            />
          </Link>
          <div className="flex justify-center gap-6 mb-4 text-sm font-medium text-muted-foreground">
            <Link href="/privacy" className="hover:text-primary transition-colors">Privacy Policy</Link>
            <Link href="/terms" className="hover:text-primary transition-colors">Terms of Service</Link>
          </div>
          <p className="text-sm text-muted-foreground">
            &copy; {new Date().getFullYear()} {APP_LEGAL_ENTITY}. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
