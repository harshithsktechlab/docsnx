import fs from 'fs';
import path from 'path';
import { buildRawContext, saveContextFile, optimizeContextWithAI } from '../src/lib/context-manager.mjs';

// Manually load env for CLI execution. Prefer `.env.local` (what this project
// actually uses), then fall back to `.env`. Earlier files win (not overwritten).
function loadEnv() {
  for (const fileName of ['.env.local', '.env']) {
    try {
      const envPath = path.resolve(process.cwd(), fileName);
      if (!fs.existsSync(envPath)) continue;
      const envContent = fs.readFileSync(envPath, 'utf8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const index = trimmed.indexOf('=');
          if (index > 0) {
            const key = trimmed.substring(0, index).trim();
            let val = trimmed.substring(index + 1).trim();
            // Strip quotes if present
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.substring(1, val.length - 1);
            }
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      }
      console.log(`Loaded environment variables from ${fileName}`);
    } catch (error) {
      console.warn(`Failed to load ${fileName} file:`, error.message);
    }
  }
}

async function run() {
  console.log('================================================');
  console.log('DocsNX AI Context Generator CLI');
  console.log('================================================');
  
  loadEnv();

  const args = process.argv.slice(2);
  const shouldOptimize = args.includes('--optimize') || args.includes('-o');

  try {
    console.log('Scanning workspace (files, db schema, git)...');
    let context = buildRawContext();
    const rawLen = context.length;
    console.log(`Raw context generated. Size: ${rawLen} characters (approx. ${Math.round(rawLen / 4)} tokens)`);

    if (shouldOptimize) {
      console.log('Requesting Gemini AI to optimize/compress context...');
      if (!process.env.GEMINI_API_KEY) {
        console.warn('WARNING: GEMINI_API_KEY is not defined. Optimization will fall back to mock compression.');
      }
      
      const optimized = await optimizeContextWithAI(context);
      context = optimized;
      const optLen = context.length;
      const savings = Math.round(((rawLen - optLen) / rawLen) * 100);
      console.log(`Context optimized via Gemini. Size: ${optLen} characters (approx. ${Math.round(optLen / 4)} tokens)`);
      console.log(`Compression ratio: -${savings}% token savings!`);
    }

    const savedPath = saveContextFile(context);
    console.log(`Success! Context written to: ${savedPath}`);
    console.log('================================================');
  } catch (error) {
    console.error('Failed to generate context:', error);
    process.exit(1);
  }
}

run();
