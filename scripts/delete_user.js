#!/usr/bin/env node

import { argv } from 'process';
import { execSync } from 'child_process';

const args = argv.slice(2);
const isLocal = args.includes('--local');
const isStaging = args.includes('--staging');

const flags = args.filter(arg => arg.startsWith('--'));
const emails = args.filter(arg => !arg.startsWith('--'));

if (emails.length === 0) {
  console.log('================================================================================');
  console.log('                            DELETE USER FROM D1 DATABASE                        ');
  console.log('================================================================================');
  console.log('Usage:');
  console.log('  node scripts/delete_user.js <email> [--local | --staging]');
  console.log('');
  console.log('Options:');
  console.log('  --local      Target local SQLite D1 database');
  console.log('  --staging    Target staging D1 database (ecoli_db_staging)');
  console.log('  (default)    Target production D1 database (ecoli_db)');
  console.log('================================================================================');
  process.exit(1);
}

const email = emails[0].trim().toLowerCase();
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

if (!emailRegex.test(email)) {
  console.error(`Error: "${email}" is not a valid email address.`);
  process.exit(1);
}

const dbTarget = isLocal ? '' : '--remote';
const dbName = isStaging ? 'ecoli_db_staging' : 'ecoli_db';
const envFlag = isStaging ? '--env staging' : '';
const targetDesc = isLocal ? 'Local (SQLite)' : (isStaging ? 'Staging D1 (Remote)' : 'Production D1 (Remote)');

console.log('================================================================================');
console.log('                            DELETE USER FROM D1 DATABASE                        ');
console.log('================================================================================');
console.log(` Target Database: ${targetDesc}`);
console.log(` Target User:     ${email}`);
console.log('--------------------------------------------------------------------------------');

// Construct SQL query to delete user and clean up all associated data
const sql = `
  DELETE FROM users WHERE email = '${email}';
  DELETE FROM chat_limits WHERE identifier = 'user:${email}';
  DELETE FROM chat_history WHERE identifier = 'user:${email}' OR identifier LIKE 'user:${email}:%';
`;

try {
  console.log('Executing database deletion command...');
  const cmd = `npx wrangler d1 execute ${dbName} ${dbTarget} ${envFlag} --json --command "${sql.replace(/"/g, '\\"')}"`;
  
  const output = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
  const parsed = JSON.parse(output);
  
  console.log('--------------------------------------------------------------------------------');
  console.log(`Success: User ${email} and all associated data have been successfully deleted.`);
  console.log('================================================================================');
} catch (err) {
  console.error('--------------------------------------------------------------------------------');
  console.error('Error: Failed to execute deletion query on database.');
  console.error(err.message);
  console.error('================================================================================');
  process.exit(1);
}
