import React from 'react';
export const dynamic = 'force-dynamic';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowRight, ShieldCheck, Zap, Smartphone, CheckCircle, PlayCircle, Cloud } from 'lucide-react';
import LandingNav from './components/LandingNav';
import { APP_LEGAL_ENTITY, APP_MARK, APP_NAME } from '@/lib/brand';
import { db } from '../lib/db';
import { subscriptionPlans, systemConfigs } from '../db/schema';
import { eq } from 'drizzle-orm';
import { priceIn, termCycle } from '@/lib/planCycles';

/**
 * The headline figure for one pricing card, or null for a plan with no price.
 *
 * The card read `plan.price` — the MONTHLY column — printed it behind a `$`,
 * and called `Number(null) === 0` "Free". Every live plan is annual and, since
 * 0058, carries its figure in `price_yearly` with a null monthly, so the
 * landing page advertised ₹999 and ₹3,499 plans as Free and the ₹4,999 one as
 * "$4999.00". The billing screen and checkout already price from the plan's
 * term via `priceIn`/`termCycle`; this is the same answer, in rupees, with the
 * suffix the term implies. A plan with no INR price is not free — it is
 * unsellable, and the caller drops it rather than show it.
 */
function cardPrice(plan) {
  const amount = priceIn(plan, 'INR');
  if (amount === null) return null;
  const cycle = termCycle(plan);
  return {
    amount,
    label: amount === 0 ? 'Free' : `₹${amount.toLocaleString('en-IN')}`,
    suffix: amount === 0 ? null : cycle === 'YEARLY' ? '/yr' : cycle === 'MONTHLY' ? '/mo' : ' one-time',
  };
}

const FEATURES = [
  {
    id: 'security',
    icon: ShieldCheck,
    title: 'Zero-Knowledge Vault',
    desc: 'End-to-end encryption ensures only you and your designated members can access your critical data.',
    image: '/assets/landing/cards/vault.webp',
  },
  {
    icon: Zap,
    title: 'AI-Powered Insights',
    desc: 'Our intelligent engine analyzes your policies and investments to find coverage gaps and premium savings.',
    image: '/assets/landing/cards/ai-insights.webp',
  },
  {
    icon: Smartphone,
    title: 'Works on Every Device',
    desc: 'Install DocsNX straight from your browser onto phone, tablet or desktop. No app store, no updates to chase.',
    image: '/assets/landing/cards/devices.webp',
  },
  {
    icon: Cloud,
    title: 'Your Google Drive',
    desc: 'Store your data directly in your own Google Drive. You maintain 100% ownership and control of your files.',
    image: '/assets/landing/cards/drive.webp',
  },
];

