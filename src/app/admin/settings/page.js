'use client';
import { PasswordInput } from '@/components/ui/password-input';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  Settings, Loader2, Save
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';


const PROVIDER_LABELS = { smtp: 'SMTP', graph: 'Microsoft Graph', gmail: 'Gmail API' };

export default function AdminSettingsPage() {
  /** The single active email provider, read from /api/admin/email-provider. */
  const [emailProvider, setEmailProvider] = useState(null);
  useEffect(() => {
    apiCall('/api/admin/email-provider')
      .then(({ json }) => { if (json?.success) setEmailProvider(json.config.provider); })
      .catch(() => {});
  }, []);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  /** Whether an SMTP password is already stored. The route never sends it back. */
  const [hasStoredPassword, setHasStoredPassword] = useState(false);
  const [formData, setFormData] = useState({
    platformName: '',
    platformGstin: '',
    platformAddress: '',
    platformStateCode: '',
    platformLogo: '',
    platformEmail: '',
    platformPhone: '',
    smtpHost: '',
    smtpPort: '',
    smtpUser: '',
    smtpPassword: '',
    smtpFrom: '',
    smtpSecure: true
  });

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const { json: data } = await apiCall('/api/admin/settings');
      if (data.config) {
        setFormData({
          platformName: data.config.platformName || '',
          platformGstin: data.config.platformGstin || '',
          platformAddress: data.config.platformAddress || '',
          platformStateCode: data.config.platformStateCode || '',
          platformLogo: data.config.platformLogo || '',
          platformEmail: data.config.platformEmail || '',
          platformPhone: data.config.platformPhone || '',
          smtpHost: data.config.smtpHost || '',
          smtpPort: data.config.smtpPort || '',
          smtpUser: data.config.smtpUser || '',
          // ALWAYS EMPTY. This used to load the stored credential — which the
          // route returned as ciphertext — into the field and PUT it back
          // verbatim on every save. Blank now means "keep the saved one".
          smtpPassword: '',
          smtpFrom: data.config.smtpFrom || '',
          smtpSecure: data.config.smtpSecure ?? true
        });
        setHasStoredPassword(!!data.config.hasSmtpPassword);
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[admin/settings] handler threw', err);
      toast.error('Something went wrong loading settings. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogoUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    // Check file size (e.g. limit to 2MB)
    if (file.size > 2 * 1024 * 1024) {
      toast.error('Logo file is too large. Please upload an image under 2MB.');
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      setFormData(prev => ({ ...prev, platformLogo: reader.result }));
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { json: data } = await apiCall('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      if (data.success) {
        toast.success('Platform settings saved successfully.');
        setHasStoredPassword(prev => prev || !!formData.smtpPassword);
        setFormData(prev => ({ ...prev, smtpPassword: '' }));
      } else {
        toast.error(data.error || 'Failed to save settings.');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[admin/settings] handler threw', err);
      toast.error('Something went wrong while saving settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-3 text-muted-foreground">
        <Loader2 size={32} className="animate-spin text-primary" />
        <p className="text-sm">Loading settings...</p>
      </div>
    );
  }

  return (
    <PageContainer width="narrow" className="space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Settings className="text-primary" size={32} />
            Platform Settings
          </h1>
          <p className="text-muted-foreground mt-1">
            Configure invoice and GST details, and SMTP credentials.
          </p>
        </div>
      </div>

      <form onSubmit={handleSave}>
        <Tabs defaultValue="platform" className="w-full space-y-6">
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="platform">Invoicing</TabsTrigger>
            <TabsTrigger value="email">Email / SMTP</TabsTrigger>
          </TabsList>

          <TabsContent value="platform" className="space-y-6">
            <Card className="border-border/40 shadow-sm">
              <CardHeader>
                <CardTitle className="text-xl">Invoice &amp; Billing Entity</CardTitle>
                {/* Said plainly, because the absence of this line is what made
                    an invoice logo turn up as the application's logo in every
                    member's sidebar. */}
                <CardDescription>
                  These details appear on generated invoices only. The DocsNX name and
                  logo are fixed and are not configured here.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Billing Entity Name</Label>
                    <Input
                      value={formData.platformName}
                      onChange={(e) => setFormData({ ...formData, platformName: e.target.value })}
                      placeholder="e.g. DocsNX Pvt Ltd"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>GSTIN</Label>
                    <Input
                      value={formData.platformGstin}
                      onChange={(e) => setFormData({ ...formData, platformGstin: e.target.value })}
                      placeholder="22AAAAA0000A1Z5"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Billing Address</Label>
                  <Input
                    value={formData.platformAddress}
                    onChange={(e) => setFormData({ ...formData, platformAddress: e.target.value })}
                    placeholder="Full address for invoice generation"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>State Code (2-digit)</Label>
                    <Input
                      value={formData.platformStateCode}
                      onChange={(e) => setFormData({ ...formData, platformStateCode: e.target.value })}
                      placeholder="e.g. 27"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Invoice Logo</Label>
                    <div className="flex items-center gap-4">
                      {formData.platformLogo ? (
                        <div className="h-12 w-12 border border-border rounded overflow-hidden flex items-center justify-center bg-white shrink-0">
                          <img src={formData.platformLogo} alt="Logo" className="max-h-full max-w-full object-contain" />
                        </div>
                      ) : (
                        <div className="h-12 w-12 border border-border rounded border-dashed flex items-center justify-center text-xs text-muted-foreground shrink-0">
                          None
                        </div>
                      )}
                      <div className="flex-1 flex flex-col gap-1">
                        <Input
                          type="file"
                          accept="image/*"
                          onChange={handleLogoUpload}
                          className="text-xs cursor-pointer"
                        />
                        <p className="text-xs text-muted-foreground">Max 2MB. Recommended: PNG with transparent background.</p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Billing Email</Label>
                    <Input
                      type="email"
                      value={formData.platformEmail}
                      onChange={(e) => setFormData({ ...formData, platformEmail: e.target.value })}
                      placeholder="billing@docsnx.com"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Billing Phone</Label>
                    <PhoneInput
                      value={formData.platformPhone}
                      onChange={(value) => setFormData({ ...formData, platformPhone: value })}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="email" className="space-y-6">
            <Card className="border-primary/40 shadow-sm">
              <CardHeader>
                <CardTitle className="text-xl">Email Provider</CardTitle>
                <CardDescription>
                  Choose how the platform sends email: SMTP, Microsoft Graph or Gmail API. Only one is active at a time.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
                <p className="text-sm">
                  Active provider:{' '}
                  <strong>{emailProvider ? PROVIDER_LABELS[emailProvider] || emailProvider : '…'}</strong>
                </p>
                <Button asChild type="button" variant="outline">
                  <Link href="/admin/smtp">Change email provider</Link>
                </Button>
              </CardContent>
            </Card>
            <Card className="border-border/40 shadow-sm">
              <CardHeader>
                <CardTitle className="text-xl">SMTP Configuration (Emails)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>SMTP Host</Label>
                    <Input
                      value={formData.smtpHost}
                      onChange={(e) => setFormData({ ...formData, smtpHost: e.target.value })}
                      placeholder="smtp.gmail.com"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>SMTP Port</Label>
                    <Input
                      type="number"
                      value={formData.smtpPort}
                      onChange={(e) => setFormData({ ...formData, smtpPort: e.target.value })}
                      placeholder="587 or 465"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>SMTP Username</Label>
                    <Input
                      value={formData.smtpUser}
                      onChange={(e) => setFormData({ ...formData, smtpUser: e.target.value })}
                      placeholder="user@example.com"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>SMTP Password</Label>
                    <PasswordInput
                      autoComplete="new-password"
                      value={formData.smtpPassword}
                      onChange={(e) => setFormData({ ...formData, smtpPassword: e.target.value })}
                      placeholder={hasStoredPassword ? 'Saved — leave blank to keep it' : '••••••••'}
                    />
                    {hasStoredPassword && (
                      <p className="text-xs text-muted-foreground">
                        A password is saved. Type here only to replace it.
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label>From Address (Sender Name & Email)</Label>
                    <Input
                      value={formData.smtpFrom}
                      onChange={(e) => setFormData({ ...formData, smtpFrom: e.target.value })}
                      placeholder="DocsNX <noreply@docsnx.com>"
                    />
                  </div>
                  <div className="flex items-center space-x-2 pt-8">
                    <Switch
                      checked={formData.smtpSecure}
                      onCheckedChange={(checked) => setFormData({ ...formData, smtpSecure: checked })}
                    />
                    <Label>Use SSL/TLS (Secure Connection)</Label>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <div className="flex justify-end mt-8">
          <Button type="submit" size="lg" disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save Settings
          </Button>
        </div>
      </form>
    </PageContainer>
  );
}
