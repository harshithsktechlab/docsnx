import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { GoogleGenAI } from '@google/genai';

// Safe AI Client getter
function getAIClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('GEMINI_API_KEY is not defined in environment variables. Falling back to Mock optimizer.');
    return null;
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Parses the Drizzle schema (src/db/schema.ts) into a compressed representation
 * of tables (with their DB name + columns/flags) and enums.
 *
 * The schema is authored with one column per line, e.g.
 *   export const users = pgTable("users", {
 *     id: uuid("id").primaryKey().defaultRandom(),
 *     tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
 *     email: varchar("email", { length: 255 }).unique().notNull(),
 *   }, (table) => { ... indexes ... });
 * so a small line-oriented state machine is enough — no TS parser needed.
 */
function parseDrizzleSchema() {
  try {
    const schemaPath = path.resolve(process.cwd(), 'src/db/schema.ts');
    if (!fs.existsSync(schemaPath)) {
      return '_No Drizzle schema found at `src/db/schema.ts`._';
    }

    const lines = fs.readFileSync(schemaPath, 'utf8').split('\n');

    const enums = [];
    const tables = [];

    const enumRe = /^export const (\w+)\s*=\s*pgEnum\(\s*["']([^"']+)["']\s*,\s*\[([^\]]*)\]/;
    const tableRe = /^export const (\w+)\s*=\s*pgTable\(\s*["']([^"']+)["']/;
    const fieldRe = /^(\w+):\s*(\w+)\(\s*["']([^"']+)["']/;

    let current = null;   // { constName, dbName, fields: [] }
    let state = 'idle';   // 'idle' | 'fields' | 'afterFields'

    const closeTable = () => {
      if (current) tables.push(current);
      current = null;
      state = 'idle';
    };

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      // Enums (single line)
      const em = line.match(enumRe);
      if (em) {
        const values = em[3]
          .split(',')
          .map((v) => v.trim().replace(/["']/g, ''))
          .filter(Boolean);
        enums.push({ constName: em[1], dbName: em[2], values });
        continue;
      }

      // Table start
      const tm = line.match(tableRe);
      if (tm) {
        if (current) closeTable(); // safety: previous table never closed
        current = { constName: tm[1], dbName: tm[2], fields: [] };
        state = 'fields';
        continue;
      }

      if (!current) continue;

      // Transition into the optional index builder: `}, (table) => {` / `=> ({`
      if (state === 'fields' && /^\},\s*\(?\w*\)?\s*=>/.test(line)) {
        state = 'afterFields';
        continue;
      }

      // End of the pgTable(...) call
      if (line.startsWith('});') || line === ')' || line === '};') {
        if (state === 'fields' || state === 'afterFields') {
          closeTable();
          continue;
        }
      }

      // Column lines (only while inside the fields object)
      if (state === 'fields') {
        const fm = line.match(fieldRe);
        if (fm) {
          const [, name, type] = fm;
          const flags = [];
          if (line.includes('.primaryKey(')) flags.push('PK');
          if (line.includes('.references(')) flags.push('FK');
          if (line.includes('.unique(')) flags.push('U');
          if (line.includes('.notNull(')) flags.push('NN');
          current.fields.push(`${name}: ${type}${flags.length ? `[${flags.join(',')}]` : ''}`);
        }
      }
    }
    if (current) closeTable();

    let out = `### Drizzle Schema (\`src/db/schema.ts\`) — ${tables.length} tables, ${enums.length} enum(s)\n\n`;
    out += '_Column names are camelCase in code; the DB name (snake_case) is shown per table. Flags: PK=primary key, FK=foreign key, U=unique, NN=not null._\n\n';

    for (const e of enums) {
      out += `- **enum ${e.constName}** (\`${e.dbName}\`): ${e.values.join(', ')}\n`;
    }
    if (enums.length) out += '\n';

    for (const t of tables) {
      out += `- **${t.constName}** (table \`${t.dbName}\`)\n  - ${t.fields.join(', ')}\n`;
    }
    return out;
  } catch (error) {
    return `Error parsing Drizzle schema: ${error.message}`;
  }
}

/**
 * Scans directories recursively up to maxDepth, returning a nested tree structure as markdown list.
 */
function scanDirectory(dir, relativePath = '', depth = 0, maxDepth = 4) {
  if (depth > maxDepth) return '';

  const ignoreDirs = new Set(['.git', 'node_modules', '.next', 'dist', '.gemini', 'tmp', 'public']);
  const ignoreFiles = new Set(['package-lock.json', '.env', '.env.local', 'README.md', 'CLAUDE.md', 'AGENTS.md', 'AI_CONTEXT.md']);

  try {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    let result = '';

    // Sort: directories first, then files
    files.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const file of files) {
      if (file.name.startsWith('.') && file.name !== '.env') {
        if (file.name !== '.gitignore' && file.name !== '.eslintrc.json' && file.name !== '.eslint.config.mjs') {
          continue; // Skip dotfiles except config
        }
      }

      if (file.isDirectory() && ignoreDirs.has(file.name)) continue;
      if (!file.isDirectory() && ignoreFiles.has(file.name)) continue;

      const indent = '  '.repeat(depth);
      const relativeFilePath = relativePath ? `${relativePath}/${file.name}` : file.name;

      if (file.isDirectory()) {
        result += `${indent}- 📂 **${file.name}/**\n`;
        result += scanDirectory(path.join(dir, file.name), relativeFilePath, depth + 1, maxDepth);
      } else {
        // Show file extension and name
        result += `${indent}- 📄 ${file.name}\n`;
      }
    }

    return result;
  } catch (error) {
    return `${'  '.repeat(depth)}- *Error reading dir ${relativePath || '/'}: ${error.message}*\n`;
  }
}

/**
 * Gets the current git status and recent commits.
 */
function getGitMetadata() {
  let gitInfo = '### Git Status & Activity\n\n';

  // Check if it's a git repo
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore', cwd: process.cwd() });
  } catch (e) {
    return gitInfo + '*Not inside a git repository or git command failed.*\n';
  }

  try {
    // Current status (unstaged changes)
    const status = execSync('git status --porcelain', { encoding: 'utf8', cwd: process.cwd() }).trim();
    gitInfo += '#### Uncommitted Changes:\n';
    if (status) {
      gitInfo += '```text\n' + status + '\n```\n\n';
    } else {
      gitInfo += '*No uncommitted changes.*\n\n';
    }

    // Recent 5 commits
    const commits = execSync('git log -n 5 --oneline', { encoding: 'utf8', cwd: process.cwd() }).trim();
    gitInfo += '#### Recent Commits:\n';
    if (commits) {
      gitInfo += '```text\n' + commits + '\n```\n';
    } else {
      gitInfo += '*No commits found.*\n';
    }
  } catch (error) {
    gitInfo += `*Failed to query Git info: ${error.message}*\n`;
  }

  return gitInfo;
}

/**
 * Gathers package information from package.json
 */
function getPackageMetadata() {
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    if (!fs.existsSync(pkgPath)) return 'No package.json found.';

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const dep = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };
    const drizzleOrm = dep['drizzle-orm'] || 'unknown';
    const drizzleKit = dep['drizzle-kit'] || 'unknown';

    let info = '### Project Metadata\n\n';
    info += `- **Name**: ${pkg.name || 'docsnx'}\n`;
    info += `- **Version**: ${pkg.version || '0.1.0'}\n`;
    info += `- **Framework**: Next.js (version: ${pkg.dependencies?.next || 'unknown'}), React ${pkg.dependencies?.react || 'unknown'}\n`;
    info += `- **Language**: TypeScript ${dep.typescript || ''}\n`.trimEnd() + '\n';
    info += `- **Database ORM**: Drizzle ORM (drizzle-orm ${drizzleOrm}, drizzle-kit ${drizzleKit}) over PostgreSQL (pg ${dep.pg || 'unknown'})\n`;
    info += `- **Dependencies**: ${Object.keys(pkg.dependencies || {}).join(', ') || 'None'}\n`;
    info += `- **Scripts**: ${Object.keys(pkg.scripts || {}).join(', ') || 'None'}\n`;
    return info;
  } catch (error) {
    return `Error reading package.json: ${error.message}`;
  }
}

