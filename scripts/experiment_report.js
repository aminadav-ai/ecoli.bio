#!/usr/bin/env node

import { argv } from 'process';
import { execSync } from 'child_process';

let isLocal = argv.includes('--local');
let isStaging = argv.includes('--staging');

let dateArg = null;
let startDate = null;
let endDate = null;
let limitArg = 30;

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
  } else if (argv[i] === '--limit' && argv[i + 1]) {
    const val = parseInt(argv[i + 1], 10);
    if (!isNaN(val)) {
      limitArg = val;
    }
    i++;
  }
}

let dbName = 'ecoli_db';
let dbTarget = '--remote';
let envFlag = '';

if (isLocal) {
  dbTarget = '--local';
} else if (isStaging) {
  dbTarget = '--remote -e staging';
  dbName = 'ecoli_db_staging';
}

function runQuery(sql) {
  try {
    // Escape double quotes inside the SQL query for CLI safely
    const escapedSql = sql.replace(/"/g, '\\"').replace(/\n/g, ' ');
    const cmd = `npx wrangler d1 execute ${dbName} ${dbTarget} --json --command "${escapedSql}"`;
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

console.log('========================================================================================================================');
console.log('                                         EXPERIMENT LOGS & SLIDERS REPORT                                                ');
console.log(` Target Database: ${isLocal ? 'Local (SQLite)' : (isStaging ? 'Staging D1 (Remote)' : 'Production D1 (Remote)')}`);
console.log('========================================================================================================================');

// 1. Check if reaction_activity table exists
const checkTableSql = `SELECT name FROM sqlite_master WHERE type='table' AND name='reaction_activity'`;
const tableExists = runQuery(checkTableSql).length > 0;

// 2. Fetch stats
const actionStatsSql = `SELECT action_type, COUNT(*) as count FROM experiment_logs GROUP BY action_type`;
const actionStats = runQuery(actionStatsSql);

const uniqueSessionsSql = `SELECT COUNT(DISTINCT session_id) as count FROM experiment_logs`;
const uniqueSessions = runQuery(uniqueSessionsSql)[0]?.count || 0;

console.log('SUMMARY STATISTICS:');
console.log(`- Total Unique Sessions in Logs: ${uniqueSessions}`);
let totalActions = 0;
for (const row of actionStats) {
  console.log(`- Action [${row.action_type}]:`.padEnd(25) + `${row.count}`);
  totalActions += row.count;
}
console.log(`- Total Logged Actions:         ${totalActions}`);
console.log('------------------------------------------------------------------------------------------------------------------------');

// 3. Top changed sliders
const topSlidersSql = `
  SELECT target, COUNT(*) as count 
  FROM experiment_logs 
  WHERE action_type = 'slider' 
  GROUP BY target 
  ORDER BY count DESC 
  LIMIT 10
`;
const topSliders = runQuery(topSlidersSql);

console.log('TOP 10 MOST ADJUSTED SLIDERS / PARAMETERS:');
if (topSliders.length === 0) {
  console.log('No slider changes logged yet.');
} else {
  for (let i = 0; i < topSliders.length; i++) {
    const row = topSliders[i];
    console.log(`  ${i + 1}. [${row.target}]`.padEnd(45) + `${row.count} times`);
  }
}
console.log('------------------------------------------------------------------------------------------------------------------------');

// 4. Build filter clause for logs
let filterClause = '';
if (dateArg) {
  filterClause = `WHERE DATE(e.created_at) = '${dateArg}'`;
} else if (startDate && endDate) {
  filterClause = `WHERE DATE(e.created_at) BETWEEN '${startDate}' AND '${endDate}'`;
}

// 5. Fetch detailed logs
const logsSql = `
  SELECT 
    e.created_at, 
    e.session_id, 
    s.email, 
    e.action_type, 
    e.target, 
    e.prev_value, 
    e.value, 
    e.growth_rate, 
    e.is_dead
  FROM experiment_logs e
  LEFT JOIN simulation_sessions s ON e.session_id = s.id
  ${filterClause}
  ORDER BY e.id DESC
  LIMIT ${limitArg}
`;

const logs = runQuery(logsSql);

console.log(`RECENT LOG ENTRIES (Limit: ${limitArg}):`);
console.log('------------------------------------------------------------------------------------------------------------------------');
console.log('Time (UTC)          User/Email                     Session ID      Type       Target           Change       Growth  Dead');
console.log('------------------------------------------------------------------------------------------------------------------------');

if (logs.length === 0) {
  console.log('No matching log entries found.');
} else {
  for (const log of logs) {
    const timeStr = log.created_at ? log.created_at.slice(0, 19) : 'N/A';
    
    // Parse user email/guest
    let userStr = log.email || 'unknown';
    if (userStr.startsWith('guest:')) {
      userStr = userStr.replace('guest:', 'Guest (');
      userStr = userStr.slice(0, 26) + (userStr.length > 26 ? '...)' : ')');
    } else if (userStr === 'guest') {
      userStr = 'Guest';
    }
    
    const sessId = log.session_id ? log.session_id.replace('session_', '') : 'N/A';
    const typeStr = log.action_type || 'N/A';
    const targetStr = log.target || 'N/A';
    
    // Format change values
    let changeStr = '-';
    if (log.action_type === 'slider') {
      const pVal = log.prev_value !== null && log.prev_value !== undefined ? log.prev_value.toFixed(2) : '?';
      const nVal = log.value !== null && log.value !== undefined ? log.value.toFixed(2) : '?';
      changeStr = `${pVal}->${nVal}`;
    } else if (log.action_type === 'initial') {
      changeStr = 'Init';
    }
    
    const growthStr = log.growth_rate !== null && log.growth_rate !== undefined ? log.growth_rate.toFixed(4) : 'N/A';
    const deadStr = log.is_dead ? 'YES' : 'no';

    const tPad = timeStr.padEnd(19).slice(0, 19);
    const uPad = userStr.padEnd(30).slice(0, 30);
    const sPad = sessId.padEnd(15).slice(0, 15);
    const tyPad = typeStr.padEnd(10).slice(0, 10);
    const tgPad = targetStr.padEnd(16).slice(0, 16);
    const chPad = changeStr.padEnd(12).slice(0, 12);
    const gPad = growthStr.padEnd(7).slice(0, 7);
    const dPad = deadStr;

    console.log(`${tPad} ${uPad} ${sPad} ${tyPad} ${tgPad} ${chPad} ${gPad} ${dPad}`);
  }
}
console.log('------------------------------------------------------------------------------------------------------------------------');

// 6. Reaction activity (if table exists)
if (tableExists) {
  const reactActivitySql = `
    SELECT reaction, vmax_count, km_count, (vmax_count + km_count) as total_count 
    FROM reaction_activity 
    WHERE total_count > 0
    ORDER BY total_count DESC 
    LIMIT 15
  `;
  const reactActivity = runQuery(reactActivitySql);
  
  console.log('REACTION ACTIVITY SUMMARY (Enzyme Parameter Changes):');
  if (reactActivity.length === 0) {
    console.log('No reaction parameter changes (Vmax / Km) recorded in reaction_activity.');
  } else {
    console.log('  Reaction Name             Vmax Changes   Km Changes     Total Changes');
    console.log('  ---------------------------------------------------------------------');
    for (const row of reactActivity) {
      const namePad = (row.reaction || '').padEnd(25).slice(0, 25);
      const vmaxPad = String(row.vmax_count || 0).padEnd(14);
      const kmPad = String(row.km_count || 0).padEnd(14);
      const totalPad = String(row.total_count || 0);
      console.log(`  ${namePad} ${vmaxPad} ${kmPad} ${totalPad}`);
    }
  }
  console.log('========================================================================================================================');
}
