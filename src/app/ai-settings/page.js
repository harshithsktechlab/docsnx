'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Key,
  Plus,
  Trash2,
  Edit2,
  CheckCircle,
  XCircle,
  AlertCircle,
  Loader2,
  Eye,
  EyeOff,
  Zap,
  Brain,
  ToggleLeft,
  ToggleRight,
  Activity,
  Clock,
  Server,
  RefreshCw,
  Save,
  X,
  Shield,
  Receipt,
  Settings,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { AI_MODEL_OPTIONS, defaultModelFor, DEFAULT_GEMINI_MODEL } from '@/lib/aiModels';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';


// Model ids live in src/lib/aiModels.ts, which also holds the published price
// per id used to bill tenant_ai_usages. This list used to be a local literal
// that still offered gemini-2.0-flash and gemini-1.5-flash long after Google
// shut them down — picking one wrote a dead id into api_keys.model and broke
// every AI call made with that key.
const GEMINI_MODELS = AI_MODEL_OPTIONS.gemini;
const OPENAI_MODELS = AI_MODEL_OPTIONS.openai;

const PROVIDER_COLORS = {
  gemini: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-500', label: 'Gemini' },
  openai: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-500', label: 'OpenAI' },
};

function UsageBar({ used, limit }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  let colorClass = 'bg-emerald-500';
  if (pct >= 90) colorClass = 'bg-red-500';
  else if (pct >= 70) colorClass = 'bg-amber-500';
  
  return (
    <div className="flex items-center gap-3 w-full">
      <div className="flex-1">
        <Progress value={pct} className={`h-1.5 [&>div]:${colorClass}`} />
      </div>
      <span className="text-xs text-muted-foreground whitespace-nowrap min-w-[60px] text-right">
        {used} / {limit}
      </span>
    </div>
  );
}

function StatusBadge({ isActive, errorCount }) {
  if (!isActive) {
    return (
      <Badge variant="outline" className="flex items-center gap-1 bg-muted/40 text-muted-foreground border-border/40">
        <XCircle size={11} /> Inactive
      </Badge>
    );
  }
  if (errorCount > 3) {
    return (
      <Badge variant="destructive" className="flex items-center gap-1">
        <AlertCircle size={11} /> Errors ({errorCount})
      </Badge>
    );
  }
  return (
    <Badge variant="success" className="flex items-center gap-1">
      <CheckCircle size={11} /> Active
    </Badge>
  );
}

