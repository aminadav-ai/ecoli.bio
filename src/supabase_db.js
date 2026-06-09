import crypto from 'crypto';
import pg from 'pg';
import fs from 'fs';
import path from 'path';

// Load env variables from .env file locally if it exists
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

const { Pool } = pg;

// Connection pool configuration
const connectionString = process.env.DATABASE_URL;
const config = {};

if (connectionString) {
  try {
    const parsedUrl = new URL(connectionString);
    config.user = decodeURIComponent(parsedUrl.username);
    config.password = decodeURIComponent(parsedUrl.password);
    config.host = parsedUrl.hostname;
    config.port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 5432;
    config.database = decodeURIComponent(parsedUrl.pathname.substring(1));
  } catch (err) {
    console.error('[Postgres DB] Failed to parse DATABASE_URL via URL parser, falling back:', err);
    config.connectionString = connectionString;
  }
} else {
  config.user = process.env.PGUSER;
  config.password = process.env.PGPASSWORD;
  config.host = process.env.PGHOST;
  config.port = process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432;
  config.database = process.env.PGDATABASE;
}

// Enable SSL rejectUnauthorized: false unconditionally for remote databases
const isLocalhost = (config.host === 'localhost' || config.host === '127.0.0.1') ||
                    (config.connectionString && (config.connectionString.includes('localhost') || config.connectionString.includes('127.0.0.1')));

if (!isLocalhost) {
  config.ssl = {
    rejectUnauthorized: false
  };
}

export const pool = new Pool(config);

const tokenCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function clearCachedUser(email) {
  if (!email) return;
  for (const [token, entry] of tokenCache.entries()) {
    if (entry.user && entry.user.email === email) {
      tokenCache.delete(token);
    }
  }
}

// Get user profile by session token
export async function getUserByToken(token) {
  if (!token) return null;
  const now = Date.now();
  if (tokenCache.has(token)) {
    const entry = tokenCache.get(token);
    if (now - entry.timestamp < CACHE_TTL_MS) {
      return entry.user;
    }
  }
  try {
    const sessionRes = await pool.query(
      'SELECT email FROM user_sessions WHERE token = $1',
      [token]
    );
    if (sessionRes.rows.length > 0) {
      const email = sessionRes.rows[0].email;
      const userRes = await pool.query(
        'SELECT * FROM users WHERE email = $1',
        [email]
      );
      if (userRes.rows.length > 0) {
        const user = userRes.rows[0];
        tokenCache.set(token, { user, timestamp: now });
        return user;
      }
    }
  } catch (err) {
    console.error('[Postgres DB] Failed to get user by token:', err);
  }
  return null;
}

// Check if user is premium
export function isPremiumActive(user) {
  if (!user || !user.premium_until) return false;
  return new Date(user.premium_until) > new Date();
}

// Helper to get local date string for timezone comparison
function getLocalDateString(date, timeZone) {
  if (!timeZone) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  } catch (err) {
    return null;
  }
}

// 1. Check message limits & increment
export async function checkLimitAndIncrement(ip, guestId, authToken, timeZone) {
  const user = await getUserByToken(authToken);
  
  if (!user) {
    return { allowed: false, isPremium: false, user: null, remaining: 0 };
  }

  const isPremium = isPremiumActive(user);
  let limitMax = 5; // Authorized Free limit

  if (isPremium) {
    const tier = user.premium_tier || 1;
    limitMax = tier === 2 ? 500 : 100;
  }

  // Use user email since they are logged in
  const identifier = `user:${user.email}`;

  try {
    const res = await pool.query('SELECT * FROM chat_limits WHERE identifier = $1', [identifier]);
    const records = res.rows;
    const now = new Date();

    if (records.length > 0) {
      const record = records[0];
      const lastReset = new Date(record.last_reset);
      const activeTz = record.timezone || timeZone;
      
      let shouldReset = false;
      if (activeTz) {
        const resetDateStr = getLocalDateString(lastReset, activeTz);
        const nowDateStr = getLocalDateString(now, activeTz);
        if (resetDateStr && nowDateStr) {
          shouldReset = (resetDateStr !== nowDateStr);
        } else {
          const diffHrs = (now - lastReset) / (1000 * 60 * 60);
          shouldReset = (diffHrs >= 24);
        }
      } else {
        const diffHrs = (now - lastReset) / (1000 * 60 * 60);
        shouldReset = (diffHrs >= 24);
      }

      if (shouldReset) {
        await pool.query(
          'UPDATE chat_limits SET count = 1, last_reset = $1, timezone = $2 WHERE identifier = $3',
          [now, timeZone || 'UTC', identifier]
        );
        return { allowed: true, isPremium, user, remaining: limitMax - 1 };
      } else {
        if (record.count >= limitMax) {
          return { allowed: false, isPremium, user, remaining: 0 };
        } else {
          const newCount = record.count + 1;
          await pool.query(
            'UPDATE chat_limits SET count = $1 WHERE identifier = $2',
            [newCount, identifier]
          );
          return { allowed: true, isPremium, user, remaining: limitMax - newCount };
        }
      }
    } else {
      await pool.query(
        'INSERT INTO chat_limits (identifier, count, last_reset, timezone) VALUES ($1, $2, $3, $4) ON CONFLICT (identifier) DO UPDATE SET count = 1, last_reset = EXCLUDED.last_reset, timezone = EXCLUDED.timezone',
        [identifier, 1, now, timeZone || 'UTC']
      );
      return { allowed: true, isPremium, user, remaining: limitMax - 1 };
    }
  } catch (err) {
    console.error('[Postgres DB] Check limit error:', err);
    return { allowed: true, isPremium, user, remaining: 1 };
  }
}

