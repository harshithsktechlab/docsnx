# Scope: Milestone 1 - WhatsApp Removal & Super Admin Guards

## Architecture
- Stack: Next.js (App Router), React, Tailwind CSS, Prisma
- Roles: SUPER_ADMIN and tenant-scoped roles (e.g. ADMIN, MEMBER, etc.).
- Shell Component: src/app/components/Shell.js (contains side navigation and layout).

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | WhatsApp Removal (R1) | Remove all WhatsApp references, pages, backend worker, database configurations/models. | None | IN_PROGRESS |
| 2 | Super Admin guards (R2) | Enforce client-side route guards in Shell.js to redirect SUPER_ADMIN away from tenant-specific URLs. | None | IN_PROGRESS |

## Interface Contracts
- None (internal cleanups and Shell.js guards).
