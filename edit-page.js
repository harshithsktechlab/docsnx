const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/app/admin/tenants/page.js');
let code = fs.readFileSync(filePath, 'utf8');

// 1. Add state variables
code = code.replace(
  'const [isProcessingPayment, setIsProcessingPayment] = useState(false);',
  `const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [availablePlans, setAvailablePlans] = useState([]);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [tenantForPayment, setTenantForPayment] = useState(null);
  const [selectedPlanId, setSelectedPlanId] = useState('');`
);

// 2. Add fetchAvailablePlans in loadSession
code = code.replace(
  'fetchAvailableAddons();',
  `fetchAvailableAddons();
      fetchAvailablePlans();`
);

// 3. Add fetchAvailablePlans function definition
code = code.replace(
  'const fetchAvailableAddons = async () => {',
  `const fetchAvailablePlans = async () => {
    try {
      const res = await fetch('/api/admin/plans');
      const data = await res.json();
      if (data.success) {
        setAvailablePlans(data.plans?.filter(p => p.isActive) || []);
      }
    } catch (e) {
      console.error('Failed to load plans', e);
    }
  };

  const fetchAvailableAddons = async () => {`
);

// 4. Update openPaymentModal and add processPayment
code = code.replace(
  /const openPaymentModal = async \(tenant\) => {[\s\S]*?method: 'POST',[\s\S]*?body: JSON.stringify\({ planId: 'YEARLY_BASE', tenantId: tenant.id }\)[\s\S]*?}\);/,
  `const openPaymentModal = (tenant) => {
    setTenantForPayment(tenant);
    setSelectedPlanId(tenant.subscriptionPlan || '');
    setShowPlanModal(true);
  };

  const processPayment = async () => {
    if (!tenantForPayment || !selectedPlanId) {
      toast.error('Please select a plan.');
      return;
    }
    setIsProcessingPayment(true);
    setError(''); setSuccess('');
    setShowPlanModal(false);
    try {
      const res = await fetch('/api/payments/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: selectedPlanId, tenantId: tenantForPayment.id })
      });`
);

// 5. Update Pay / Upgrade button visibility
code = code.replace(
  /<Button variant="outline" size="sm" onClick={\(\) => openPaymentModal\(tenant\)} disabled={isProcessingPayment}/,
  `{!isCurrentTenant && (
                        <Button variant="outline" size="sm" onClick={() => openPaymentModal(tenant)} disabled={isProcessingPayment}`
);

code = code.replace(
  /{isProcessingPayment \? <Loader2 size={12} className="animate-spin mr-1" \/> : <CreditCard size={12} className="mr-1" \/>}/,
  `{isProcessingPayment && tenantForPayment?.id === tenant.id ? <Loader2 size={12} className="animate-spin mr-1" /> : <CreditCard size={12} className="mr-1" />}`
);

code = code.replace(
  /Pay \/ Upgrade\s*<\/Button>/,
  `Pay / Upgrade
                        </Button>
                      )}`
);

// 6. Update AI token consumption visibility
code = code.replace(
  /{\/\* AI Token Consumption \*\/}/,
  `{/* AI Token Consumption */}
                    {!isCurrentTenant && (`
);

code = code.replace(
  /<\/div>\s*<\/div>\s*<\/CardContent>/,
  `<\/div>
                    )}
                  </div>
                </CardContent>`
);

// 7. Add Plan Selection Modal
const modalCode = `      {/* Plan Selection Modal */}
      <Dialog open={showPlanModal} onOpenChange={setShowPlanModal}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Select Subscription Plan</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Label className="mb-2 block">Choose a plan for upgrade</Label>
            <select
              value={selectedPlanId}
              onChange={(e) => setSelectedPlanId(e.target.value)}
              className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="" disabled>Select a plan...</option>
              {availablePlans.map(plan => (
                <option key={plan.id} value={plan.id}>
                  {plan.name} - ₹{plan.price}
                </option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPlanModal(false)}>Cancel</Button>
            <Button onClick={processPayment} disabled={isProcessingPayment || !selectedPlanId}>
              {isProcessingPayment && <Loader2 size={14} className="mr-2 animate-spin" />}
              Proceed to Payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
`;

code = code.replace(
  /<\/div>\s*\);\s*}\s*$/,
  modalCode
);

// 8. Hide the plan text for super admin
code = code.replace(
  /<div className="flex flex-col min-w-0">\s*<span className="text-\[10px\] font-extrabold text-muted-foreground uppercase tracking-wider">Plan<\/span>\s*<span className="text-sm font-black truncate">{tenant\.subscriptionPlan \|\| 'FREE'}<\/span>\s*<\/div>/,
  `{!isCurrentTenant && (
                          <div className="flex flex-col min-w-0">
                            <span className="text-[10px] font-extrabold text-muted-foreground uppercase tracking-wider">Plan</span>
                            <span className="text-sm font-black truncate">{tenant.subscriptionPlan || 'FREE'}</span>
                          </div>
                        )}`
);


fs.writeFileSync(filePath, code);
console.log("Successfully updated page.js");