// 2. Google OAuth Token Verification & User Signup
export async function verifyGoogleTokenAndLogin(credential) {
  const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  if (!verifyRes.ok) {
    throw new Error('Invalid Google credential token.');
  }
  const payload = await verifyRes.json();
  const email = payload.email;
  const name = payload.name || email;

  if (!email) {
    throw new Error('Email field is missing in Google credential payload.');
  }

  // Create user in DB (upsert)
  await pool.query(
    'INSERT INTO users (email, name) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name',
    [email, name]
  );

  // Create session UUID
  const token = crypto.randomUUID();
  await pool.query(
    'INSERT INTO user_sessions (token, email) VALUES ($1, $2)',
    [token, email]
  );

  // Fetch full user record to check premium state
  const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = userRes.rows[0] || { email, name };

  const visits = (user.visits || 0) + 1;
  const lastVisit = new Date();

  await pool.query(
    'UPDATE users SET visits = $1, last_visit = $2 WHERE email = $3',
    [visits, lastVisit, email]
  );

  return {
    token,
    user: {
      email: user.email,
      name: user.name,
      isAdmin: user.email === 'fbhcdbhf@gmail.com',
      isPremium: isPremiumActive(user),
      premiumTier: user.premium_tier || 0,
      premiumUntil: user.premium_until,
      autoRenew: !!user.auto_renew,
      solverTicks: user.solver_ticks || 0
    }
  };
}

// 3. Get session status, user profile & remaining limits
export async function getUserStatus(token, ip, guestId, timeZone) {
  const user = await getUserByToken(token);
  
  let limitMax = 2; // Default Guest limit
  const isPremium = user && isPremiumActive(user);
  if (user) {
    if (isPremium) {
      const tier = user.premium_tier || 1;
      limitMax = tier === 2 ? 500 : 100;
    } else {
      limitMax = 5; // Authorized Free limit
    }
  }

  const identifier = user ? `user:${user.email}` : `guest:${guestId || ip || 'unknown'}`;
  let count = 0;

  try {
    const res = await pool.query('SELECT * FROM chat_limits WHERE identifier = $1', [identifier]);
    const records = res.rows;
    if (records.length > 0) {
      const record = records[0];
      const lastReset = new Date(record.last_reset);
      const activeTz = record.timezone || timeZone;
      
      let isExpired = false;
      if (activeTz) {
        const resetDateStr = getLocalDateString(lastReset, activeTz);
        const nowDateStr = getLocalDateString(new Date(), activeTz);
        if (resetDateStr && nowDateStr) {
          isExpired = (resetDateStr !== nowDateStr);
        } else {
          const diffHrs = (new Date() - lastReset) / (1000 * 60 * 60);
          isExpired = (diffHrs >= 24);
        }
      } else {
        const diffHrs = (new Date() - lastReset) / (1000 * 60 * 60);
        isExpired = (diffHrs >= 24);
      }

      if (!isExpired) {
        count = record.count;
      }
    }
  } catch (err) {
    console.error('[Postgres DB] Failed to get limit count:', err);
  }

  return {
    loggedIn: !!user,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    user: user ? {
      email: user.email,
      name: user.name,
      isAdmin: user.email === 'fbhcdbhf@gmail.com',
      isPremium,
      premiumTier: user.premium_tier || 0,
      premiumUntil: user.premium_until,
      autoRenew: !!user.auto_renew,
      solverTicks: user.solver_ticks || 0
    } : null,
    limit: {
      max: limitMax,
      count,
      remaining: Math.max(0, limitMax - count)
    }
  };
}

// 4. Logout (destroy session)
export async function logoutSession(token) {
  if (!token) return;
  try {
    await pool.query('DELETE FROM user_sessions WHERE token = $1', [token]);
  } catch (err) {
    console.error('[Postgres DB] Logout session error:', err);
  }
}

// 5. Simulate Premium Payment
export async function simulatePremiumPayment(token, tier, autoRenew) {
  const user = await getUserByToken(token);
  if (!user) {
    throw new Error('Unauthorized or invalid session.');
  }

  const premiumUntil = new Date();
  premiumUntil.setDate(premiumUntil.getDate() + 30);
  
  const chosenTier = parseInt(tier, 10) === 2 ? 2 : 1;

  await pool.query(
    'UPDATE users SET premium_until = $1, premium_tier = $2, auto_renew = $3 WHERE email = $4',
    [premiumUntil, chosenTier, !!autoRenew, user.email]
  );
  clearCachedUser(user.email);

  return {
    success: true,
    premiumUntil: premiumUntil.toISOString(),
    premiumTier: chosenTier,
    autoRenew: !!autoRenew
  };
}

