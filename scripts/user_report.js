#!/usr/bin/env node

import { argv } from 'process';
import { execSync } from 'child_process';
import { MAX_USERS_LIMIT } from '../src/d1_db.js';

let isLocal = argv.includes('--local');
let isStaging = argv.includes('--staging');

const dbTarget = isLocal ? '' : '--remote';
const dbName = isStaging ? 'ecoli_db_staging' : 'ecoli_db';
const envFlag = isStaging ? '--env staging' : '';

function runQuery(sql) {
  try {
    const cmd = `npx wrangler d1 execute ${dbName} ${dbTarget} ${envFlag} --json --command "${sql.replace(/"/g, '\\"')}"`;
    const output = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    const parsed = JSON.parse(output);
    // Support different wrangler JSON output structures
    if (Array.isArray(parsed)) {
      if (parsed[0] && parsed[0].results) {
        return parsed[0].results;
      }
      return parsed;
    }
    if (parsed && parsed.results) {
      return parsed.results;
    }
    return [];
  } catch (err) {
    console.error(`Error executing database query:`, err.message);
    process.exit(1);
  }
}

console.log('========================================================================================================');
console.log('                                       USER ACCOUNT REPORT                                              ');
console.log(` Target Database: ${isLocal ? 'Local (SQLite)' : (isStaging ? 'Staging D1 (Remote)' : 'Production D1 (Remote)')}`);
console.log('========================================================================================================');

// Fetch user data
const sql = `
  SELECT 
    email, 
    name, 
    created_at, 
    premium_tier, 
    visits, 
    questions, 
    solver_ticks, 
    credits, 
    last_visit 
  FROM users 
  ORDER BY created_at DESC
`;

const users = runQuery(sql);

console.log('--------------------------------------------------------------------------------------------------------');
console.log('Email                           Name                 Created      Tier    Visits  Questions   Credits     Ticks');
console.log('--------------------------------------------------------------------------------------------------------');

let totalUsers = 0;
let premiumBasicCount = 0;
let premiumProCount = 0;
let totalVisits = 0;
let totalQuestions = 0;
let totalTicks = 0;
let totalCredits = 0.0;

if (users.length === 0) {
  console.log('No registered users found.');
} else {
  for (const user of users) {
    totalUsers++;
    
    // Formatting values
    const email = (user.email || '').padEnd(30).substring(0, 30);
    const name = (user.name || 'N/A').padEnd(20).substring(0, 20);
    
    // Format creation date (YYYY-MM-DD)
    let created = 'N/A';
    if (user.created_at) {
      created = user.created_at.split(' ')[0] || user.created_at;
    }
    created = created.padEnd(12);

    // Format Premium Tier
    let tier = 'Free';
    if (user.premium_tier === 1) {
      tier = 'Basic';
      premiumBasicCount++;
    } else if (user.premium_tier === 2) {
      tier = 'Pro';
      premiumProCount++;
    }
    tier = tier.padEnd(7);

    const visits = String(user.visits || 0).padEnd(7);
    const questions = String(user.questions || 0).padEnd(11);
    const userCreditsVal = user.credits !== null && user.credits !== undefined ? parseFloat(user.credits) : 250.0;
    const credits = userCreditsVal.toFixed(2).padEnd(11);
    const ticks = String(user.solver_ticks || 0);

    totalVisits += (user.visits || 0);
    totalQuestions += (user.questions || 0);
    totalTicks += (user.solver_ticks || 0);
    totalCredits += userCreditsVal;

    console.log(`${email} ${name} ${created} ${tier} ${visits} ${questions} ${credits} ${ticks}`);
  }
}

console.log('--------------------------------------------------------------------------------------------------------');
console.log(`SUMMARY STATISTICS:`);
console.log(`- Total Registered Users:  ${totalUsers} (Limit: ${MAX_USERS_LIMIT})`);
console.log(`- Premium Basic Users:     ${premiumBasicCount}`);
console.log(`- Premium Pro Users:       ${premiumProCount}`);
console.log(`- Total Visits:            ${totalVisits}`);
console.log(`- Total Questions Asked:   ${totalQuestions}`);
console.log(`- Total Solver Ticks:      ${totalTicks}`);
console.log(`- Total User Credits:      ${totalCredits.toFixed(2)} (Avg: ${(totalUsers > 0 ? totalCredits / totalUsers : 0.0).toFixed(2)})`);
console.log('========================================================================================================');

