# Handoff Report: WhatsApp Integration Removal (Milestone 1 - R1)

## 1. Observation
Below are the exact file paths, line numbers, and contents observed in the codebase using `grep_search` and `view_file` calls:

### Files to Delete Completely
- **Background Worker**: `scripts/whatsapp-worker.mjs`
  - Fully dedicated to polling DB and executing WhatsApp processing.
- **WhatsApp Processor**: `src/lib/whatsapp-processor.js`
  - Handles parsing WhatsApp messages via Gemini and creating records in target modules (documents, medical, vehicles, investments, etc.).
- **WhatsApp Page View**: `src/app/whatsapp/page.js` (and the parent folder `src/app/whatsapp`)
  - The frontend console UI for viewing and reprocessing WhatsApp message logs.
- **WhatsApp API Route**: `src/app/api/whatsapp/route.js` (and the parent folder `src/app/api/whatsapp`)
  - The API endpoints handling GET (fetch messages) and POST (manual reprocessing).

---

### Code References to Modify / Remove

#### 1. Database Schema and Seeding
- **`prisma/schema.prisma`** (Lines 292–314):
  ```prisma
  model WhatsappMessage {
    id               String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
    tenantId         String    @map("tenant_id") @db.Uuid
    instanceName     String    @map("instance_name")
    remoteJid        String    @map("remote_jid")
    messageId        String    @map("message_id")
    fromMe           Boolean?  @map("from_me")
    senderJid        String?   @map("sender_jid")
    senderPn         String?   @map("sender_pn")
    pushName         String?   @map("push_name")
    messageText      String?   @map("message_text")
    messageType      String?   @map("message_type")
    mediaUrl         String?   @map("media_url")
    mediaMime        String?   @map("media_mime")
    fileName         String?   @map("file_name")
    payload          Json      @map("payload")
    messageTimestamp BigInt?   @map("message_timestamp")
    status           String?   @map("status")
    createdAt        DateTime? @default(now()) @map("created_at") @db.Timestamptz

    @@unique([tenantId, instanceName, messageId])
    @@map("whatsapp_messages")
  }
  ```
- **`prisma/seed.js`** (Lines 52–81):
  - Seeds a pending WhatsApp message for testing using `prisma.whatsappMessage.upsert(...)`.
- **`scripts/query-db.mjs`** (Lines 9–16):
  ```javascript
  const messages = await db.whatsappMessage.findMany();
  console.log('--- WHATSAPP MESSAGES IN DB ---');
  console.log(JSON.stringify(messages.map(m => ({
    id: m.id,
    messageId: m.messageId,
    status: m.status,
    messageText: m.messageText
  })), null, 2));
  ```

#### 2. Super Admin & Navigation Authorization
- **`src/lib/auth.js`** (Line 61):
  ```javascript
  const adminModules = ['tenants', 'ai-keys', 'audit_logs', 'whatsapp', 'dashboard'];
  ```
  - `'whatsapp'` must be removed.

#### 3. Client Navigation Layout
- **`src/app/components/Shell.js`** (Lines 20, 206, 384):
  - Line 20: `MessageSquareCode` is imported from `lucide-react`.
  - Line 206: `{ name: 'WhatsApp', path: '/whatsapp', icon: MessageSquareCode },`
  - Line 384: `{ name: 'WhatsApp', path: '/whatsapp', icon: MessageSquareCode },`

#### 4. Dashboard Metrics and Quick Links
- **`src/app/api/dashboard/route.js`** (Lines 13, 17, 51):
  - Line 13: `const [tenantCount, userCount, keyCount, whatsappCount] = await Promise.all([`
  - Line 17: `prisma.whatsappMessage.count(),`
  - Line 51: `whatsappMessages: whatsappCount,`
- **`src/app/dashboard/page.js`** (Lines 23, 149, 212–219):
  - Line 23: Imports `MessageSquareCode` from `lucide-react`.
  - Line 149: `{ name: 'WhatsApp Logs', count: adminStats.whatsappMessages, icon: MessageSquareCode, color: '#f59e0b', path: '/whatsapp', sub: 'Integrations ledger' },`
  - Lines 212–219: WhatsApp Quick Link button targeting `/whatsapp`.

#### 5. More Menu Options
- **`src/app/more/page.js`** (Lines 11, 40, 44):
  - Line 11: Imports `MessageSquareCode` from `lucide-react`.
  - Line 40: `{ name: 'WhatsApp Automation', path: '/whatsapp', icon: MessageSquareCode, color: '#10b981', desc: 'System integration messages' },`
  - Line 44: `{ name: 'WhatsApp Automation', path: '/whatsapp', icon: MessageSquareCode, color: '#10b981', desc: 'Scan and process inbox documents' },`

#### 6. User Forms
- **`src/app/register/page.js`** (Lines 148, 155):
  - Line 148: `label="Phone Number (WhatsApp) *"`
  - Line 155: `hint="Used to match incoming WhatsApp documents to your profile."`
- **`src/app/users/page.js`** (Lines 640, 760):
  - Line 640: `<Label htmlFor="addPhone">Phone Number (WhatsApp)</Label>`
  - Line 760: `<Label htmlFor="editPhone">Phone Number (WhatsApp)</Label>`

