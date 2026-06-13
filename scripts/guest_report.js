#!/usr/bin/env node

import { argv } from 'process';
import { execSync } from 'child_process';

let isLocal = argv.includes('--local');
let isStaging = argv.includes('--staging');
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

let dbName = 'ecoli_db';
let dbTarget = '--remote';

if (isLocal) {
  dbTarget = '--local';
} else if (isStaging) {
  dbTarget = '--remote --env staging';
  dbName = 'ecoli_db_staging';
}

function runQuery(sql) {
  try {
    const cmd = `npx wrangler d1 execute ${dbName} ${dbTarget} --json --command "${sql.replace(/"/g, '\\"')}"`;
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

function parseUserAgent(ua) {
  if (!ua) return 'Unknown OS / Browser';
  
  let os = 'Unknown OS';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Macintosh') || ua.includes('Mac OS')) os = 'macOS';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  else if (ua.includes('Linux')) os = 'Linux';
  
  let browser = 'Unknown Browser';
  if (ua.includes('Firefox/')) browser = 'Firefox';
  else if (ua.includes('Chrome/') && ua.includes('Safari/')) {
    if (ua.includes('Edg/')) browser = 'Edge';
    else if (ua.includes('OPR/') || ua.includes('Opera')) browser = 'Opera';
    else browser = 'Chrome';
  }
  else if (ua.includes('Safari/') && !ua.includes('Chrome/')) browser = 'Safari';
  else if (ua.includes('MSIE') || ua.includes('Trident/')) browser = 'IE';
  
  return `${os} / ${browser}`;
}

function printDetailedSessions(sessions, title) {
  console.log(`\n${title}`);
  console.log('------------------------------------------------------------------------------------------------------------------------');
  console.log('First Visit (UTC)   IP Address      Location               ISP/Organization          Device               Visits');
  console.log('------------------------------------------------------------------------------------------------------------------------');
  if (sessions.length === 0) {
    console.log('No detailed guest session data available.');
  } else {
    for (const row of sessions) {
      const timeStr = row.first_visit_time 
        ? row.first_visit_time.replace('T', ' ').slice(0, 19)
        : 'N/A';
      
      const ipStr = (row.ip || 'N/A');
      
      const locParts = [];
      if (row.city && row.city !== 'unknown') locParts.push(row.city);
      if (row.country && row.country !== 'unknown') locParts.push(row.country);
      const locStr = locParts.join(', ') || 'N/A';
      
      const asnStr = (row.asn_org || 'N/A');
      const deviceStr = parseUserAgent(row.user_agent);
      const visitsStr = String(row.visit_count || 0);
      
      const timePad = timeStr.padEnd(19).slice(0, 19);
      const ipPad = ipStr.padEnd(15).slice(0, 15);
      const locPad = locStr.padEnd(22).slice(0, 22);
      const asnPad = asnStr.padEnd(25).slice(0, 25);
      const devicePad = deviceStr.padEnd(20).slice(0, 20);
      const visitsPad = visitsStr.padStart(6).slice(0, 6);
      
      console.log(`${timePad} ${ipPad} ${locPad} ${asnPad} ${devicePad} ${visitsPad}`);
    }
  }
  console.log('------------------------------------------------------------------------------------------------------------------------');
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
  
  // Detailed
  const detailSql = `SELECT session_id, visit_date, visit_count, ip, user_agent, country, city, asn_org, first_visit_time FROM guest_visits WHERE visit_date = '${dateArg}' ORDER BY first_visit_time DESC`;
  const detailedResults = runQuery(detailSql);
  printDetailedSessions(detailedResults, `Detailed guest sessions for ${dateArg}:`);
} else if (startDate && endDate) {
  // Stats for date range
  const sql = `SELECT COUNT(DISTINCT session_id) as unique_guests, SUM(visit_count) as total_visits FROM guest_visits WHERE visit_date BETWEEN '${startDate}' AND '${endDate}'`;
  const results = runQuery(sql);
  const data = results[0] || { unique_guests: 0, total_visits: 0 };
  console.log(`Range:         ${startDate} to ${endDate}`);
  console.log(`Unique Guests: ${data.unique_guests || 0}`);
  console.log(`Total Visits:  ${data.total_visits || 0}`);
  
  // Detailed
  const detailSql = `SELECT session_id, visit_date, visit_count, ip, user_agent, country, city, asn_org, first_visit_time FROM guest_visits WHERE visit_date BETWEEN '${startDate}' AND '${endDate}' ORDER BY first_visit_time DESC`;
  const detailedResults = runQuery(detailSql);
  printDetailedSessions(detailedResults, `Detailed guest sessions between ${startDate} and ${endDate}:`);
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
  
  // Detailed (last 20)
  const detailSql = `SELECT session_id, visit_date, visit_count, ip, user_agent, country, city, asn_org, first_visit_time FROM guest_visits ORDER BY first_visit_time DESC LIMIT 20`;
  const detailedResults = runQuery(detailSql);
  printDetailedSessions(detailedResults, `20 Most Recent Guest Sessions overall:`);
}
console.log('==================================================');
