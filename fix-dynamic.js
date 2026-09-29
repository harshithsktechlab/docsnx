const fs = require('fs');
const glob = require('glob'); // Not available? No, wait, I can just use a simple recursive read.
const path = require('path');

const files = [
  'src/app/api/admin/ai-keys/route.ts',
  'src/app/api/admin/ai-keys/[id]/route.ts',
  'src/app/api/admin/plans/route.ts',
  'src/app/api/admin/smtp/route.ts',
  'src/app/api/admin/tenants/route.ts',
  'src/app/admin/layout.tsx',
];

for (const file of files) {
  const fullPath = path.join(process.cwd(), file);
  if (fs.existsSync(fullPath)) {
    let content = fs.readFileSync(fullPath, 'utf8');
    if (!content.includes('export const dynamic')) {
      // Find the first line after imports
      const lines = content.split('\n');
      let insertIndex = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim().startsWith('import') && lines[i].trim() !== '') {
          insertIndex = i;
          break;
        }
      }
      lines.splice(insertIndex, 0, `\nexport const dynamic = 'force-dynamic';\n`);
      fs.writeFileSync(fullPath, lines.join('\n'));
      console.log('Fixed', file);
    }
  } else {
    console.log('Not found:', fullPath);
  }
}