export default function AISettingsPage() {
  const router = useRouter();
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // Add/Edit modal state
  const [showAddForm, setShowAddForm] = useState(false);
  const [editKey, setEditKey] = useState(null);
  
  // Form values
  const [formData, setFormData] = useState({
    label: '',
    provider: 'gemini',
    apiKey: '',
    model: DEFAULT_GEMINI_MODEL,
    dailyLimit: 1500,
    priority: 0,
  });

  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [showKeyValue, setShowKeyValue] = useState(false);
  const [billingProfile, setBillingProfile] = useState({ platformName: '', platformGstin: '', platformAddress: '' });
  const [billingSaving, setBillingSaving] = useState(false);
  const [aiCosts, setAiCosts] = useState({
    aiCostRecordAnalysis: 1,
    aiCostCategoryAnalysis: 2,
    aiCostPortfolioAnalysis: 5,
    aiCostBulkScan: 10
  });
  const [aiCostsSaving, setAiCostsSaving] = useState(false);

  useEffect(() => {
    fetchKeys();
    fetchBillingProfile();
  }, []);

  const fetchBillingProfile = async () => {
    try {
      const { json: data } = await apiCall('/api/admin/settings');
      if (!data.error && data.config) {
        setBillingProfile(data.config);
        setAiCosts({
          aiCostRecordAnalysis: parseFloat(data.config.aiCostRecordAnalysis) || 1.00,
          aiCostCategoryAnalysis: parseFloat(data.config.aiCostCategoryAnalysis) || 2.00,
          aiCostPortfolioAnalysis: parseFloat(data.config.aiCostPortfolioAnalysis) || 5.00,
          aiCostBulkScan: parseFloat(data.config.aiCostBulkScan) || 10.00
        });
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchKeys = async () => {
    try {
      const { json: data } = await apiCall('/api/admin/ai-keys');
      if (data.success) {
        setKeys(data.keys || []);
      } else {
        setError(data.error || 'Failed to load API keys.');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[ai-settings] handler threw', err);
      setError('Something went wrong loading API keys. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const openAddForm = () => {
    setFormData({
      label: '',
      provider: 'gemini',
      apiKey: '',
      model: DEFAULT_GEMINI_MODEL,
      dailyLimit: 1500,
      priority: 0,
    });
    setEditKey(null);
    setShowKeyValue(false);
    setShowAddForm(true);
  };

  const openEditForm = (k) => {
    setFormData({
      label: k.label,
      provider: k.provider,
      apiKey: '', // don't pre-populate API key value for security
      model: k.model,
      dailyLimit: k.dailyLimit,
      priority: k.priority,
    });
    setEditKey(k);
    setShowKeyValue(false);
    setShowAddForm(true);
  };

  const handleProviderChange = (prov) => {
    const defaultModel = defaultModelFor(prov);
    const defaultLimit = prov === 'gemini' ? 1500 : 5000;
    setFormData(prev => ({
      ...prev,
      provider: prov,
      model: defaultModel,
      dailyLimit: defaultLimit,
    }));
  };

  const handleSaveBilling = async (e) => {
    e.preventDefault();
    setBillingSaving(true);
    try {
      const { res, json } = await apiCall('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(billingProfile)
      }, { subject: 'billing profile', action: 'updating the billing profile' });
      // The body was never read, so "Failed to update billing profile" was the
      // answer to a validation refusal, an expired session and a 500 alike.
      if (res.ok) toast.success('Billing profile updated');
      else toast.error(json.error || 'Failed to update billing profile');
    } catch (e) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[ai-settings] handler threw', e);
      toast.error('Something went wrong. Please try again.');
    } finally {
      setBillingSaving(false);
    }
  };

  const handleSaveAiCosts = async (e) => {
    e.preventDefault();
    setAiCostsSaving(true);
    try {
      const { res, json } = await apiCall('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...billingProfile, ...aiCosts })
      }, { subject: 'AI costs', action: 'updating the AI action costs' });
      if (res.ok) toast.success('AI action base costs updated');
      else toast.error(json.error || 'Failed to update AI action costs');
    } catch (e) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[ai-settings] handler threw', e);
      toast.error('Something went wrong. Please try again.');
    } finally {
      setAiCostsSaving(false);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!formData.label.trim()) {
      toast.info('Label is required.');
      return;
    }
    if (!editKey && !formData.apiKey.trim()) {
      toast.info('API Key is required.');
      return;
    }

    setSaving(true);
    setError('');
    setSuccess('');

    try {
      if (editKey) {
        const { json: data } = await apiCall(`/api/admin/ai-keys/${editKey.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
          label: formData.label,
          provider: formData.provider,
          apiKey: formData.apiKey.trim() || undefined,
          model: formData.model,
          dailyLimit: formData.dailyLimit,
          priority: formData.priority,
          }),
        });
        if (data.success) {
          setSuccess('Key updated successfully.');
          await fetchKeys();
          setShowAddForm(false);
        } else {
          toast.error(data.error || 'Failed to update key.');
        }
      } else {
        const { json: data } = await apiCall('/api/admin/ai-keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
          label: formData.label,
          provider: formData.provider,
          apiKey: formData.apiKey.trim(),
          model: formData.model,
          dailyLimit: formData.dailyLimit,
          priority: formData.priority,
          }),
        });
        if (data.success) {
          setSuccess('API key added successfully.');
          await fetchKeys();
          setShowAddForm(false);
        } else {
          toast.error(data.error || 'Failed to add key.');
        }
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[ai-settings] handler threw', err);
      toast.error('Something went wrong saving key. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (key) => {
    if (!confirm(`Delete key "${key.label}"?`)) return;
    setError('');
    setSuccess('');
    try {
      const { json: data } = await apiCall(`/api/admin/ai-keys/${key.id}`, { method: 'DELETE' });
      if (data.success) {
        setSuccess('Key deleted successfully.');
        setKeys(prev => prev.filter(k => k.id !== key.id));
      } else {
        toast.error(data.error || 'Failed to delete key.');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[ai-settings] handler threw', err);
      toast.error('Something went wrong deleting key. Please try again.');
    }
  };

  const handleToggleActive = async (key) => {
    setError('');
    setSuccess('');
    try {
      const { json: data } = await apiCall(`/api/admin/ai-keys/${key.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !key.isActive }),
      });
      if (data.success) {
        setSuccess(`Key ${key.isActive ? 'deactivated' : 'activated'}.`);
        await fetchKeys();
      } else {
        toast.error(data.error || 'Failed to update status.');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[ai-settings] handler threw', err);
      toast.error('Something went wrong updating status. Please try again.');
    }
  };

  const handleTestKey = async (key) => {
    setTestingId(key.id);
    // clear old test result
    setTestResults(prev => ({ ...prev, [key.id]: null }));
    try {
      // POST with the id in the BODY. The route exports only POST and reads
      // `id` off `req.json()`, so the GET-with-?id= this used to send was
      // answered with a bare 405 — a red "Test Connection Failed" banner for a
      // key that was never tested, and no `lastError` row to say otherwise.
      const { json: data } = await apiCall('/api/admin/ai-keys/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: key.id }),
        timeoutMs: 120_000,
      });
      setTestResults(prev => ({ ...prev, [key.id]: data }));
    } catch (err) {
      console.error('[ai-settings] key test threw', err);
      setTestResults(prev => ({
        ...prev,
        [key.id]: { success: false, errorMessage: 'The test could not be run. Please try again.' }
      }));
    } finally {
      setTestingId(null);
    }
  };

  const modelOptions = formData.provider === 'gemini' ? GEMINI_MODELS : OPENAI_MODELS;

  return (
    <PageContainer width="narrow">
      
      {/* Header Row */}
      <div className="flex items-center justify-between gap-4 animate-fade-in">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">AI Configuration</h1>
          <p className="text-muted-foreground text-sm">Manage LLM endpoint credentials for OCR and document understanding</p>
        </div>
        <Button 
          onClick={openAddForm} 
          className="flex items-center gap-2 h-10 px-4"
        >
          <Plus size={16} />
          <span>Add Key</span>
        </Button>
      </div>

      {success && (
        <Alert variant="success" className="animate-scale-in">
          <CheckCircle size={18} />
          <AlertDescription>{success}</AlertDescription>
        </Alert>
      )}

      {/* Add/Edit Key Modal */}
      <Dialog open={showAddForm} onOpenChange={(open) => { if (!open) setShowAddForm(false); }}>
        <DialogContent aria-describedby={undefined} className="max-w-[500px] border-border/50 bg-popover/95 backdrop-blur shadow-glass">
          <DialogHeader>
            <DialogTitle className="text-lg font-bold flex items-center gap-2 text-foreground">
              <Key className="text-primary" size={20} />
              <span>{editKey ? 'Edit API Key Configuration' : 'Add New API Endpoint Key'}</span>
            </DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSave} className="flex flex-col gap-5 py-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="keyLabel">Friendly Label *</Label>
              <Input
                id="keyLabel"
                placeholder="e.g. My Personal Gemini Flash Key"
                value={formData.label}
                onChange={e => setFormData(prev => ({ ...prev, label: e.target.value }))}
                disabled={saving}
                className="h-11 rounded-xl"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div className="flex flex-col gap-2">
                <Label htmlFor="provider">AI Provider</Label>
                <Select value={formData.provider} onValueChange={handleProviderChange} disabled={saving}>
                  <SelectTrigger id="provider" className="h-11 rounded-xl">
                    <SelectValue placeholder="Select Provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gemini">Google Gemini AI</SelectItem>
                    <SelectItem value="openai">OpenAI (ChatGPT)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="model">Model</Label>
                <Select value={formData.model} onValueChange={(val) => setFormData(prev => ({ ...prev, model: val }))} disabled={saving}>
                  <SelectTrigger id="model" className="h-11 rounded-xl">
                    <SelectValue placeholder="Select Model" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.map(m => (
                      <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="apiKey">API Key {!editKey && '*'}</Label>
              <div className="relative">
                <Input
                  id="apiKey"
                  type={showKeyValue ? 'text' : 'password'}
                  placeholder={editKey ? 'Enter new key to replace, or leave blank' : (formData.provider === 'openai' ? 'sk-...' : 'AIza...')}
                  value={formData.apiKey}
                  onChange={e => setFormData(prev => ({ ...prev, apiKey: e.target.value }))}
                  disabled={saving}
                  className="pr-10 h-11 rounded-xl"
                />
                <button
                  type="button"
                  onClick={() => setShowKeyValue(!showKeyValue)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showKeyValue ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div className="flex flex-col gap-2">
                <Label htmlFor="dailyLimit">Daily Request Limit</Label>
                <Input
                  id="dailyLimit"
                  type="number"
                  min={1}
                  value={formData.dailyLimit}
                  onChange={e => setFormData(prev => ({ ...prev, dailyLimit: parseInt(e.target.value) || 1500 }))}
                  disabled={saving}
                  className="h-11 rounded-xl"
                />
                <p className="text-xs text-muted-foreground mt-0.5 leading-tight">
                  {formData.provider === 'openai' ? 'OpenAI: check plan limit' : 'Gemini free tier: ~1500/day'}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="priority">Priority (0 = highest)</Label>
                <Input
                  id="priority"
                  type="number"
                  min={0}
                  value={formData.priority}
                  onChange={e => setFormData(prev => ({ ...prev, priority: parseInt(e.target.value) || 0 }))}
                  disabled={saving}
                  className="h-11 rounded-xl"
                />
                <p className="text-xs text-muted-foreground mt-0.5 leading-tight">
                  Lower priority values are rotated and used first
                </p>
              </div>
            </div>

            <DialogFooter className="mt-4 gap-2">
              <Button 
                type="button" 
                variant="outline" 
                onClick={() => setShowAddForm(false)}
                disabled={saving}
                className="rounded-xl font-bold"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving} className="gap-1.5 rounded-xl font-bold px-6 shadow-md">
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                <span>{editKey ? 'Save Changes' : 'Add Key'}</span>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Keys List */}
      {loading ? (
        <div className="flex flex-col gap-4">
          {[...Array(2)].map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-xl" />
          ))}
        </div>
      ) : keys.length === 0 ? (
        <Card className="border-dashed border-border p-12 text-center animate-fade-in">
          <CardContent className="flex flex-col items-center justify-center gap-4 p-0 text-muted-foreground">
            <Key size={40} className="text-faint" />
            <p className="text-lg font-bold text-foreground">No API Keys Configured</p>
            <p className="text-sm max-w-md">
              Add Gemini or OpenAI API keys to enable AI scanning and parsing. The system will rotate active keys automatically.
            </p>
            <Button onClick={openAddForm} className="gap-1.5">
              <Plus size={16} /> Add Your First API Key
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {keys.map((key, index) => {
            const pStyle = PROVIDER_COLORS[key.provider] || PROVIDER_COLORS.gemini;
            const testResult = testResults[key.id];
            return (
              <Card
                key={key.id}
                className={`border-border/50 bg-card backdrop-blur shadow-glass border-l-4 border-l-${key.provider === 'openai' ? 'emerald-500' : 'blue-500'} ${key.isActive ? '' : 'opacity-60'} transition-opacity duration-250 animate-fade-in`}
              >
                <CardContent className="p-6 flex flex-col gap-4">
                  {/* Header Row */}
                  <div className="flex flex-col md:flex-row justify-between items-start gap-4">
                    <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-extrabold text-foreground text-base truncate">
                          {key.label}
                        </span>
                        <Badge variant="outline" className={`${pStyle.bg} ${pStyle.border} ${pStyle.text} font-bold text-xs`}>
                          {pStyle.label}
                        </Badge>
                        <StatusBadge isActive={key.isActive} errorCount={key.errorCount} />
                        {index === 0 && key.isActive && (
                          <Badge variant="secondary" className="bg-primary/10 text-primary hover:bg-primary/15 border-transparent text-xs font-bold">
                            ⚡ Primary
                          </Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Brain size={12} /> {key.model}
                        </span>
                        <span className="flex items-center gap-1 font-mono">
                          <Shield size={12} /> {key.apiKey}
                        </span>
                        <span className="flex items-center gap-1">
                          <Activity size={12} /> Priority: {key.priority}
                        </span>
                        {key.lastUsedAt && (
                          <span className="flex items-center gap-1">
                            <Clock size={12} /> Last used: {new Date(key.lastUsedAt).toLocaleString()}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center gap-1.5 w-full md:w-auto flex-shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleTestKey(key)}
                        disabled={testingId === key.id}
                        className="h-8 text-xs gap-1 font-bold"
                      >
                        {testingId === key.id ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
                        <span>Test</span>
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => openEditForm(key)}
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      >
                        <Edit2 size={13} />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => handleToggleActive(key)}
                        className={`h-8 w-8 ${key.isActive ? 'text-emerald-500 hover:text-emerald-600' : 'text-muted-foreground hover:text-foreground'}`}
                      >
                        {key.isActive ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => handleDelete(key)}
                        className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-500/10 border-red-500/20"
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </div>

                  {/* Usage Bar */}
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground uppercase font-bold tracking-wider">
                      Daily Usage Limit
                    </span>
                    <UsageBar used={key.dailyUsage} limit={key.dailyLimit} />
                  </div>

                  {/* Test Result */}
                  {testResult && (
                    <div className={`p-4 rounded-xl border flex flex-col gap-1.5 ${
                      testResult.success 
                        ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-600 dark:text-emerald-400' 
                        : 'bg-red-500/5 border-red-500/20 text-red-600 dark:text-red-400'
                    }`}>
                      <div className="flex items-center gap-2">
                        {testResult.success
                          ? <CheckCircle size={14} className="text-emerald-500" />
                          : <XCircle size={14} className="text-red-500" />
                        }
                        <span className="text-xs font-bold">
                          {testResult.success ? `✓ Key Connection Success — ${testResult.latencyMs}ms` : 'Test Connection Failed'}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground pl-5 leading-relaxed">
                        {/* `errorMessage` is the route's own classified sentence;
                            `error` is what apiCall synthesises when the route never
                            answered. Without the fallback a non-200 renders an empty
                            line under "Test Connection Failed", which is exactly what
                            hid the 405 this button used to provoke. */}
                        {testResult.success ? testResult.testResult : (testResult.errorMessage || testResult.error)}
                      </p>
                    </div>
                  )}

                  {/* Last Error */}
                  {key.lastError && key.errorCount > 0 && (
                    <div className="p-3 rounded-lg bg-red-500/5 border border-red-500/15 text-xs text-muted-foreground">
                      <span className="text-red-500 font-bold mr-1">Last connection error:</span> {key.lastError}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Summary Stats */}
      {keys.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4 animate-fade-in stagger-2">
          {[
            { label: 'Total Keys', value: keys.length, icon: Key, color: 'text-indigo-400 bg-indigo-500/10' },
            { label: 'Active Keys', value: keys.filter(k => k.isActive).length, icon: CheckCircle, color: 'text-emerald-500 bg-emerald-500/10' },
            { label: 'Total Capacity', value: keys.filter(k => k.isActive).reduce((a, k) => a + k.dailyLimit, 0).toLocaleString(), icon: Server, color: 'text-amber-500 bg-amber-500/10' },
            { label: 'Used Today', value: keys.reduce((a, k) => a + k.dailyUsage, 0).toLocaleString(), icon: Activity, color: 'text-primary bg-primary/10' },
          ].map(stat => (
            <Card key={stat.label} className="border-border/50 bg-card backdrop-blur shadow-glass p-4 flex items-center gap-3.5">
              <span className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${stat.color}`}>
                <stat.icon size={18} />
              </span>
              <div className="min-w-0">
                <p className="text-xl font-black text-foreground leading-none">{stat.value}</p>
                <p className="text-xs text-muted-foreground font-semibold mt-1 truncate">{stat.label}</p>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* AI Action Base Costs Form */}
      <Card className="border-border/50 bg-card backdrop-blur shadow-glass mt-4 animate-fade-in stagger-3">
        <CardHeader>
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <Settings size={20} className="text-primary" />
            AI Action Base Costs
          </CardTitle>
          <CardDescription>
            Configure the base credit cost for each AI action. The final cost deducted from a tenant&apos;s balance will be (Base Cost × Allowed Members).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveAiCosts} className="flex flex-col gap-5">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="aiCostRecordAnalysis">Record Analysis Base Cost</Label>
                <Input
                  id="aiCostRecordAnalysis"
                  type="number"
                  min="0"
                  step="0.01"
                  value={aiCosts.aiCostRecordAnalysis}
                  onChange={(e) => setAiCosts(prev => ({ ...prev, aiCostRecordAnalysis: parseFloat(e.target.value) || 0 }))}
                  disabled={aiCostsSaving}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="aiCostCategoryAnalysis">Category Analysis Base Cost</Label>
                <Input
                  id="aiCostCategoryAnalysis"
                  type="number"
                  min="0"
                  step="0.01"
                  value={aiCosts.aiCostCategoryAnalysis}
                  onChange={(e) => setAiCosts(prev => ({ ...prev, aiCostCategoryAnalysis: parseFloat(e.target.value) || 0 }))}
                  disabled={aiCostsSaving}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="aiCostPortfolioAnalysis">Portfolio Analysis Base Cost</Label>
                <Input
                  id="aiCostPortfolioAnalysis"
                  type="number"
                  min="0"
                  step="0.01"
                  value={aiCosts.aiCostPortfolioAnalysis}
                  onChange={(e) => setAiCosts(prev => ({ ...prev, aiCostPortfolioAnalysis: parseFloat(e.target.value) || 0 }))}
                  disabled={aiCostsSaving}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="aiCostBulkScan">Power Scan Base Cost</Label>
                <Input
                  id="aiCostBulkScan"
                  type="number"
                  min="0"
                  step="0.01"
                  value={aiCosts.aiCostBulkScan}
                  onChange={(e) => setAiCosts(prev => ({ ...prev, aiCostBulkScan: parseFloat(e.target.value) || 0 }))}
                  disabled={aiCostsSaving}
                />
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <Button type="submit" disabled={aiCostsSaving}>
                {aiCostsSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Settings className="w-4 h-4 mr-2" />}
                Save AI Costs
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
