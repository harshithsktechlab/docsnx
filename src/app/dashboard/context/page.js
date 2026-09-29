'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Bot, 
  Sparkles, 
  RefreshCw, 
  FileCode2, 
  Terminal, 
  Copy, 
  Check, 
  Loader2,
  Database,
  GitBranch
} from 'lucide-react';
import { clientGetMe } from '@/lib/clientAuth';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';


export default function ContextDashboard() {
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null); // 'refresh' | 'optimize' | null
  const [contextData, setContextData] = useState(null);
  const [logs, setLogs] = useState([]);
  const [copied, setCopied] = useState(false);
  const [metrics, setMetrics] = useState({
    size: 0,
    tokens: 0,
    updatedAt: '',
    hasGeminiKey: false
  });

  const addLog = (text, type = 'info') => {
    setLogs(prev => [...prev, { text, time: new Date().toLocaleTimeString(), type }]);
  };

  useEffect(() => {
    async function checkAuthAndLoad() {
      const auth = await clientGetMe();
      if (!auth.success || auth.user.role !== 'SUPER_ADMIN') {
        addLog('Access Denied: Super Admin role required.', 'error');
        setIsAdmin(false);
        router.push('/dashboard');
        return;
      }
      setIsAdmin(true);
      addLog('Authentication verified. Welcome to Context Manager.', 'success');
      await fetchContextData();
      setLoading(false);
    }

    checkAuthAndLoad();
  }, [router]);

  async function fetchContextData() {
    try {
      addLog('Loading current context file status...', 'info');
      const { json: data } = await apiCall('/api/context');
      
      if (data.success) {
        setContextData(data.context.content);
        setMetrics({
          size: data.context.size,
          tokens: data.estTokens,
          updatedAt: new Date(data.context.updatedAt).toLocaleString(),
          hasGeminiKey: data.hasGeminiKey
        });
        addLog(`Context successfully loaded. Size: ${data.context.size} bytes (${data.estTokens} tokens).`, 'success');
      } else {
        addLog(`Failed to fetch context: ${data.error}`, 'error');
      }
    } catch (err) {
      // This screen IS the log, so the raw message is the right level of
      // detail here — but it is a thrown bug now, not a transport failure,
      // and labelling it as one sent an operator to check the network.
      console.error('[dashboard/context] load threw', err);
      addLog(`Loading the context threw an unexpected error: ${err.message}`, 'error');
    }
  }

  const handleRefresh = async () => {
    if (actionLoading) return;
    setActionLoading('refresh');
    setLogs([]);
    addLog('Initiating full project directory structure scan...', 'info');
    addLog('Extracting database models from Prisma schema...', 'info');
    addLog('Reading package.json dependencies and scripts...', 'info');
    addLog('Querying git repository status and commits...', 'info');

    try {
      const { json: data } = await apiCall('/api/context', { method: 'POST', timeoutMs: 180_000 });
      
      if (data.success) {
        setContextData(data.context.content);
        setMetrics({
          size: data.context.size,
          tokens: data.estTokens,
          updatedAt: new Date(data.context.updatedAt).toLocaleString(),
          hasGeminiKey: data.hasGeminiKey
        });
        addLog('Context generated and written to AI_CONTEXT.md in project root.', 'success');
        addLog(`Scan completed. New size: ${data.context.size} bytes.`, 'success');
      } else {
        addLog(`Error during scan: ${data.error}`, 'error');
      }
    } catch (err) {
      addLog(`Scan failed: ${err.message}`, 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleOptimize = async () => {
    if (actionLoading) return;
    setActionLoading('optimize');
    addLog('Requesting Gemini AI optimizer to compress context...', 'info');
    addLog('Processing semantic layers, compressing descriptions...', 'info');

    try {
      const { json: data } = await apiCall('/api/context', { method: 'PUT', timeoutMs: 180_000 });
      
      if (data.success) {
        setContextData(data.context.content);
        setMetrics({
          size: data.context.size,
          tokens: data.estTokens,
          updatedAt: new Date(data.context.updatedAt).toLocaleString(),
          hasGeminiKey: data.hasGeminiKey
        });
        addLog(`AI Optimization success! Saved approximately ${data.savings || 0}% in tokens!`, 'success');
        addLog(`New size: ${data.context.size} bytes (${data.estTokens} tokens).`, 'success');
      } else {
        addLog(`Optimization error: ${data.error}`, 'error');
      }
    } catch (err) {
      addLog(`Optimization failed: ${err.message}`, 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const copyToClipboard = () => {
    if (!contextData) return;
    navigator.clipboard.writeText(contextData);
    setCopied(true);
    addLog('Context copied to clipboard.', 'success');
    setTimeout(() => setCopied(false), 2000);
  };

  const formatSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = 2;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  };

  if (loading || !isAdmin) {
    return (
      <PageContainer width="narrow">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-60 w-full rounded-xl" />
      </PageContainer>
    );
  }

  return (
    <PageContainer width="narrow">
      
      {/* Header */}
      <div className="flex flex-col gap-1 mb-2 animate-fade-in">
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground flex items-center gap-2.5">
          <Bot size={28} className="text-primary" />
          <span>AI Context Manager</span>
        </h1>
        <p className="text-muted-foreground text-sm">
          Auto-generate and AI-optimize context summaries to save token consumption.
        </p>
      </div>

      {/* Metrics Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-fade-in stagger-1">
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-4 flex flex-col justify-between min-h-[96px]">
          <span className="text-xs text-muted-foreground font-bold uppercase tracking-wider">
            Estimated Tokens
          </span>
          <span className="text-2xl font-black text-primary leading-none my-1">
            {metrics.tokens.toLocaleString()}
          </span>
          <span className="text-xs text-faint leading-none">
            Based on ~4 chars/token
          </span>
        </Card>

        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-4 flex flex-col justify-between min-h-[96px]">
          <span className="text-xs text-muted-foreground font-bold uppercase tracking-wider">
            Context File Size
          </span>
          <span className="text-2xl font-black text-secondary leading-none my-1">
            {formatSize(metrics.size)}
          </span>
          <span className="text-xs text-faint leading-none">
            Saved in AI_CONTEXT.md
          </span>
        </Card>

        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-4 flex flex-col justify-between min-h-[96px]">
          <span className="text-xs text-muted-foreground font-bold uppercase tracking-wider">
            Last Compiled
          </span>
          <span className="text-sm font-bold text-foreground leading-snug my-auto">
            {metrics.updatedAt || 'Never'}
          </span>
          <span className="text-xs text-faint leading-none">
            Timestamp
          </span>
        </Card>

        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-4 flex flex-col justify-between min-h-[96px]">
          <span className="text-xs text-muted-foreground font-bold uppercase tracking-wider">
            Gemini Optimizer
          </span>
          <div className="my-auto">
            {metrics.hasGeminiKey ? (
              <Badge variant="success" className="text-xs px-2 py-0.5 font-bold uppercase tracking-wider">
                Active (Gemini 2.5)
              </Badge>
            ) : (
              <Badge variant="warning" className="text-xs px-2 py-0.5 font-bold uppercase tracking-wider">
                Mock Fallback
              </Badge>
            )}
          </div>
          <span className="text-xs text-faint leading-none">
            Rotation status
          </span>
        </Card>
      </div>

      {/* Control Actions */}
      <Card className="border-border/50 bg-card backdrop-blur shadow-glass animate-fade-in stagger-2">
        <CardHeader className="pb-3">
          <h3 className="text-xs text-primary uppercase font-bold tracking-wider">Control Panel</h3>
        </CardHeader>
        <CardContent className="flex flex-col sm:flex-row gap-3">
          <Button 
            onClick={handleRefresh} 
            disabled={actionLoading !== null}
            className="flex-1 h-12 gap-2 text-sm font-semibold"
          >
            {actionLoading === 'refresh' ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <RefreshCw size={16} />
            )}
            <span>{actionLoading === 'refresh' ? 'Scanning...' : 'Refresh Scan'}</span>
          </Button>
          
          <Button 
            onClick={handleOptimize} 
            disabled={actionLoading !== null}
            variant="secondary"
            className="flex-1 h-12 gap-2 text-sm font-semibold border border-secondary text-foreground bg-pink-500/5 hover:bg-pink-500/10"
          >
            <Sparkles size={16} className={`text-secondary ${actionLoading === 'optimize' ? 'animate-pulse' : ''}`} />
            <span>{actionLoading === 'optimize' ? 'Improving...' : 'AI Auto-Improve'}</span>
          </Button>
        </CardContent>
      </Card>

      {/* Console Logs */}
      <Card className="border-border/50 bg-[#070a13] shadow-glass p-5 rounded-2xl animate-fade-in stagger-3">
        <div className="flex items-center gap-2 mb-3 text-muted-foreground">
          <Terminal size={15} />
          <span className="text-xs font-mono font-bold uppercase tracking-wider">Scanner Output Log</span>
        </div>
        <div className="max-h-[140px] overflow-y-auto flex flex-col gap-1 font-mono text-xs p-3 bg-black/45 rounded-lg border border-border/40">
          {logs.length === 0 ? (
            <span className="text-faint">Console ready. Run actions to stream details...</span>
          ) : (
            logs.map((log, index) => {
              let colorClass = 'text-muted-foreground';
              if (log.type === 'success') colorClass = 'text-emerald-500';
              if (log.type === 'error') colorClass = 'text-red-500';
              return (
                <div key={index} className="flex gap-2.5 items-start">
                  <span className="text-faint flex-shrink-0">[{log.time}]</span>
                  <span className={colorClass}>{log.text}</span>
                </div>
              );
            })
          )}
        </div>
      </Card>

      {/* Context File Preview */}
      <Card className="border-border/50 bg-card backdrop-blur shadow-glass animate-fade-in stagger-4">
        <CardHeader className="pb-3 flex flex-row items-center justify-between gap-4">
          <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
            <FileCode2 size={16} className="text-accent" />
            <span>Context Preview (AI_CONTEXT.md)</span>
          </h3>
          <button 
            onClick={copyToClipboard}
            disabled={!contextData}
            className={`flex items-center gap-1 text-xs font-semibold bg-transparent border-none cursor-pointer transition-colors ${
              copied ? 'text-emerald-500' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            <span>{copied ? 'Copied' : 'Copy Content'}</span>
          </button>
        </CardHeader>
        <CardContent>
          <pre className="w-full h-[260px] bg-background/35 border border-border/40 rounded-xl p-4 font-mono text-xs overflow-auto text-foreground white-space-pre-wrap word-break-break-all">
            {contextData || 'No context compiled. Click "Refresh Scan" above to compile project context details.'}
          </pre>
        </CardContent>
      </Card>

    </PageContainer>
  );
}
