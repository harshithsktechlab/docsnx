import React from 'react';
import PageContainer from '@/app/components/PageContainer';


export default function TermsOfService() {
  return (
    <PageContainer width="narrow" className="space-y-8">
      <h1 className="text-4xl font-extrabold tracking-tight">Terms of Service</h1>
      <p className="text-muted-foreground">Last Updated: {new Date().toLocaleDateString()}</p>
      
      <div className="prose prose-neutral dark:prose-invert max-w-none">
        <h2>1. Acceptance of Terms</h2>
        <p>
          By accessing and using DocsNX, you accept and agree to be bound by the terms and provision of this agreement.
        </p>
        
        <h2>2. Description of Service</h2>
        <p>
          DocsNX provides a digital platform for families to store, manage, and analyze sensitive documents, medical records, financial data, and passwords ("Service"). You are responsible for all activities that occur under your tenant account.
        </p>

        <h2>3. Subscription and Billing</h2>
        <p>
          The Service is billed on a subscription basis. You will be billed in advance on a recurring schedule depending on the plan you select. All payments are non-refundable unless otherwise required by Indian Consumer Protection laws.
        </p>
        
        <h2>4. AI Capabilities and Disclaimer</h2>
        <p>
          DocsNX integrates Artificial Intelligence to provide document scanning and insights. AI-generated insights, especially those regarding financial or medical records, are for informational purposes only. They do not constitute professional medical, legal, or financial advice. We are not liable for any actions taken based on AI outputs (hallucinations or otherwise).
        </p>

        <h2>5. User Data and Security</h2>
        <p>
          You retain all rights to the data you upload. We implement reasonable security practices as mandated by the IT Act, 2000, including AES encryption for highly sensitive fields (like passwords). However, you are responsible for maintaining the confidentiality of your login credentials.
        </p>

        <h2>6. Termination</h2>
        <p>
          We may terminate or suspend your account immediately, without prior notice or liability, for any reason whatsoever, including without limitation if you breach the Terms.
        </p>
      </div>
    </PageContainer>
  );
}
