'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Users,
  Building2,
  CreditCard,
  Zap,
  ShieldAlert,
  Server,
  Activity,
  ArrowUpRight,
  TrendingUp,
  Database,
  Lock,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  FileText,
  Mail,
  Sliders,
  DollarSign,
  Cpu,
  Layers,
  Sparkles,
  Search,
  ExternalLink,
  ChevronRight,
  UserCheck,
  Tag,
  Package,
  MessageCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { formatDate } from '@/lib/dateHelper';
import { APP_NAME } from '@/lib/brand';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';


interface DashboardSummary {
  success: boolean;
  stats: {
    totalTenants: number;
    activeTenants: number;
    inactiveTenants: number;
    onboardedTenants: number;
    googleDriveEnabledTenants: number;
    totalUsers: number;
    totalVaultRecords: number;
    totalAiCreditsBalance: number;
    totalAiUsageCost: number;
    estimatedMRR: number;
  };
  subscriptionBreakdown: {
    planId: string;
    name: string;
    price: number;
    count: number;
  }[];
  expiringTenants: {
    id: string;
    name: string;
    isActive: boolean;
    expiry: string;
    planName: string;
  }[];
  overdueAmcTenants: {
    id: string;
    name: string;
    isActive: boolean;
    amcDueDate: string;
  }[];
  aiKeyHealth: {
    totalApiKeys: number;
    activeApiKeysCount: number;
    errorApiKeysCount: number;
  };
  systemStatus: {
    smtpConfigured: boolean;
  };
  recentTenants: {
    id: string;
    name: string;
    isActive: boolean;
    hasCompletedOnboarding: boolean;
    googleDriveEnabled: boolean;
    aiProvider: string;
    aiModel: string;
    aiCreditsBalance: number;
    createdAt: string;
    adminEmail: string;
    adminName: string;
    planName: string;
  }[];
  recentAuditLogs: {
    id: string;
    action: string;
    resource: string;
    details: string;
    createdAt: string;
  }[];
}

