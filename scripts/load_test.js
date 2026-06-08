#!/usr/bin/env node

/**
 * Скрипт нагрузочного тестирования для cellflux.org
 * Имитирует активность N пользователей, отправляющих запросы к солверу раз в 5 секунд.
 * Запросы распределены во времени.
 * Поддерживает изменение числа пользователей прямо во время работы (введите число и нажмите Enter).
 */

import { argv } from 'process';

// Настройки по умолчанию
let targetUrl = 'https://cellflux.org';
let numUsers = 10;

// Парсинг аргументов командной строки
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === '--url' && argv[i + 1]) {
    targetUrl = argv[i + 1];
    i++;
  } else if (argv[i] === '--users' && argv[i + 1]) {
    numUsers = parseInt(argv[i + 1], 10) || 10;
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

class VirtualUser {
  constructor(id) {
    this.id = id;
    this.guestId = `test_load_user_${id}_${Math.random().toString(36).substring(2, 7)}`;
    this.active = false;
    this.timer = null;
  }

  start() {
    this.active = true;
    // Случайная начальная задержка до 5 секунд для распределения нагрузки
    const initialDelay = Math.random() * 5000;
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
    
    // Планируем следующий запрос ровно через 5 секунд
    if (this.active) {
      this.timer = setTimeout(() => this.runLoop(), 5000);
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

      const res = await fetch(`${targetUrl}/api/solve-fba`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-guest-id': this.guestId
        },
        body: JSON.stringify(payload),
        // Устанавливаем таймаут запроса в 10 секунд
        signal: AbortSignal.timeout(10000)
      });

      const responseTime = Date.now() - startTime;
      stats.responseTimes.push(responseTime);

      if (res.status === 200) {
        stats.success++;
        stats.totalSuccess++;
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
      const user = new VirtualUser(i);
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
  console.log('----------------------------------------------------');
  console.log(' Метрики за последнюю секунду:');
  console.log(`   RPS (запросов/сек): ${rps}`);
  console.log(`   Успешно (200 OK):   ${success}`);
  console.log(`   Лимит (429):        ${rateLimits}`);
  console.log(`   Ошибки/Таймауты:    ${errors}`);
  console.log(' Время отклика:');
  console.log(`   Среднее (avg):      ${avgTime.toFixed(1)} ms`);
  console.log(`   Минимум (min):      ${minTime} ms`);
  console.log(`   Максимум (max):      ${maxTime} ms`);
  console.log('----------------------------------------------------');
  console.log(' Накопительный итог:');
  console.log(`   Всего успешно:      ${stats.totalSuccess}`);
  console.log(`   Всего лимитов:      ${stats.totalRateLimits}`);
  console.log(`   Всего ошибок:       ${stats.totalErrors}`);
  console.log('====================================================');
  console.log(' Чтобы изменить количество пользователей, введите число');
  console.log(' и нажмите Enter (например, "50"): ');
}, 1000);
