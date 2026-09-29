const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/app/components/Shell.js');
let code = fs.readFileSync(filePath, 'utf8');

if (!code.includes("path: '/admin/payments'")) {
  code = code.replace(
    /\{ name: 'SMTP Logs', path: '\/admin\/smtp', icon: Mail \}/,
    `{ name: 'SMTP Logs', path: '/admin/smtp', icon: Mail },\n    { name: 'Payments', path: '/admin/payments', icon: Receipt }`
  );
  
  // Need to import Receipt if not there
  if (!code.includes("Receipt")) {
    code = code.replace(
      /Mail,\n/,
      `Mail,\n  Receipt,\n`
    );
  }
}

fs.writeFileSync(filePath, code);
console.log("Updated Shell.js");
