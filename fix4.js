const fs = require('fs');
const path = require('path');

function replaceExact(filePath, searchStr, replaceStr) {
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace(/\r\n/g, '\n');
  if (content.includes(searchStr)) {
    content = content.replace(searchStr, replaceStr);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Modified: ${filePath}`);
  } else {
    // console.log(`Not found in ${filePath}`);
  }
}

// dashboard
const dashboardOld = `    if (user.role === 'STANDARD') {
      docsWhere = and(docsWhere, eq(documents.userId, user.id))!;
      medWhere = and(medWhere, eq(medicalRecords.userId, user.id))!;
      passWhere = and(passWhere, eq(passwords.userId, user.id))!;
      vehWhere = and(vehWhere, eq(vehicles.userId, user.id))!;
      invWhere = and(invWhere, eq(investments.userId, user.id))!;
      licWhere = and(licWhere, eq(licMediclaims.userId, user.id))!;
    }`;
replaceExact(path.join(__dirname, 'src/app/api/dashboard/route.ts'), dashboardOld, '');

// lic-mediclaim
const licOld = `    if (user.role === 'STANDARD') {
      whereConditions.push(eq(licMediclaims.userId, user.id));
    } else if (targetUserId) {
      whereConditions.push(eq(licMediclaims.userId, targetUserId));
    }`;
const licNew = `    if (targetUserId) {
      whereConditions.push(eq(licMediclaims.userId, targetUserId));
    }`;
replaceExact(path.join(__dirname, 'src/app/api/lic-mediclaim/route.ts'), licOld, licNew);

// investments
const invOld = `    if (user.role === 'STANDARD') {
      whereConditions.push(eq(investments.userId, user.id));
    } else if (targetUserId) {
      whereConditions.push(eq(investments.userId, targetUserId));
    }`;
const invNew = `    if (targetUserId) {
      whereConditions.push(eq(investments.userId, targetUserId));
    }`;
replaceExact(path.join(__dirname, 'src/app/api/investments/route.ts'), invOld, invNew);

// follow-up/count
const followupCountOld = `    if (user.role === 'STANDARD') {
      todoCondition = and(
        eq(todos.tenantId, tenantId),
        eq(todos.status, 'PENDING'),
        or(eq(todos.assigneeId, user.id), isNull(todos.assigneeId))
      ) as any;
    }`;
replaceExact(path.join(__dirname, 'src/app/api/follow-up/count/route.ts'), followupCountOld, '');

// targetUserId ternary replacements for bank-info, investments, credit-cards
const targetUserIdRegex = /const\s+targetUserId\s*=\s*user\.role\s*===\s*'STANDARD'\s*\?\s*user\.id\s*:\s*\(?userId\s*\|\|\s*user\.id\)?;?/g;
const targetUserIdReplacement = 'const targetUserId = userId || user.id;';

function replaceRegex(filePath, regex, replacement) {
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace(/\r\n/g, '\n');
  if (regex.test(content)) {
    content = content.replace(regex, replacement);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Modified Regex: ${filePath}`);
  }
}

replaceRegex(path.join(__dirname, 'src/app/api/bank-info/route.ts'), targetUserIdRegex, targetUserIdReplacement);
replaceRegex(path.join(__dirname, 'src/app/api/investments/route.ts'), targetUserIdRegex, targetUserIdReplacement);
replaceRegex(path.join(__dirname, 'src/app/api/credit-cards/route.ts'), targetUserIdRegex, targetUserIdReplacement);

console.log('Done fix4b.');
