import fs from 'fs';
import path from 'path';

// Load env variables
if (fs.existsSync('.env')) {
  const envConfig = fs.readFileSync('.env', 'utf8');
  for (const line of envConfig.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('=');
    const key = parts[0].trim();
    const value = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

async function inspect() {
  if (!supabaseUrl || !supabaseKey) {
    console.error('Supabase credentials missing in .env');
    return;
  }

  const url = `${supabaseUrl}/rest/v1/users?limit=1`;
  const res = await fetch(url, {
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`
    }
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Fetch failed:', res.status, err);
    return;
  }

  const users = await res.json();
  if (users.length === 0) {
    console.log('No users in database to inspect, but query succeeded.');
  } else {
    console.log('Columns in "users" table:');
    console.log(Object.keys(users[0]));
    console.log('Sample user record:', JSON.stringify(users[0], null, 2));
  }
}

inspect().catch(console.error);
