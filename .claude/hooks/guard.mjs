#!/usr/bin/env node
/**
 * docsnx PreToolUse safety guard (wired in .claude/settings.json).
 *
 * Blocks two classes of action regardless of the permission allow-list:
 *   1. Reading files that hold real secrets (.env*, full_dump.sql, *.pem, the
 *      "google client" dir, local test creds) via any shell reader.
 *   2. Irreversible / destructive commands (recursive root deletes, DB drops &
 *      resets, force-pushes, curl|sh).
 *
 * Contract: read the hook JSON on stdin. Exit 2 to BLOCK the tool call and feed
 * the stderr message back to Claude. Exit 0 to allow. Any parse error → allow
 * (fail-open) so the guard can never wedge normal work.
 */
import { readFileSync } from 'node:fs';

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

const input = readStdin();
const tool = input.tool_name || '';
const ti = input.tool_input || {};

function block(msg) {
  process.stderr.write(`⛔ docsnx guard: ${msg}\n`);
  process.exit(2);
}

// Filenames/paths that contain production secrets and must never be read.
const SECRET_TARGET =
  /(^|[\s"'/=])(\.env(\.[a-z0-9_.-]+)?|full_dump\.sql|test-login\.json|dump-users\.mjs|[^\s"']*\.pem|[^\s"']*\.dump|google client)(\b|["'\s/]|$)/i;

// Shell verbs that read/print file contents.
const READER =
  /\b(cat|less|more|head|tail|bat|nano|vim|vi|view|code|grep|egrep|fgrep|rg|ag|ack|awk|sed|strings|xxd|od|hexdump|sort|uniq|cut|tac|nl|base64)\b/i;

// Irreversible commands.
const DESTRUCTIVE = [
  [/\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/(?:\s|$)|\/\*|~|\$HOME|\.$)/i, 'refusing recursive delete of a root/home path'],
  [/prisma\s+migrate\s+reset/i, 'prisma migrate reset is forbidden (AGENTS.md §9)'],
  [/drizzle-kit\s+drop/i, 'drizzle-kit drop can destroy schema — run it yourself if truly intended'],
  [/\bdrop\s+database\b/i, 'DROP DATABASE is blocked'],
  [/\btruncate\s+table\b/i, 'TRUNCATE is blocked — confirm and run manually if intended'],
  [/\bgit\s+push\b[^\n]*(--force(-with-lease)?|(\s|=)-f(\s|$))/i, 'force-push is blocked'],
  [/\bcurl\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, 'piping curl straight into a shell is blocked'],
  [/\|\s*(sudo\s+)?(sh|bash)\s+-c\b.*(curl|wget)/i, 'remote-piped shell execution is blocked'],
];

if (tool === 'Bash') {
  const cmd = String(ti.command || '');
  if (READER.test(cmd) && SECRET_TARGET.test(cmd)) {
    block('that file holds real secrets — reading it is blocked. Use masked/example values instead.');
  }
  for (const [re, msg] of DESTRUCTIVE) {
    if (re.test(cmd)) block(msg);
  }
}

// Read/Edit/Write tools targeting a secret file (belt-and-suspenders with the
// deny rules in settings.json, which cover the common cases already).
if (tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
  const p = String(ti.file_path || ti.path || '');
  if (SECRET_TARGET.test(p) && tool === 'Read') {
    block('that file holds real secrets — reading it is blocked.');
  }
}

process.exit(0);
