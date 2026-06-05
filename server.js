import express from 'express';
import fs from 'fs';
import path from 'path';
import highsLoader from 'highs';

// Load env variables from .env file locally if it exists
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

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// --- Visitor Tracking & Notification System ---
const activeSessions = new Map(); // key: ip + ua, value: timestamp
const recentVisits = []; // list of timestamps of visits in the last 10 minutes
const queuedVisits = []; // visits collected for the next stats update
let statsInterval = null;
let isStatsMode = false;

const STATS_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes session cooldown
const STATS_TRIGGER_THRESHOLD = 3; // switch to stats mode if > 3 visits in 10 mins

// Helper to parse User Agent into readable OS & Browser
function parseUserAgent(ua = '') {
  let os = 'Unknown OS';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  else if (ua.includes('Macintosh')) os = 'macOS';
  else if (ua.includes('Linux')) os = 'Linux';

  let browser = 'Unknown Browser';
  if (ua.includes('Chrome')) browser = 'Chrome';
  else if (ua.includes('Safari')) browser = 'Safari';
  else if (ua.includes('Firefox')) browser = 'Firefox';
  else if (ua.includes('Edge')) browser = 'Edge';

  return `${os} (${browser})`;
}

// Send Telegram Message Helper
async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log(`[Notification (Console-only)]: ${text.replace(/<[^>]*>/g, '')}`);
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML'
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Server] Telegram API error: ${res.status} - ${errText}`);
    }
  } catch (err) {
    console.error('[Server] Failed to send Telegram message:', err);
  }
}

// Log visit to visits.log
function logVisitToFile(visit) {
  const dateStr = new Date(visit.timestamp).toISOString();
  const line = `${dateStr} - IP: ${visit.ip} - Device: ${visit.device} - Referer: ${visit.referer}\n`;
  fs.appendFile(path.resolve('visits.log'), line, (err) => {
    if (err) {
      console.error('[Server] Failed to write to visits.log:', err);
    }
  });
}

// Periodic cleanup of active sessions older than 24 hours to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of activeSessions.entries()) {
    if (now - timestamp > 24 * 60 * 60 * 1000) {
      activeSessions.delete(key);
    }
  }
}, 60 * 60 * 1000);

// Function to send accumulated statistics
async function sendStatsSummary() {
  if (queuedVisits.length === 0) {
    const now = Date.now();
    const countInWindow = recentVisits.filter(t => now - t < STATS_WINDOW_MS).length;
    if (countInWindow <= STATS_TRIGGER_THRESHOLD) {
      isStatsMode = false;
      if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = null;
      }
      console.log('[Server] Active visits rate decreased. Switching back to individual notifications.');
    }
    return;
  }

  const totalVisits = queuedVisits.length;
  const uniqueIPs = new Set(queuedVisits.map(v => v.ip)).size;

  // Aggregate devices
  const devices = {};
  for (const v of queuedVisits) {
    devices[v.device] = (devices[v.device] || 0) + 1;
  }
  const deviceList = Object.entries(devices)
    .map(([d, count]) => `• <code>${d}</code>: <b>${count}</b>`)
    .join('\n');

  const text = `📊 <b>Сводная статистика посещений (за 10 мин)</b>\n\n` +
               `Всего новых визитов: <b>${totalVisits}</b>\n` +
               `Уникальных адресов (IP): <b>${uniqueIPs}</b>\n\n` +
               `<b>Устройства:</b>\n${deviceList}`;

  await sendTelegramMessage(text);
  
  // Clear queue
  queuedVisits.length = 0;

  // Check if we should switch back to individual notifications
  const now = Date.now();
  const countInWindow = recentVisits.filter(t => now - t < STATS_WINDOW_MS).length;
  if (countInWindow <= STATS_TRIGGER_THRESHOLD) {
    isStatsMode = false;
    if (statsInterval) {
      clearInterval(statsInterval);
      statsInterval = null;
    }
    await sendTelegramMessage(`ℹ️ <b>Режим статистики отключен.</b> Активность снизилась, возвращаюсь к поштучным оповещениям.`);
  }
}

// Track a new visit
async function trackVisit(req) {
  const now = Date.now();
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown';
  if (ip && ip.includes(',')) {
    ip = ip.split(',')[0].trim();
  }

  const ua = req.headers['user-agent'] || '';
  const referer = req.headers['referer'] || 'Direct/Unknown';
  const sessionKey = `${ip}::${ua}`;

  // Check cooldown to de-duplicate visits from the same browser session
  const lastSeen = activeSessions.get(sessionKey);
  if (lastSeen && (now - lastSeen < COOLDOWN_MS)) {
    activeSessions.set(sessionKey, now);
    return;
  }

  // Register new session
  activeSessions.set(sessionKey, now);

  const device = parseUserAgent(ua);
  const visit = {
    timestamp: now,
    ip,
    device,
    referer
  };

  // Log to local file and server console
  logVisitToFile(visit);
  console.log(`[Visit] New connection from ${ip} (${device}), Referer: ${referer}`);

  // Maintain recent visits within 10-minute window
  recentVisits.push(now);
  while (recentVisits.length > 0 && (now - recentVisits[0] > STATS_WINDOW_MS)) {
    recentVisits.shift();
  }

  if (isStatsMode) {
    queuedVisits.push(visit);
  } else {
    if (recentVisits.length > STATS_TRIGGER_THRESHOLD) {
      isStatsMode = true;
      queuedVisits.push(visit);
      
      await sendTelegramMessage(
        `⚠️ <b>Высокая активность посещений!</b>\n` +
        `Число новых визитов за 10 минут превысило лимит (${STATS_TRIGGER_THRESHOLD}).\n` +
        `Переключаюсь в режим накопления статистики. Буду присылать сводные отчеты каждые 10 минут.`
      );

      if (!statsInterval) {
        statsInterval = setInterval(sendStatsSummary, STATS_WINDOW_MS);
      }
    } else {
      const text = `🔔 <b>Новый посетитель на сайте!</b>\n\n` +
                   `IP: <code>${ip}</code>\n` +
                   `Устройство: <code>${device}</code>\n` +
                   `Реферер: <code>${referer}</code>`;
      await sendTelegramMessage(text);
    }
  }
}

// Load static bounds and LP header once on startup
const staticBoundsPath = path.resolve('src/static_bounds.json');
let staticBounds = {};
if (fs.existsSync(staticBoundsPath)) {
  staticBounds = JSON.parse(fs.readFileSync(staticBoundsPath, 'utf8'));
} else {
  console.warn(`[Server] Warning: static_bounds.json not found at ${staticBoundsPath}`);
}

const lpHeaderPath = path.resolve('public/static_lp_header.txt');
let staticLpHeader = '';
if (fs.existsSync(lpHeaderPath)) {
  staticLpHeader = fs.readFileSync(lpHeaderPath, 'utf8');
} else {
  console.warn(`[Server] Warning: static_lp_header.txt not found at ${lpHeaderPath}`);
}

// Initialize HiGHS solver
let highs = null;
highsLoader().then(h => {
  highs = h;
  console.log('[Server] HiGHS solver loaded successfully.');
}).catch(err => {
  console.error('[Server] Failed to load HiGHS solver:', err);
});

function calculateBounds(concentrations, parameters) {
  const bounds = {};
  
  // Define default blocked bypasses
  const defaultBlocked = ['PFK_3', 'FBA3', 'F6PA', 'GLCDpp', 'XYLI2', 'GLCabcpp'];
  
  // Define coupled checkpoints
  const coupledCheckpoints = new Set(['GLCptspp', 'PFK', 'PYK', 'CS', 'ICDHyr', 'SUCDi']);
  
  // Stoichiometry needed for kinetic bounds calculation
  const reactionSubstrates = {
    'GLCptspp': ['pep_c'], // glc__D_p is buffered, only pep_c is checked
    'PFK': ['f6p_c'], // atp_c is buffered
    'PYK': ['pep_c'], // adp_c, h_c are buffered
    'CS': ['accoa_c', 'oaa_c'], // h2o_c is buffered
    'ICDHyr': ['icit_c'], // nadp_c is buffered
    'SUCDi': ['succ_c'] // q8_c is buffered
  };
  const reactionProducts = {
    'GLCptspp': [], // no reversible check
    'PFK': ['fdp_c'],
    'PYK': ['pyr_c'],
    'CS': ['cit_c'],
    'ICDHyr': ['akg_c'],
    'SUCDi': ['fum_c']
  };

  for (const rxnId of Object.keys(staticBounds)) {
    const orig = staticBounds[rxnId];

    // Apply default blocked bypasses
    if (defaultBlocked.includes(rxnId)) {
      bounds[rxnId] = { lowerBound: 0.0, upperBound: 0.0 };
      continue;
    }

    // Default Vmax and Km parameters (client simulation defaults)
    let defaultVmax = 10.0;
    let defaultKm = 0.8;

    if (rxnId === 'GLCptspp' || rxnId === 'EX_glc__D_e') {
      defaultVmax = 18.0;
      defaultKm = 0.5;
    } else if (rxnId === 'PFK' || rxnId === 'PYK') {
      defaultVmax = 15.0;
      defaultKm = 0.3;
    } else if (rxnId === 'CS' || rxnId === 'ICDHyr') {
      defaultVmax = 12.0;
      defaultKm = 0.4;
    } else if (rxnId === 'BIOMASS_Ecoli_core_w_GAM') {
      defaultVmax = 8.0;
      defaultKm = 1.0;
    }

    // Get current Vmax/Km (overridden by student if present in parameters)
    const param = parameters[rxnId] || {};
    const vMax = param.vMax !== undefined ? param.vMax : defaultVmax;
    const km = param.km !== undefined ? param.km : defaultKm;

    if (coupledCheckpoints.has(rxnId)) {
      // Check reversibility
      const isReversible = (orig.lb < -1e-5);

      if (isReversible) {
        let ubForward = vMax;
        let ubBackward = vMax;

        const subs = reactionSubstrates[rxnId] || [];
        for (const sId of subs) {
          const conc = concentrations[sId] !== undefined ? concentrations[sId] : 1.0;
          ubForward = Math.min(ubForward, vMax * (conc / (km + conc)));
        }
        const prods = reactionProducts[rxnId] || [];
        for (const pId of prods) {
          const conc = concentrations[pId] !== undefined ? concentrations[pId] : 1.0;
          ubBackward = Math.min(ubBackward, vMax * (conc / (km + conc)));
        }

        bounds[rxnId] = { lowerBound: -ubBackward, upperBound: ubForward };
      } else {
        let ubForward = vMax;
        const subs = reactionSubstrates[rxnId] || [];
        for (const sId of subs) {
          const conc = concentrations[sId] !== undefined ? concentrations[sId] : 1.0;
          ubForward = Math.min(ubForward, vMax * (conc / (km + conc)));
        }

        bounds[rxnId] = { lowerBound: 0.0, upperBound: ubForward };
      }
    } else {
      bounds[rxnId] = { lowerBound: orig.lb, upperBound: orig.ub };
    }
  }

  return bounds;
}

// API Endpoints
app.post('/api/solve-fba', async (req, res) => {
  try {
    if (!highs) {
      return res.status(503).json({ error: 'Solver is still initializing' });
    }

    const concentrations = req.body.concentrations || {};
    const parameters = req.body.parameters || {};

    const bounds = calculateBounds(concentrations, parameters);

    const boundsLines = [];
    for (const [rxnId, b] of Object.entries(bounds)) {
      const formatBound = (val, isUpper) => {
        if (val === null || val === undefined) return isUpper ? 'inf' : '-inf';
        if (val === Infinity || val >= 999999) return 'inf';
        if (val === -Infinity || val <= -999999) return '-inf';
        return val.toString();
      };
      boundsLines.push(`  ${formatBound(b.lowerBound, false)} <= R_${rxnId} <= ${formatBound(b.upperBound, true)}`);
    }

    const lpString = staticLpHeader + boundsLines.join('\n') + '\nEnd';

    const sol = highs.solve(lpString, {
      "log_to_console": false,
      "output_flag": false
    });

    if (sol.Status === 'Optimal') {
      const columns = sol.Columns;
      const fluxes = {};
      for (const colName of Object.keys(columns)) {
        if (colName.startsWith('R_')) {
          const rxnId = colName.substring(2);
          fluxes[rxnId] = columns[colName].Primal;
        }
      }
      const biomassFlux = columns['R_BIOMASS_Ec_iJO1366_core_53p95M']?.Primal || 0.0;
      const isDead = biomassFlux < 0.005;

      return res.json({
        status: sol.Status,
        fluxes,
        biomass_flux: biomassFlux,
        is_dead: isDead
      });
    } else {
      return res.json({
        status: sol.Status,
        fluxes: {},
        biomass_flux: 0.0,
        is_dead: true
      });
    }
  } catch (err) {
    console.error('Error in solve-fba API:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Middleware to track visits
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    trackVisit(req).catch(err => console.error('[Server] Visit tracking error:', err));
  }
  next();
});

// Serve static assets from 'dist' folder
app.use(express.static(path.resolve('dist')));

// SPA Fallback: serve index.html for all non-api routes
app.get('*any', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.resolve('dist/index.html'));
});

// Start listening
app.listen(PORT, () => {
  console.log(`[Server] Production Express server is listening on port ${PORT}`);
});
