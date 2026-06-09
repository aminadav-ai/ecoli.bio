#!/usr/bin/env node

/**
 * Скрипт нагрузочного тестирования для cellflux.org
 * Имитирует активность N пользователей, отправляющих запросы к солверу через случайные интервалы от 10 до 60 секунд.
 * Запросы распределены во времени под авторизованной сессией.
 * Поддерживает изменение числа пользователей прямо во время работы (введите число и нажмите Enter).
 */

import { argv } from 'process';
import pg from 'pg';
import fs from 'fs';
import path from 'path';

// Настройки по умолчанию
let targetUrl = 'https://cellflux.org';
let numUsers = 10;
let cmdToken = null;

// Парсинг аргументов командной строки
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === '--url' && argv[i + 1]) {
    targetUrl = argv[i + 1];
    i++;
  } else if (argv[i] === '--users' && argv[i + 1]) {
    numUsers = parseInt(argv[i + 1], 10) || 10;
    i++;
  } else if (argv[i] === '--token' && argv[i + 1]) {
    cmdToken = argv[i + 1];
    i++;
  }
}

// Убираем слеш в конце URL, если он есть
if (targetUrl.endsWith('/')) {
  targetUrl = targetUrl.slice(0, -1);
}

// Статистика
const stats = {
  activeUsers: 0,
  requestsSent: 0,
  success: 0,
  rateLimits: 0,
  errors: 0,
  responseTimes: [],
  totalSuccess: 0,
  totalRateLimits: 0,
  totalErrors: 0
};

// Хранилище виртуальных пользователей
const users = new Map();
let activeToken = null;

class VirtualUser {
  constructor(id, token) {
    this.id = id;
    this.guestId = `test_load_user_${id}_${Math.random().toString(36).substring(2, 7)}`;
    this.sessionId = `test_session_${id}_${Math.random().toString(36).substring(2, 7)}`;
    this.token = token;
    this.active = false;
    this.timer = null;
  }

  start() {
    this.active = true;
    // Случайная начальная задержка до 60 секунд для плавного распределения нагрузки холодного старта
    const initialDelay = Math.random() * 60000;
    this.timer = setTimeout(() => this.runLoop(), initialDelay);
  }

  stop() {
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async runLoop() {
    if (!this.active) return;
    
    await this.sendSolveRequest();
    
    // Планируем следующий запрос через случайный интервал от 10 до 60 секунд
    if (this.active) {
      const nextDelay = 10000 + Math.random() * 50000;
      this.timer = setTimeout(() => this.runLoop(), nextDelay);
    }
  }

  async sendSolveRequest() {
    const startTime = Date.now();
    stats.requestsSent++;

    try {
      // Имитируем случайное изменение параметров среды слайдерами
      const payload = {
        concentrations: {
          o2_e: parseFloat((Math.random() * 0.4).toFixed(3)),
          glc__D_e: parseFloat((Math.random() * 15.0).toFixed(3))
        },
        parameters: {},
        reset: false
      };

      if (this.lastTimestamp) {
        payload.lastTimestamp = this.lastTimestamp;
      }

      const headers = {
        'Content-Type': 'application/json',
        'x-guest-id': this.guestId,
        'x-session-id': this.sessionId
      };

      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }

      const res = await fetch(`${targetUrl}/api/solve-fba`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
      });

      const responseTime = Date.now() - startTime;
      stats.responseTimes.push(responseTime);

      if (res.status === 200) {
        stats.success++;
        stats.totalSuccess++;
        const data = await res.json().catch(() => ({}));
        if (data.lastTimestamp) {
          this.lastTimestamp = data.lastTimestamp;
        }
      } else if (res.status === 429) {
        stats.rateLimits++;
        stats.totalRateLimits++;
      } else {
        stats.errors++;
        stats.totalErrors++;
      }
    } catch (err) {
      const responseTime = Date.now() - startTime;
      stats.responseTimes.push(responseTime);
      stats.errors++;
      stats.totalErrors++;
    }
  }
}

// Функция изменения числа пользователей
function adjustUsers(targetCount) {
  const currentCount = users.size;

  if (targetCount > currentCount) {
    // Добавляем пользователей
    for (let i = currentCount + 1; i <= targetCount; i++) {
      const user = new VirtualUser(i, activeToken);
      users.set(i, user);
      user.start();
    }
  } else if (targetCount < currentCount) {
    // Останавливаем и удаляем лишних
    for (let i = currentCount; i > targetCount; i--) {
      const user = users.get(i);
      if (user) {
        user.stop();
        users.delete(i);
      }
    }
  }
  stats.activeUsers = users.size;
}

