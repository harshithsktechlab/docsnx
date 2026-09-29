# familyos Overhaul Planning Report

This report outlines the findings, analysis, and implementation roadmap for the familyos platform overhaul project. It details the steps required to remove WhatsApp, enforce tenant isolation, establish the Vesta design system, add `holderId` and `isGlobal` to record models, implement a follow-up and notification system, integrate AI auto-fill features, build a Super Admin billing dashboard with Razorpay checkout, and provide local JSON backup and restore options.

---

## 1. Findings

### R1: WhatsApp Integration Removal
The WhatsApp integration is powered by the Stitch API and managed through background workers, webhook routes, and database models. The following files and references must be removed or modified:
*   **Background Worker**: `scripts/whatsapp-worker.mjs` polls the Stitch API, fetches messages, and calls the processor.
*   **Webhook Route Handler**: `src/app/api/whatsapp/route.js` lists and reprocesses WhatsApp messages.
*   **UI Page**: `src/app/whatsapp/page.js` is the dedicated console for viewing WhatsApp logs.
*   **Processor Utility**: `src/lib/whatsapp-processor.js` handles categorizing WhatsApp messages and filing them into other models.
*   **DB Model**: `WhatsappMessage` model in `prisma/schema.prisma` mapping to `whatsapp_messages` table.
*   **Environment Config**: `docker-compose.yml` sets `STITCH_API_KEY` for the backend and the `familyos-worker` service running `node scripts/whatsapp-worker.mjs`.
*   **SSO Integration**: `src/app/api/auth/sso/route.js` has references to SSO matching.
*   **Seed Script**: `prisma/seed.js` seeds a dummy WhatsApp message.
*   **Database Query Utility**: `scripts/query-db.mjs` references `db.whatsappMessage.findMany()`.
*   **Dashboard API & Page**:
    *   `src/app/api/dashboard/route.js` references `prisma.whatsappMessage.count()`.
    *   `src/app/dashboard/page.js` displays a "WhatsApp Messages" stat card.
*   **Shell Navigation**: `src/app/components/Shell.js` includes navigation links pointing to `/whatsapp`.
*   **User Register and Management Pages**:
    *   `src/app/register/page.js` contains a field labeled `Phone Number (WhatsApp)` with a hint referencing incoming WhatsApp documents.
    *   `src/app/users/page.js` lists/modifies the user profile phone number field labeled `Phone Number (WhatsApp)`.
*   **AI Library**: `src/lib/ai.js` defines `parseWhatsAppMessage` and `buildMockWhatsAppParse` which parse message text.
*   **Auth Module Permissions**: `src/lib/auth.js` lists `whatsapp` under permitted modules for `SUPER_ADMIN`.

### R2: Refined Tenant Isolation & Super Admin Permissions
*   **Super Admin Check**: A user with `role: 'SUPER_ADMIN'` is authenticated. When checking permissions via `hasPermission(user, module, action)` in `src/lib/auth.js`, the super admin is restricted strictly to the following modules: `['tenants', 'ai-keys', 'audit_logs', 'whatsapp', 'dashboard']`.
*   **Block from Tenant Records**: Because standard record modules like `documents`, `medical`, and `bank_info` are omitted from the super admin permitted list, `hasPermission` returns `false`, causing the API routes to return `403 Forbidden`.
*   **UI Deficit**: While API requests are blocked, the Super Admin can still manually navigate to `/documents` or `/medical`. The layout shell (`Shell.js`) hides these navigation links, but no client-side route guards redirect Super Admins away if they access those page URLs directly.

