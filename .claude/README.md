# Claude Code setup for docsnx

This directory configures Claude Code (and any Claude Agent SDK usage) for the
docsnx multi-tenant vault. It is **committed and shared** with the whole team and
CI. Goal: make every Claude session behave like a senior engineer who already
knows this codebase's security contract — optimized for **context, security,
speed, and token cost**.

> Machine-specific overrides go in `.claude/settings.local.json` (gitignored).
> Don't put team rules there.

## What's here

### `settings.json` — permissions + hooks (shared)
- **Permissions (balanced):** auto-allows safe, read-only inspection and the
  `lint / test / typecheck / build / drizzle-kit generate|check` commands so
  routine work runs without a prompt. Still prompts for installs, `git push`,
  and DB writes. **Hard-denies** reading secrets (`.env*`, `full_dump.sql`,
  `*.pem`, `google client/`, local test creds) and destructive DB/prod commands.
- **Hooks:**
  - `hooks/guard.mjs` (PreToolUse) — blocks reading secret files and irreversible
    commands (root `rm -rf`, `DROP DATABASE`, `TRUNCATE`, `prisma migrate reset`,
    `drizzle-kit drop`, force-push, `curl | sh`). Fail-open by design.
  - `hooks/lint-changed.mjs` (PostToolUse) — runs ESLint (errors only) on each
    changed `src/**` file and surfaces problems advisorily (never reverts).

### `agents/` — specialist subagents (spawn with the Task tool or `@agent`)
| Agent | Model | Use it for |
|---|---|---|
| `security-auditor` | opus | Deep read-only audit: tenant isolation, auth, credential leaks, encryption, AI privacy shield. Run before committing security-sensitive changes. |
| `code-reviewer` | sonnet | General pre-commit review; routes security-heavy diffs to the auditor. |
| `api-route-builder` | sonnet | Create/edit `src/app/api/**/route.ts` to the house security pipeline. |
| `drizzle-migrator` | sonnet | Safe schema changes + forward-only migrations (tenant cols, RLS, encryption). |
| `test-engineer` | sonnet | Vitest/Playwright tests, especially tenant-isolation & permission regressions. |

Opus is reserved for the highest-stakes reviewer; the workhorses run on Sonnet to
keep latency and token cost down.

### `skills/` — auto-loaded, on-demand knowledge (keeps base context lean)
- `tenant-isolation` — the `withTenant` + RLS + `tenantId` predicate rules.
- `api-route-pattern` — the canonical route-handler pipeline.
- `field-encryption` — encrypt vs hash vs blind-index; never-expose rules.
- `zero-trust-privacy` — the 4-pillar AI Privacy Shield & Zero-View encryption.
- `app-idea-doc` — turn a raw app/feature idea into a structured product brief
  (problem, personas, use cases, MoSCoW features, metrics, risks). Not
  security-specific; use it to capture/brainstorm/spec an idea.

These trigger automatically from their `description`; they don't bloat every
prompt, which is the token-efficient way to carry deep domain rules.

### `commands/` — slash commands
- `/secure-review` — lint + typecheck + tests + `security-auditor` on the diff.
- `/tenant-audit` — scan routes/lib for isolation defects.
- `/new-module` — scaffold a full tenant-scoped vault module end-to-end.

## MCP servers
- **claude.ai Google Drive** connector: authorize it in your claude.ai connector
  settings (can't be done from a non-interactive CLI session).
- See `../.mcp.json.example` for optional local servers (read-only Postgres,
  Context7 docs). **Never** point a DB MCP at the production primary — it bypasses
  RLS. Copy to `.mcp.json` and use env vars for any connection string.

## Plugins
Claude Code plugins install from marketplaces, which needs an interactive session
+ network. To add Anthropic's set:
```
/plugin marketplace add anthropics/claude-code
/plugin install <name>
```
The agents/skills/commands above already cover the project-specific needs without
external plugins.

## Note on docs drift
`AGENTS.md` / `AI_CONTEXT.md` still describe **Prisma + JavaScript**, but the code
is actually **Drizzle ORM + TypeScript** with Postgres **RLS** (`withTenant`).
The skills/agents here reflect the real stack. Worth reconciling those docs.
