'use client';
import { PasswordInput } from '@/components/ui/password-input';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, Save, Loader2, CheckCircle2, AlertCircle, Shield, Send } from 'lucide-react';
import { smtpSecurityIssue, smtpSecureForPort } from '@/lib/smtpSecurity';
import { clientGetMe } from '@/lib/clientAuth';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';


export default function SmtpConfigPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  /** Whether a password is already saved — decides the placeholder and `required`. */
  const [hasStoredPassword, setHasStoredPassword] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({
    smtpHost: '',
    smtpPort: 587,
    // FALSE, beside port 587. These two fields are one setting: 587 upgrades
    // with STARTTLS and 465 is TLS from the first byte, so 587 + secure is a
    // handshake that cannot complete. It used to default to `true` here, which
    // is how a re-entered configuration silently killed every outbound email.
    smtpSecure: false,
    smtpUser: '',
    smtpPassword: '',
    smtpFrom: ''
  });

  // Recomputed on every render rather than stored: it is a pure function of two
  // fields, and a copy in state is a copy that can disagree with them.
  const securityIssue = smtpSecurityIssue(Number(formData.smtpPort), formData.smtpSecure);

  useEffect(() => {
    async function verifyAdmin() {
      const me = await clientGetMe();
      if (!me.success || me.user.role !== 'SUPER_ADMIN') {
        router.push('/dashboard');
        return;
      }
      fetchSmtpConfig();
    }
    verifyAdmin();
  }, []);

  const fetchSmtpConfig = async () => {
    try {
      const { json } = await apiCall('/api/admin/smtp');
      if (json.success && json.config) {
        // `hasPassword`, never the password — the route stopped decrypting the
        // stored credential into this response. The field stays EMPTY and an
        // empty field means "keep what is saved", so the form is not holding a
        // live SMTP password in browser memory for as long as the tab is open.
        const { hasPassword, ...config } = json.config;
        setHasStoredPassword(!!hasPassword);
        setFormData({ ...config, smtpPassword: '' });
      } else {
        setError(json.error || 'Failed to load SMTP configuration.');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[admin/smtp] handler threw', err);
      setError('Something went wrong fetching SMTP configurations. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setSuccess('');
    setError('');
    try {
      const { json } = await apiCall('/api/admin/smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      if (json.success) {
        setSuccess('SMTP Server configurations updated successfully.');
        // A typed password has been consumed. Clearing it keeps the field's
        // meaning consistent — empty means "keep the saved one" — and stops the
        // credential sitting in state after it has been stored.
        setHasStoredPassword(true);
        setFormData(prev => ({ ...prev, smtpPassword: '' }));
      } else {
        setError(json.error || 'Failed to save configuration.');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[admin/smtp] handler threw', err);
      setError('Something went wrong saving configuration. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  /**
   * Proves the SAVED configuration, not the one in the form — the route reads
   * the stored row. Saying so in the copy matters: an operator who edits a
   * field and presses Test would otherwise be testing the previous settings and
   * believing the result.
   */
  const handleTest = async () => {
    setTesting(true);
    setSuccess('');
    setError('');
    try {
      const { json } = await apiCall('/api/admin/smtp/test', { method: 'POST' });
      if (json.success) {
        setSuccess(json.message || 'Test email sent.');
      } else {
        setError(json.error || 'The test email could not be sent.');
      }
    } catch (err) {
      console.error('[admin/smtp] test handler threw', err);
      setError('Something went wrong sending the test email. Please try again.');
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
        <Loader2 size={28} className="animate-spin text-primary" />
        <p className="text-sm">Loading global mail server config...</p>
      </div>
    );
  }

  return (
    <PageContainer width="compact" className="pb-12">
      <div className="flex flex-col gap-1.5 animate-fade-in">
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground flex items-center gap-2">
          <Shield className="text-primary w-8 h-8" />
          <span>System Configurations</span>
        </h1>
        <p className="text-muted-foreground text-sm">Configure system-wide mail server attributes (Super Admin only)</p>
      </div>

      {success && (
        <Alert variant="success" className="animate-scale-in">
          <CheckCircle2 size={18} />
          <AlertDescription className="text-xs">{success}</AlertDescription>
        </Alert>
      )}

      {/*
        `error` was being SET in three handlers and rendered nowhere — the
        variable was written, `AlertCircle` was imported for it, and the slot
        was left blank. So a failed save or a rejected configuration looked
        exactly like a successful one: nothing happened on screen.
      */}
      {error && (
        <Alert variant="destructive" className="animate-scale-in">
          <AlertCircle size={18} />
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSave} className="animate-fade-in stagger-1">
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass">
          <CardHeader>
            <CardTitle className="text-lg font-bold text-primary flex items-center gap-2">
              <Mail size={18} />
              <span>SMTP Mail Configuration</span>
            </CardTitle>
            <CardDescription className="text-xs">
              This configuration enables standard platform notifications, system verification emails, and alerts delivery.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>SMTP Host Address *</Label>
                <Input 
                  placeholder="smtp.mailgun.org or smtp.gmail.com" 
                  value={formData.smtpHost}
                  onChange={e => setFormData(prev => ({ ...prev, smtpHost: e.target.value }))}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>SMTP Port *</Label>
                <Input 
                  type="number"
                  placeholder="587" 
                  value={formData.smtpPort}
                  onChange={e => {
                    const port = parseInt(e.target.value, 10);
                    // Move the TLS mode with the port, because it is not an
                    // independent choice — 465 is implicit TLS and 587/25 are
                    // STARTTLS. `smtpSecureForPort` returns null for a port we
                    // have no opinion about, and that choice is left alone.
                    const implied = smtpSecureForPort(port);
                    setFormData(prev => ({
                      ...prev,
                      smtpPort: port,
                      smtpSecure: implied === null ? prev.smtpSecure : implied,
                    }));
                  }}
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>SMTP Username/User *</Label>
                <Input 
                  placeholder="postmaster@yourdomain.com" 
                  value={formData.smtpUser}
                  onChange={e => setFormData(prev => ({ ...prev, smtpUser: e.target.value }))}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>SMTP Password {hasStoredPassword ? '' : '*'}</Label>
                <PasswordInput
                  autoComplete="new-password"
                  placeholder={hasStoredPassword ? 'Saved — leave blank to keep it' : '••••••••••••••••'}
                  value={formData.smtpPassword}
                  onChange={e => setFormData(prev => ({ ...prev, smtpPassword: e.target.value }))}
                  // Only mandatory when there is nothing stored to fall back on.
                  // Marking it required while a password is saved would force the
                  // admin to re-type a credential they can no longer read, just to
                  // change the port.
                  required={!hasStoredPassword}
                />
                {hasStoredPassword && (
                  <p className="text-xs text-muted-foreground">
                    A password is saved. Type here only to replace it.
                  </p>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Sender Email Address (From) *</Label>
              <Input 
                type="email"
                placeholder="noreply@docsnx.com" 
                value={formData.smtpFrom}
                onChange={e => setFormData(prev => ({ ...prev, smtpFrom: e.target.value }))}
                required
              />
            </div>

            <label className="flex items-center gap-2.5 cursor-pointer text-sm font-semibold text-foreground mt-2">
              <input 
                type="checkbox" 
                className="w-4 h-4 rounded accent-primary" 
                checked={formData.smtpSecure}
                onChange={e => setFormData(prev => ({ ...prev, smtpSecure: e.target.checked }))}
              />
              Enforce TLS/SSL connection security (Secure)
            </label>
            <p className="text-xs text-muted-foreground -mt-1">
              Leave this unticked for ports 587, 25 and 2525. Tick it only for port 465.
              Either way the connection to your mail server is encrypted — this box just
              tells us which method your port expects. It changes automatically when you
              change the port, so in most cases you can leave it alone.
            </p>

            {/*
              The one combination that cannot connect, named before it is saved.
              The API refuses it too — this is the explanation, not the
              enforcement, because a form can be bypassed.
            */}
            {securityIssue && (
              <Alert variant="warning" className="animate-scale-in">
                <AlertCircle size={18} />
                <AlertDescription className="text-xs">{securityIssue}</AlertDescription>
              </Alert>
            )}
          </CardContent>
          <CardFooter className="pt-2 flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
            <Button 
              type="submit" 
              disabled={saving || !!securityIssue}
              className="w-full sm:w-auto font-bold h-10 px-5 text-xs bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-2"
            >
              {saving ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>Saving Server Configs...</span>
                </>
              ) : (
                <>
                  <Save size={14} />
                  <span>Save SMTP Configuration</span>
                </>
              )}
            </Button>
            {/*
              `type="button"`, or it submits the form it sits inside. Tests the
              SAVED row, so it is only meaningful after a save — hence the note
              beside it rather than a tooltip nobody opens.
            */}
            <Button
              type="button"
              variant="outline"
              onClick={handleTest}
              disabled={testing || saving}
              className="w-full sm:w-auto font-bold h-10 px-5 text-xs flex items-center gap-2"
            >
              {testing ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>Sending...</span>
                </>
              ) : (
                <>
                  <Send size={14} />
                  <span>Send test email</span>
                </>
              )}
            </Button>
            <span className="text-xs text-muted-foreground sm:ml-1">
              Sends to your own address using the <strong>saved</strong> settings. Save first.
            </span>
          </CardFooter>
        </Card>
      </form>
    </PageContainer>
  );
}
