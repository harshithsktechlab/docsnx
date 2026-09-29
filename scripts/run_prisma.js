const path = require('path');

// Mock TTY to bypass non-interactive checks in Prisma
process.stdout.isTTY = true;
process.stderr.isTTY = true;
process.stdin.isTTY = true;

// Override process.argv for prisma
process.argv = [
  process.argv[0],
  path.resolve(__dirname, '../node_modules/prisma/build/index.js'),
  'migrate',
  'dev',
  '--name',
  'add_reset_token'
];

// Load and run Prisma CLI
require('../node_modules/prisma/build/index.js');