/**
 * Builds the initial raw context document.
 */
export function buildRawContext() {
  const timestamp = new Date().toISOString();

  let md = `# Project Context - DocsNX\n\n`;
  md += `*Generated automatically on: ${timestamp}*\n\n`;

  md += `## 1. Project Information\n\n`;
  md += getPackageMetadata() + '\n';

  md += `## 2. Database Schema\n\n`;
  md += parseDrizzleSchema() + '\n';

  md += `## 3. Directory Layout (src/)\n\n`;
  md += `\`\`\`text\n`;
  md += scanDirectory(path.resolve(process.cwd(), 'src'), 'src', 0, 3);
  md += `\`\`\`\n\n`;

  md += `## 4. Git Workspace Details\n\n`;
  md += getGitMetadata() + '\n';

  md += `## 5. Architectural & Design Guidelines\n\n`;
  md += `- **Tech Stack**: Next.js 15 App Router, React 19, TypeScript, Drizzle ORM, PostgreSQL. Deployed on Oracle Cloud (OCI) via Docker.\n`;
  md += `- **Tenant Isolation**: Postgres RLS via \`withTenant(tenantId, cb)\` in \`src/lib/db.ts\` (sets the \`app.tenant_id\` session var), PLUS an explicit \`eq(table.tenantId, user.tenantId)\` predicate in every query. Reads exclude soft-deleted rows (\`isNull(table.deletedAt)\`). Never scope by a tenantId taken from the request.\n`;
  md += `- **Migrations**: Drizzle Kit — \`npx drizzle-kit generate\` then \`migrate\` (prod) / \`push\` (local). Config in \`drizzle.config.ts\`; generated SQL in \`drizzle/\`.\n`;
  md += `- **Styling System**: Tailwind CSS v3 + Radix UI + CSS variables in \`src/app/globals.css\`. Glassmorphism dark mode default, toggles to light.\n`;
  md += `- **Auth**: Cookie-based JWT (\`auth_token\`, HttpOnly, 7-day). Checks via \`getUserFromRequest\` / \`hasPermission\` in \`src/lib/auth.ts\`. Roles: SUPER_ADMIN, TENANT_ADMIN, STANDARD.\n`;
  md += `- **Encryption**: AES-256-GCM at rest via \`src/lib/encryption.ts\` and field helpers in \`src/lib/fieldCrypto.ts\` (blind index for lookups, \`hashToken\` for OTPs/reset tokens). Browser Zero-View encryption via \`src/lib/clientCrypto.ts\`. \`passwordHash\` never reaches the client.\n`;
  md += `- **AI Features**: Gemini (\`gemini-2.5-flash\`) + OpenAI, always via \`executeWithRotation\` (\`src/lib/aiKeyManager.ts\`). Payloads masked/compressed by \`prepareAiPayload\` (\`src/lib/aiPrivacyMasker.ts\`). See AGENTS.md §11.\n`;

  return md;
}

