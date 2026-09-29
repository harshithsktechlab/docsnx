const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/app/billing/page.js');
let code = fs.readFileSync(filePath, 'utf8');

// Add state for billing profile
if (!code.includes('billingProfile')) {
  code = code.replace(
    /const \[showDrivePrompt, setShowDrivePrompt\] = useState\(false\);/,
    `const [showDrivePrompt, setShowDrivePrompt] = useState(false);
  const [billingProfile, setBillingProfile] = useState({ billingName: '', billingGst: '', billingAddress: '' });
  const [billingSaving, setBillingSaving] = useState(false);`
  );

  // Add fetch for billing profile
  code = code.replace(
    /const fetchPaymentHistory = useCallback\(async \(\) => {/,
    `const fetchBillingProfile = useCallback(async () => {
    try {
      const res = await fetch('/api/tenants/billing-profile');
      const data = await res.json();
      if (!data.error) setBillingProfile(data);
    } catch { /* silent */ }
  }, []);

  const fetchPaymentHistory = useCallback(async () => {`
  );

  // Add fetchBillingProfile to useEffect
  code = code.replace(
    /fetchPaymentHistory\(\);\n    \}/,
    `fetchPaymentHistory();\n      fetchBillingProfile();\n    }`
  );

  code = code.replace(
    /\[currentUser, fetchPlans, fetchPaymentHistory\]\);/,
    `[currentUser, fetchPlans, fetchPaymentHistory, fetchBillingProfile]);`
  );

  // Save handler
  code = code.replace(
    /const refreshCurrentPlan = useCallback/,
    `const handleSaveBilling = async (e) => {
    e.preventDefault();
    setBillingSaving(true);
    try {
      const res = await fetch('/api/tenants/billing-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(billingProfile)
      });
      if (res.ok) toast.success('Billing profile updated');
      else toast.error('Failed to update billing profile');
    } catch {
      toast.error('Network error');
    } finally {
      setBillingSaving(false);
    }
  };

  const refreshCurrentPlan = useCallback`
  );

  // Add UI for Billing Profile before Payment History
  const billingProfileUI = `
        {/* Billing Profile */}
        <Card className="border-border/40 shadow-sm mt-8">
          <CardHeader>
            <CardTitle className="text-xl flex items-center gap-2">
              <Sparkles size={24} className="text-primary" />
              Billing Details (GST)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSaveBilling} className="space-y-4 max-w-2xl">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Company / Legal Name</label>
                  <input
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    value={billingProfile.billingName}
                    onChange={e => setBillingProfile(prev => ({...prev, billingName: e.target.value}))}
                    placeholder="Company Name"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">GSTIN</label>
                  <input
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    value={billingProfile.billingGst}
                    onChange={e => setBillingProfile(prev => ({...prev, billingGst: e.target.value}))}
                    placeholder="29XXXXX..."
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Billing Address</label>
                <input
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  value={billingProfile.billingAddress}
                  onChange={e => setBillingProfile(prev => ({...prev, billingAddress: e.target.value}))}
                  placeholder="123 Example Street"
                />
              </div>
              <Button type="submit" disabled={billingSaving}>
                {billingSaving && <Loader2 size={16} className="mr-2 animate-spin" />}
                Save Billing Profile
              </Button>
            </form>
          </CardContent>
        </Card>
`;

  code = code.replace(
    /\{\/\* Payment History \*\/\}/,
    `${billingProfileUI}\n        {/* Payment History */}`
  );
}

fs.writeFileSync(filePath, code);
console.log("Updated billing page");