### R3: Dynamic Design System & Collapsible Side Panel (Vesta Theme)
*   **Current Theme Layout**: `src/app/layout.js` wraps pages in `<Shell>{children}</Shell>`. `src/app/globals.css` specifies HSL variables for `dark` and `light` themes. The sidebar is currently fixed at `w-[260px]`.
*   **Design Tokens**: R3 specifies Terracotta (`#e07a5f`) and Sand (`#f4f1de`) as primary branding colors.
*   **Collapsible Panel**: The sidebar needs to support a `collapsed` state, narrowing its width to `72px` and hiding text labels, only displaying icons.
*   **Navigation Restructuring**: Restructure into 5 distinct categories:
    1.  **Overview**: Dashboard (`/dashboard`)
    2.  **Family Folders**: Documents (`/documents`), Medical (`/medical`)
    3.  **Care & Safety**: Emergency (`/emergency`), Warranty/AMC (`/warranty-amc`)
    4.  **Wealth & Assets**: Bank & Cards (`/bank-info`), Trading (`/trading`), Investments (`/investments`), LIC & Mediclaim (`/lic-mediclaim`)
    5.  **Utilities**: Vehicles (`/vehicles`), Rentals/Subscriptions (`/rentals-subscriptions`), To-Dos (`/todos`), Profile (`/profile`)

### R4: Standardized Date & Document Model
*   **Record Models**: The models `Document`, `MedicalRecord`, `Password`, `BankInfo`, `TradingDemat`, `Vehicle`, `LicMediclaim`, and `Investment` all contain `userId` but lack `holderId` and `isGlobal`.
*   **Date Formats**: Many date fields are rendered directly or formatted using basic string methods. Date picker inputs are standard `<input type="date">` which require `yyyy-MM-dd` formats, but the visual rendering across the board needs to be standardized to `dd/mm/yyyy`.

### R5 & R6: Follow-Up, Notifications, and AI Features
*   **Follow-Up**: Currently, reminders for vehicle and policy expiries are calculated dynamically on the dashboard route (`/api/dashboard`). There is no centralized alert center.
*   **OCR & AI Scan**: Files are uploaded via `src/lib/upload.js` and parsed in `src/app/api/ai/scan/route.js` using `scanMultipleFiles` from `src/lib/ai.js`. Key rotation is managed via `src/lib/aiKeyManager.js` using the global `ApiKey` model.
*   **Auto-fill with AI**: Forms do not have an inline "Auto-fill with AI" option during manual uploads. 

### R7: Tenant-level API Keys & Super Admin Dashboard
*   **API Keys**: Keys are currently global and managed in a shared pool (`ApiKey`). There is no tenant-wise isolation or tracking of key usage.
*   **Super Admin Dashboard**: Currently shows system-wide activity logs. SMTP configurations and billing plans are missing from the database schema and UI.
*   **Payment Checkout**: Razorpay is not referenced anywhere in the codebase.

### R8: Local Storage & Backup Options
*   There is no backup/restore configuration in the codebase. The platform relies on Next.js routes writing directly to PostgreSQL through Prisma.

---

## 2. Plan

### Phase 1: Clean Up WhatsApp Integration (R1)
1.  **Delete Files**:
    *   Delete `scripts/whatsapp-worker.mjs`
    *   Delete `src/app/api/whatsapp/route.js`
    *   Delete `src/app/whatsapp/page.js`
    *   Delete `src/lib/whatsapp-processor.js`
2.  **Remove Schema Model**:
    *   Remove `model WhatsappMessage` from `prisma/schema.prisma`.
3.  **Clean Code References**:
    *   `docker-compose.yml`: Remove `familyos-worker` service definition and `STITCH_API_KEY` from environment variables.
    *   `prisma/seed.js`: Remove references to `whatsappMessage` seeding.
    *   `scripts/query-db.mjs`: Delete references checking WhatsApp records.
    *   `src/app/api/dashboard/route.js`: Remove `whatsappCount` from metrics query.
    *   `src/app/components/Shell.js`: Remove `MessageSquareCode` icons and navigation entries.
    *   `src/app/dashboard/page.js`: Remove the "WhatsApp Logs" stat card and button click redirect handler.
    *   `src/app/more/page.js`: Remove "WhatsApp Automation" cards.
    *   `src/app/register/page.js` & `src/app/users/page.js`: Update the phone number input label from `Phone Number (WhatsApp)` to `Phone Number`. Update hint texts.
    *   `src/lib/ai.js`: Remove `parseWhatsAppMessage` and `buildMockWhatsAppParse` functions.
    *   `src/lib/auth.js`: Remove `whatsapp` from the `adminModules` array.

