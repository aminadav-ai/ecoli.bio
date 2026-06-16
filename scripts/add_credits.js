#!/usr/bin/env node

import { argv } from 'process';
import { execSync } from 'child_process';

const args = argv.slice(2);
const isLocal = args.includes('--local');
const isStaging = args.includes('--staging');

const flags = args.filter(arg => arg.startsWith('--'));
const nonFlags = args.filter(arg => !arg.startsWith('--'));

if (nonFlags.length < 2) {
  console.log('================================================================================');
  console.log('                            ADD CREDITS TO USER ACCOUNT                         ');
  console.log('================================================================================');
  console.log('Usage:');
  console.log('  node scripts/add_credits.js <email> <amount> [--local | --staging]');
  console.log('');
  console.log('Options:');
  console.log('  --local      Target local SQLite D1 database');
  console.log('  --staging    Target staging D1 database (ecoli_db_staging)');
  console.log('  (default)    Target production D1 database (ecoli_db)');
  console.log('================================================================================');
  process.exit(1);
}

const email = nonFlags[0].trim().toLowerCase();
const amountStr = nonFlags[1].trim();
const amount = parseFloat(amountStr);

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!emailRegex.test(email)) {
  console.error(`Error: "${email}" is not a valid email address.`);
  process.exit(1);
}

if (isNaN(amount)) {
  console.error(`Error: "${amountStr}" is not a valid number.`);
  process.exit(1);
}

const dbTarget = isLocal ? '' : '--remote';
const dbName = isStaging ? 'ecoli_db_staging' : 'ecoli_db';
const envFlag = isStaging ? '--env staging' : '';
const targetDesc = isLocal ? 'Local (SQLite)' : (isStaging ? 'Staging D1 (Remote)' : 'Production D1 (Remote)');

console.log('================================================================================');
console.log('                            ADD CREDITS TO USER ACCOUNT                         ');
console.log('================================================================================');
console.log(` Target Database: ${targetDesc}`);
console.log(` User Email:     ${email}`);
console.log(` Amount:          ${amount >= 0 ? '+' : ''}${amount} credits`);
console.log('--------------------------------------------------------------------------------');

// SQL queries: update the credits and select user profile to check new balance
const sql = `
  UPDATE users SET credits = COALESCE(credits, 0.0) + ${amount} WHERE email = '${email}';
  SELECT email, name, credits FROM users WHERE email = '${email}';
`;

try {
  console.log('Executing database update command...');
  const cmd = `npx wrangler d1 execute ${dbName} ${dbTarget} ${envFlag} --json --command "${sql.replace(/"/g, '\\"')}"`;
  
  const output = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
  const parsed = JSON.parse(output);
  
  let userRecord = null;
  if (Array.isArray(parsed)) {
    // Look for results in the array of responses (from the second statement)
    const selectResponse = parsed.find(r => r.results && r.results.length > 0);
    if (selectResponse) {
      userRecord = selectResponse.results[0];
    }
  } else if (parsed && parsed.results && parsed.results.length > 0) {
    userRecord = parsed.results[0];
  }
  
  console.log('--------------------------------------------------------------------------------');
  if (userRecord) {
    const formattedCredits = parseFloat(userRecord.credits).toFixed(2);
    console.log(`Success: Successfully adjusted credits for user ${email}.`);
    console.log(`User Name:   ${userRecord.name || 'N/A'}`);
    console.log(`New Balance: ${formattedCredits} credits`);
  } else {
    console.warn(`Warning: User "${email}" was not found in the database. No changes were made.`);
  }
  console.log('================================================================================');
} catch (err) {
  console.error('--------------------------------------------------------------------------------');
  console.error('Error: Failed to execute database update command.');
  console.error(err.message);
  console.error('================================================================================');
  process.exit(1);
}
