#!/usr/bin/env node

/**
 * Load testing script for cellflux.org (under Cloudflare stack)
 * Simulates activity of N users sending requests to the solver at random intervals from 10 to 60 seconds.
 * Requests are distributed in time under an authorized session.
 * Supports changing the number of users dynamically at runtime (type a number and press Enter).
 */

import { argv } from 'process';
import fs from 'fs';
import { execSync } from 'child_process';

// Default settings
let targetUrl = 'https://cellflux.org';
let numUsers = 10;
let cmdToken = null;

// Command line arguments parsing
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

// Remove trailing slash from URL if present
if (targetUrl.endsWith('/')) {
  targetUrl = targetUrl.slice(0, -1);
}

// Statistics
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

// Virtual users storage
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
    
    // Schedule the next request after a random interval from 10 to 60 seconds
    if (this.active) {
      const nextDelay = 10000 + Math.random() * 50000;
      this.timer = setTimeout(() => this.runLoop(), nextDelay);
    }
  }

  async sendSolveRequest() {
    const startTime = Date.now();
    stats.requestsSent++;

    try {
      // Simulate random environmental parameters changes via sliders
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

// Function to change the number of users
function adjustUsers(targetCount) {
  const currentCount = users.size;

  if (targetCount > currentCount) {
    // Add users with a 600ms step to prevent cold start peak load
    let index = 0;
    for (let i = currentCount + 1; i <= targetCount; i++) {
      const user = new VirtualUser(i, activeToken);
      users.set(i, user);
      user.start(index * 600);
      index++;
    }
  } else if (targetCount < currentCount) {
    // Stop and remove excess users
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

// Creating a test session in Cloudflare D1
async function getOrCreateTestSession() {
  console.log('[Load Test] Preparing test session in Cloudflare D1...');
  const email = 'test_load_user@cellflux.org';
  const token = 'test_load_token_uuid_value_12345';
  
  try {
    // 1. Create user in D1
    console.log('[Load Test] Adding test user to D1...');
    execSync(`npx wrangler d1 execute ecoli_db --remote --command "INSERT INTO users (email, name, premium_tier, premium_until) VALUES ('${email}', 'Load Test User', 2, '2030-01-01') ON CONFLICT (email) DO UPDATE SET premium_tier = 2, premium_until = '2030-01-01';"`, { stdio: 'ignore' });
    
    // 2. Create session in D1
    console.log('[Load Test] Creating test session in D1...');
    execSync(`npx wrangler d1 execute ecoli_db --remote --command "INSERT INTO user_sessions (token, email) VALUES ('${token}', '${email}') ON CONFLICT (token) DO NOTHING;"`, { stdio: 'ignore' });
    
    // 3. Reset chat limits
    console.log('[Load Test] Resetting chat limits...');
    execSync(`npx wrangler d1 execute ecoli_db --remote --command "DELETE FROM chat_limits WHERE identifier = 'user:${email}';"`, { stdio: 'ignore' });
    
    console.log(`[Load Test] Test session in D1 successfully created/updated. Token: ${token}`);
    return token;
  } catch (err) {
    console.error('[Load Test] Failed to update DB via Wrangler CLI:', err.message);
    console.log('[Load Test] Will use default token without forcing DB update.');
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
    console.warn('\n⚠️ WARNING: Test token not found. Requests to solver might return 401 Unauthorized. Use parameter --token <token>.\n');
  }

  // Start initial number of users
  adjustUsers(numUsers);

  // Read input from console to dynamically change user count
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    const input = data.trim();
    const num = parseInt(input, 10);
    if (!isNaN(num) && num >= 0) {
      adjustUsers(num);
      console.log(`\n>>> Number of users changed to: ${num}\n`);
    } else {
      console.log(`\n>>> Invalid input. Please enter an integer.\n`);
    }
  });

  const testStartTime = Date.now();

  // Output statistics once per second
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

    // Calculate test duration and average RPS
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - testStartTime) / 1000));
    const totalRequests = stats.totalSuccess + stats.totalRateLimits + stats.totalErrors;
    const avgRps = totalRequests / elapsedSeconds;

    const pad = (num) => String(num).padStart(2, '0');
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    const elapsedStr = `${pad(minutes)}:${pad(seconds)}`;

    // Clear per-second statistics
    stats.requestsSent = 0;
    stats.success = 0;
    stats.rateLimits = 0;
    stats.errors = 0;
    stats.responseTimes = [];

    // Clear screen and draw dashboard
    process.stdout.write('\x1B[2J\x1B[0F');
    console.log('====================================================');
    console.log('             CELLFLUX.ORG LOAD TESTER               ');
    console.log('====================================================');
    console.log(` Target URL:           ${targetUrl}`);
    console.log(` Active Users:         ${stats.activeUsers}`);
    console.log(` Auth Token:           ${activeToken ? 'Active (Bearer)' : 'None (Guest)'}`);
    console.log(` Elapsed Time:         ${elapsedStr}`);
    console.log('----------------------------------------------------');
    console.log(' Metrics for the last second:');
    console.log(`   Current RPS:        ${rps}`);
    console.log(`   Success (200 OK):   ${success}`);
    console.log(`   Rate Limit (429):   ${rateLimits}`);
    console.log(`   Errors/Timeouts:    ${errors}`);
    console.log(' Response time:');
    console.log(`   Average (avg):      ${avgTime.toFixed(1)} ms`);
    console.log(`   Minimum (min):      ${minTime} ms`);
    console.log(`   Maximum (max):      ${maxTime} ms`);
    console.log('----------------------------------------------------');
    console.log(' Cumulative total:');
    console.log(`   Total requests:     ${totalRequests}`);
    console.log(`   Average RPS (avg):  ${avgRps.toFixed(2)}`);
    console.log(`   Total success:      ${stats.totalSuccess}`);
    console.log(`   Total rate limits:  ${stats.totalRateLimits}`);
    console.log(`   Total errors:       ${stats.totalErrors}`);
    console.log('====================================================');
    console.log(' To change the number of users, type a number');
    console.log(' and press Enter (e.g., "50"): ');
  }, 1000);
}

start().catch(err => {
  console.error('[Load Test] Initialization error:', err);
});
