'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { MessageCircle, Save, Loader2, RefreshCw, Send, AlertCircle, Shield } from 'lucide-react';
import { clientGetMe } from '@/lib/clientAuth';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { PasswordInput } from '@/components/ui/password-input';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';


/**
 * Reasons that mean NOTHING IS STORED YET, as opposed to stored-and-broken.
 *
 * The instance list is read from `system_configs`, never from the boxes on this
 * page (see the header of /api/admin/whatsapp/instances — a credential must not
 * travel in a body just to populate a dropdown). So until these clear, typing a
 * URL and key changes nothing about what Refresh can find, and the page has to
 * say so rather than offer a control that cannot work.
 */
const unsavedReasons = ['missing_url', 'missing_key'];

/**
 * Reasons the list can be empty that are not faults: nothing has been saved
 * yet, or the engine genuinely holds no instances. These read as a hint. Every
 * other reason means something is configured but broken, and gets an alert.
 */
const mutedReasons = [...unsavedReasons, 'empty'];

/**
 * Which of the engine's linked handsets the platform sends from.
 *
 * The API key box is deliberately EMPTY on load, not pre-filled: the GET never
 * returns the stored key, and a blank value on save means "keep the one you
 * have". So an admin changing only the instance never round-trips the secret
 * through the browser.
 */