// 6. Increment user visits/login count
export async function incrementUserVisits(email) {
  try {
    await pool.query(
      'UPDATE users SET visits = COALESCE(visits, 0) + 1, last_visit = CURRENT_TIMESTAMP WHERE email = $1',
      [email]
    );
    clearCachedUser(email);
  } catch (err) {
    console.error('[Postgres DB] Failed to increment user visits:', err);
  }
}

// 7. Increment user asked questions count
export async function incrementUserQuestions(email) {
  try {
    await pool.query(
      'UPDATE users SET questions = COALESCE(questions, 0) + 1 WHERE email = $1',
      [email]
    );
    clearCachedUser(email);
  } catch (err) {
    console.error('[Postgres DB] Failed to increment user questions:', err);
  }
}

// 8. Increment user active session seconds spent (stubbed out)
export async function incrementUserTimeSpent(email, seconds) {
  return 0;
}

// 9. Fetch and format all user statistics for admin report
export async function getAllUsersFromDb() {
  try {
    const res = await pool.query('SELECT * FROM users');
    const dbUsers = res.rows;
    
    return dbUsers.map(u => {
      return {
        email: u.email,
        name: u.name,
        created_at: u.created_at,
        premium_tier: u.premium_tier,
        visits: u.visits || 0,
        last_visit: u.last_visit || u.created_at || null,
        questions: u.questions || 0,
        auto_renew: !!u.auto_renew
      };
    });
  } catch (err) {
    console.error('[Postgres DB] Failed to get all users:', err);
    return [];
  }
}

// 10. Delete user and their associated data
export async function deleteUserFromDb(email) {
  try {
    // delete user sessions
    await pool.query('DELETE FROM user_sessions WHERE email = $1', [email]);
  } catch (err) {
    console.error('[Postgres DB] Failed to delete user sessions:', err);
  }

  try {
    // delete chat limits
    const identifier = `user:${email}`;
    await pool.query('DELETE FROM chat_limits WHERE identifier = $1', [identifier]);
  } catch (err) {
    console.error('[Postgres DB] Failed to delete chat limits:', err);
  }

  try {
    // delete user
    await pool.query('DELETE FROM users WHERE email = $1', [email]);
    clearCachedUser(email);
  } catch (err) {
    console.error('[Postgres DB] Failed to delete user:', err);
    throw err;
  }
}

// 11. Save chat message to history
export async function saveChatMessage(identifier, role, message, context = null) {
  try {
    await pool.query(
      'INSERT INTO chat_history (identifier, role, message, context) VALUES ($1, $2, $3, $4)',
      [
        identifier,
        role,
        message,
        context ? (typeof context === 'object' ? JSON.stringify(context) : context) : null
      ]
    );
  } catch (err) {
    console.warn('[Postgres DB] Failed to save chat message:', err.message);
  }
}

// 12. Load chat history for identifier
export async function getChatHistory(identifier, limit = 50) {
  try {
    const res = await pool.query(
      'SELECT * FROM chat_history WHERE identifier = $1 ORDER BY created_at ASC LIMIT $2',
      [identifier, limit]
    );
    return res.rows;
  } catch (err) {
    console.warn('[Postgres DB] Failed to load chat history:', err.message);
    return [];
  }
}

// 13. Update user O2 preference (stub - disabled as per user request)
export async function updateUserO2Preference(email, o2Val) {
  return true;
}

// 14. Bulk increment user active session seconds spent (stubbed out)
export async function bulkIncrementUserTimeSpent(updates) {
  return;
}

// 15. Bulk increment user active simulation time and solver ticks via RPC
export async function bulkIncrementUserStats(updates) {
  if (!updates || updates.length === 0) return;
  try {
    await pool.query(
      'SELECT bulk_increment_user_stats($1::jsonb)',
      [JSON.stringify(updates)]
    );
    for (const item of updates) {
      if (item.email) {
        clearCachedUser(item.email);
      }
    }
  } catch (err) {
    console.error('[Postgres DB] Failed to bulk increment user stats:', err);
  }
}

// 16. Get and Save Simulation Session State
export async function getSessionState(sessionId) {
  try {
    const res = await pool.query(
      'SELECT state FROM simulation_sessions WHERE id = $1',
      [sessionId]
    );
    return res.rows.length > 0 ? res.rows[0].state : null;
  } catch (err) {
    console.error('[Postgres DB] Failed to get session state:', err);
  }
  return null;
}

export async function upsertSessionState(sessionId, email, state) {
  try {
    await pool.query(
      'INSERT INTO simulation_sessions (id, email, state, updated_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, state = EXCLUDED.state, updated_at = EXCLUDED.updated_at',
      [
        sessionId,
        email || null,
        typeof state === 'object' ? JSON.stringify(state) : state
      ]
    );
  } catch (err) {
    console.error('[Postgres DB] Failed to upsert session state:', err);
  }
}
