---
description: Pre-commit gate — run lint, typecheck, tests, then security-audit the working diff.
argument-hint: "[optional path or 'staged']"
allowed-tools: Bash(npm run lint), Bash(npm run lint:*), Bash(npx tsc:*), Bash(npm test), Bash(npx vitest:*), Bash(git diff:*), Bash(git status:*), Read, Grep, Glob, Task
---

Run docsnx's pre-commit quality + security gate over the current working changes
${ARGUMENTS:+(scope: $ARGUMENTS)}.

Do the following in order and report a concise pass/fail for each step. Stop and
surface blockers; don't auto-commit.

1. **Scope** — `git status` + `git diff` (use `--staged` if the argument is
   `staged`, else the full working tree, or the given path). List changed files.
2. **Lint** — `npm run lint`. Report errors (warnings are fine).
3. **Typecheck** — `npx tsc --noEmit`. Report new type errors.
4. **Tests** — `npm test`. If a data route/lib changed and no matching test did,
   note the coverage gap.
5. **Security audit** — launch the `security-auditor` subagent on the changed
   files (tenant isolation, auth/permission, credential exposure, encryption, AI
   privacy shield). Relay its ranked findings.
6. **Verdict** — a single line: READY TO COMMIT / FIX FIRST, with the top blockers.