export default function WhatsAppGatewayPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  // Length + SHA-256 prefix of the stored key. Never the key. This is the only
  // way to tell "the engine's key changed" from "something else got saved here".
  const [keyFingerprint, setKeyFingerprint] = useState(null);
  const [instances, setInstances] = useState([]);
  const [instancesLoaded, setInstancesLoaded] = useState(false);
  // Why the list is the length it is. `null` until the route has answered once.
  const [listing, setListing] = useState(null);
  const [testNumber, setTestNumber] = useState('');
  const [formData, setFormData] = useState({
    enabled: false,
    apiUrl: '',
    apiKey: '',
    instance: '',
  });

  const loadInstances = useCallback(async ({ quiet = false } = {}) => {
    setRefreshing(true);
    try {
      const { json } = await apiCall('/api/admin/whatsapp/instances');
      if (!json.success) {
        if (!quiet) toast.error(json.error || 'Could not reach the WhatsApp engine.');
        return;
      }
      setInstances(json.instances || []);
      setInstancesLoaded(true);
      setListing({ reason: json.reason, message: json.message });
      if (!quiet) {
        // The route now says exactly what went wrong; repeat it rather than
        // guessing. It stays on screen in the alert below either way.
        if (json.reason === 'ok') toast.success(`Found ${json.instances.length} instance(s).`);
        else if (json.reason === 'empty') toast.info(json.message);
        else toast.error(json.message);
      }
    } catch (err) {
      console.error('[admin/whatsapp] instance listing threw', err);
      if (!quiet) toast.error('Something went wrong listing instances. Please try again.');
    } finally {
      setRefreshing(false);
    }
  }, []);

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
          setFormData({
            enabled: !!json.config.enabled,
            apiUrl: json.config.apiUrl || '',
            apiKey: '',
            instance: json.config.instance || '',
          });
          setHasApiKey(!!json.config.hasApiKey);
          setKeyFingerprint(json.config.keyFingerprint ?? null);
          // Unconditionally, even with no key stored: the reason the list is
          // empty is the thing an admin opens this page to find out, and making
          // them click Refresh to be told "nothing is saved yet" helps nobody.
          loadInstances({ quiet: true });
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
  }, [router, loadInstances]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { json } = await apiCall('/api/admin/whatsapp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (json.success) {
        if (formData.apiKey) {
          setHasApiKey(true);
          // Re-read the fingerprint rather than deriving it from what was just
          // typed: the point of showing it is to report what the SERVER ended up
          // with, and a value computed in the browser would agree with the box
          // even when the two had diverged.
          const { json: fresh } = await apiCall('/api/admin/whatsapp');
          if (fresh?.success) setKeyFingerprint(fresh.config?.keyFingerprint ?? null);
        }
        // Clear the box again so a second save does not re-send the key.
        setFormData((prev) => ({ ...prev, apiKey: '' }));
        toast.success('WhatsApp gateway saved.');
        // NOT quiet: this is the moment the connection becomes real, and the
        // instance list either fills or fails for a nameable reason. Saying so
        // is what makes the second step obvious instead of something the admin
        // has to guess at by clicking Refresh.
        loadInstances();
      } else {
        toast.error(typeof json.error === 'string' ? json.error : 'Failed to save configuration.');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
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
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[admin/whatsapp] handler threw', err);
      toast.error('Something went wrong sending the test message. Please try again.');
    } finally {
      setSendingTest(false);
    }
  };

  // PhoneInput seeds itself with the dial code alone, so a non-empty value is
  // not yet a number. Ten digits is the shortest thing worth sending.
  const testNumberIsDialable = testNumber.replace(/\D/g, '').length >= 10;

  // `hasApiKey` is a truthiness check on the CIPHERTEXT, so it stays true for a
  // key this server can no longer decrypt. Only the listing knows the difference.
  const keyIsUsable = hasApiKey && listing?.reason !== 'key_unreadable';

  // Whether a URL *and* a key are actually in system_configs — the only thing
  // the instance list is ever read from. Text sitting in the boxes above is not
  // a saved connection, and mistaking one for the other is what sends an admin
  // to Refresh before Save and produces "no URL is saved" over a filled-in form.
  //
  // `key_unreadable`, `unauthorized`, `unreachable` and `http_error` all count
  // as SAVED: something is stored, it just does not work, and each has its own
  // copy below. Those must keep Refresh usable — retrying is the fix for them.
  //
  // `listing` is null until the instances route has answered once; treat that as
  // "not yet known" so a slow first fetch never flashes step 1 over a gateway
  // that is already configured.
  const connectionSaved = !!listing && !unsavedReasons.includes(listing.reason);
  const awaitingFirstSave = !!listing && !connectionSaved;

  const selected = instances.find((inst) => inst.name === formData.instance);
  // Keep a saved-but-unlisted instance selectable, so a temporarily unreachable
  // engine cannot silently blank the stored choice on the next save.
  const options = selected || !formData.instance
    ? instances
    : [...instances, { name: formData.instance, number: null, connectionStatus: 'not listed' }];

  // An empty Select that says "Select an instance" invites clicking a box with
  // nothing in it. Say why it is empty instead; the detail is right below it.
  const instancePlaceholder = awaitingFirstSave
    ? 'Save the URL and key first'
    : !instancesLoaded
      ? 'Refresh to list instances'
      : options.length === 0
        ? 'Nothing to select'
        : 'Select an instance';

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
        <Loader2 size={28} className="animate-spin text-primary" />
        <p className="text-sm">Loading WhatsApp gateway config...</p>
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
          Choose the Evolution instance the platform sends from (Super Admin only)
        </p>
      </div>

      <form onSubmit={handleSave} className="animate-fade-in stagger-1">
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass">
          <CardHeader>
            <CardTitle className="text-lg font-bold text-primary flex items-center gap-2">
              <MessageCircle size={18} />
              <span>Evolution API Connection</span>
            </CardTitle>
            <CardDescription className="text-xs">
              Verification codes and password-reset links go out on WhatsApp as well as email.
              Email remains the channel of record — a WhatsApp failure never blocks a sign-up or a reset.
            </CardDescription>
          </CardHeader>

          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <Switch
                checked={formData.enabled}
                onCheckedChange={(checked) => setFormData((prev) => ({ ...prev, enabled: checked }))}
              />
              <Label className="cursor-pointer">Send platform messages over WhatsApp</Label>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Evolution API URL *</Label>
              <Input
                placeholder="http://127.0.0.1:8080"
                value={formData.apiUrl}
                onChange={(e) => setFormData((prev) => ({ ...prev, apiUrl: e.target.value }))}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              {/* A stored-but-undecryptable key is worse than no key: the form
                  says "leave blank to keep it" while the picker behaves as if
                  none were there. When that is the reason, ask for it again. */}
              <Label>Evolution API Key {keyIsUsable ? '' : '*'}</Label>
              <PasswordInput
                // Keep the browser out: this is the engine's bearer credential,
                // not the admin's password, and an autofilled one gets encrypted
                // and stored exactly as if it had been typed.
                autoComplete="new-password"
                placeholder={keyIsUsable ? 'Stored — leave blank to keep it' : 'Paste the engine API key'}
                value={formData.apiKey}
                onChange={(e) => setFormData((prev) => ({ ...prev, apiKey: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Encrypted at rest and never sent back to this page. Leave blank unless you are replacing it.
              </p>
              {keyFingerprint && (
                // A shape, not a secret. It is here so "the engine rejected the
                // key" stops being unfalsifiable from the browser: a length that
                // does not match the engine's own key says the value was
                // truncated or overwritten on the way in, rather than simply
                // being the wrong key.
                <p className="text-xs text-muted-foreground font-mono">
                  Stored: {keyFingerprint.length} chars · fp {keyFingerprint.sha256}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              {/* No asterisk while nothing is saved: there is nothing to pick
                  yet, and a field marked required that cannot be filled reads as
                  a blocked save. It is not — the PUT accepts a null instance,
                  which is exactly what the first of the two saves sends. */}
              <Label>Sending Instance {connectionSaved ? '*' : ''}</Label>
              <div className="flex items-center gap-2">
                <Select
                  value={formData.instance || undefined}
                  onValueChange={(value) => setFormData((prev) => ({ ...prev, instance: value }))}
                  disabled={awaitingFirstSave}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder={instancePlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((inst) => (
                      <SelectItem key={inst.name} value={inst.name}>
                        {inst.name}
                        {inst.number ? ` — ${inst.number}` : ''} ({inst.connectionStatus})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => loadInstances()}
                  disabled={refreshing || awaitingFirstSave}
                  title={awaitingFirstSave ? 'Save the URL and key before listing instances' : 'Refresh the instance list'}
                  className="h-10 px-3 shrink-0"
                >
                  {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                </Button>
              </div>
              {listing && listing.reason !== 'ok' && (
                awaitingFirstSave ? (
                  // Not a fault, so not destructive — but not a 10px grey line
                  // either. This is the step the admin is actually on, and the
                  // button that advances it is directly below.
                  <Alert>
                    <AlertCircle size={18} />
                    <AlertDescription className="text-xs">
                      <strong>Step 1 of 2</strong> — save the URL and key first. The instance list is read
                      from the saved connection, not from the boxes above.
                    </AlertDescription>
                  </Alert>
                ) : mutedReasons.includes(listing.reason) ? (
                  <p className="text-xs text-muted-foreground">{listing.message}</p>
                ) : (
                  <Alert variant="destructive">
                    <AlertCircle size={18} />
                    <AlertDescription className="text-xs">
                      {listing.message}
                      {/* The comparison belongs next to the complaint. A rejected
                          key and a mangled one are the same message from the
                          engine, and the length is what tells them apart. */}
                      {listing.reason === 'unauthorized' && keyFingerprint && (
                        <>
                          {' '}Stored here: <span className="font-mono">{keyFingerprint.length} chars ·
                          fp {keyFingerprint.sha256}</span>. Compare that with the engine&apos;s own key — a
                          different length means the value was truncated or overwritten before it was saved,
                          not that the key itself is wrong.
                        </>
                      )}
                    </AlertDescription>
                  </Alert>
                )
              )}
            </div>

            {selected && selected.connectionStatus !== 'open' && (
              <Alert variant="destructive">
                <AlertCircle size={18} />
                <AlertDescription className="text-xs">
                  Instance <strong>{selected.name}</strong> is <strong>{selected.connectionStatus}</strong>, not
                  connected. Messages sent through it will be accepted and then silently dropped — reconnect it in
                  the Evolution dashboard.
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
                  <span>Saving Gateway...</span>
                </>
              ) : (
                <>
                  <Save size={14} />
                  <span>{awaitingFirstSave ? 'Save & List Instances' : 'Save WhatsApp Configuration'}</span>
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
            Proves the selected instance can actually deliver. Uses the saved configuration, so save first.
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