export default async function LandingPage() {
  let plans = [];
  try {
    plans = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.isActive, true));
  } catch (error) {
    console.error("Failed to load plans on landing page:", error);
  }
  // Only plans that can actually be bought, cheapest first — the query has no
  // ORDER BY, so without this the cards land in whatever order Postgres likes.
  const pricedPlans = plans
    .map((plan) => ({ plan, pricing: cardPrice(plan) }))
    .filter(({ pricing }) => pricing !== null)
    .sort((a, b) => a.pricing.amount - b.pricing.amount);

  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-primary/30">
      {/* Navigation */}
      <LandingNav />

      {/* Hero Section */}
      <section className="relative pt-32 pb-20 lg:pt-48 lg:pb-32 overflow-hidden">
        {/* Ambient Gradients */}
        <div className="absolute top-0 inset-x-0 h-full overflow-hidden -z-10">
          <div className="absolute -top-[40%] -right-[20%] w-[70%] h-[70%] rounded-full bg-primary/20 blur-[120px] mix-blend-screen" />
          <div className="absolute top-[20%] -left-[20%] w-[50%] h-[50%] rounded-full bg-blue-600/20 blur-[120px] mix-blend-screen" />
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-8 items-center">
            <div className="flex flex-col gap-6 animate-fade-in text-center lg:text-left">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary border border-primary/20 text-xs font-bold uppercase tracking-wider w-fit mx-auto lg:mx-0">
                <Sparkles size={14} /> DocsNX 2.0 is Live
              </div>
              <h1 className="text-5xl lg:text-7xl font-black tracking-tight leading-[1.1]">
                Your <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-orange-400">Digital Vault</span>
              </h1>
              <p className="text-lg lg:text-xl text-muted-foreground max-w-2xl mx-auto lg:mx-0 leading-relaxed">
                DocsNX is a secure workspace designed to help you manage medical records, investments, insurance policies, and essential documents. By integrating with Google Drive, DocsNX acts as a dedicated vault that automatically syncs and backs up your sensitive information directly to your personal cloud storage, ensuring you retain full ownership and control over your data.
              </p>

              <div className="flex flex-wrap items-center justify-center lg:justify-start gap-3 pt-1">
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs font-semibold">
                  <ShieldCheck size={14} /> BYOD Automated Zero-Knowledge Google Drive Sync
                </span>
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-600 dark:text-blue-400 text-xs font-semibold">
                  <Cloud size={14} /> Your Data Stays Exclusively in Your Drive
                </span>
              </div>
              
              <div className="flex flex-col sm:flex-row items-center gap-4 mt-4 justify-center lg:justify-start">
                <Link href="/register" className="w-full sm:w-auto text-base font-bold bg-foreground text-background px-8 py-4 rounded-full hover:bg-foreground/90 transition-all flex items-center justify-center gap-2 group shadow-xl">
                  Register for Free <ArrowRight size={18} className="group-hover:translate-x-1 transition-transform" />
                </Link>
              </div>
            </div>

            <div className="relative mx-auto w-full max-w-lg lg:max-w-none animate-slide-up stagger-2">
              <div className="relative rounded-[2rem] border border-border/50 bg-card p-2 shadow-2xl backdrop-blur-xl">
                <div className="rounded-[1.5rem] overflow-hidden border border-border/50 bg-black aspect-[4/3] relative">
                  <video 
                    autoPlay 
                    loop 
                    muted 
                    playsInline 
                    className="w-full h-full object-cover"
                    poster="/assets/landing/DocsNX_landing_page_mockup_202607062132.jpeg"
                  >
                    <source src="/assets/landing/DocsNX_dashboard_animation_202607062132.mp4" type="video/mp4" />
                  </video>
                </div>
                {/* Floating Elements */}
                <div className="absolute -left-8 top-12 p-4 bg-card border border-border rounded-2xl shadow-xl flex items-center gap-4 animate-pulse-slow">
                  <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
                    <ShieldCheck size={20} className="text-emerald-500" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider">Security</p>
                    <p className="text-sm font-black">Bank-Grade Encryption</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Storyboard Section */}
      <section className="py-24 relative overflow-hidden">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-3xl mx-auto mb-16">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary border border-primary/20 text-xs font-bold uppercase tracking-wider mb-6">
              How it works
            </div>
            <h2 className="text-3xl lg:text-5xl font-black mb-4">The DocsNX Story</h2>
            <p className="text-lg text-muted-foreground">See how DocsNX secures your digital life and gives you complete peace of mind.</p>
          </div>
          <div className="relative rounded-[2rem] overflow-hidden border border-border shadow-2xl bg-card">
            <Image
              src="/assets/landing/storyboard.jpeg"
              alt="DocsNX Explainer Storyboard"
              width={1376}
              height={768}
              className="w-full h-auto object-cover"
            />
          </div>
        </div>
      </section>

      {/* Trust & Features */}
      <section id="features" className="py-24 bg-muted/30 border-y border-border/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-3xl mx-auto mb-16">
            <h2 className="text-3xl lg:text-5xl font-black mb-4">Everything in its right place</h2>
            <p className="text-lg text-muted-foreground">DocsNX brings all your scattered financial, medical, and personal records into a single, cohesive ecosystem.</p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {FEATURES.map((feature) => (
              <FeatureCard key={feature.title} {...feature} />
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-24 relative overflow-hidden bg-gradient-to-b from-background via-primary/5 to-background">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-3xl mx-auto mb-16">
            <h2 className="text-3xl lg:text-5xl font-black mb-6">Simple, transparent pricing</h2>
            <p className="text-lg text-muted-foreground mb-8 leading-relaxed">
              Whether you&apos;re managing records for a single household or running a complex multi-tenant organization, we have a plan tailored for your needs.
            </p>
          </div>
          
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8 relative max-w-6xl mx-auto">
            {pricedPlans.map(({ plan, pricing }) => (
              <div key={plan.id} className="relative rounded-[2rem] overflow-hidden border border-border shadow-2xl bg-card p-8 hover:scale-105 transition-transform duration-500 flex flex-col">
                {plan.name?.toLowerCase().includes('pro') && (
                  <div className="absolute top-0 right-0 bg-primary text-primary-foreground text-xs font-bold px-3 py-1 rounded-bl-xl">
                    POPULAR
                  </div>
                )}
                <h3 className="text-2xl font-black mb-2">{plan.name}</h3>
                <div className="text-4xl font-black mb-6">
                  {pricing.label}
                  {pricing.suffix && (
                    <span className="text-sm font-medium text-muted-foreground">{pricing.suffix}</span>
                  )}
                </div>
                <div className="flex flex-col gap-2 mb-8 flex-1">
                  {plan.isLifetime && (
                    <div className="flex items-center gap-3">
                      <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-500 mt-0.5 shrink-0">
                        <CheckCircle size={12} />
                      </div>
                      <span className="font-medium text-sm text-foreground">Lifetime Validity</span>
                    </div>
                  )}
                  {plan.isLifetime && Number(plan.amcAmount) > 0 && (
                    <div className="flex items-center gap-3">
                      <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-500 mt-0.5 shrink-0">
                        <CheckCircle size={12} />
                      </div>
                      <span className="font-medium text-sm text-foreground">₹{plan.amcAmount}/year AMC</span>
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-500 mt-0.5 shrink-0">
                      <CheckCircle size={12} />
                    </div>
                    <span className="font-medium text-sm text-foreground">Up to {plan.maxMembers} Members</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-500 mt-0.5 shrink-0">
                      <CheckCircle size={12} />
                    </div>
                    <span className="font-medium text-sm text-foreground">{plan.storageLimitGB} GB Secure Storage</span>
                  </div>
                  {plan.aiCredits > 0 && (
                    <div className="flex items-center gap-3">
                      <div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center text-primary mt-0.5 shrink-0">
                        <Sparkles size={12} />
                      </div>
                      <span className="font-medium text-sm text-foreground">{plan.aiCredits} AI Credits Included</span>
                    </div>
                  )}
                </div>
                <Link href="/register" className="w-full text-center text-sm font-bold bg-foreground text-background px-6 py-3 rounded-full hover:bg-foreground/90 transition-all mt-auto shadow-xl">
                  Get Started
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
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

function FeatureCard({ id, icon: Icon, title, desc, image }) {
  return (
    <div id={id} className="group rounded-3xl bg-card border border-border overflow-hidden hover:shadow-xl transition-all hover:border-primary/30 flex flex-col h-full w-full">
      <div className="p-8 pb-6 flex-1">
        <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mb-6">
          <Icon />
        </div>
        <h3 className="text-xl font-black mb-3">{title}</h3>
        <p className="text-muted-foreground leading-relaxed">{desc}</p>
      </div>
      <div className="relative h-48 mt-auto overflow-hidden bg-muted">
        <Image
          src={image}
          alt=""
          fill
          sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 25vw"
          className="object-cover object-center group-hover:scale-110 transition-transform duration-700"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-card via-transparent to-transparent" />
      </div>
    </div>
  );
}

// Sparkles icon component
function Sparkles(props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    </svg>
  );
}
