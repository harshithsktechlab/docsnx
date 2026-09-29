'use client';

/**
 * A dev aid for the status palette. Not linked from anywhere and not part of
 * the product — the same footing as /gradient-preview and /logo-preview.
 *
 * It exists because the alert colours were wrong in a way that only shows up on
 * a real background: `text-destructive` measured 1.87:1 on dark and nobody
 * noticed until an alert appeared on a page someone was actually using. Every
 * variant is rendered here against both surfaces the app puts them on — a plain
 * card and a `.glass-card` — so a regression is one page load away from being
 * visible in both themes rather than waiting to be discovered in a form.
 *
 * The toggle writes `localStorage.theme` and `data-theme`, which is exactly what
 * Shell.js does, so it drives the real tokens and not a local imitation.
 */
import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, TriangleAlert, Trash2 } from 'lucide-react';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/** variant → the icon and copy each one is actually used for in the app. */
const VARIANTS = [
  {
    variant: 'destructive',
    Icon: AlertCircle,
    title: 'Destructive — a refusal the user must act on',
    body: 'You cannot file records into Identity, Education, Civil & Government Records or Others. Remove this record, or ask an administrator for access.',
  },
  {
    variant: 'warning',
    Icon: TriangleAlert,
    title: 'Warning — allowed, but not what they meant',
    body: 'This scan duplicates a record you already hold. Saving will overwrite the existing one rather than adding a second copy.',
  },
  {
    variant: 'success',
    Icon: CheckCircle2,
    title: 'Success — the thing they asked for happened',
    body: 'All 12 records were saved and their files uploaded to your Drive vault.',
  },
  {
    variant: 'default',
    Icon: Info,
    title: 'Default — context, no action required',
    body: 'AI Scan finished. Review the grouped records below; you can rename them, edit their fields and choose who each one belongs to.',
  },
];

function Row({ surface }) {
  const wrap =
    surface === 'glass' ? 'glass-card static p-6'
    : surface === 'card' ? 'rounded-2xl border border-border bg-card p-6'
    : 'p-6';
  return (
    <div className={`${wrap} flex flex-col gap-4`}>
      {VARIANTS.map(({ variant, Icon, title, body }) => (
        <Alert key={variant} variant={variant}>
          <Icon className="h-4 w-4" />
          <div>
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription className="mt-1 opacity-90">{body}</AlertDescription>
          </div>
        </Alert>
      ))}
      {/* The bare form, which is how most of the 28 callsites use it: one icon,
          one line, no title. It has to survive without the title's weight. */}
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription className="text-sm">
          One record is filed under a module you do not have permission to add to.
        </AlertDescription>
      </Alert>
    </div>
  );
}

export default function AlertsPreview() {
  const [theme, setTheme] = useState('light');

  useEffect(() => {
    const saved = localStorage.getItem('theme') || 'light';
    setTheme(saved);
    document.documentElement.setAttribute('data-theme', saved);
  }, []);

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('theme', next);
    document.documentElement.setAttribute('data-theme', next);
  };

  return (
    <div className="min-h-screen bg-background text-foreground p-8 md:p-12 flex flex-col gap-10">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold">Status palette</h1>
          <p className="text-muted-foreground mt-1">
            Every alert variant on the three surfaces the app puts them on. Flip the
            theme — all four must stay readable in both.
          </p>
        </div>
        <Button onClick={toggle} variant="outline">
          Theme: {theme} — switch to {theme === 'dark' ? 'light' : 'dark'}
        </Button>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
          On a glass card (the bulk-scan review screen)
        </h2>
        <Row surface="glass" />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
          On a solid card
        </h2>
        <Row surface="card" />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
          On the bare page background
        </h2>
        <Row surface="bare" />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
          The same tokens as badges, and the solid fills they are NOT
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="success">Saved</Badge>
          <Badge variant="warning">Expiring</Badge>
          <Badge variant="danger">Overdue</Badge>
          {/* Solid fills stay saturated and pair with white — a different job
              from the -text tokens above, which is the whole point of the split. */}
          <Button variant="destructive" size="sm">Delete</Button>
        </div>
      </section>

      {/*
        * ── THE FOUR JOBS RED WAS DOING ────────────────────────────────────
        * 53 callsites used `text-destructive` for all of these at once, which
        * is why it could not be readable: a fill dark enough for white button
        * text is never a legible label. Each row is one job, so a regression in
        * any of them is visible here rather than in whichever form ships it.
        */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
          The four jobs red does — one row each
        </h2>
        <div className="rounded-2xl border border-border bg-card p-6 flex flex-col gap-5 text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Validation error &mdash; text-danger-text
            </span>
            <label className="font-medium">
              Policy number <span className="text-danger-text">*</span>
            </label>
            <input
              className="h-9 rounded-lg border border-danger-border bg-transparent px-3 max-w-xs"
              defaultValue=""
              placeholder="Required"
              readOnly
            />
            <p className="text-xs font-medium text-danger-text">This field is required.</p>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Destructive control &mdash; text-danger-action
            </span>
            <div className="flex items-center gap-3">
              <button className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-danger-action hover:bg-destructive/10">
                <Trash2 size={14} /> Delete record
              </button>
              <button className="h-9 w-9 rounded-lg flex items-center justify-center text-danger-action hover:bg-destructive/10">
                <Trash2 size={16} />
              </button>
              {/* The comparison that motivated the extra token: the message
                  colour on a 16px glyph reads pale rather than dangerous. */}
              <span className="text-xs text-muted-foreground">vs</span>
              <button className="h-9 w-9 rounded-lg flex items-center justify-center text-danger-text hover:bg-destructive/10">
                <Trash2 size={16} />
              </button>
              <span className="text-xs text-muted-foreground">(danger-text, too pale here)</span>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Bad-status emphasis &mdash; text-danger-text / text-warning-text
            </span>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-semibold text-danger-text">3 overdue</span>
              <span className="flex items-center gap-1 rounded-md bg-danger-surface px-1.5 py-0.5 text-xs font-bold text-danger-text">
                <TriangleAlert size={9} /> 3 overdue
              </span>
              <span className="font-bold text-warning-text">12 days remaining</span>
              <span className="font-bold text-success-text">Active</span>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Solid fill &mdash; --destructive, unchanged
            </span>
            <div className="flex items-center gap-3">
              <Button variant="destructive" size="sm">Delete workspace</Button>
              <span className="text-xs text-muted-foreground">
                white on a dark fill — the one job --destructive was always right for
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
          Raw tokens
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {['danger', 'warning', 'success', 'info'].map((name) => (
            <div
              key={name}
              className="rounded-xl border p-4 flex flex-col gap-2"
              style={{
                background: `hsl(var(--${name}-surface))`,
                borderColor: `hsl(var(--${name}-border))`,
                color: `hsl(var(--${name}-text))`,
              }}
            >
              <span className="font-bold">{name}</span>
              <span className="text-xs opacity-90">text on surface</span>
              <span className="text-xs font-mono opacity-75">--{name}-text</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
