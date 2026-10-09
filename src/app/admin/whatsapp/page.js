'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { MessageCircle, Save, Loader2, Send, AlertCircle, CheckCircle2, Shield } from 'lucide-react';
import { clientGetMe } from '@/lib/clientAuth';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';


/**
 * The platform's WhatsApp on/off switch.
 *
 * Messages go out through Meta's WhatsApp Cloud API. Its URL and token are
 * server environment variables, so there is nothing secret on this page: the
 * switch, whether the server has those credentials, and a test send.
 */
export default function WhatsAppGatewayPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [metaConfigured, setMetaConfigured] = useState(false);
  const [testNumber, setTestNumber] = useState('');

  useEffect(() => {
    async function init() {
      const me = await clientGetMe();
      if (!me.success || me.user.role !== 'SUPER_ADMIN') {
        router.push('/dashboard');
        return;
      }
      try {
        const { json } = await apiCall('/api/admin/whatsapp');
        if (json.success && json.config) {
          setEnabled(!!json.config.enabled);
          setMetaConfigured(!!json.config.metaConfigured);
        } else {
          toast.error(json.error || 'Failed to load WhatsApp configuration.');
        }
      } catch (err) {
        // Transport failures are values now, not throws — `apiCall` and
        // `postUpload` return them. So reaching this catch means a bug in the
        // block above, and calling that a network error sent people to check
        // a connection that was working.
        console.error('[admin/whatsapp] handler threw', err);
        toast.error('Something went wrong loading WhatsApp configuration. Please try again.');
      } finally {
        setLoading(false);
      }
    }
    init();
  }, [router]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { json } = await apiCall('/api/admin/whatsapp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (json.success) {
        toast.success(enabled ? 'WhatsApp verification enabled.' : 'WhatsApp verification disabled.');
      } else {
        toast.error(typeof json.error === 'string' ? json.error : 'Failed to save configuration.');
      }
    } catch (err) {
      console.error('[admin/whatsapp] handler threw', err);
      toast.error('Something went wrong saving configuration. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setSendingTest(true);
    try {
      const { json } = await apiCall('/api/admin/whatsapp/test', {
        timeoutMs: 120_000,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: testNumber }),
      });
      if (json.success) toast.success(json.message || 'Test message sent.');
      else toast.error(typeof json.error === 'string' ? json.error : 'Test message failed.');
    } catch (err) {
      console.error('[admin/whatsapp] handler threw', err);
      toast.error('Something went wrong sending the test message. Please try again.');
    } finally {
      setSendingTest(false);
    }
  };

  // PhoneInput seeds itself with the dial code alone, so a non-empty value is
  // not yet a number. Ten digits is the shortest thing worth sending.
  const testNumberIsDialable = testNumber.replace(/\D/g, '').length >= 10;

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
        <Loader2 size={28} className="animate-spin text-primary" />
        <p className="text-sm">Loading WhatsApp settings...</p>
      </div>
    );
  }

  return (
    <PageContainer width="compact" className="pb-12">
      <div className="flex flex-col gap-1.5 animate-fade-in">
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground flex items-center gap-2">
          <Shield className="text-primary w-8 h-8" />
          <span>WhatsApp Gateway</span>
        </h1>
        <p className="text-muted-foreground text-sm">
          Turn WhatsApp verification codes on or off (Super Admin only)
        </p>
      </div>

      <form onSubmit={handleSave} className="animate-fade-in stagger-1">
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass">
          <CardHeader>
            <CardTitle className="text-lg font-bold text-primary flex items-center gap-2">
              <MessageCircle size={18} />
              <span>WhatsApp (Meta Cloud API)</span>
            </CardTitle>
            <CardDescription className="text-xs">
              When on, verification codes are sent on WhatsApp. Members with a phone number verify by WhatsApp;
              tenant admins with a phone number verify by both email and WhatsApp. When off, everyone verifies by email.
            </CardDescription>
          </CardHeader>

          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <Switch
                checked={enabled}
                onCheckedChange={setEnabled}
                disabled={!metaConfigured && !enabled}
              />
              <Label className="cursor-pointer">Send verification codes over WhatsApp</Label>
            </div>

            {metaConfigured ? (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <CheckCircle2 size={14} className="text-primary" />
                Meta credentials found on the server.
              </p>
            ) : (
              <Alert variant="destructive">
                <AlertCircle size={18} />
                <AlertDescription className="text-xs">
                  <strong>WHATSAPP_BUSINESS_API_URL</strong> and <strong>WHATSAPP_API_TOKEN</strong> are not set in
                  the server environment, so WhatsApp cannot send. Set them and restart the service.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>

          <CardFooter className="pt-2">
            <Button
              type="submit"
              disabled={saving}
              className="w-full sm:w-auto font-bold h-10 px-5 text-xs bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-2"
            >
              {saving ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>Saving...</span>
                </>
              ) : (
                <>
                  <Save size={14} />
                  <span>Save</span>
                </>
              )}
            </Button>
          </CardFooter>
        </Card>
      </form>

      <Card className="border-border/50 bg-card backdrop-blur shadow-glass animate-fade-in stagger-2">
        <CardHeader>
          <CardTitle className="text-lg font-bold text-primary flex items-center gap-2">
            <Send size={18} />
            <span>Send a Test Message</span>
          </CardTitle>
          <CardDescription className="text-xs">
            Sends the verification-code template with the dummy code 123456. Uses the saved setting, so save first.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Test Number</Label>
            <PhoneInput value={testNumber} onChange={setTestNumber} />
          </div>
        </CardContent>
        <CardFooter className="pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleTest}
            disabled={sendingTest || !testNumberIsDialable}
            className="w-full sm:w-auto font-bold h-10 px-5 text-xs flex items-center gap-2"
          >
            {sendingTest ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                <span>Sending...</span>
              </>
            ) : (
              <>
                <Send size={14} />
                <span>Send Test Message</span>
              </>
            )}
          </Button>
        </CardFooter>
      </Card>
    </PageContainer>
  );
}