### Phase 2: Schema Modifications & New Models (R4)
1.  **Update schema.prisma**:
    *   Add `holderId` (`String? @db.Uuid`) and `isGlobal` (`Boolean @default(false)`) to: `Document`, `MedicalRecord`, `Password`, `BankInfo`, `TradingDemat`, `Vehicle`, `LicMediclaim`, and `Investment`.
    *   Declare relation `holder User? @relation("UserHeldRecords", fields: [holderId], references: [id], onDelete: SetNull)` on each record model.
    *   Add corresponding `heldRecords` array relation (e.g. `heldDocuments Document[] @relation("UserHeldRecords")`) on the `User` model.
2.  **Add New Modules Models**:
    *   **Emergency**:
        ```prisma
        model EmergencyContact {
          id           String   @id @default(uuid()) @db.Uuid
          tenantId     String   @map("tenant_id") @db.Uuid
          tenant       Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
          userId       String   @map("user_id") @db.Uuid
          user         User     @relation("EmergencyCreator", fields: [userId], references: [id], onDelete: Cascade)
          holderId     String?  @map("holder_id") @db.Uuid
          holder       User?    @relation("EmergencyHolder", fields: [holderId], references: [id], onDelete: SetNull)
          isGlobal     Boolean  @default(false) @map("is_global")
          name         String
          phone        String
          relationship String
          bloodGroup   String?  @map("blood_group")
          medicalNotes String?  @map("medical_notes")
          hospitalPref String?  @map("hospital_preference")
          createdAt    DateTime @default(now()) @map("created_at")
          updatedAt    DateTime @updatedAt @map("updated_at")

          @@map("emergency_contacts")
        }
        ```
    *   **Warranty/AMC**:
        ```prisma
        model WarrantyAmc {
          id           String   @id @default(uuid()) @db.Uuid
          tenantId     String   @map("tenant_id") @db.Uuid
          tenant       Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
          userId       String   @map("user_id") @db.Uuid
          user         User     @relation("WarrantyCreator", fields: [userId], references: [id], onDelete: Cascade)
          holderId     String?  @map("holder_id") @db.Uuid
          holder       User?    @relation("WarrantyHolder", fields: [holderId], references: [id], onDelete: SetNull)
          isGlobal     Boolean  @default(false) @map("is_global")
          productName  String   @map("product_name")
          purchaseDate DateTime @map("purchase_date")
          durationM    Int      @map("duration_months")
          expiryDate   DateTime @map("expiry_date")
          provider     String?
          contactNo    String?  @map("contact_number")
          filePath     String?  @map("file_path")
          notes        String?
          createdAt    DateTime @default(now()) @map("created_at")
          updatedAt    DateTime @updatedAt @map("updated_at")

          @@map("warranty_amcs")
        }
        ```
    *   **Rentals/Subscriptions**:
        ```prisma
        model RentalSubscription {
          id           String   @id @default(uuid()) @db.Uuid
          tenantId     String   @map("tenant_id") @db.Uuid
          tenant       Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
          userId       String   @map("user_id") @db.Uuid
          user         User     @relation("RentalCreator", fields: [userId], references: [id], onDelete: Cascade)
          holderId     String?  @map("holder_id") @db.Uuid
          holder       User?    @relation("RentalHolder", fields: [holderId], references: [id], onDelete: SetNull)
          isGlobal     Boolean  @default(false) @map("is_global")
          name         String
          amount       Decimal  @db.Decimal(12, 2)
          billingCycle String   @map("billing_cycle") // "monthly" | "yearly"
          nextRenewal  DateTime @map("next_renewal")
          paymentMethod String? @map("payment_method")
          autoRenew    Boolean  @default(true) @map("auto_renew")
          notes        String?
          createdAt    DateTime @default(now()) @map("created_at")
          updatedAt    DateTime @updatedAt @map("updated_at")

          @@map("rentals_subscriptions")
        }
        ```
    *   **To-Dos**:
        ```prisma
        model TodoTask {
          id          String    @id @default(uuid()) @db.Uuid
          tenantId    String    @map("tenant_id") @db.Uuid
          tenant      Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
          userId      String    @map("user_id") @db.Uuid
          user        User      @relation("TodoCreator", fields: [userId], references: [id], onDelete: Cascade)
          holderId    String?   @map("holder_id") @db.Uuid
          holder      User?     @relation("TodoHolder", fields: [holderId], references: [id], onDelete: SetNull)
          isGlobal    Boolean   @default(false) @map("is_global")
          title       String
          description String?
          dueDate     DateTime? @map("due_date")
          status      String    @default("pending") // "pending" | "completed"
          priority    String    @default("medium") // "low" | "medium" | "high"
          createdAt   DateTime  @default(now()) @map("created_at")
          updatedAt   DateTime  @updatedAt @map("updated_at")

          @@map("todo_tasks")
        }
        ```
    *   **Notifications**:
        ```prisma
        model NotificationAlert {
          id         String   @id @default(uuid()) @db.Uuid
          tenantId   String   @map("tenant_id") @db.Uuid
          tenant     Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
          userId     String   @map("user_id") @db.Uuid // Target recipient
          user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
          title      String
          message    String
          type       String   @default("info") // "info" | "warning" | "danger"
          link       String
          isRead     Boolean  @default(false) @map("is_read")
          createdAt  DateTime @default(now()) @map("created_at")

          @@map("notification_alerts")
        }
        ```
    *   **AI Token Usage Tracking & Tenant API Key Mapping**:
        ```prisma
        model AiTokenUsage {
          id         String   @id @default(uuid()) @db.Uuid
          tenantId   String   @map("tenant_id") @db.Uuid
          tenant     Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
          tokensUsed Int      @map("tokens_used")
          model      String
          purpose    String
          createdAt  DateTime @default(now()) @map("created_at")

          @@map("ai_token_usages")
        }
        ```
    *   **Tenant Settings & Subscriptions**:
        Add to `Tenant` model:
        ```prisma
        apiKey         String   @unique @default(uuid()) @map("api_key") // Tenant-specific API authorization key
        smtpHost       String?  @map("smtp_host")
        smtpPort       Int?     @map("smtp_port")
        smtpUser       String?  @map("smtp_user")
        smtpPass       String?  @map("smtp_pass")
        planTier       String   @default("free") @map("plan_tier") // "free", "premium", "enterprise"
        subscriptionAt DateTime? @map("subscription_at")
        subscriptionActive Boolean @default(true) @map("subscription_active")
        ```
