const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/app/admin/tenants/page.js');
let code = fs.readFileSync(filePath, 'utf8');

// 1. Add state for isManualPayment and selectedAddonId
if (!code.includes('isManualPayment')) {
  code = code.replace(
    /const \[selectedPlanId, setSelectedPlanId\] = useState\(''\);/,
    `const [selectedPlanId, setSelectedPlanId] = useState('');
  const [selectedAddonId, setSelectedAddonId] = useState('');
  const [isManualPayment, setIsManualPayment] = useState(false);
  const [showAddonModal, setShowAddonModal] = useState(false);`
  );

  // 2. Modify processPayment
  const oldProcess = `const processPayment = async () => {
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
      });`;

  const newProcess = `const processPayment = async (isForAddon = false) => {
    if (!tenantForPayment) return;
    if (isForAddon && !selectedAddonId) {
      toast.error('Please select an add-on.');
      return;
    }
    if (!isForAddon && !selectedPlanId) {
      toast.error('Please select a plan.');
      return;
    }
    
    setIsProcessingPayment(true);
    setError(''); setSuccess('');
    if (isForAddon) setShowAddonModal(false);
    else setShowPlanModal(false);
    
    try {
      const payload = { 
        tenantId: tenantForPayment.id,
        isManualPayment
      };
      if (isForAddon) payload.addonId = selectedAddonId;
      else payload.planId = selectedPlanId;

      const res = await fetch('/api/payments/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });`;

  code = code.replace(oldProcess, newProcess);

  // 3. Update old processPayment calls if any inside the JSX? No, the Plan Modal button calls processPayment(). We can just make it processPayment(false) and Addon processPayment(true).
  
  // Update Plan modal UI
  const planModalFind = `<DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setShowPlanModal(false)}>Cancel</Button>
            <Button onClick={processPayment}>Proceed to Payment</Button>
          </DialogFooter>`;
  
  const planModalReplace = `<div className="flex items-center space-x-2 mt-4">
              <input type="checkbox" id="manualPayment" className="w-4 h-4" checked={isManualPayment} onChange={e => setIsManualPayment(e.target.checked)} />
              <label htmlFor="manualPayment" className="text-sm">Record as Manual Payment (Skip Razorpay)</label>
            </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setShowPlanModal(false)}>Cancel</Button>
            <Button onClick={() => processPayment(false)}>{isManualPayment ? 'Record Payment' : 'Proceed to Payment'}</Button>
          </DialogFooter>`;

  code = code.replace(planModalFind, planModalReplace);

  // Replace Grant Add-on button in tenant card with "Grant Add-on..." to open modal
  // Look for: const handleGrantAddon = async (tId, aId) => {
  // It's probably better to just change the existing handleGrantAddon or replace it with a modal.
  const oldGrantAddonBtn = `<Button size="sm" onClick={() => handleGrantAddon(t.id, t.selectedAddon)}>`;
  const newGrantAddonBtn = `<Button size="sm" onClick={() => {
                              setTenantForPayment(t);
                              setSelectedAddonId(t.selectedAddon);
                              setIsManualPayment(false);
                              setShowAddonModal(true);
                            }}>`;
  code = code.replace(oldGrantAddonBtn, newGrantAddonBtn);

  // Add Addon Modal
  const addonModal = `
      {/* Addon Modal */}
      <Dialog open={showAddonModal} onOpenChange={setShowAddonModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Grant Add-on & Record Payment</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm mb-4">You are granting an add-on to <strong>{tenantForPayment?.name}</strong>.</p>
            <div className="flex items-center space-x-2 mt-4">
              <input type="checkbox" id="addonManualPayment" className="w-4 h-4" checked={isManualPayment} onChange={e => setIsManualPayment(e.target.checked)} />
              <label htmlFor="addonManualPayment" className="text-sm">Record as Manual Payment (Skip Razorpay)</label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddonModal(false)}>Cancel</Button>
            <Button onClick={() => processPayment(true)}>{isManualPayment ? 'Record Payment' : 'Proceed to Payment'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  `;

  code = code.replace(/<\/div>\s*<\/div>\s*<\/div>\s*$/m, addonModal + "\n    </div>\n  </div>\n</div>\n");
}

fs.writeFileSync(filePath, code);
console.log("Updated tenants page");
