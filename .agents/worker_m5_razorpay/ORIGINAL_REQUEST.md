## 2026-07-04T10:38:01Z

You are the teamwork_preview_worker.
Your working directory is d:\Apps\familyos\.agents\worker_m5_razorpay.
Your task is to add the `razorpay` npm package dependency, create a programmatic script `scripts/test_razorpay.js` to test order and subscription generation using test credentials, verify it offline using stubbing, and run a final project-wide build verification.

Please follow these steps:
1. Open and update `package.json` to include `"razorpay": "^2.9.2"` (or a similar compatible version) in dependencies.
2. Run `npm install` to install dependencies.
3. Create `scripts/test_razorpay.js` that:
   - Requires `razorpay` package.
   - Instantiates a Razorpay client:
     `const Razorpay = require('razorpay');`
     `const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder', key_secret: process.env.RAZORPAY_KEY_SECRET || 'rzp_test_secret_placeholder' });`
   - Attempts to call `razorpay.orders.create({ amount: 499900, currency: "INR", receipt: "receipt_1" })` to generate a one-time order ID.
   - Attempts to call `razorpay.subscriptions.create({ plan_id: "plan_PRO_123", customer_notify: 1, total_count: 12 })` to generate a subscription ID.
   - Handles network failure or authentication failure: since the network is restricted (`CODE_ONLY` mode) and real API calls will fail, the script must stub or mock these calls. You can implement this by either overriding `razorpay.orders.create` and `razorpay.subscriptions.create` to return a mock response when offline or when using placeholder credentials, or catching the error and generating a valid mock order/subscription ID, printing a clear message and exiting with code 0.
   - E.g.
     ```javascript
     // Check if we are running in placeholder/offline mode and stub if so
     if (razorpay.key_id === 'rzp_test_placeholder' || process.env.NODE_ENV === 'test' || true) {
       // Override to return mock objects so it works offline
       razorpay.orders.create = async () => ({ id: 'order_test_' + Math.random().toString(36).substring(2, 10).toUpperCase(), amount: 499900 });
       razorpay.subscriptions.create = async () => ({ id: 'sub_test_' + Math.random().toString(36).substring(2, 10).toUpperCase(), plan_id: 'plan_PRO_123' });
     }
     ```
   - Print the generated Order ID and Subscription ID.
4. Run the script: `node scripts/test_razorpay.js` and verify it succeeds and outputs the IDs.
5. Run a final production build check: `npm run build`. Confirm that the entire Next.js project compiles cleanly and successfully.
6. Write a detailed `handoff.md` and report back.

MANDATORY INTEGRITY WARNING: DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.
