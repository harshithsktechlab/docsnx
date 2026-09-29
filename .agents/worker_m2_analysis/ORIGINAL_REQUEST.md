## 2026-07-04T10:25:00Z
<USER_REQUEST>
You are the teamwork_preview_worker.
Your working directory is d:\Apps\familyos\.agents\worker_m2_analysis.
Your task is to implement the AI Portfolio Analysis backend API, frontend UI dashboard, and sidebar/more page navigation links.

Please follow these steps:
1. Open and inspect `src/lib/ai.js`.
2. Add a new exported async function `generatePortfolioAnalysis(portfolioData, tenantId)` to `src/lib/ai.js` that:
   - Formulates detailed instructions for risk and portfolio analysis.
   - The prompt should ask the AI model to output a structured JSON response containing:
     - `gaps`: array of objects { title, severity ('high'|'medium'|'low'), description } representing missing cover, low sum assured, missing core documents.
     - `investments`: array of objects { title, issue, impact, suggestion } representing bad, stagnant or high-risk investments.
     - `expiry`: array of objects { item, expiryDate, daysRemaining, actionRequired } representing expired or soon-expiring policies, vehicle insurances, rentals, or warranties.
     - `recommendations`: array of strings for general financial and health planning tips.
   - Uses `executeTenantWithRotation(tenantId, ...)` to query Gemini/OpenAI.
   - Handles the prompt token and completion token counts correctly (or return a mock fallback if no keys configured). Let's write a mock fallback analysis matching the seeded mock tenant data if no keys are configured, so it is fully offline-resilient!
3. Implement backend route handler `/src/app/api/analysis/route.js` (GET):
   - Secure the route: call `getUserFromRequest(req)` to get user. If not logged in, return 401. If `user.role === 'SUPER_ADMIN'`, return 403.
   - Retrieve all database records scoped by `tenantId = user.tenantId` for:
     - `medicalRecord`
     - `investment`
     - `licMediclaim`
     - `document`
     - `vehicle`
     - `warrantyAmc`
     - `contractAgreement`
   - Call the `generatePortfolioAnalysis` helper with this aggregated data.
   - Return a success response with the analyzed JSON content.
4. Implement frontend UI page `/src/app/analysis/page.js`:
   - Create a polished, responsive dashboard displaying the analysis.
   - Use cozy Sand & Terracotta theme visual styling (css variables, Lucide icons, glassmorphism cards).
   - Display sections: "Insurance & Coverage Gaps", "Investment Health Insights", "Critical Expiry Alerts", and "AI Action Recommendations".
   - Under each section, render visually striking card alerts with colored badges: red/rose for high severity/expired, amber for medium severity/soon-expiring, blue/emerald for low severity/healthy.
   - Provide a "Run Analysis" refresh button with loading spinners and loading progress state message.
   - Call `/api/analysis` to fetch the data.
5. Update `src/app/components/Shell.js`:
   - Under `navGroups` `Overview` category, add:
     `{ name: 'AI Analysis', path: '/analysis', icon: Sparkles }`
     (Make sure to import `Sparkles` icon if not already imported).
6. Update `src/app/more/page.js`:
   - Under `standardModules`, add a new module object:
     `{ name: 'AI Portfolio Analysis', path: '/analysis', icon: Sparkles, color: '#e07a5f', desc: 'Aggregated risk, investment, and coverage audit' }`
7. Test your changes locally to ensure the page loads and runs successfully, returning the portfolio analysis for the seeded mock tenant (verify that missing mediclaim, bad investments, and expired vehicle insurance are correctly flagged).
8. Write a detailed `handoff.md` and report back.

MANDATORY INTEGRITY WARNING: DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.
</USER_REQUEST>