3.  **Run Database Migrations**: Execute `npx prisma migrate dev --name extend_schema_for_overhaul`.

### Phase 3: Refine Tenant Isolation (R2)
1.  **Refine API Route Controls**: Ensure all API routes that access user files/records perform permission validation checks first via `hasPermission(user, module, action)`.
2.  **Centralized Route Guarding in Shell**:
    In `src/app/components/Shell.js`, inside the `loadUser` block, add client-side redirect logic to catch and redirect Super Admins if they access page paths not in their whitelist:
    ```javascript
    const adminAllowedPaths = ['/dashboard', '/tenants', '/ai-settings', '/audit-logs', '/login', '/register'];
    const isTenantSpecificPath = !adminAllowedPaths.some(p => pathname === p || pathname.startsWith(p + '/'));
    if (data.user.role === 'SUPER_ADMIN' && isTenantSpecificPath) {
      router.push('/dashboard');
    }
    ```

### Phase 4: Dynamic UI Overhaul & Navigation Restructuring (R3)
1.  **Integrate Vesta Theme in globals.css**:
    *   Primary brand Terracotta: HSL `12 68% 63%` (`#e07a5f`).
    *   Secondary/Background Sand: HSL `49 48% 91%` (`#f4f1de`).
    *   Update dark and light custom CSS variables inside `@layer base` in `globals.css` with these tokens.
