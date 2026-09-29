const fs = require('fs');
const path = require('path');

function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let originalContent = content;

  // 1. Replace POST targetUserId assignment
  content = content.replace(/(const|let)\s+targetUserId\s*=\s*user\.role\s*===\s*'STANDARD'\s*\?\s*user\.id\s*:\s*\(([^)]+)\);/g, '$1 targetUserId = $2;');

  // 2. Replace GET finalUserId assignment
  content = content.replace(/if\s*\(\s*user\.role\s*===\s*'STANDARD'\s*\)\s*\{\s*finalUserId\s*=\s*user\.id;\s*\}\s*else\s*if\s*\(\s*targetUserId\s*\)\s*\{\s*finalUserId\s*=\s*targetUserId;\s*\}/g, 'if (targetUserId) {\n      finalUserId = targetUserId;\n    }');

  // 3. Replace GET baseConditions push
  content = content.replace(/if\s*\(\s*user\.role\s*===\s*'STANDARD'\s*\)\s*\{\s*(baseConditions|conditions)\.push\(eq\([^,]+,\s*user\.id\)\);\s*\}\s*else\s*if\s*\(\s*targetUserId\s*\)\s*\{\s*\1\.push\(eq\(([^,]+),\s*targetUserId\)\);\s*\}/g, 'if (targetUserId) {\n      $1.push(eq($2, targetUserId));\n    }');

  // 4. Replace GET / PUT / DELETE forbidden blocks
  // Matches blocks like:
  // if (user.role === 'STANDARD' && record.userId !== user.id) {
  //   return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  // }
  // We should be careful about line breaks.
  content = content.replace(/if\s*\(\s*user\.role\s*===\s*'STANDARD'\s*&&\s*[^)]+\)\s*\{\s*return\s+NextResponse\.json\(\{\s*error:\s*'Forbidden'\s*\}\s*,\s*\{\s*status:\s*403\s*\}\);\s*\}/g, '');

  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Modified: ${filePath}`);
  }
}

function walk(dir) {
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      walk(fullPath);
    } else if (file === 'route.ts') {
      processFile(fullPath);
    }
  }
}

walk(path.join(__dirname, 'src', 'app', 'api'));
console.log('Done.');