// Загрузка переменных окружения для подключения к БД
async function getOrCreateTestSession() {
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
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

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log('[Load Test] DATABASE_URL не найден в .env. Будет запущен без интеграции с базой данных.');
    return null;
  }

  const { Pool } = pg;
  const config = { connectionString };
  
  if (!connectionString.includes('localhost') && !connectionString.includes('127.0.0.1')) {
    config.ssl = { rejectUnauthorized: false };
  }

  const pool = new Pool(config);
  try {
    console.log('[Load Test] Подключение к PostgreSQL...');
    const email = 'test_load_user@cellflux.org';
    
    // Создаем тестового пользователя
    await pool.query(
      `INSERT INTO users (email, name, premium_tier, premium_until) 
       VALUES ($1, 'Load Test User', 2, '2030-01-01') 
       ON CONFLICT (email) 
       DO UPDATE SET premium_tier = 2, premium_until = '2030-01-01'`,
      [email]
    );

    // Генерируем или находим токен
    const token = 'test_load_token_uuid_value_12345';
    await pool.query(
      `INSERT INTO user_sessions (token, email) 
       VALUES ($1, $2) 
       ON CONFLICT DO NOTHING`,
      [token, email]
    );

    // Сбрасываем лимиты
    await pool.query(
      `DELETE FROM chat_limits WHERE identifier = $1`,
      [`user:${email}`]
    );

    console.log(`[Load Test] Тестовая сессия создана в БД. Токен: ${token}`);
    await pool.end();
    return token;
  } catch (err) {
    console.error('[Load Test] Не удалось создать сессию в БД:', err.message);
    console.log('[Load Test] Переключение в резервный режим.');
    try { await pool.end(); } catch (e) {}
    return null;
  }
}

async function start() {
  let token = cmdToken;
  if (!token) {
    token = await getOrCreateTestSession();
  }
  
  activeToken = token;
  
  if (!activeToken) {
    console.warn('\n⚠️ ВНИМАНИЕ: Тестовый токен не найден. Запросы к солверу могут возвращать 401 Unauthorized. Используйте параметр --token <токен>.\n');
  }

  // Запуск начального количества пользователей
  adjustUsers(numUsers);

  // Чтение ввода из консоли для динамического изменения числа пользователей
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    const input = data.trim();
    const num = parseInt(input, 10);
    if (!isNaN(num) && num >= 0) {
      adjustUsers(num);
      console.log(`\n>>> Количество пользователей изменено на: ${num}\n`);
    } else {
      console.log(`\n>>> Некорректный ввод. Введите целое число.\n`);
    }
  });

  const testStartTime = Date.now();

  // Вывод статистики раз в секунду
  setInterval(() => {
    const rps = stats.requestsSent;
    const success = stats.success;
    const rateLimits = stats.rateLimits;
    const errors = stats.errors;
    
    let avgTime = 0;
    let minTime = 0;
    let maxTime = 0;

    if (stats.responseTimes.length > 0) {
      const sum = stats.responseTimes.reduce((a, b) => a + b, 0);
      avgTime = sum / stats.responseTimes.length;
      minTime = Math.min(...stats.responseTimes);
      maxTime = Math.max(...stats.responseTimes);
    }

    // Расчет времени теста и среднего RPS
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - testStartTime) / 1000));
    const totalRequests = stats.totalSuccess + stats.totalRateLimits + stats.totalErrors;
    const avgRps = totalRequests / elapsedSeconds;

    const pad = (num) => String(num).padStart(2, '0');
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    const elapsedStr = `${pad(minutes)}:${pad(seconds)}`;

    // Очистка статистики за секунду
    stats.requestsSent = 0;
    stats.success = 0;
    stats.rateLimits = 0;
    stats.errors = 0;
    stats.responseTimes = [];

    // Очищаем экран и рисуем дашборд
    process.stdout.write('\x1B[2J\x1B[0F');
    console.log('====================================================');
    console.log('             CELLFLUX.ORG LOAD TESTER               ');
    console.log('====================================================');
    console.log(` Target URL:           ${targetUrl}`);
    console.log(` Active Users:         ${stats.activeUsers}`);
    console.log(` Auth Token:           ${activeToken ? 'Active (Bearer)' : 'None (Guest)'}`);
    console.log(` Elapsed Time:         ${elapsedStr}`);
    console.log('----------------------------------------------------');
    console.log(' Метрики за последнюю секунду:');
    console.log(`   Текущий RPS:        ${rps}`);
    console.log(`   Успешно (200 OK):   ${success}`);
    console.log(`   Лимит (429):        ${rateLimits}`);
    console.log(`   Ошибки/Таймауты:    ${errors}`);
    console.log(' Время отклика:');
    console.log(`   Среднее (avg):      ${avgTime.toFixed(1)} ms`);
    console.log(`   Минимум (min):      ${minTime} ms`);
    console.log(`   Максимум (max):      ${maxTime} ms`);
    console.log('----------------------------------------------------');
    console.log(' Накопительный итог:');
    console.log(`   Всего запросов:     ${totalRequests}`);
    console.log(`   Средний RPS (avg):   ${avgRps.toFixed(2)}`);
    console.log(`   Всего успешно:      ${stats.totalSuccess}`);
    console.log(`   Всего лимитов:      ${stats.totalRateLimits}`);
    console.log(`   Всего ошибок:       ${stats.totalErrors}`);
    console.log('====================================================');
    console.log(' Чтобы изменить количество пользователей, введите число');
    console.log(' и нажмите Enter (например, "50"): ');
  }, 1000);
}

start().catch(err => {
  console.error('[Load Test] Ошибка инициализации:', err);
});
