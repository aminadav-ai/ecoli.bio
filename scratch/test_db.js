import fs from 'fs';

function loadEnv() {
  if (!fs.existsSync('.env')) return;
  const content = fs.readFileSync('.env', 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      const key = trimmed.substring(0, idx).trim();
      let val = trimmed.substring(idx + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.substring(1, val.length - 1);
      }
      process.env[key] = val;
    }
  }
}

async function run() {
  loadEnv();
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('Supabase is not configured in .env');
    return;
  }
  const url = `${supabaseUrl}/rest/v1/`;
  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`
  };
  try {
    const response = await fetch(url, { headers });
    const spec = await response.json();
    console.log('API response:', spec);
  } catch (e) {
    console.error('Fetch error:', e);
  }
}

run();
