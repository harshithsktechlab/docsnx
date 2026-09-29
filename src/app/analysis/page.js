'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { 
  Sparkles, 
  Lightbulb, 
  RefreshCw, 
  CheckCircle2, 
  ShieldCheck,
  FileText,
  Activity,
  Car,
  Briefcase,
  Shield
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import PageContainer from '@/app/components/PageContainer';
import { cn } from '@/lib/utils';
import { useWorkspaceApi } from '@/lib/net/useWorkspaceApi';
import { usePermittedCategories, navModulesFrom } from '@/lib/usePermittedCategories';
import { BUSINESS_NAV_MODULES } from '@/lib/moduleRegistry';
import { moduleIcon } from '@/lib/moduleIcons';


/**
 * The household's five analysable areas.
 *
 * Hand-listed, and left that way: these are the personal scopes worth a
 * portfolio-level read, not simply every module that has an AI profile. A
 * company's list below IS derived, because its fourteen modules are all
 * company paperwork and the member's permissions are the only thing that
 * should narrow them.
 */
const PERSONAL_CATEGORIES = [
  { id: 'medical', label: 'Medical Records', icon: Activity },
  { id: 'lic_mediclaim', label: 'LIC & Mediclaim', icon: Shield },
  { id: 'investments', label: 'Investments', icon: Briefcase },
  { id: 'vehicles', label: 'Vehicles', icon: Car },
  { id: 'documents', label: 'Documents', icon: FileText }
];

