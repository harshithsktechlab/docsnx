const fs = require('fs');
const path = require('path');

function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let originalContent = content;

  // 1. For dashboard
  // Remove the block:
  // if (user.role === 'STANDARD') { ... docsWhere = and(docsWhere, ...) ... }
  content = content.replace(/if\s*\(\s*user\.role\s*===\s*'STANDARD'\s*\)\s*\{[\s\S]*?(?=\}\s*const\s*\[)/, '');

  // 2. For rentals, warranty, todos:
  // if (user.role === 'STANDARD') {
  //   conditions.push(or(eq(warrantyAmcs.isGlobal, true), eq(warrantyAmcs.holderId, user.id))!);
  //   if (targetUserId) {
  //     conditions.push(eq(warrantyAmcs.holderId, targetUserId));
  //   }
  // } else {
  //   // TENANT_ADMIN
  //   if (targetUserId) {
  //     conditions.push(eq(warrantyAmcs.holderId, targetUserId));
  //   }
  // }
  // Replace with:
  // if (targetUserId) {
  //   conditions.push(eq(warrantyAmcs.holderId, targetUserId));
  // }
  // OR for todos:
  // if (targetUserId) {
  //   conditions.push(or(eq(todos.assigneeId, targetUserId), eq(todos.creatorId, targetUserId))!);
  // }
  content = content.replace(/if\s*\(\s*user\.role\s*===\s*'STANDARD'\s*\)\s*\{[\s\S]*?\}\s*else\s*\{\s*\/\/\s*TENANT_ADMIN\s*(if\s*\(\s*targetUserId\s*\)\s*\{[\s\S]*?\}\s*)\}/g, '$1');

  // 3. For follow-up:
  // if (user.role === 'STANDARD') {
  //   todoCondition = and(
  //     eq(todos.tenantId, tenantId),
  //     eq(todos.status, 'PENDING'),
  //     or(eq(todos.assigneeId, user.id), isNull(todos.assigneeId))
  //   ) as any;
  // }
  content = content.replace(/if\s*\(\s*user\.role\s*===\s*'STANDARD'\s*\)\s*\{[\s\S]*?as\s+any;\s*\}/g, '');

  // 4. For follow-up/count:
  // if (user.role === 'STANDARD') {
  //   tasksWhere = and(tasksWhere, eq(todos.assigneeId, user.id));
  // }
  content = content.replace(/if\s*\(\s*user\.role\s*===\s*'STANDARD'\s*\)\s*\{\s*tasksWhere\s*=\s*and\(tasksWhere,\s*eq\(todos\.assigneeId,\s*user\.id\)\);\s*\}/g, '');

  // 5. For bank-info whereConditions:
  // if (user.role === 'STANDARD') {
  //   whereConditions.push(eq(bankInfos.userId, user.id));
  // } else if (targetUserId) {
  //   whereConditions.push(eq(bankInfos.userId, targetUserId));
  // }
  content = content.replace(/if\s*\(\s*user\.role\s*===\s*'STANDARD'\s*\)\s*\{\s*whereConditions\.push\(eq\([^,]+,\s*user\.id\)\);\s*\}\s*else\s*if\s*\(\s*targetUserId\s*\)\s*\{\s*whereConditions\.push\(eq\(([^,]+),\s*targetUserId\)\);\s*\}/g, 'if (targetUserId) {\n      whereConditions.push(eq($1, targetUserId));\n    }');

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
console.log('Done fix3.');
