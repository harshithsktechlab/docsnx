const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/app/admin/ai-settings/page.js');
let code = fs.readFileSync(filePath, 'utf8');

// 1. Add states for Billing Profile
if (!code.includes('billingProfile')) {
  code = code.replace(
    /const \[showKeyValue, setShowKeyValue\] = useState\(false\);/,
    `const [showKeyValue, setShowKeyValue] = useState(false);
  const [billingProfile, setBillingProfile] = useState({ platformName: '', platformGstin: '', platformAddress: '' });
  const [billingSaving, setBillingSaving] = useState(false);`
  );

  // 2. Fetch billing profile on mount
  const fetchKeysFn = `const fetchKeys = async () => {`;
  code = code.replace(
    fetchKeysFn,
    `const fetchBillingProfile = async () => {
    try {
      const res = await fetch('/api/admin/billing-profile');
      const data = await res.json();
      if (!data.error) {
        setBillingProfile(data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchKeys = async () => {`
  );

  // Call it in useEffect
  code = code.replace(
    /fetchKeys\(\);\n  \}, \[\]\);/,
    `fetchKeys();\n    fetchBillingProfile();\n  }, []);`
  );

  // 3. Save billing profile handler
  code = code.replace(
    /const handleSave = async \(e\) => {/,
    `const handleSaveBilling = async (e) => {
    e.preventDefault();
    setBillingSaving(true);
    try {
      const res = await fetch('/api/admin/billing-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(billingProfile)
      });
      if (res.ok) toast.success('Billing profile updated');
      else toast.error('Failed to update billing profile');
    } catch (e) {
      toast.error('Network error');
    } finally {
      setBillingSaving(false);
    }
  };

  const handleSave = async (e) => {`
  );

  // 4. Add UI Card
  const newCard = `{/* Billing Profile Card */}
        <Card className="border-border/40 shadow-sm mb-6">
          <CardHeader>
            <CardTitle className="text-xl flex items-center gap-2">
              <Receipt size={24} className="text-primary" />
              Platform Billing Profile
            </CardTitle>
            <CardDescription>
              GST and address details for automated invoices generated for tenants.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSaveBilling} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Platform Name / Company Name</Label>
                  <Input 
                    value={billingProfile.platformName} 
                    onChange={e => setBillingProfile(prev => ({...prev, platformName: e.target.value}))}
                    placeholder="Docsnx LLC"
                  />
                </div>
                <div className="space-y-2">
                  <Label>GSTIN</Label>
                  <Input 
                    value={billingProfile.platformGstin} 
                    onChange={e => setBillingProfile(prev => ({...prev, platformGstin: e.target.value}))}
                    placeholder="29XXXXX..."
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Billing Address</Label>
                <Input 
                  value={billingProfile.platformAddress} 
                  onChange={e => setBillingProfile(prev => ({...prev, platformAddress: e.target.value}))}
                  placeholder="123 Tech Park, Bangalore"
                />
              </div>
              <Button type="submit" disabled={billingSaving}>
                {billingSaving && <Loader2 size={16} className="mr-2 animate-spin" />}
                Save Billing Profile
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Existing keys layout */}`;

  code = code.replace(
    /<div className="flex justify-between items-end mb-6">/,
    `${newCard}\n\n        <div className="flex justify-between items-end mb-6">`
  );
  
  // Also add Receipt import
  code = code.replace(
    /Shield,\n} from 'lucide-react';/,
    `Shield,\n  Receipt,\n} from 'lucide-react';`
  );
  
  code = code.replace(
    /import \{ Card, CardContent \} from '@\/components\/ui\/card';/,
    `import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';`
  );
}

fs.writeFileSync(filePath, code);
console.log("Updated ai-settings page");