2.  **Collapsible Sidebar Panel**:
    *   In `src/app/components/Shell.js`, add state `const [collapsed, setCollapsed] = useState(false);`.
    *   Modify classes on `<aside>`: `w-[260px]` changes to `collapsed ? 'w-[72px]' : 'w-[260px]'`.
    *   For sidebar links, hide labels and headers: `collapsed ? 'hidden' : 'block'`.
    *   Add a floating arrow toggle button: `onClick={() => setCollapsed(!collapsed)}`.
3.  **Implement 5 Sidebar Categories**:
    *   In `Shell.js`, group navigation links into the five arrays: `Overview`, `FamilyFolders`, `CareSafety`, `WealthAssets`, and `Utilities`.
    *   Map these lists into the sidebar accordion render.

### Phase 5: Centralized Reminders & Notifications (R5)
1.  **Calculated Task Engine**: Write a backend script or worker to parse vehicle PUCs/insurances, policy expiries, rental renewals, profile birthdays, and warranty expiries once per day and insert corresponding rows in the `NotificationAlert` table.
2.  **Notification List Component**:
    *   Update `NotificationList` inside `Shell.js` to poll and display entries from `/api/notifications` (mapping to the `NotificationAlert` table).
    *   Clicking a notification redirects the user to the record's page and calls a `DELETE` or `PUT` route to mark it read/dismissed.

### Phase 6: AI Extraction & Auto-fill features (R6)
1.  **Tenant-level AI Key Rotation**:
    *   Update `executeWithRotation` in `src/lib/aiKeyManager.js` to accept a `tenantId`.
    *   Fetch keys configured specifically for that `tenantId` (filtering `ApiKey` by `tenantId` matches).
2.  **Auto-fill with AI button**:
    *   In upload and record creation forms (e.g. `src/app/documents/page.js`), place an "Auto-fill with AI" button beside the file input field.
    *   When clicked, it uploads the file to `/api/ai/scan`, extracts the values using Gemini/OpenAI OCR, and maps the returned JSON values to the React form state.
3.  **Centralized AI recommendation views**:
    *   Create a view in `/dashboard` or `/more` called "AI Insights". It calls an API route `/api/ai/recommendations` that uses Gemini to audit policies, demat details, and medical records to generate tips.

### Phase 7: Super Admin Billing & Razorpay Integration (R7)
1.  **Tenant API Key Verification**:
    *   Replace `slug` check in registration with a unique API key generator.
    *   Allow administrative routes to verify requests sending the headers `x-api-key`.
2.  **Super Admin Dashboard UI**:
    *   Modify `src/app/dashboard/page.js` to render tenant-wise AI Token usage charts (from `AiTokenUsage` count) and SMTP credential configurations.
    *   Remove all system activity log widgets for Super Admins.
3.  **Simulated Razorpay Checkouts**:
    *   Add a script script tags in `src/app/layout.js` loading `https://checkout.razorpay.com/v1/checkout.js`.
    *   Create a payment check interface in user settings.
    *   Clicking "Pay" opens the Razorpay modal. On payment success, send status to `/api/billing/payment-callback` which flags the Tenant record as `subscriptionActive = true` and updates `planTier`.

### Phase 8: Local Storage Mode & JSON Backups (R8)
1.  **Local Storage Database Adapter**:
    *   Scaffold client-side service workers or IndexedDB managers in `/src/lib/localDb.js`.
    *   Create a toggle switch in `/profile` settings labeled "Keep data offline on local device".
    *   When enabled, set a variable in `localStorage.setItem('local_mode', 'true')`.
    *   In data fetch/mutate components, check `local_mode` first. If true, read/write from IndexedDB instead of making backend fetch requests.
2.  **JSON Backup & Restore Handler**:
    *   **Export**: Write a function that reads all database models (or IndexedDB stores if in local mode) and compiles them into a JSON array, exporting it as `familyos_backup_[date].json`.
    *   **Restore**: Write a file reader endpoint/utility that accepts the `.json` upload, validates fields format, and runs a Prisma transaction to recreate the records.