#### 7. AI Helper Library
- **`src/lib/ai.js`** (Lines 141–224):
  - Functions `parseWhatsAppMessage` and `buildMockWhatsAppParse` are defined to support WhatsApp processing.

#### 8. Environment & Deployment Configurations
- **`docker-compose.yml`** (Lines 29, 35–50):
  - Line 29: `- STITCH_API_KEY=<REDACTED>`
  - Lines 35–50: Entire `familyos-worker` service definition that runs `node scripts/whatsapp-worker.mjs`.
- **`.env`** (Line 6):
  - `STITCH_API_KEY="<REDACTED>"`

#### 9. Project Documentation
- **`project-context/database.md`** (Line 11): Mention of `WhatsappMessage` core entity.
- **`project-context/integrations.md`** (Lines 6, 16–20): Description of "Stitch (WhatsApp API)" integration.
- **`AI_CONTEXT.md`** (Lines 48–49, 96, 132, 147, 182): References to WhatsApp folders/files/models.
- **`AGENTS.md`** (Line 45): Reference to WhatsApp worker and model.

---

## 2. Logic Chain
1. **Schema Integrity**: Removing the `WhatsappMessage` model (Observation: `prisma/schema.prisma` lines 292–314) will break any TypeScript/JavaScript files that execute queries against `prisma.whatsappMessage` or `db.whatsappMessage`.
2. **Dependent Cleanup**: Thus, database seeding (`prisma/seed.js` lines 52–81), the Super Admin dashboard statistics query (`src/app/api/dashboard/route.js` lines 13–18, 51), and utility queries (`scripts/query-db.mjs` lines 9–16) must have their references to `whatsappMessage` removed or adjusted so they run without errors.
3. **Dead Code Elimination**: Files exclusively implementing WhatsApp ingestion (`scripts/whatsapp-worker.mjs`), processing (`src/lib/whatsapp-processor.js`), web routes (`src/app/whatsapp/page.js`), and route handlers (`src/app/api/whatsapp/route.js`) are no longer functional and should be deleted entirely.
4. **UI Reconciliation**: To prevent broken links, UI modules targeting `/whatsapp` or displaying WhatsApp stats must be pruned (Observation: `Shell.js` lines 206, 384; `dashboard/page.js` lines 149, 212–219; `more/page.js` lines 40, 44). Unused `lucide-react` imports (specifically `MessageSquareCode`) should also be removed.
5. **Labels Update**: User registration and edit fields (Observation: `register/page.js` lines 148, 155; `users/page.js` lines 640, 760) reference "(WhatsApp)" which is obsolete and must be updated to avoid user confusion.
6. **Infrastructure Cleanup**: Polling variables (`STITCH_API_KEY` in `.env` and `docker-compose.yml`) and container setups (`familyos-worker` in `docker-compose.yml`) are redundant without the background worker and should be removed.

---

## 3. Caveats
- No caveats. The codebase search was comprehensive, using case-insensitive grep across all source, script, configuration, and documentation folders, ignoring only agent directories.

---

## 4. Conclusion
To completely remove WhatsApp integration, the following actions must be taken:
1. **Delete 4 files**:
   - `scripts/whatsapp-worker.mjs`
   - `src/lib/whatsapp-processor.js`
   - `src/app/whatsapp/page.js` (and directory)
   - `src/app/api/whatsapp/route.js` (and directory)
2. **Modify `prisma/schema.prisma`** to remove `WhatsappMessage`.
3. **Modify `prisma/seed.js`** to remove `WhatsappMessage` seeding.
4. **Modify `scripts/query-db.mjs`** to remove `db.whatsappMessage` queries.
5. **Modify `src/lib/ai.js`** to remove `parseWhatsAppMessage` and `buildMockWhatsAppParse` functions.
6. **Modify `src/lib/auth.js`** to remove `'whatsapp'` from `adminModules`.
7. **Modify `src/app/components/Shell.js`**, `src/app/dashboard/page.js`, and `src/app/more/page.js` to remove sidebar items, navigation buttons, stats cards, and unused imports.
8. **Modify `src/app/register/page.js`** and `src/app/users/page.js` to remove WhatsApp hints/labels.
9. **Modify `docker-compose.yml`** and `.env` to remove `STITCH_API_KEY` and the `familyos-worker` service.
10. **Update documentation** in `project-context/database.md`, `project-context/integrations.md`, `AI_CONTEXT.md`, and `AGENTS.md`.

---

## 5. Verification Method
1. **Database Schema Compile**:
   - Run `npx prisma generate` to verify the Prisma Client regenerates successfully without `WhatsappMessage`.
   - Run local development migration using `npx prisma migrate dev` (simulate in non-production environments) or run tests.
2. **Next.js Production Build**:
   - Run `npm run build` to verify the frontend and API routes build successfully, proving that no broken imports or obsolete page routes remain.
3. **Seeding Validation**:
   - Run `node prisma/seed.js` or `npm run db:seed` (if configured) to verify the seed runner executes without database queries failing.