export default function AnalysisPage() {
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  /**
   * ── ONE PAGE, TWO WORKSPACES ──────────────────────────────────────────────
   *
   * `/analysis` reads the household's records; `/business/<id>/analysis` reads
   * one company's. The API has handled both since the business account shipped
   * — it refuses a `biz_*` module with no company and a personal one with a
   * company — so all this page has to do is offer the right modules and let
   * `useWorkspaceApi` put the company on the request.
   */
  const { api, companyId } = useWorkspaceApi();
  const { categories: permittedCategories } = usePermittedCategories();

  /**
   * A company's tabs are its permitted business modules, through the same
   * builder the sidebar and the company dashboard use — so the three cannot
   * offer different sets, and a member denied a module is not shown a tab that
   * 403s on arrival.
   */
  const categories = useMemo(() => {
    if (!companyId) return PERSONAL_CATEGORIES;
    return navModulesFrom(
      permittedCategories, BUSINESS_NAV_MODULES, 'business', `/business/${companyId}`,
    ).map((m) => ({ id: m.key, label: m.name, icon: moduleIcon(m.key) }));
  }, [companyId, permittedCategories]);

  /**
   * `medical` is the household's first tab and is not a category a company has,
   * so the initial value is corrected once the workspace's list is known — see
   * the effect below. Starting from a fixed string rather than from
   * `categories[0]` keeps the first render identical to what it was, and the
   * permitted list is not loaded on that render anyway.
   */
  const [activeCategory, setActiveCategory] = useState('medical');

  const fetchAnalysis = async (category, isManual = false) => {
    setLoading(true);
    setError('');
    setAnalysis(null);

    try {
      const { json } = await api(`/api/analysis?category=${category}${isManual ? '&refresh=true' : ''}`,
        // A cold cache means several model calls; the 45s default would abandon
        // a request that was still working and report it as a timeout.
        { timeoutMs: 180_000 });
      
      if (json.success && json.analysis) {
        setAnalysis(json.analysis);
      } else {
        setError(json.error || 'Failed to generate category analysis.');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[analysis] handler threw', err);
      setError('Something went wrong running category analysis. Please try again.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Keep the selected tab inside the workspace's own list.
   *
   * Without this a company's page would open on `medical` and ask the API to
   * analyse a personal module with a company attached — which it correctly
   * refuses with "This module is personal and takes no company", so the page
   * would show an error where its first tab should be.
   */
  useEffect(() => {
    if (categories.length === 0) return;
    if (!categories.some((c) => c.id === activeCategory)) {
      setActiveCategory(categories[0].id);
    }
  }, [categories, activeCategory]);

  useEffect(() => {
    // Nothing to ask for until the tab is one this workspace actually has.
    if (!categories.some((c) => c.id === activeCategory)) return;
    fetchAnalysis(activeCategory);
  }, [activeCategory, categories]);

  const handleCategoryChange = (val) => {
    setActiveCategory(val);
  };

  return (
    <PageContainer className="gap-8 py-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-border pb-6">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-primary" />
            <h1 className="text-3xl font-extrabold tracking-tight text-foreground font-sans">AI Category Analysis</h1>
          </div>
          <p className="text-muted-foreground mt-1">
            Deep-dive AI analysis into specific areas of your portfolio to identify risks and actionable insights.
          </p>
        </div>
        <Button 
          onClick={() => fetchAnalysis(activeCategory, true)} 
          disabled={loading}
          className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold flex items-center gap-2 rounded-xl transition-all duration-300 shadow-md shadow-primary/10"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh Analysis
        </Button>
      </div>

      <Tabs defaultValue="medical" value={activeCategory} onValueChange={handleCategoryChange} className="w-full">
        {/* The household has five tabs and a company up to fourteen, so the
            fixed five-column grid becomes a scrolling row once there are more
            than a grid's worth. `overflow-x-auto` on the list rather than on the
            page: a horizontal scrollbar under the tabs is expected, one under
            the whole page is a layout bug. */}
        <TabsList className={cn(
          'w-full h-auto p-1 bg-muted/50 rounded-xl gap-1',
          categories.length > 5
            ? 'flex justify-start overflow-x-auto'
            : 'grid grid-cols-2 md:grid-cols-5',
        )}>
          {categories.map(cat => (
            <TabsTrigger 
              key={cat.id} 
              value={cat.id}
              className={cn(
                'flex items-center gap-2 py-3 rounded-lg data-[state=active]:bg-card data-[state=active]:shadow-sm transition-all',
                categories.length > 5 && 'shrink-0',
              )}
            >
              <cat.icon className="h-4 w-4" />
              <span className="hidden sm:inline">{cat.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="mt-8">
          {loading ? (
            <div className="flex flex-col gap-6 animate-pulse">
              <Skeleton className="h-32 w-full rounded-2xl" />
              <Skeleton className="h-64 w-full rounded-2xl" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center gap-4 py-20 bg-destructive/5 border border-destructive/20 rounded-2xl">
              <p className="text-danger-text font-medium">{error}</p>
              <Button onClick={() => fetchAnalysis(activeCategory, true)} variant="outline">
                <RefreshCw className="mr-2 h-4 w-4" /> Try Again
              </Button>
            </div>
          ) : analysis ? (
            <div className="grid grid-cols-1 gap-8">
              
              {/* Summary Card */}
              <Card className="glass-card overflow-hidden border-primary/20 bg-primary/5">
                <CardContent className="p-6 flex flex-col gap-3">
                  <div className="flex items-center gap-2 mb-2">
                    <ShieldCheck className="h-6 w-6 text-primary" />
                    <h2 className="text-xl font-bold text-foreground">Category Summary</h2>
                  </div>
                  <p className="text-foreground/90 leading-relaxed text-lg">
                    {analysis.summary}
                  </p>
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Item Analysis List */}
                <Card className="glass-card overflow-hidden lg:col-span-2">
                  <CardHeader className="border-b border-border/50 bg-muted/20 p-5">
                    <CardTitle className="text-lg font-bold text-foreground">Detailed Record Insights</CardTitle>
                    <CardDescription>Individual assessment of your {categories.find(c => c.id === activeCategory)?.label.toLowerCase()} records.</CardDescription>
                  </CardHeader>
                  <CardContent className="p-6">
                    {(!analysis.itemsAnalysis || analysis.itemsAnalysis.length === 0) ? (
                      <div className="flex items-center gap-3 p-4 bg-emerald-500/5 border border-emerald-500/10 rounded-xl text-emerald-400">
                        <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
                        <span className="text-sm font-medium">No active issues or records found for this category.</span>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-4">
                        {analysis.itemsAnalysis.map((item, idx) => {
                          const requiresAction = item.actionRequired && item.actionRequired.toLowerCase() !== 'none';
                          return (
                            <div key={idx} className={`p-5 border rounded-xl transition-all duration-200 ${requiresAction ? 'bg-amber-500/5 border-amber-500/20' : 'bg-muted/20 border-border/50 hover:bg-muted/40'}`}>
                              <div className="flex justify-between items-start gap-4 mb-3">
                                <h3 className="font-semibold text-foreground text-base leading-tight">{item.itemTitle}</h3>
                                {requiresAction && (
                                  <Badge className="bg-amber-500/10 text-amber-500 border border-amber-500/20 px-2 py-0.5 shadow-none whitespace-nowrap">
                                    Action Needed
                                  </Badge>
                                )}
                              </div>
                              <p className="text-muted-foreground text-sm mb-3">{item.insights}</p>
                              {requiresAction && (
                                <div className="mt-3 pt-3 border-t border-border/50">
                                  <p className="text-sm font-medium text-foreground"><span className="text-amber-500">→</span> {item.actionRequired}</p>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Recommendations */}
                <Card className="glass-card overflow-hidden">
                  <CardHeader className="border-b border-border/50 bg-muted/20 p-5">
                    <div className="flex items-center gap-2">
                      <Lightbulb className="h-5 w-5 text-primary" />
                      <CardTitle className="text-lg font-bold text-foreground">Recommendations</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent className="p-6">
                    {(!analysis.recommendations || analysis.recommendations.length === 0) ? (
                      <p className="text-sm text-muted-foreground italic">No further recommendations at this time.</p>
                    ) : (
                      <ul className="space-y-4">
                        {analysis.recommendations.map((rec, index) => (
                          <li key={index} className="flex gap-3 items-start bg-muted/30 border border-border/50 p-4 rounded-xl">
                            <div className="h-6 w-6 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5 border border-primary/20">
                              <Sparkles className="h-3.5 w-3.5 text-primary" />
                            </div>
                            <span className="text-foreground text-sm leading-relaxed">{rec}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </div>

            </div>
          ) : null}
        </div>
      </Tabs>
    </PageContainer>
  );
}
