#!/usr/bin/env node

/**
 * Скрипт нагрузочного тестирования для cellflux.org (под стек Cloudflare)
 * Имитирует активность N пользователей, отправляющих запросы к солверу через случайные интервалы от 10 до 60 секунд.
 * Запросы распределены во времени под авторизованной сессией.
 * Поддерживает изменение числа пользователей прямо во время работы (введите число и нажмите Enter).
 */

import { argv } from 'process';
import fs from 'fs';
import { execSync } from 'child_process';

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

  start(delay = 0) {
    this.active = true;
    this.timer = setTimeout(() => this.runLoop(), delay);
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
        await res.json().catch(() => ({}));
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
    // Добавляем пользователей с шагом в 600мс для предотвращения пиковой нагрузки холодного старта
    let index = 0;
    for (let i = currentCount + 1; i <= targetCount; i++) {
      const user = new VirtualUser(i, activeToken);
      users.set(i, user);
      user.start(index * 600);
      index++;
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

// Создание тестовой сессии в Cloudflare D1
async function getOrCreateTestSession() {
  console.log('[Load Test] Подготовка тестовой сессии в Cloudflare D1...');
  const email = 'test_load_user@cellflux.org';
  const token = 'test_load_token_uuid_value_12345';
  
  try {
    // 1. Создаем пользователя в D1
    console.log('[Load Test] Добавление тестового пользователя в D1...');
    execSync(`npx wrangler d1 execute ecoli_db --remote --command "INSERT INTO users (email, name, premium_tier, premium_until) VALUES ('${email}', 'Load Test User', 2, '2030-01-01') ON CONFLICT (email) DO UPDATE SET premium_tier = 2, premium_until = '2030-01-01';"`, { stdio: 'ignore' });
    
    // 2. Создаем сессию в D1
    console.log('[Load Test] Создание тестовой сессии в D1...');
    execSync(`npx wrangler d1 execute ecoli_db --remote --command "INSERT INTO user_sessions (token, email) VALUES ('${token}', '${email}') ON CONFLICT (token) DO NOTHING;"`, { stdio: 'ignore' });
    
    // 3. Сбрасываем лимиты чата
    console.log('[Load Test] Сброс лимитов чата...');
    execSync(`npx wrangler d1 execute ecoli_db --remote --command "DELETE FROM chat_limits WHERE identifier = 'user:${email}';"`, { stdio: 'ignore' });
    
    console.log(`[Load Test] Тестовая сессия в D1 успешно создана/обновлена. Токен: ${token}`);
    return token;
  } catch (err) {
    console.error('[Load Test] Не удалось обновить БД через Wrangler CLI:', err.message);
    console.log('[Load Test] Будет использован дефолтный токен без принудительного обновления БД.');
    return token;
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
