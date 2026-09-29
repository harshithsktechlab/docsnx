const fs = require('fs');
let data = fs.readFileSync('src/db/schema.ts', 'utf8');
data = data.replace(/timestamp\(\"([^\"]+)\"\)/g, 'timestamp("$1", { withTimezone: true })');
fs.writeFileSync('src/db/schema.ts', data);
console.log('Done');
