# Project: familyos-enterprise-features

## Architecture
- Stack: Next.js 15, React 19, Prisma 5, PostgreSQL, Tailwind CSS v3, Lucide icons.
- Multi-tenancy: Shared schema with tenantId scoping on all client queries.
- UI Layout: Single layout (Shell.js) wrapping page routes with sidebar navigation.
- AI Integration: Rotated API keys using Gemini/OpenAI via aiKeyManager.js.

## Milestones
| # | Name | Scope | Dependencies | Status | Conversation ID |
|---|---|---|---|---|---|
| 1 | DB Schema & Mock Data Setup | Add password reset fields to User in `schema.prisma`, run migration, and write `scripts/mock_tenant_data.js` to seed a tenant with portfolio gaps. | None | PLANNED | TBD |
| 2 | AI Portfolio Analysis | Implement `/api/analysis` route and `/analysis` page dashboard for aggregated portfolio insights, and add navigation links. | M1 | PLANNED | TBD |
| 3 | SMTP Authentication Flow | Build forgot/reset password API routes and UI pages, integrating SMTP `SystemConfig` and `nodemailer` with offline fallback. | M1 | PLANNED | TBD |
| 4 | Card UI Refactoring & AI | Refactor card faces to show only Share and PDF Download, move edit/delete to dropdowns, and ensure AI auto-fill on all upload flows. | M2 | PLANNED | TBD |
| 5 | Razorpay & Verification | Create Razorpay order/subscription generator test script, run Next.js build, and verify all acceptance criteria. | M3, M4 | PLANNED | TBD |

## Code Layout
- Frontend UI Pages: `src/app/`
- API Route Handlers: `src/app/api/`
- Navigation/Sidebar Shell: `src/app/components/Shell.js`
- Core Libraries: `src/lib/` (auth, ai, db, encryption, sharePrintHelper)
- Prisma Schema: `prisma/schema.prisma`
- Mock Seeding Script: `scripts/mock_tenant_data.js`
- Razorpay Test Script: `scripts/test_razorpay.js`
