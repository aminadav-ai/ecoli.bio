import fs from 'fs';
import path from 'path';

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
        if (statsInterval && typeof statsInterval.unref === 'function') {
          statsInterval.unref();
        }
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