/**
 * Saves content to AI_CONTEXT.md in the project root.
 */
export function saveContextFile(content) {
  const contextPath = path.resolve(process.cwd(), 'AI_CONTEXT.md');
  fs.writeFileSync(contextPath, content, 'utf8');
  return contextPath;
}

/**
 * Loads current AI_CONTEXT.md from the root directory, or returns null if not found.
 */
export function loadContextFile() {
  const contextPath = path.resolve(process.cwd(), 'AI_CONTEXT.md');
  if (fs.existsSync(contextPath)) {
    const stats = fs.statSync(contextPath);
    const content = fs.readFileSync(contextPath, 'utf8');
    return {
      content,
      size: stats.size,
      updatedAt: stats.mtime.toISOString(),
      path: contextPath
    };
  }
  return null;
}

/**
 * Uses Gemini AI to optimize, compress, and refine the raw context markdown.
 */
export async function optimizeContextWithAI(rawContext) {
  const ai = getAIClient();
  if (!ai) {
    // Return a mocked optimized version
    const timestamp = new Date().toISOString();
    return rawContext + `\n\n## 6. AI Optimization Note\n\n*Optimized using mock AI on ${timestamp}. In a real run with GEMINI_API_KEY, this context would be compressed into a high-density version to save active token usage.*`;
  }

  const systemPrompt = `You are an LLM context optimization expert. Your task is to analyze the provided project context markdown document and rewrite/compress it to make it highly token-efficient for coding agents (like Claude or Gemini) while preserving all critical details.

Rules:
1. Maintain the overall structure and headers (Metadata, Schema, Dir structure, Git, Guidelines).
2. Do NOT alter, omit, or shorten database table names, database field names, relationship structures, or API routes.
3. Compress prose, instructions, and list items into highly dense, concise phrases. Eliminate filler words and fluff.
4. Keep the output formatted in clean Markdown.
5. Do not wrap the response in outer markdown wrappers like \`\`\`markdown. Return only the raw optimized markdown text starting with the title header.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [systemPrompt, rawContext],
    });

    let text = response.text.trim();

    // Clean up markdown wrapper if model accidentally returned it
    if (text.startsWith('```markdown')) {
      text = text.substring(11, text.length - 3).trim();
    } else if (text.startsWith('```')) {
      text = text.substring(3, text.length - 3).trim();
    }

    return text;
  } catch (error) {
    console.error('Failed to compress context via Gemini:', error);
    throw new Error(`AI Optimization failed: ${error.message}`);
  }
}