export default function AdminDashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('overview');

  const fetchDashboardData = async () => {
    setLoading(true);
    setError('');
    try {
      const { json } = await apiCall('/api/admin/dashboard/summary', {
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (json.success) {
        setData(json);
      } else {
        setError(json.error || 'Failed to load dashboard telemetry.');
      }
    } catch (err: any) {
      console.error('[admin] telemetry load threw', err);
      setError('Something went wrong loading Superadmin telemetry. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const adminNavItems = [
    { title: 'Tenants & Workspaces', href: '/admin/tenants', icon: Building2, count: data?.stats.totalTenants },
    { title: 'Subscription Plans', href: '/admin/plans', icon: Layers },
    { title: 'Platform Users', href: '/admin/users', icon: Users, count: data?.stats.totalUsers },
    { title: 'Payments & Overrides', href: '/admin/payments', icon: CreditCard },
    { title: 'Discounts & Coupons', href: '/admin/discounts', icon: Tag },
    { title: 'Addons Catalog', href: '/admin/addons', icon: Package },
    { title: 'AI Key Hub', href: '/admin/ai-settings', icon: Cpu, badge: data?.aiKeyHealth.errorApiKeysCount ? 'ERROR' : undefined },
    { title: 'SMTP Gateway', href: '/admin/smtp', icon: Mail },
    { title: 'WhatsApp Gateway', href: '/admin/whatsapp', icon: MessageCircle },
    { title: 'System Settings', href: '/admin/settings', icon: Sliders },
  ];

  return (
    <PageContainer className="space-y-8 pb-16 animate-fade-in">
      {/* Top Banner Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border/40 pb-6">
        <div className="flex items-center gap-4">
          <div className="w-13 h-13 rounded-2xl bg-gradient-to-br from-primary via-orange-500 to-amber-500 flex items-center justify-center shadow-lg shadow-primary/20">
            <Activity className="w-7 h-7 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-3xl font-extrabold tracking-tight text-foreground">
                Executive Superadmin Command Center
              </h1>
              <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 text-xs font-semibold px-2.5 py-0.5">
                {`${APP_NAME} Sovereign Cloud`}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              Real-time multi-tenant orchestration, FinOps telemetry, Zero-Trust vault compliance, and AI key health.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchDashboardData}
            disabled={loading}
            className="flex items-center gap-2 border-border/60 hover:bg-muted/50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh Telemetry
          </Button>
          <Button
            size="sm"
            onClick={() => router.push('/admin/tenants')}
            className="bg-gradient-to-r from-primary to-orange-500 hover:opacity-90 text-white font-medium shadow-md"
          >
            <Building2 className="w-4 h-4 mr-2" />
            Provision Tenant
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="font-medium">{error}</AlertDescription>
        </Alert>
      )}

      {/* Admin Module Switcher Ribbon */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-9 gap-2.5">
        {adminNavItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.href}
              onClick={() => router.push(item.href)}
              className="flex flex-col items-center justify-center p-3 rounded-xl border border-border/50 bg-card hover:bg-card hover:border-primary/50 transition-all duration-200 group relative text-center shadow-sm"
            >
              <div className="w-9 h-9 rounded-lg bg-primary/10 group-hover:bg-primary group-hover:text-white text-primary flex items-center justify-center mb-1.5 transition-colors">
                <Icon className="w-4 h-4" />
              </div>
              <span className="text-xs font-medium text-foreground group-hover:text-primary transition-colors">
                {item.title}
              </span>
              {item.count !== undefined && (
                <span className="text-xs text-muted-foreground mt-0.5">{item.count}</span>
              )}
              {item.badge && (
                <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-2xs font-bold px-1.5 py-0.5 rounded-full animate-pulse">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Top 4 KPI Executive Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Fleet Health */}
        <Card className="relative overflow-hidden border-border/50 bg-card/80 backdrop-blur-md shadow-lg hover:shadow-xl transition-all">
          <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 rounded-full blur-2xl -mr-10 -mt-10 pointer-events-none" />
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Tenant Fleet Health
              </span>
              <div className="p-2 rounded-lg bg-primary/10 text-primary">
                <Building2 className="w-4 h-4" />
              </div>
            </div>
            <div className="mt-3 flex items-baseline justify-between">
              <div className="text-3xl font-extrabold text-foreground">
                {loading ? '—' : data?.stats.activeTenants ?? 0}
                <span className="text-base font-normal text-muted-foreground"> / {data?.stats.totalTenants ?? 0}</span>
              </div>
              <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-xs">
                Active
              </Badge>
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground pt-3 border-t border-border/40">
              <span>Onboarded: {data?.stats.onboardedTenants ?? 0}</span>
              <span>Inactive: {data?.stats.inactiveTenants ?? 0}</span>
            </div>
          </CardContent>
        </Card>

        {/* Card 2: Estimated Monthly Revenue */}
        <Card className="relative overflow-hidden border-border/50 bg-card/80 backdrop-blur-md shadow-lg hover:shadow-xl transition-all">
          <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 rounded-full blur-2xl -mr-10 -mt-10 pointer-events-none" />
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Estimated Monthly MRR
              </span>
              <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500">
                <DollarSign className="w-4 h-4" />
              </div>
            </div>
            <div className="mt-3 flex items-baseline justify-between">
              <div className="text-3xl font-extrabold text-foreground">
                ₹{loading ? '—' : (data?.stats.estimatedMRR ?? 0).toLocaleString('en-IN')}
              </div>
              <span className="text-xs text-emerald-500 font-medium flex items-center gap-1">
                <TrendingUp className="w-3.5 h-3.5" />
                Active Plans
              </span>
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground pt-3 border-t border-border/40">
              <span>Subscription Plans: {data?.subscriptionBreakdown.length ?? 0}</span>
              <span className="text-orange-400 font-medium">Expiring Soon: {data?.expiringTenants.length ?? 0}</span>
            </div>
          </CardContent>
        </Card>

        {/* Card 3: AI FinOps & Credits */}
        <Card className="relative overflow-hidden border-border/50 bg-card/80 backdrop-blur-md shadow-lg hover:shadow-xl transition-all">
          <div className="absolute top-0 right-0 w-32 h-32 bg-amber-500/10 rounded-full blur-2xl -mr-10 -mt-10 pointer-events-none" />
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                AI FinOps & API Health
              </span>
              <div className="p-2 rounded-lg bg-amber-500/10 text-amber-500">
                <Cpu className="w-4 h-4" />
              </div>
            </div>
            <div className="mt-3 flex items-baseline justify-between">
              <div className="text-3xl font-extrabold text-foreground">
                {loading ? '—' : (data?.stats.totalAiCreditsBalance ?? 0).toLocaleString()}
                <span className="text-xs font-normal text-muted-foreground ml-1">credits pool</span>
              </div>
              {data?.aiKeyHealth.errorApiKeysCount ? (
                <Badge className="bg-red-500/10 text-red-400 border-red-500/20 text-xs">
                  {data.aiKeyHealth.errorApiKeysCount} Key Error
                </Badge>
              ) : (
                <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-xs">
                  {data?.aiKeyHealth.activeApiKeysCount ?? 0} Keys Active
                </Badge>
              )}
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground pt-3 border-t border-border/40">
              <span>Total API Cost: ${data?.stats.totalAiUsageCost.toFixed(4) ?? '0.0000'}</span>
              <span>Keys in Pool: {data?.aiKeyHealth.totalApiKeys ?? 0}</span>
            </div>
          </CardContent>
        </Card>

        {/* Card 4: Vault & User Telemetry */}
        <Card className="relative overflow-hidden border-border/50 bg-card/80 backdrop-blur-md shadow-lg hover:shadow-xl transition-all">
          <div className="absolute top-0 right-0 w-32 h-32 bg-purple-500/10 rounded-full blur-2xl -mr-10 -mt-10 pointer-events-none" />
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Encrypted Vault Records
              </span>
              <div className="p-2 rounded-lg bg-purple-500/10 text-purple-500">
                <Lock className="w-4 h-4" />
              </div>
            </div>
            <div className="mt-3 flex items-baseline justify-between">
              <div className="text-3xl font-extrabold text-foreground">
                {loading ? '—' : (data?.stats.totalVaultRecords ?? 0).toLocaleString()}
              </div>
              <span className="text-xs text-purple-400 font-medium flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5" />
                18 Vault Modules
              </span>
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground pt-3 border-t border-border/40">
              <span>Total Members: {data?.stats.totalUsers ?? 0}</span>
              <span>Drive Sync Adoption: {data?.stats.googleDriveEnabledTenants ?? 0}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabbed Interactive Command Console */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="bg-card/90 border border-border/60 p-1.5 rounded-xl h-auto flex flex-wrap gap-1">
          <TabsTrigger value="overview" className="rounded-lg px-4 py-2 text-xs font-semibold">
            <Activity className="w-3.5 h-3.5 mr-1.5" />
            Fleet & Subscriptions Overview
          </TabsTrigger>
          <TabsTrigger value="finops" className="rounded-lg px-4 py-2 text-xs font-semibold">
            <Cpu className="w-3.5 h-3.5 mr-1.5" />
            AI & LLM FinOps Monitor
          </TabsTrigger>
          <TabsTrigger value="governance" className="rounded-lg px-4 py-2 text-xs font-semibold">
            <ShieldAlert className="w-3.5 h-3.5 mr-1.5" />
            Governance & Zero-Trust Posture
          </TabsTrigger>
          <TabsTrigger value="tenants" className="rounded-lg px-4 py-2 text-xs font-semibold">
            <Building2 className="w-3.5 h-3.5 mr-1.5" />
            Live Tenant Workspaces
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Overview */}
        <TabsContent value="overview" className="mt-6 space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Subscription Tiers Distribution */}
            <Card className="border-border/50 bg-card/80 backdrop-blur-md shadow-md lg:col-span-1">
              <CardContent className="p-5">
                <h3 className="text-base font-bold text-foreground flex items-center gap-2 mb-4">
                  <Layers className="w-4 h-4 text-primary" />
                  Plan Tier Distribution
                </h3>
                <div className="space-y-4">
                  {data?.subscriptionBreakdown.map((plan) => {
                    const percentage = data.stats.totalTenants
                      ? Math.round((plan.count / data.stats.totalTenants) * 100)
                      : 0;
                    return (
                      <div key={plan.planId} className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-foreground">{plan.name}</span>
                          <span className="text-muted-foreground">
                            {plan.count} tenants ({percentage}%)
                          </span>
                        </div>
                        <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                          <div
                            className="bg-gradient-to-r from-primary to-orange-500 h-2 rounded-full transition-all duration-500"
                            style={{ width: `${percentage}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                  {(!data?.subscriptionBreakdown || data.subscriptionBreakdown.length === 0) && (
                    <p className="text-xs text-muted-foreground py-6 text-center">No subscription plans found.</p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Expiring Subscriptions Alert Table */}
            <Card className="border-border/50 bg-card/80 backdrop-blur-md shadow-md lg:col-span-2">
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-base font-bold text-foreground flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-orange-400" />
                    Expiring Subscriptions Watch (Next 30 Days)
                  </h3>
                  <Button variant="ghost" size="sm" onClick={() => router.push('/admin/tenants')} className="text-xs">
                    View All Tenants <ChevronRight className="w-3 h-3 ml-1" />
                  </Button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-border/40 text-muted-foreground font-semibold">
                        <th className="py-2.5 px-3">Tenant Organization</th>
                        <th className="py-2.5 px-3">Plan Tier</th>
                        <th className="py-2.5 px-3">Status</th>
                        <th className="py-2.5 px-3">Expiry Date</th>
                        <th className="py-2.5 px-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/30">
                      {data?.expiringTenants.map((t) => (
                        <tr key={t.id} className="hover:bg-muted/40 transition-colors">
                          <td className="py-3 px-3 font-semibold text-foreground">{t.name}</td>
                          <td className="py-3 px-3">
                            <Badge variant="outline" className="text-xs">
                              {t.planName}
                            </Badge>
                          </td>
                          <td className="py-3 px-3">
                            {t.isActive ? (
                              <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-xs">
                                Active
                              </Badge>
                            ) : (
                              <Badge className="bg-red-500/10 text-red-400 border-red-500/20 text-xs">
                                Suspended
                              </Badge>
                            )}
                          </td>
                          <td className="py-3 px-3 text-muted-foreground font-medium">
                            {t.expiry ? formatDate(t.expiry) : 'N/A'}
                          </td>
                          <td className="py-3 px-3 text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => router.push(`/admin/tenants`)}
                              className="text-xs h-7 px-2.5"
                            >
                              Manage Plan
                            </Button>
                          </td>
                        </tr>
                      ))}
                      {(!data?.expiringTenants || data.expiringTenants.length === 0) && (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-muted-foreground">
                            No subscription plans are expiring within the next 30 days.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Tab 2: AI & LLM FinOps Monitor */}
        <TabsContent value="finops" className="mt-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Card className="border-border/50 bg-card/80 backdrop-blur-md shadow-md">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-muted-foreground">TOTAL AI CREDITS BALANCE</span>
                  <Cpu className="w-4 h-4 text-primary" />
                </div>
                <div className="mt-2 text-2xl font-extrabold text-foreground">
                  {data?.stats.totalAiCreditsBalance.toLocaleString() ?? 0}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Pooled credit reserve across all tenant workspaces.
                </p>
              </CardContent>
            </Card>

            <Card className="border-border/50 bg-card/80 backdrop-blur-md shadow-md">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-muted-foreground">TOTAL RECORD SCAN API COST</span>
                  <DollarSign className="w-4 h-4 text-emerald-500" />
                </div>
                <div className="mt-2 text-2xl font-extrabold text-foreground">
                  ${data?.stats.totalAiUsageCost.toFixed(4) ?? '0.0000'}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Cumulative LLM invocation cost recorded in tenantAiUsages.
                </p>
              </CardContent>
            </Card>

            <Card className="border-border/50 bg-card/80 backdrop-blur-md shadow-md">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-muted-foreground">API KEY ROTATION POOL</span>
                  <Activity className="w-4 h-4 text-amber-500" />
                </div>
                <div className="mt-2 text-2xl font-extrabold text-foreground">
                  {data?.aiKeyHealth.activeApiKeysCount ?? 0} / {data?.aiKeyHealth.totalApiKeys ?? 0} Active
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Gemini & OpenAI sovereign rotation keys configured.
                </p>
              </CardContent>
            </Card>
          </div>

          <Card className="border-border/50 bg-card/80 backdrop-blur-md shadow-md">
            <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-bold text-foreground">Manage Sovereign API Key Rotation & AI Costs</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  Add multi-key Gemini free-tier keys or update per-analysis AI credit deductions.
                </p>
              </div>
              <Button onClick={() => router.push('/admin/ai-settings')} className="bg-primary text-white">
                Open AI Key Manager <ExternalLink className="w-3.5 h-3.5 ml-2" />
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 3: Governance & Zero-Trust Posture */}
        <TabsContent value="governance" className="mt-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="border-border/50 bg-card/80 backdrop-blur-md shadow-md">
              <CardContent className="p-5 space-y-4">
                <h3 className="text-base font-bold text-foreground flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-primary" />
                  System & Infrastructure Health Check
                </h3>
                <div className="space-y-3 pt-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground">SMTP Outbound Gateway</span>
                    {data?.systemStatus.smtpConfigured ? (
                      <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Configured</Badge>
                    ) : (
                      <Badge className="bg-orange-500/10 text-orange-400 border-orange-500/20">Fallback Mode</Badge>
                    )}
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground">Google Drive Zero-Knowledge Sync</span>
                    <span className="font-bold text-foreground">
                      {data?.stats.googleDriveEnabledTenants ?? 0} / {data?.stats.totalTenants ?? 0} tenants enabled
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground">Tenant Onboarding Completion</span>
                    <span className="font-bold text-foreground">
                      {data?.stats.onboardedTenants ?? 0} / {data?.stats.totalTenants ?? 0} organizations completed
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border/50 bg-card/80 backdrop-blur-md shadow-md">
              <CardContent className="p-5">
                <h3 className="text-base font-bold text-foreground flex items-center gap-2 mb-3">
                  <Activity className="w-4 h-4 text-primary" />
                  Platform Security Audit Stream
                </h3>
                <div className="space-y-2.5 max-h-56 overflow-y-auto pr-1">
                  {data?.recentAuditLogs.map((log) => (
                    <div key={log.id} className="p-2.5 rounded-lg bg-muted/40 border border-border/30 text-xs">
                      <div className="flex items-center justify-between font-semibold text-foreground">
                        <span>{log.action}</span>
                        <span className="text-xs text-muted-foreground">{formatDate(log.createdAt)}</span>
                      </div>
                      <p className="text-muted-foreground mt-0.5 line-clamp-1">{log.details}</p>
                    </div>
                  ))}
                  {(!data?.recentAuditLogs || data.recentAuditLogs.length === 0) && (
                    <p className="text-xs text-muted-foreground py-6 text-center">No audit logs recorded yet.</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Tab 4: Live Tenant Workspaces */}
        <TabsContent value="tenants" className="mt-6">
          <Card className="border-border/50 bg-card/80 backdrop-blur-md shadow-md">
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-bold text-foreground flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-primary" />
                  Recent Tenant Organizations
                </h3>
                <Button size="sm" onClick={() => router.push('/admin/tenants')} className="text-xs">
                  Full Workspace Directory <ChevronRight className="w-3.5 h-3.5 ml-1" />
                </Button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-border/40 text-muted-foreground font-semibold">
                      <th className="py-2.5 px-3">Organization Name</th>
                      <th className="py-2.5 px-3">Admin User Email</th>
                      <th className="py-2.5 px-3">Plan Tier</th>
                      <th className="py-2.5 px-3">AI Engine</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3">Created</th>
                      <th className="py-2.5 px-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {data?.recentTenants.map((t) => (
                      <tr key={t.id} className="hover:bg-muted/40 transition-colors">
                        <td className="py-3 px-3 font-semibold text-foreground flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-primary" />
                          {t.name}
                        </td>
                        <td className="py-3 px-3 text-muted-foreground font-mono">{t.adminEmail}</td>
                        <td className="py-3 px-3">
                          <Badge variant="outline">{t.planName}</Badge>
                        </td>
                        <td className="py-3 px-3">
                          <Badge variant="secondary" className="text-xs uppercase">
                            {t.aiProvider}
                          </Badge>
                        </td>
                        <td className="py-3 px-3">
                          {t.isActive ? (
                            <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-xs">
                              Active
                            </Badge>
                          ) : (
                            <Badge className="bg-red-500/10 text-red-400 border-red-500/20 text-xs">
                              Suspended
                            </Badge>
                          )}
                        </td>
                        <td className="py-3 px-3 text-muted-foreground">{formatDate(t.createdAt)}</td>
                        <td className="py-3 px-3 text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => router.push('/admin/tenants')}
                            className="text-xs h-7 px-2.5"
                          >
                            Manage
                          </Button>
                        </td>
                      </tr>
                    ))}
                    {(!data?.recentTenants || data.recentTenants.length === 0) && (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-muted-foreground">
                          No tenant organizations found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
