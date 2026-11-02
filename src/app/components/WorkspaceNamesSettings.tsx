'use client';

import React from 'react';
import { Building2, UserCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import InlineRename from '@/app/components/InlineRename';
import { personalWorkspaceName } from '@/lib/workspaceName';

/**
 * Every name an admin can change, in one place: the workspace (or the personal
 * and business names of a combo account) and each company.
 *
 * The same pencils sit on the dashboard header, where the name is shown — this
 * is the full list for people who go looking in Settings. All the saving is in
 * `InlineRename`.
 */
interface WorkspaceNamesSettingsProps {
  accountType: string;
  tenant: { name?: string | null; personalWorkspaceName?: string | null } | null | undefined;
  companies: Array<{ id: string; name: string }>;
  /** Re-read the signed-in user after a save so the page stops showing the old name. */
  onChanged: () => void;
}

export default function WorkspaceNamesSettings({
  accountType,
  tenant,
  companies,
  onChanged,
}: WorkspaceNamesSettingsProps) {
  const isCombo = accountType === 'both';
  const hasBusiness = accountType === 'business' || isCombo;

  const rows: Array<{ key: string; icon: React.ReactNode; title: string; hint: string; node: React.ReactNode }> = [];

  if (isCombo) {
    rows.push({
      key: 'personal',
      icon: <UserCheck size={16} />,
      title: 'Personal workspace',
      hint: 'Your personal side.',
      node: (
        <InlineRename
          value={personalWorkspaceName(tenant)}
          kind="personal"
          className="font-semibold text-foreground"
          onSaved={onChanged}
        />
      ),
    });
  }
  rows.push({
    key: 'account',
    icon: isCombo || accountType === 'business' ? <Building2 size={16} /> : <UserCheck size={16} />,
    title: accountType === 'personal' ? 'Workspace' : 'Business account',
    hint: accountType === 'personal'
      ? 'Shown in the sidebar, on your dashboard and on invoices.'
      : 'The umbrella name over your companies, shown in the sidebar and on invoices.',
    node: (
      <InlineRename
        value={(tenant?.name || '').trim() || 'My Workspace'}
        kind="account"
        className="font-semibold text-foreground"
        onSaved={onChanged}
      />
    ),
  });

  return (
    <Card className="border-border/50 bg-card backdrop-blur shadow-glass animate-fade-in">
      <CardHeader>
        <CardTitle className="text-lg font-bold text-primary">Workspace names</CardTitle>
        <CardDescription className="text-xs">
          Rename your workspace{hasBusiness ? ' and companies' : ''} any time. The name you type
          to confirm an account erasure follows the account name.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-xs">
        {rows.map((r) => (
          <div key={r.key} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 font-bold text-muted-foreground uppercase tracking-wider">
              {r.icon}
              {r.title}
            </div>
            <div className="text-sm">{r.node}</div>
            <p className="text-muted-foreground">{r.hint}</p>
          </div>
        ))}

        {hasBusiness && (
          <div className="flex flex-col gap-2 border-t border-border/50 pt-4">
            <div className="flex items-center gap-1.5 font-bold text-muted-foreground uppercase tracking-wider">
              <Building2 size={16} />
              Companies
            </div>
            {companies.length === 0 ? (
              <p className="text-muted-foreground">No companies yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {companies.map((c) => (
                  <li key={c.id} className="text-sm">
                    <InlineRename
                      value={c.name}
                      kind="company"
                      companyId={c.id}
                      className="font-semibold text-foreground"
                      onSaved={onChanged}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
