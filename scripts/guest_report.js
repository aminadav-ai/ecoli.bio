#!/usr/bin/env node

import { argv } from 'process';
import { execSync } from 'child_process';

let isLocal = argv.includes('--local');
let showList = argv.includes('--list');

let dateArg = null;
let startDate = null;
let endDate = null;

for (let i = 2; i < argv.length; i++) {
  if (argv[i] === '--date' && argv[i + 1]) {
    dateArg = argv[i + 1];
    i++;
  } else if (argv[i] === '--start' && argv[i + 1]) {
    startDate = argv[i + 1];
    i++;
  } else if (argv[i] === '--end' && argv[i + 1]) {
    endDate = argv[i + 1];
    i++;
  }
}

const dbTarget = isLocal ? '' : '--remote';

function runQuery(sql) {
  try {
    const cmd = `npx wrangler d1 execute ecoli_db ${dbTarget} --json --command "${sql.replace(/"/g, '\\"')}"`;
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

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

console.log('==================================================');
console.log('            GUEST VISITS STATS REPORT             ');
console.log(` Target Database: ${isLocal ? 'Local (SQLite)' : 'Remote (Cloudflare D1)'}`);
console.log('==================================================');

if (dateArg) {
  // Stats for a single date
  const sql = `SELECT '${dateArg}' as visit_date, COUNT(DISTINCT session_id) as unique_guests, SUM(visit_count) as total_visits FROM guest_visits WHERE visit_date = '${dateArg}'`;
  const results = runQuery(sql);
  const data = results[0] || { unique_guests: 0, total_visits: 0 };
  console.log(`Date:          ${dateArg}`);
  console.log(`Unique Guests: ${data.unique_guests || 0}`);
  console.log(`Total Visits:  ${data.total_visits || 0}`);
} else if (startDate && endDate) {
  // Stats for date range
  const sql = `SELECT COUNT(DISTINCT session_id) as unique_guests, SUM(visit_count) as total_visits FROM guest_visits WHERE visit_date BETWEEN '${startDate}' AND '${endDate}'`;
  const results = runQuery(sql);
  const data = results[0] || { unique_guests: 0, total_visits: 0 };
  console.log(`Range:         ${startDate} to ${endDate}`);
  console.log(`Unique Guests: ${data.unique_guests || 0}`);
  console.log(`Total Visits:  ${data.total_visits || 0}`);
} else {
  // List stats
  let sql;
  if (showList) {
    sql = `SELECT visit_date, COUNT(DISTINCT session_id) as unique_guests, SUM(visit_count) as total_visits FROM guest_visits GROUP BY visit_date ORDER BY visit_date DESC`;
    console.log(`All dates overview:`);
  } else {
    // Default last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const dateStr = formatDate(sevenDaysAgo);
    sql = `SELECT visit_date, COUNT(DISTINCT session_id) as unique_guests, SUM(visit_count) as total_visits FROM guest_visits WHERE visit_date >= '${dateStr}' GROUP BY visit_date ORDER BY visit_date DESC`;
    console.log(`Last 7 days overview:`);
  }
  
  const results = runQuery(sql);
  
  console.log('--------------------------------------------------');
  console.log('Date         Unique Guests    Total Visits');
  console.log('--------------------------------------------------');
  if (results.length === 0) {
    console.log('No data found.');
  } else {
    for (const row of results) {
      if (!row.visit_date) continue;
      const dateStr = row.visit_date.padEnd(12);
      const uniqueStr = String(row.unique_guests || 0).padEnd(16);
      const totalStr = String(row.total_visits || 0);
      console.log(`${dateStr} ${uniqueStr} ${totalStr}`);
    }
  }
}
console.log('==================================================');
