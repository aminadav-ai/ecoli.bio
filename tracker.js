import fs from 'fs';
import path from 'path';
import { getUserByToken } from './src/supabase_db.js';

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
export async function sendTelegramMessage(text) {
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
    } else {
      console.log(`[Telegram Bot] Message sent successfully.`);
    }
  } catch (err) {
    console.error('[Server] Failed to send Telegram message:', err);
  }
}

// Check if a path is suspicious (potential security scanning)
export function isSuspiciousPath(urlPath) {
  if (!urlPath) return false;
  const pathLower = urlPath.toLowerCase();

  // Exclude legitimate admin API routes
  if (pathLower.startsWith('/api/admin/')) {
    return false;
  }

  const suspiciousPatterns = [
    '.env',
    '.git',
    '.php',
    'wp-',
    'phpmyadmin',
    'xmlrpc',
    '/admin',
    '/administrator',
    '/config',
    '.bak',
    '.sql',
    '.zip',
    '.tar',
    '.rar',
    '.tgz',
    'dump',
    'db_backup',
    'composer.json',
    'package.json'
  ];

  return suspiciousPatterns.some(pattern => pathLower.includes(pattern));
}

// Check if path should be completely ignored for normal visit notifications
export function shouldIgnorePath(urlPath) {
  if (!urlPath) return true;
  const pathLower = urlPath.toLowerCase();

  // Suspicious paths must NEVER be ignored
  if (isSuspiciousPath(urlPath)) {
    return false;
  }

  // Ignore high frequency / internal endpoints
  if (
    pathLower === '/api/solve-fba' ||
    pathLower === '/api/auth/heartbeat' ||
    pathLower === '/api/auth/status'
  ) {
    return true;
  }

  // Ignore standard static asset extensions
  const ignoredExtensions = [
    '.js', '.css', '.png', '.jpg', '.jpeg', '.gif',
    '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot',
    '.map', '.json', '.txt'
  ];

  if (ignoredExtensions.some(ext => pathLower.endsWith(ext))) {
    return true;
  }

  return false;
}

// Log visit to visits.log
function logVisitToFile(visit) {
  const dateStr = new Date(visit.timestamp).toISOString();
  const isSuspicious = visit.suspicious ? ' [SUSPICIOUS SCAN]' : '';
  const line = `${dateStr} - IP: ${visit.ip} - Device: ${visit.device} - Referer: ${visit.referer} - Path: ${visit.method || 'GET'} ${visit.path || '/'}${isSuspicious}\n`;
  fs.appendFile(path.resolve('visits.log'), line, (err) => {
    if (err) {
      console.error('[Server] Failed to write to visits.log:', err);
    }
  });
}

// Periodic cleanup of active sessions older than 24 hours to prevent memory leaks
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of activeSessions.entries()) {
    if (now - timestamp > 24 * 60 * 60 * 1000) {
      activeSessions.delete(key);
    }
  }
}, 60 * 60 * 1000);
if (cleanupTimer && typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

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
export async function trackVisit(req) {
  const now = Date.now();
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown';
  if (ip && ip.includes(',')) {
    ip = ip.split(',')[0].trim();
  }

  const ua = req.headers['user-agent'] || '';
  const referer = req.headers['referer'] || 'Direct/Unknown';
  const device = parseUserAgent(ua);

  // Get path from request url
  const urlStr = req.url || '';
  const urlPath = urlStr.split('?')[0] || '/';

  // 1. Check if the path is suspicious (potential scan)
  const isSuspicious = isSuspiciousPath(urlPath);
  if (isSuspicious) {
    const visit = {
      timestamp: now,
      ip,
      device,
      referer,
      path: urlPath,
      method: req.method || 'GET',
      suspicious: true
    };
    logVisitToFile(visit);
    console.warn(`[Suspicious Scan] New scan attempt from ${ip} (${device}), method: ${req.method || 'GET'}, url: ${urlStr}`);

    // Send immediate Warning alert bypassing session cooldown
    const alertText = `⚠️ <b>Попытка сканирования сайта (Подозрительный запрос)!</b>\n\n` +
                      `<b>Запрос:</b> <code>${req.method || 'GET'} ${urlStr}</code>\n` +
                      `<b>IP:</b> <code>${ip}</code>\n` +
                      `<b>Устройство:</b> <code>${device}</code>\n` +
                      `<b>Реферер:</b> <code>${referer}</code>`;
    await sendTelegramMessage(alertText);
    return;
  }

  // 2. Ignore static assets and high-frequency internal APIs
  if (shouldIgnorePath(urlPath)) {
    return;
  }

  // Check cooldown to de-duplicate visits from the same browser session
  const sessionKey = `${ip}::${ua}`;
  const lastSeen = activeSessions.get(sessionKey);
  if (lastSeen && (now - lastSeen < COOLDOWN_MS)) {
    activeSessions.set(sessionKey, now);
    return;
  }

  // Register new session
  activeSessions.set(sessionKey, now);

  const visit = {
    timestamp: now,
    ip,
    device,
    referer,
    path: urlPath,
    method: req.method || 'GET'
  };

  // Log to local file and server console
  logVisitToFile(visit);
  console.log(`[Visit] New connection from ${ip} (${device}), path: ${req.method || 'GET'} ${urlPath}, Referer: ${referer}`);

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
        if (statsInterval && typeof statsInterval.unref === 'function') {
          statsInterval.unref();
        }
      }
    } else {
      const text = `🔔 <b>Новый посетитель на сайте!</b>\n\n` +
                   `<b>Путь:</b> <code>${req.method || 'GET'} ${urlPath}</code>\n` +
                   `<b>IP:</b> <code>${ip}</code>\n` +
                   `<b>Устройство:</b> <code>${device}</code>\n` +
                   `<b>Реферер:</b> <code>${referer}</code>`;
      await sendTelegramMessage(text);
    }
  }
}

// Track a user chat query to AI assistant
export async function trackChatQuery(req, message) {
  const now = Date.now();
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown';
  if (ip && ip.includes(',')) {
    ip = ip.split(',')[0].trim();
  }

  const ua = req.headers['user-agent'] || '';
  const device = parseUserAgent(ua);

  // Extract user email if logged in
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  let email = 'Guest (Не авторизован)';
  if (token) {
    const user = await getUserByToken(token);
    if (user && user.email) {
      email = user.email;
    }
  }

  // Escape HTML characters to prevent Telegram API errors
  const safeMessage = (message || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  console.log(`[Chat Query] Tracking query from ${email}: "${message}"`);

  const text = `💬 <b>Запрос к ИИ чату!</b>\n\n` +
               `<b>Пользователь:</b> <code>${email}</code>\n` +
               `<b>IP:</b> <code>${ip}</code>\n` +
               `<b>Устройство:</b> <code>${device}</code>\n\n` +
               `<b>Вопрос:</b>\n<blockquote>${safeMessage}</blockquote>`;

  await sendTelegramMessage(text);
}
