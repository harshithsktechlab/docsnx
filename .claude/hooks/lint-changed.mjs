#!/usr/bin/env node
/**
 * docsnx PostToolUse lint feedback (wired in .claude/settings.json).
 *
 * After an Edit/Write to a source file under src/, run ESLint (errors only) on
 * just that file. If ESLint reports errors, surface them back to Claude via
 * exit 2. This is ADVISORY: the write already happened and is never reverted —
 * the message simply prompts a fix before moving on. Warnings are ignored
 * (`--quiet`) to keep the signal high and the latency low.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}

const file = String(input?.tool_input?.file_path || '');

// Only lint TS/JS sources inside the app; skip config, tests fixtures, etc. are
// still linted if under src/ — that is intentional.
if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) process.exit(0);
if (!/(^|\/)src\//.test(file)) process.exit(0);

try {
  execFileSync('npx', ['eslint', '--quiet', '--no-error-on-unmatched-pattern', file], {
    stdio: 'pipe',
    timeout: 90_000,
  });
  process.exit(0); // clean
} catch (e) {
  const out = `${e.stdout?.toString() || ''}${e.stderr?.toString() || ''}`.trim();
  if (!out) process.exit(0);
  process.stderr.write(
    `⚠️ (advisory) ESLint found errors in ${file} — fix before continuing:\n${out.slice(0, 4000)}\n`
  );
  process.exit(2); // feed message to Claude; does NOT revert the write
}
