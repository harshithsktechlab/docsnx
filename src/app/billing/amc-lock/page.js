'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, CreditCard, ShieldAlert, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { toast } from 'sonner';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';


export default function AmcLockScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [tenant, setTenant] = useState(null);
  const [invoice, setInvoice] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    const fetchAmcInfo = async () => {
      try {
        // `apiCall` resolves rather than rejecting, so one failing request no
        // longer discards the results of the others — `Promise.all` used to
        // throw the whole batch away and land in a catch that named none of them.
        const [{ json: meData }, { json: invData }] = await Promise.all([
          apiCall('/api/auth/me'),
          apiCall('/api/billing/amc/pending'),
        ]);

        if (meData.success) {
          setTenant(meData.user.tenant);
        }
        if (invData.success && invData.invoice) {
          setInvoice(invData.invoice);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchAmcInfo();
  }, []);

  const handlePayAMC = async () => {
    if (!invoice) return;
    setIsProcessing(true);
    try {
      const { res, json: data } = await apiCall('/api/billing/amc/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: invoice.id })
      });
      
      if (!data.success) {
        toast.error(data.error || 'Failed to initialize payment');
        setIsProcessing(false);
        return;
      }

      const options = {
        key: data.keyId,
        amount: data.amount,
        currency: data.currency,
        name: 'DocsNX',
        description: 'Annual Maintenance Charge',
        order_id: data.orderId,
        handler: async function (response) {
          // Verify payment
          const { json: verifyData } = await apiCall('/api/payments/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature
            })
          });
          if (verifyData.success) {
            toast.success('AMC Paid Successfully!');
            window.location.href = '/dashboard';
          } else {
            toast.error('Payment verification failed');
          }
        },
        theme: {
          color: '#0f172a'
        }
      };

      const rzp = new window.Razorpay(options);
      rzp.on('payment.failed', function (response) {
        toast.error('Payment failed: ' + response.error.description);
      });
      rzp.open();
    } catch (err) {
      console.error(err);
      toast.error('Error connecting to payment gateway');
    } finally {
      setIsProcessing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <PageContainer width="compact" className="items-center">
      {/* Background Ambience */}
      <div className="fixed top-0 left-0 w-[500px] h-[500px] rounded-full bg-destructive/10 blur-[120px] pointer-events-none -translate-x-1/2 -translate-y-1/2" />

      <Card className="max-w-md w-full shadow-2xl border-destructive/20 relative overflow-hidden z-10 animate-in fade-in zoom-in duration-300">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-destructive/50 to-destructive" />
        <CardHeader className="text-center pb-2">
          <div className="mx-auto w-12 h-12 bg-danger-surface text-danger-text rounded-full flex items-center justify-center mb-4">
            <Lock className="w-6 h-6" />
          </div>
          <CardTitle className="text-2xl font-bold">Workspace Locked</CardTitle>
          <CardDescription className="text-base mt-2">
            Your Annual Maintenance Charge (AMC) is overdue. Please settle the pending invoice to restore access to your workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          <div className="bg-card border rounded-lg p-4 mb-6 space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Workspace</span>
              <span className="font-medium">{tenant?.name || 'Loading...'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Amount Due</span>
              <span className="font-bold text-lg">
                {invoice ? `₹${invoice.amount}` : 'Loading...'}
              </span>
            </div>
            {invoice?.dueDate && (
              <div className="flex justify-between text-sm text-danger-text">
                <span>Due Date</span>
                <span>{new Date(invoice.dueDate).toLocaleDateString()}</span>
              </div>
            )}
          </div>

          <div className="bg-amber-500/10 text-amber-500 text-sm p-3 rounded-md flex gap-2 items-start mb-6 border border-amber-500/20">
            <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
            <p>Your data is safe, but access is temporarily restricted until the AMC is paid.</p>
          </div>

          <Button 
            className="w-full h-12 text-base font-semibold" 
            onClick={handlePayAMC}
            disabled={isProcessing || !invoice}
          >
            {isProcessing ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Processing...</>
            ) : (
              <><CreditCard className="w-4 h-4 mr-2" /> Pay AMC to Unlock</>
            )}
          </Button>

          <Button variant="ghost" className="w-full mt-2" onClick={() => {
            // Deliberately unconditional: the cookie is HttpOnly and cleared
            // server-side, but a member who wants out of a locked account gets
            // sent to the login screen whether or not the call answered.
            apiCall('/api/auth/logout', { method: 'POST' }).finally(() => router.push('/login'));
          }}>
            Sign Out
          </Button>
        </CardContent>
      </Card>

      <script src="https://checkout.razorpay.com/v1/checkout.js" async />
    </PageContainer>
  );
}
