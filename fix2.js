const fs = require('fs');
const path = require('path');

function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let originalContent = content;

  // Replace standalone if (user.role === 'STANDARD') pushes:
  // e.g. 
  // if (user.role === 'STANDARD') {
  //   baseConditions.push(eq(corporateCompliances.userId, user.id));
  // }
  content = content.replace(/if\s*\(\s*user\.role\s*===\s*'STANDARD'\s*\)\s*\{\s*(baseConditions|conditions)\.push\(eq\([^,]+,\s*user\.id\)\);\s*\}/g, '');

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
console.log('Done fix2.');