---

## 3. Risks

1.  **Super Admin Data Leaks (RLS bypass)**:
    *   *Risk*: A Super Admin could craft custom raw API queries or exploit route parameter parameters to access tenant data.
    *   *Mitigation*: Ensure that the database queries *always* check `tenantId` matching the user session. Enforce this via a Prisma middleware or custom base repositories.
2.  **Local Mode Data Loss**:
    *   *Risk*: If local-only mode is active, the tenant's data is only stored in their browser cache. Clearing site cookies or cache deletes their family records permanently.
    *   *Mitigation*: Display a prominent warning message when enabling local-only mode, and prompt users to download a JSON backup weekly.
3.  **Token Usage Quota Expiry**:
    *   *Risk*: If a tenant exhausts their allocated tokens, their AI scanner and recommendations will fail.
    *   *Mitigation*: The key manager should fall back gracefully to a warning banner rather than crashing the interface, prompting them to upgrade their subscription or check billing status.

---

## 4. Implementation

### Database Schema Draft (prisma/schema.prisma)
```prisma
// Example updates for record models (adding holderId and isGlobal)
model Document {
  id        String   @id @default(uuid()) @db.Uuid
  tenantId  String   @map("tenant_id") @db.Uuid
  tenant    Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  userId    String   @map("user_id") @db.Uuid
  user      User     @relation("UserUploadedDocuments", fields: [userId], references: [id], onDelete: Cascade)
  holderId  String?  @map("holder_id") @db.Uuid
  holder    User?    @relation("UserHeldDocuments", fields: [holderId], references: [id], onDelete: SetNull)
  isGlobal  Boolean  @default(false) @map("is_global")
  name      String
  category  String
  filePath  String   @map("file_path")
  fileName  String   @map("file_name")
  mimeType  String   @map("mime_type")
  metadata  Json?
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@map("documents")
}
```

### Collapsible Sidebar Logic (src/app/components/Shell.js)
```javascript
// Sidebar collapsible layout wrapper
return (
  <div className="flex min-h-screen bg-background text-foreground">
    {!isEmbedded && (
      <aside 
        className={cn(
          "min-h-screen bg-card border-r border-border transition-all duration-300 flex flex-col fixed top-0 left-0 bottom-0 z-40 hidden lg:flex",
          collapsed ? "w-[72px]" : "w-[260px]"
        )}
      >
        {/* Toggle Button */}
        <button 
          onClick={() => setCollapsed(!collapsed)}
          className="absolute -right-3 top-6 bg-primary text-white rounded-full p-1 border shadow-lg"
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
        </button>
        
        {/* Sidebar categories mapped */}
        ...
      </aside>
    )}
  </div>
);
```

### Date Format Utility (src/lib/utils.js)
```javascript
// Standard dd/mm/yyyy formatter
export function formatDate(dateInput) {
  if (!dateInput) return 'N/A';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return String(dateInput);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}
```

---

## 5. Validation

### Testing WhatsApp Removal
1.  Verify that the application compiles without errors after deleting the worker and routes.
2.  Inspect the database schema post-migration to confirm `whatsapp_messages` table no longer exists.
3.  Check that the WhatsApp console navigation menu items are missing from the sidebar and "More" page.

### Testing Super Admin Block
1.  Log in as a `SUPER_ADMIN` user.
2.  Attempt to manually navigate to `/documents` or `/medical`. Confirm that the UI immediately redirects you back to `/dashboard`.
3.  Make a mock POST request to `/api/documents` authenticated as a Super Admin and confirm the API returns `403 Forbidden`.

### Testing Local Backup Export & Restore
1.  Create 3 test documents and 2 passwords in standard online mode.
2.  Go to Settings, click "Export JSON Backup". Verify a `.json` file downloads containing those exact records.
3.  Delete the records from the UI.
4.  Upload the `.json` backup file via the "Restore Backup" tool.
5.  Verify that the records are successfully written back to the database and reappear in the UI cards.
