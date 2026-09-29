'use client';

/**
 * The SUPER_ADMIN dashboard — tenant and user totals, and the two screens the
 * platform role actually works in.
 *
 * Split out of `/dashboard/page.js` when the household's half became
 * `WorkspaceDashboard`. It is not a workspace and shares nothing with one: no
 * records, no counts, no growth chart, and deliberately no audit feed — that
 * trail is tenant-owned and `/api/dashboard` stopped returning it to this role.
 *
 * Rendered from the payload `WorkspaceDashboard` already fetched
 * (`isAdminDashboard`), so this costs no request of its own.
 */
import React from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, ArrowUpRight, Users } from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';

const containerVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.1 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } },
};

export default function AdminDashboard({ stats = {}, userName = 'Administrator', greeting }) {
  const router = useRouter();

  const adminStatCards = [
    { name: 'Total Tenants', count: stats.tenants, icon: Users, color: '#3b82f6', path: '/tenants', sub: 'Active workspaces' },
    { name: 'System Users', count: stats.users, icon: Users, color: '#06b6d4', path: '/tenants', sub: 'Across all families' },
    { name: 'AI API Keys', count: stats.apiKeys, icon: KeyRound, color: '#8b5cf6', path: '/ai-settings', sub: 'Key rotation pool' },
  ];

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="show" className="flex flex-col gap-6 w-full max-w-7xl mx-auto pb-8">
      {/* Welcome Section */}
      <motion.div variants={itemVariants}>
        <Card className="border-border/50 bg-gradient-to-r from-indigo-500/5 to-pink-500/5 backdrop-blur shadow-glass p-6 border-l-4 border-l-red-500">
          <span className="text-xs uppercase font-bold text-red-500 tracking-widest leading-none">
            System Administrator
          </span>
          <h2 className="text-2xl font-black text-foreground mt-1.5 leading-none">
            {greeting}, <span className="gradient-text">{userName}</span>!
          </h2>
          <p className="text-muted-foreground text-sm mt-1">
            System dashboard. You have total control over tenants, API keys, and system integration logs.
          </p>
        </Card>
      </motion.div>

      {/* Quick Actions Panel */}
      <motion.div variants={itemVariants}>
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-6">
          <CardHeader className="p-0 pb-4">
            <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Admin Quick Actions</h3>
          </CardHeader>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Button
              variant="secondary"
              onClick={() => router.push('/tenants')}
              className="flex flex-col items-center gap-2 p-6 h-auto rounded-xl border border-primary/20 bg-primary/5 hover:bg-primary/10 text-foreground transition-all"
            >
              <Users size={20} className="text-primary" />
              <span className="text-xs font-bold">Manage Tenants</span>
            </Button>

            <Button
              variant="secondary"
              onClick={() => router.push('/ai-settings')}
              className="flex flex-col items-center gap-2 p-6 h-auto rounded-xl border border-border bg-background/25 hover:bg-muted/30 text-foreground transition-all"
            >
              <KeyRound size={20} className="text-accent" />
              <span className="text-xs font-bold">AI API Keys</span>
            </Button>
          </div>
        </Card>
      </motion.div>

      {/* Stats Grid */}
      <motion.div variants={itemVariants} className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {adminStatCards.map((card) => {
          const Icon = card.icon;
          return (
            <Card
              key={card.name}
              onClick={() => router.push(card.path)}
              className="border-border/50 bg-card backdrop-blur shadow-glass hover:bg-muted/10 transition-all cursor-pointer p-5 flex flex-col gap-4"
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
                <div className="text-2xl font-black text-foreground leading-none">{card.count}</div>
                <div className="text-xs font-bold text-foreground mt-1.5 leading-none">{card.name}</div>
                <div className="text-xs text-muted-foreground mt-1 leading-none">{card.sub}</div>
              </div>
            </Card>
          );
        })}
      </motion.div>
    </motion.div>
  );
}
