#!/usr/bin/env node

import { argv } from 'process';
import { readFileSync } from 'fs';

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

const targetDesc = isLocal ? 'Local (Development)' : (isStaging ? 'Staging Server' : 'Production Server');

console.log('================================================================================');
console.log('                            ADD CREDITS TO USER ACCOUNT                         ');
console.log('================================================================================');
console.log(` Target Environment: ${targetDesc}`);
console.log(` User Email:        ${email}`);
console.log(` Amount:             ${amount >= 0 ? '+' : ''}${amount} credits`);
console.log('--------------------------------------------------------------------------------');

// Extract ADMIN_SECRET from wrangler.toml
let adminSecret = process.env.ADMIN_SECRET;
if (!adminSecret) {
  try {
    const configContent = readFileSync('wrangler.toml', 'utf-8');
    const match = configContent.match(/ADMIN_SECRET\s*=\s*"([^"]+)"/);
    if (match) {
      adminSecret = match[1];
    }
  } catch (err) {
    // Ignore error
  }
}
if (!adminSecret) {
  adminSecret = 'admin_secret_dev';
}

const baseUrl = isLocal 
  ? 'http://127.0.0.1:8787' 
  : (isStaging ? 'https://sim3.ecoli.bio' : 'https://ecoli.bio');

async function run() {
  const url = `${baseUrl}/api/admin/add-credits`;
  try {
    console.log(`Sending API request to ${url}...`);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminSecret}`
      },
      body: JSON.stringify({ email, amount })
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`Invalid JSON response: ${text}`);
    }

    if (!res.ok) {
      throw new Error(data.error || `HTTP error ${res.status}`);
    }

    console.log('--------------------------------------------------------------------------------');
    const formattedCredits = parseFloat(data.credits).toFixed(2);
    console.log(`Success: Successfully adjusted credits for user ${data.email}.`);
    console.log(`User Name:   ${data.name || 'N/A'}`);
    console.log(`New Balance: ${formattedCredits} credits`);
    console.log('================================================================================');
  } catch (err) {
    console.error('--------------------------------------------------------------------------------');
    console.error('Error: Failed to adjust credits.');
    console.error(err.message);
    console.error('================================================================================');
    process.exit(1);
  }
}

run();
