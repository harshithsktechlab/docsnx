/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A VALUE READ AT RENDER, BEFORE THE LINE THAT DECLARES IT               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The onboarding wizard derived `chosenDestination` from a `destinationId` whose
 * `useState` sat fifty lines further down the component. `const` and `let` are
 * not hoisted into usable existence, so that read threw on EVERY render:
 *
 *     Cannot access 'eS' before initialization
 *
 * — `eS` being what the minifier called `destinationId`. The page was replaced
 * by an error boundary for every user, and the boundary's way out ran through
 * the gate that sends an un-onboarded tenant straight back to the wizard, so
 * there was no exit at all. It shipped because nothing could see it: `next
 * build` compiles a TDZ read happily, and the wizard is a `.js` file with JSX in
 * it, which vitest cannot import to smoke-test.
 *
 * This is the same gap the `no-undef` block in eslint.config.mjs was added for
 * — a page that throws at render — and `no-undef` cannot see this one, because
 * the identifier IS defined. Just later.
 *
 * ── WHY NOT JUST TURN ON `no-use-before-define` ────────────────────────────
 * Because it reports 69 places in src/ and 68 of them are fine. A handler that
 * NAMES a `const fetchThings` defined below it is not a bug — the name is read
 * when the handler runs, long after the whole component body has finished
 * evaluating. The rule cannot tell that apart from a read during render, so as a
 * gate it would mean 68 cleanups or 68 disable comments to catch the one.
 *
 * So the rule below asks the question the built-in one cannot: does this read
 * happen while the enclosing function is being EVALUATED? A reference crosses a
 * function boundary on its way up to the declaration's scope — an arrow in a
 * `useEffect`, a click handler, a `.map` callback — and it is deferred. A
 * reference that reaches the declaration's scope without crossing one (directly
 * in the body, or inside an `if`/`for`/block within it) runs immediately, and
 * that is a TDZ hit every time the line is reached.
 *
 * ── .js AND .jsx ONLY ──────────────────────────────────────────────────────
 * Same scoping as the `no-undef` block, for the same reason. TypeScript already
 * reports this as TS2448 ("Block-scoped variable used before its declaration"),
 * which is why `src/db/schema.ts` and `src/lib/permissionLevels.ts` show up
 * under the raw built-in rule and still compile: their reads are deferred too.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import type { Rule, Scope } from 'eslint';

const SRC = path.resolve(__dirname, '../src');

/** Every .js/.jsx file under src/, which is the set tsc never looks at. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (/\.jsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Is this reference evaluated as part of running the scope that declares the
 * variable, or only later, when some nested function is called?
 *
 * Walk up from the scope the reference sits in until the declaring scope is
 * reached. A `function` scope anywhere along that walk (arrow functions and
 * methods included — eslint types them all as 'function') means the read waits
 * for a call. Block, `for` and `switch` scopes do not: they are entered on the
 * way through.
 */
function isDeferred(reference: Scope.Reference, declaringScope: Scope.Scope): boolean {
  let scope: Scope.Scope | null = reference.from;
  while (scope && scope !== declaringScope) {
    if (scope.type === 'function' || scope.type === 'class-field-initializer') return true;
    scope = scope.upper;
  }
  return false;
}

const renderTimeTdz: Rule.RuleModule = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const sourceCode = context.sourceCode;

    return {
      'Program:exit'() {
        for (const scope of sourceCode.scopeManager.scopes) {
          for (const variable of scope.variables) {
            const def = variable.defs[0];
            // Only const/let. `var` is hoisted and initialised to undefined, so
            // an early read is a different (and much louder) kind of wrong, and
            // function declarations are hoisted whole.
            if (!def || def.type !== 'Variable' || def.parent.kind === 'var') continue;

            const declaredAt = def.name.range?.[0];
            if (declaredAt === undefined) continue;

            for (const reference of variable.references) {
              const readAt = reference.identifier.range?.[0];
              if (readAt === undefined || readAt >= declaredAt) continue;
              if (isDeferred(reference, variable.scope)) continue;

              context.report({
                node: reference.identifier,
                message:
                  `'${variable.name}' is read here, but its const/let declaration is `
                  + `below — this throws "Cannot access '${variable.name}' before `
                  + 'initialization" every time this line runs. Move the declaration above it.',
              });
            }
          }
        }
      },
    };
  },
};

const linter = new Linter();

const config: Linter.Config[] = [{
  // Flat config matches by filename, and its default file list is .js only —
  // without this every .jsx file comes back "No matching configuration found".
  files: ['**/*.js', '**/*.jsx'],
  plugins: { guard: { rules: { 'render-time-tdz': renderTimeTdz } } },
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
  rules: { 'guard/render-time-tdz': 'error' },
}];

describe('no .js/.jsx source reads a const/let before it is declared', () => {
  it('finds nothing', () => {
    const files = sourceFiles(SRC);
    // A guard that silently stopped matching files would pass forever.
    expect(files.length).toBeGreaterThan(100);

    const offences: string[] = [];
    for (const file of files) {
      const messages = linter.verify(readFileSync(file, 'utf8'), config, file);
      for (const m of messages) {
        // ONLY this rule. These files carry `eslint-disable` comments naming
        // rules the real config supplies and this minimal one does not, and
        // ESLint reports each of those as a problem of its own — noise about
        // the harness rather than about the code.
        if (m.ruleId !== 'guard/render-time-tdz') continue;
        offences.push(`${path.relative(SRC, file)}:${m.line}:${m.column}  ${m.message}`);
      }
    }

    expect(offences).toEqual([]);
  });
});
