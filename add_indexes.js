const fs = require('fs');
let data = fs.readFileSync('src/db/schema.ts', 'utf8');

// Regex to match pgTable block
const regex = /export const (\w+) = pgTable\("([^"]+)", \{([^}]+)\}\);/g;

data = data.replace(regex, (match, varName, tableName, fields) => {
    if (fields.includes('tenantId:') && fields.includes('userId:')) {
        return `export const ${varName} = pgTable("${tableName}", {${fields}}, (table) => {
  return {
    tenantUserIdx: index("${tableName}_tenant_user_idx").on(table.tenantId, table.userId),
  };
});`;
    }
    return match;
});

fs.writeFileSync('src/db/schema.ts', data);
console.log('Done indexing');
