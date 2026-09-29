'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE DASHBOARD OF ONE WORKSPACE — personal or a company                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Serves BOTH `/dashboard` and `/business/<companyId>/dashboard`.
 *
 * One component rather than two pages, for the reason `ModuleOverview` gives:
 * the greeting, the loading skeleton, the error state, the card grid, the
 * profile-completion panel and the growth chart are identical, and the only
 * things that differ are which cards the row holds and which account the
 * requests name. Two copies would drift the first time either changed — and the
 * bug this whole change exists to fix was exactly that kind of drift, a count
 * that nothing on the other page was reading.
 *
 * ── WHAT MAKES IT A COMPANY'S DASHBOARD ────────────────────────────────────
 * `useWorkspaceApi`, and nothing else. The hook reads `companyId` from
 * `useParams`, i.e. from the path, so on `/dashboard` there is none and the
 * requests go out byte-identical to what they were before this file existed;
 * under `/business/<id>/` every request carries `?companyId=`. No prop
 * threading, no cookie, and no call site that can be forgotten.
 *
 * None of that is a permission. The id in the path is untrusted and re-proven
 * server-side by `resolveUtilityCompany` on every request.
 *
 * ── THE COMPANY PAGE IS A SUMMARY, NOT A MENU ──────────────────────────────
 * It used to be a module chooser: a grid of every business module the member
 * could view, each tile carrying a record count and a sub-category count. The
 * rail already lists that set (see `navGroups` in Shell.js), and so does the
 * More tab at phone width, which made the grid a third copy of the same
 * navigation on the one page that should be summarising the workspace rather
 * than offering a way into it again.
 *
 * What is left is what belongs to THIS company and nowhere else: the Quick
 * Access counts, what is still missing from its setup, and its growth. That is
 * also what makes switching companies visibly change the page — the complaint
 * the grid was added to answer, which the header's `workspaceName` and the card
 * row settle on their own.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import {
  FileText,
  HeartPulse,
  KeyRound,
  Car,
  TrendingUp,
  AlertTriangle,
  ArrowUpRight,
  Sparkles,
  Cake,
  Heart,
  CheckCircle2,
  ListTodo,
  Phone,
  User,
  Scale,
  HardDrive,
  Building2,
  ScrollText,
  Landmark,
  MapPin,
} from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { AreaChart, Area, XAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { motion } from 'framer-motion';
import PageContainer from '@/app/components/PageContainer';
import AdminDashboard from '@/app/components/AdminDashboard';
import { useWorkspaceApi } from '@/lib/net/useWorkspaceApi';
import { setupChecklist } from '@/lib/setupChecklist';

const containerVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.1 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } },
};

/**
 * The look of each checklist row, keyed by `SetupItem.key`.
 *
 * Kept HERE and not in `setupChecklist.ts` because a lucide component is not
 * serialisable — the facts behind that module cross the network from
 * `/api/dashboard`, and a module that imported icons could never be reached
 * from a route handler.
 */
const SETUP_LOOK = {
  drive: { icon: HardDrive, tone: 'bg-sky-500/10 text-sky-500' },
  profile_personal: { icon: User, tone: 'bg-cyan-500/10 text-cyan-500' },
  profile_legal: { icon: Scale, tone: 'bg-purple-500/10 text-purple-500' },
  documents: { icon: FileText, tone: 'bg-blue-500/10 text-blue-500' },
  company_identity: { icon: Building2, tone: 'bg-indigo-500/10 text-indigo-500' },
  company_registration: { icon: ScrollText, tone: 'bg-violet-500/10 text-violet-500' },
  company_tax: { icon: Landmark, tone: 'bg-amber-500/10 text-amber-500' },
  company_address: { icon: MapPin, tone: 'bg-emerald-500/10 text-emerald-500' },
  company_contact: { icon: Phone, tone: 'bg-rose-500/10 text-rose-500' },
};
const DEFAULT_SETUP_LOOK = { icon: Sparkles, tone: 'bg-muted text-muted-foreground' };

function getGreeting() {
  const hours = new Date().getHours();
  if (hours < 12) return 'Good morning';
  if (hours < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * The card row, per account.
 *
 * The two sets are deliberately different rather than one set with blanks. A
 * household is asked about the things a household holds — medical records, a
 * vehicle, savings — and a company about the ones it runs on. Follow Up earns a
 * card on the business side specifically: GST returns, licence renewals, ROC
 * filings and policy expiries are dated obligations with a cost attached to
 * missing them, which is not true of anything on the personal row.
 *
 * Every path is prefixed for a company, so a card opens the page in the
 * workspace you are standing in rather than teleporting to the household's.
 */
function cardsFor(stats, followUps, companyId) {
  if (!companyId) {
    return [
      { name: 'Documents', count: stats.documents, icon: FileText, color: '#3b82f6', path: '/documents' },
      { name: 'Medical', count: stats.medical, icon: HeartPulse, color: '#06b6d4', path: '/modules/health_medical' },
      { name: 'Passwords', count: stats.passwords, icon: KeyRound, color: '#8b5cf6', path: '/passwords' },
      { name: 'Vehicles', count: stats.vehicles, icon: Car, color: '#f59e0b', path: '/modules/vehicle' },
      { name: 'Bank & Investments', count: stats.bankInvestments, icon: TrendingUp, color: '#10b981', path: '/modules/bank_investments' },
    ];
  }
  const base = `/business/${companyId}`;
  return [
    { name: 'Documents', count: stats.documents, icon: FileText, color: '#3b82f6', path: `${base}/documents` },
    { name: 'Passwords', count: stats.passwords, icon: KeyRound, color: '#8b5cf6', path: `${base}/passwords` },
    { name: 'To-Dos', count: stats.todos, icon: ListTodo, color: '#f59e0b', path: `${base}/todos` },
    // `null` until its own request lands — see the note on the fetch below.
    { name: 'Follow Up', count: followUps, icon: CheckCircle2, color: '#ef4444', path: `${base}/follow-up` },
    { name: 'Contacts', count: stats.contacts, icon: Phone, color: '#10b981', path: `${base}/important-contacts` },
  ];
}

export default function WorkspaceDashboard() {
  const router = useRouter();
  const { api, companyId } = useWorkspaceApi();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [growthData, setGrowthData] = useState([]);
  const [followUps, setFollowUps] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchDashboard() {
      setLoading(true);
      setError('');
      try {
        // `api` resolves rather than rejecting, so a failing growth query no
        // longer discards the dashboard data alongside it.
        const [{ res, json }, { res: growthRes, json: growthJson }] = await Promise.all([
          api('/api/dashboard', {}, { subject: 'dashboard', action: 'loading your dashboard' }),
          api('/api/dashboard/growth', {}, { subject: 'growth data', action: 'loading growth data' }),
        ]);
        if (cancelled) return;

        if (res.status === 401 || growthRes.status === 401) {
          toast.error('Session expired. Please log in again.');
          router.push('/login');
          return;
        }

        if (json.success) {
          setData(json);
        } else {
          const msg = json.error || 'Failed to load dashboard data';
          setError(msg);
          toast.error(msg);
        }

        if (growthJson.success) {
          setGrowthData(growthJson.growthData || []);
        }
      } catch (err) {
        // Transport failures are values now, not throws — `api` returns them.
        // So reaching this catch means a bug in the block above, and calling
        // that a network error sent people to check a working connection.
        console.error('[dashboard] handler threw', err);
        if (cancelled) return;
        setError('Something went wrong loading your dashboard. Please try again.');
        toast.error('Something went wrong loading your dashboard.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchDashboard();
    return () => { cancelled = true; };
    // Refetches when the workspace changes: switching companies is a route
    // change, and without this the new company's page would render the old
    // one's numbers until a reload.
  }, [api, router]);

  /**
   * Follow Up is fetched SEPARATELY, and deliberately not folded into
   * `/api/dashboard`.
   *
   * Its count walks the workspace's reminder stores on Drive, which on a cold
   * `storeCache` is one read per category. Putting it in the dashboard payload
   * would hold every other number on the page behind that walk. Here it simply
   * lands late, and its card shows a dash until it does.
   *
   * The Shell polls this same endpoint for the sidebar badge, so the two agree
   * and the second call is usually served warm.
   */
  useEffect(() => {
    if (!companyId) return undefined;
    let cancelled = false;
    (async () => {
      const { json } = await api('/api/follow-up/count');
      if (!cancelled && json?.success) setFollowUps(Number(json.count) || 0);
    })();
    return () => { cancelled = true; };
  }, [api, companyId]);

  if (loading) {
    return (
      <PageContainer>
        <Skeleton className="h-20 w-full rounded-2xl" />
        {/* Mirrors the loaded order below — cards first, then the widgets row —
            so the page does not reshuffle under the reader when data lands. */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-2xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Skeleton className="h-[300px] w-full rounded-2xl" />
          <Skeleton className="h-[300px] w-full rounded-2xl lg:col-span-2" />
        </div>
      </PageContainer>
    );
  }

  if (error) {
    return (
      <PageContainer className="items-center justify-center gap-4 py-16 max-w-md">
        <Alert variant="destructive" className="animate-scale-in">
          <AlertTriangle size={18} />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <Button onClick={() => window.location.reload()} variant="secondary" className="w-auto px-6 h-10">
          Retry
        </Button>
      </PageContainer>
    );
  }

  /**
   * SUPER_ADMIN is not in a workspace and has no records to show — the route
   * answers that role with tenant and user totals and nothing else. Branched off
   * the payload rather than off a second `/api/auth/me`, so the common case pays
   * nothing for it. It cannot arise under `/business/<id>`: the route guard in
   * Shell keeps the platform role out of every tenant page.
   */
  if (data?.isAdminDashboard) {
    return (
      <AdminDashboard
        stats={data.stats || {}}
        userName={data.userName}
        greeting={getGreeting()}
      />
    );
  }

  const stats = data?.stats || {};
  const reminders = data?.reminders || [];
  const userName = data?.userName || 'User';
  // The COMPANY's name in a company workspace, the tenant's otherwise. This is
  // what makes switching companies visibly change the page.
  const workspaceName = data?.workspaceName || data?.tenantName || 'My Workspace';

  const statCards = cardsFor(stats, followUps, companyId);
  const birthdayAnniversaries = reminders.filter((r) => r.type === 'birthday' || r.type === 'anniversary');

  /**
   * What is still missing from this workspace.
   *
   * ONE array, and the percentage is counted from it — see the header of
   * src/lib/setupChecklist.ts. It used to be a score and a list computed from
   * two different expressions, which is why the panel could say "100% Done",
   * print "Profile Complete!", and list "Add Medical Records" underneath.
   *
   * The rows are the MANDATORY ones: the profile forms, Drive, and a first
   * document. "Save a password" and "add a to-do" were prompts to use a
   * feature, not gaps in an account — and they sat directly below the Quick
   * Access cards that already offer both.
   */
  const { items: setupItems, done: setupDone, total: setupTotal, percent: setupPercent } =
    setupChecklist(data?.setup || {}, companyId);
  // Pending first: the panel is read top-down and the actionable half is what
  // the reader came for. Done rows stay listed rather than vanishing, so the
  // progress bar has something to describe.
  const setupRows = [...setupItems].sort((a, b) => Number(a.done) - Number(b.done));

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="show"
      className="flex flex-col gap-6 w-full max-w-7xl mx-auto pb-8"
    >

      {/* 1. Welcome Section */}
      <motion.div variants={itemVariants}>
        <Card className="border-border/50 bg-gradient-to-r from-primary/10 to-accent/5 backdrop-blur-xl shadow-glass p-6 border-l-4 border-l-primary relative overflow-hidden">
          <div className="relative z-10">
            <span className="text-xs uppercase font-bold text-primary tracking-widest leading-none">
              {workspaceName}
            </span>
            <h2 className="text-2xl font-black text-foreground mt-1.5 leading-none drop-shadow-sm">
              {getGreeting()}, <span className="text-foreground font-black">{userName}</span>!
            </h2>
            <p className="text-muted-foreground text-sm mt-1">
              {companyId
                ? "Your company's vault is secure and up to date."
                : 'Your sovereign cloud is secure and up to date.'}
            </p>
          </div>
          {/* Glassmorphism decorative blob */}
          <div className="absolute -right-20 -top-20 w-64 h-64 bg-primary/20 blur-3xl rounded-full pointer-events-none mix-blend-screen" />
        </Card>
      </motion.div>

      {/* 2. Birthday & Anniversary Celebrations. Personal only — a company has
           no birthdays, and `reminders` is empty for one. */}
      {birthdayAnniversaries.length > 0 && (
        <motion.div variants={itemVariants}>
          <Card className="border-amber-500/20 bg-gradient-to-r from-amber-500/5 to-pink-500/5 backdrop-blur-md shadow-glass p-6">
            <CardHeader className="p-0 pb-4">
              <h3 className="text-sm font-bold uppercase tracking-wider text-amber-500 flex items-center gap-2">
                <Cake size={18} />
                <span>Celebrations</span>
              </h3>
            </CardHeader>
            <div className="flex flex-col gap-3">
              {birthdayAnniversaries.map((rem, idx) => {
                const isToday = rem.daysLeft === 0;
                const Icon = rem.type === 'birthday' ? Cake : Heart;
                return (
                  <motion.div
                    whileHover={{ scale: 1.01 }}
                    whileTap={{ scale: 0.99 }}
                    key={idx}
                    onClick={() => router.push(rem.module)}
                    className={`flex items-center justify-between p-4 rounded-xl border transition-colors cursor-pointer ${
                      isToday
                        ? 'bg-amber-500/15 border-amber-500'
                        : 'bg-background/20 border-border/60 hover:bg-muted/30'
                    }`}
                  >
                    <div className="flex items-center gap-4 min-w-0">
                      <span className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                        rem.type === 'birthday' ? 'bg-amber-500/10 text-amber-500' : 'bg-pink-500/10 text-pink-500'
                      }`}>
                        <Icon size={18} />
                      </span>
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-sm font-bold text-foreground truncate">
                          {rem.title}
                        </span>
                        <span className="text-xs text-muted-foreground truncate">
                          {isToday ? 'Happening today! 🎉' : `Upcoming in ${rem.daysLeft} days`}
                        </span>
                      </div>
                    </div>
                    {isToday ? (
                      <Badge className="bg-amber-500 text-black hover:bg-amber-500/90 font-extrabold text-2xs animate-pulse">CELEBRATE</Badge>
                    ) : (
                      <Badge variant="secondary" className="text-xs font-bold">{rem.daysLeft} days left</Badge>
                    )}
                  </motion.div>
                );
              })}
            </div>
          </Card>
        </motion.div>
      )}

      {/* 3. Quick Access cards. These are the way into the vault, so they sit
           above the fold. */}
      <motion.div variants={itemVariants} className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <motion.div key={card.name} whileHover={{ y: -4 }} whileTap={{ scale: 0.96 }}>
              <Card
                onClick={() => router.push(card.path)}
                className="border-border/40 bg-card backdrop-blur-md shadow-glass hover:bg-card hover:border-border/80 transition-all cursor-pointer p-5 flex flex-col gap-4 h-full"
              >
                <div className="flex justify-between items-start">
                  <span
                    className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ color: card.color, backgroundColor: `${card.color}15` }}
                  >
                    <Icon size={20} />
                  </span>
                  <ArrowUpRight size={15} className="text-faint" />
                </div>
                <div>
                  <div className="text-2xl font-black text-foreground leading-none">
                    {/* A dash, not a zero, while a late count is still in
                        flight — "0 renewals due" and "not known yet" are
                        different statements and only one of them is true. */}
                    {card.count ?? '—'}
                  </div>
                  <div className="text-xs font-bold text-muted-foreground mt-1.5 leading-none">{card.name}</div>
                </div>
              </Card>
            </motion.div>
          );
        })}
      </motion.div>

      {/* 4. Dynamic Widgets Row. Profile comes FIRST in source order: on a phone
           this row stacks, and the chart is the one block here with nothing to
           tap, so leading with it pushed every actionable card below the fold.
           Source order is also the desktop reading order — profile left, the
           wide chart right — which keeps the two breakpoints saying the same
           thing. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* The setup checklist. Rendered only when there is something to ask:
            a member with neither Profiles nor a viewable category has an empty
            list, and "0% Done" over nothing reads as a broken panel rather than
            as "nothing for you to do here". */}
        {setupTotal > 0 && (
        <motion.div variants={itemVariants}>
          <Card className="border-border/50 bg-card backdrop-blur-md shadow-glass p-6 h-full flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                {companyId ? 'Complete This Company' : 'Complete Your Profile'}
              </h3>
              <Badge variant="outline" className="text-xs font-bold">{setupPercent}% Done</Badge>
            </div>
            {/* The bar says the same thing as the badge, and the count below it
                says what the badge cannot: 3/4 is a finite job, 75% is a mood. */}
            <Progress value={setupPercent} className="mb-1.5" />
            <p className="text-xs text-muted-foreground mb-4">
              {setupDone} of {setupTotal} done
            </p>
            <div className="flex-1 overflow-y-auto pr-1 flex flex-col gap-3">
              {setupDone === setupTotal && (
                <div className="flex flex-col items-center justify-center py-4 text-center text-muted-foreground">
                  <Sparkles size={24} className="text-amber-500 mb-2" />
                  <span className="text-sm font-bold text-foreground">
                    {companyId ? 'Company Set Up!' : 'Profile Complete!'}
                  </span>
                  <span className="text-xs mt-1">Nothing left to fill in.</span>
                </div>
              )}
              {setupRows.map((item) => {
                const { icon: Icon, tone } = SETUP_LOOK[item.key] || DEFAULT_SETUP_LOOK;
                return (
                  <div
                    key={item.key}
                    className={`flex items-center justify-between gap-3 p-3 rounded-lg border border-border/50 ${
                      item.done ? 'bg-transparent opacity-60' : 'bg-background/50'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`p-2 rounded-md flex-shrink-0 ${item.done ? 'bg-emerald-500/10 text-emerald-500' : tone}`}>
                        {item.done ? <CheckCircle2 size={16} /> : <Icon size={16} />}
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className={`text-xs font-bold ${item.done ? 'line-through' : ''}`}>
                          {item.label}
                        </span>
                        <span className="text-xs text-muted-foreground">{item.hint}</span>
                      </div>
                    </div>
                    {/* A done row keeps no button: it is there to show progress,
                        and an "Add" beside a ticked line invites a second copy
                        of something already filled in. */}
                    {!item.done && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs flex-shrink-0"
                        onClick={() => router.push(item.path)}
                      >
                        Complete
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        </motion.div>
        )}

        {/* Asset Growth Area Chart. Takes the whole row when the checklist is
            not rendered, rather than leaving a third of it empty. */}
        <motion.div variants={itemVariants} className={setupTotal > 0 ? 'lg:col-span-2' : 'lg:col-span-3'}>
          <Card className="border-border/50 bg-card backdrop-blur-md shadow-glass p-6 h-full flex flex-col">
            <div className="flex justify-between items-center mb-6">
              <div>
                <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Assets Growth</h3>
                <p className="text-2xl font-black text-foreground mt-1">₹{stats.totalAssets?.toLocaleString() || '0'}</p>
              </div>
              <Badge variant={(stats.assetGrowthPercentage || 0) >= 0 ? 'success' : 'destructive'} className="h-6 flex items-center">
                {(stats.assetGrowthPercentage || 0) > 0 ? '+' : ''}{stats.assetGrowthPercentage || '0'}%
              </Badge>
            </div>
            <div className="flex-1 min-h-[200px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={growthData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} dy={10} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '12px', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}
                    itemStyle={{ color: 'hsl(var(--foreground))', fontWeight: 'bold' }}
                  />
                  <Area type="monotone" dataKey="value" stroke="var(--primary)" strokeWidth={3} fillOpacity={1} fill="url(#colorValue)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </motion.div>

      </div>

    </motion.div>
  );
}
