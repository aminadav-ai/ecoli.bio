// src/d1_db.js
// Cloudflare D1 (SQLite) database helper functions

// Limit of registered users allowed to log in (can be updated for debugging, e.g. "MAX_USERS_LIMIT = 2")
export const MAX_USERS_LIMIT = 100;

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

export function isPremiumActive(user) {
  if (!user || !user.premium_until) return false;
  return new Date(user.premium_until) > new Date();
}

// 1. Get user profile by session token
export async function getUserByToken(db, token) {
  if (!token) return null;
  try {
    const user = await db.prepare(
      'SELECT u.* FROM users u JOIN user_sessions s ON u.email = s.email WHERE s.token = ?'
    ).bind(token).first();
    return user;
  } catch (err) {
    console.error('[D1 DB] Failed to get user by token:', err);
  }
  return null;
}



// 3. Google OAuth Token Verification & User Signup
export async function verifyGoogleTokenAndLogin(db, credential, consentGiven = false) {
  const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  if (!verifyRes.ok) {
    throw new Error('Invalid Google credential token.');
  }
  const payload = await verifyRes.json();
  const email = payload.email;
  const name = payload.name || email;
  const picture = payload.picture || null;

  if (!email) {
    throw new Error('Email field is missing in Google credential payload.');
  }

  // Check if user already exists before inserting
  const existingUser = await db.prepare('SELECT email FROM users WHERE email = ?').bind(email).first();
  const isNewUser = !existingUser;

  if (isNewUser) {
    const countRow = await db.prepare('SELECT COUNT(*) as count FROM users').first();
    const currentCount = countRow ? countRow.count : 0;
    if (currentCount >= MAX_USERS_LIMIT) {
      return { limitReached: true };
    }
  }

  // Create user in DB (upsert)
  await db.prepare(
    'INSERT INTO users (email, name, picture, credits) VALUES (?, ?, ?, 0.0) ON CONFLICT (email) DO UPDATE SET name = excluded.name, picture = excluded.picture'
  ).bind(email, name, picture).run();

  // Create session UUID in JS
  const token = crypto.randomUUID();
  await db.prepare(
    'INSERT INTO user_sessions (token, email) VALUES (?, ?)'
  ).bind(token, email).run();

  // Fetch full user record to check premium state
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  const visits = (user.visits || 0) + 1;
  const lastVisit = new Date().toISOString();

  await db.prepare(
    'UPDATE users SET visits = ?, last_visit = ? WHERE email = ?'
  ).bind(visits, lastVisit, email).run();

  return {
    token,
    isNewUser,
    user: {
      email: user.email,
      name: user.name,
      picture: user.picture,
      isPremium: isPremiumActive(user),
      premiumTier: user.premium_tier || 0,
      premiumUntil: user.premium_until,
      autoRenew: !!user.auto_renew,
      credits: (user.credits !== undefined && user.credits !== null) ? user.credits : 0.0
    }
  };
}

// 4. Get session status & user profile (without limits)
export async function getUserStatus(db, token, ip, guestId, timeZone, googleClientId = null) {
  const user = await getUserByToken(db, token);
  const isPremium = user && isPremiumActive(user);

  return {
    loggedIn: !!user,
    googleClientId: googleClientId,
    user: user ? {
      email: user.email,
      name: user.name,
      picture: user.picture,
      isPremium,
      premiumTier: user.premium_tier || 0,
      premiumUntil: user.premium_until,
      autoRenew: !!user.auto_renew,
      credits: (user.credits !== undefined && user.credits !== null) ? user.credits : 0.0
    } : null
  };
}

// 5. Logout (destroy session)
export async function logoutSession(db, token) {
  if (!token) return;
  try {
    await db.prepare('DELETE FROM user_sessions WHERE token = ?').bind(token).run();
  } catch (err) {
    console.error('[D1 DB] Logout session error:', err);
  }
}



// 7. Increment user visits/login count
export async function incrementUserVisits(db, email) {
  try {
    const user = await db.prepare('SELECT visits FROM users WHERE email = ?').bind(email).first();
    const visits = ((user ? user.visits : 0) || 0) + 1;
    await db.prepare(
      'UPDATE users SET visits = ?, last_visit = datetime(\'now\') WHERE email = ?'
    ).bind(visits, email).run();
  } catch (err) {
    console.error('[D1 DB] Failed to increment user visits:', err);
  }
}





// 11. Save chat message to history
export async function saveChatMessage(db, identifier, role, message, context = null) {
  try {
    await db.prepare(
      'INSERT INTO chat_history (identifier, role, message, context) VALUES (?, ?, ?, ?)'
    ).bind(
      identifier,
      role,
      message,
      context ? (typeof context === 'object' ? JSON.stringify(context) : context) : null
    ).run();
  } catch (err) {
    console.warn('[D1 DB] Failed to save chat message:', err.message);
  }
}

// 12. Load chat history for identifier
export async function getChatHistory(db, identifier, limit = 50) {
  try {
    const res = await db.prepare(
      'SELECT * FROM chat_history WHERE identifier = ? ORDER BY id ASC LIMIT ?'
    ).bind(identifier, limit).all();
    return res.results || [];
  } catch (err) {
    console.warn('[D1 DB] Failed to load chat history:', err.message);
    return [];
  }
}

// 13. Bulk increment user solver ticks (Batch API) - now only deducts credits
export async function bulkIncrementUserStats(db, updates) {
  // Solver is free, do not deduct credits for solver ticks
}

// 13b. Deduct user credits (for AI query or other operations) - disabled (no-op)
export async function deductUserCredits(db, email, amount) {
  // Free trial period - credits deduction disabled
}

// 14. Record guest visit by session and date
export async function recordGuestVisit(db, sessionId, dateStr, details = {}) {
  if (!sessionId) return;
  try {
    await db.prepare(
      'INSERT INTO guest_visits (session_id, visit_date, visit_count, ip, user_agent, country, city, asn_org, first_visit_time) ' +
      'VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(session_id, visit_date) DO UPDATE SET ' +
      'visit_count = visit_count + 1, ' +
      'ip = COALESCE(?, ip), ' +
      'user_agent = COALESCE(?, user_agent), ' +
      'country = COALESCE(?, country), ' +
      'city = COALESCE(?, city), ' +
      'asn_org = COALESCE(?, asn_org)'
    ).bind(
      sessionId,
      dateStr,
      details.ip || null,
      details.userAgent || null,
      details.country || null,
      details.city || null,
      details.asnOrg || null,
      new Date().toISOString(),
      details.ip || null,
      details.userAgent || null,
      details.country || null,
      details.city || null,
      details.asnOrg || null
    ).run();
  } catch (err) {
    console.error('[D1 DB] Failed to record guest visit:', err);
  }
}

// 15. Get list of sessions for email (with chat message count)
export async function getSimulationSessions(db, email) {
  try {
    const res = await db.prepare(
      "SELECT s.id, s.base_name, s.name, s.created_at, s.updated_at, s.is_custom_name, " +
      "(SELECT COUNT(*) FROM chat_history c WHERE c.identifier = 'user:' || s.email || ':' || s.id) AS chat_count " +
      "FROM simulation_sessions s WHERE s.email = ? ORDER BY s.updated_at DESC"
    ).bind(email).all();
    return res.results || [];
  } catch (err) {
    console.error('[D1 DB] getSimulationSessions error:', err);
    return [];
  }
}

// 16. Get single session by id
export async function getSimulationSession(db, id) {
  try {
    return await db.prepare(
      'SELECT * FROM simulation_sessions WHERE id = ?'
    ).bind(id).first();
  } catch (err) {
    console.error('[D1 DB] getSimulationSession error:', err);
    return null;
  }
}

// 17. Upsert simulation session
export async function upsertSimulationSession(db, id, email, baseName, name, state, isCustomName = null) {
  try {
    if (email && email.startsWith('guest:')) {
      await db.prepare(
        'INSERT OR IGNORE INTO users (email, name, credits) VALUES (?, ?, 0.0)'
      ).bind(email, 'Guest User').run();
    }
    if (isCustomName !== null) {
      await db.prepare(
        'INSERT INTO simulation_sessions (id, email, base_name, name, state, is_custom_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime("now")) ' +
        'ON CONFLICT(id) DO UPDATE SET email = excluded.email, base_name = excluded.base_name, name = excluded.name, state = excluded.state, is_custom_name = excluded.is_custom_name, updated_at = excluded.updated_at'
      ).bind(id, email, baseName, name, state, isCustomName ? 1 : 0).run();
    } else {
      await db.prepare(
        'INSERT INTO simulation_sessions (id, email, base_name, name, state, is_custom_name, updated_at) VALUES (?, ?, ?, ?, ?, 0, datetime("now")) ' +
        'ON CONFLICT(id) DO UPDATE SET email = excluded.email, base_name = excluded.base_name, name = excluded.name, state = excluded.state, updated_at = excluded.updated_at'
      ).bind(id, email, baseName, name, state).run();
    }
  } catch (err) {
    console.error('[D1 DB] upsertSimulationSession error:', err);
  }
}

// 17b. Rename simulation session explicitly
export async function renameSimulationSession(db, id, name) {
  try {
    await db.prepare(
      'UPDATE simulation_sessions SET base_name = ?, name = ?, is_custom_name = 1, updated_at = datetime("now") WHERE id = ?'
    ).bind(name, name, id).run();
  } catch (err) {
    console.error('[D1 DB] renameSimulationSession error:', err);
  }
}

// 18. Delete simulation session
export async function deleteSimulationSession(db, id) {
  try {
    await db.prepare('DELETE FROM simulation_sessions WHERE id = ?').bind(id).run();
    await db.prepare('DELETE FROM experiment_logs WHERE session_id = ?').bind(id).run();
  } catch (err) {
    console.error('[D1 DB] deleteSimulationSession error:', err);
  }
}

// 18b. Delete chat history for session
export async function deleteChatHistoryForSession(db, email, sessionId) {
  try {
    const identifier = `user:${email}:${sessionId}`;
    await db.prepare('DELETE FROM chat_history WHERE identifier = ?').bind(identifier).run();
  } catch (err) {
    console.error('[D1 DB] deleteChatHistoryForSession error:', err);
  }
}

// 19. Count experiments by base_name and date for a user
export async function getExperimentCount(db, email, baseName, dateStr) {
  try {
    const res = await db.prepare(
      'SELECT COUNT(*) as count FROM simulation_sessions WHERE email = ? AND base_name = ? AND DATE(created_at) = ?'
    ).bind(email, baseName, dateStr).first();
    return res ? res.count : 0;
  } catch (err) {
    console.error('[D1 DB] getExperimentCount error:', err);
    return 0;
  }
}

// 20. Log user action inside an experiment with resulting simulation metrics
export async function logExperimentAction(db, sessionId, actionType, target, value, prevValue, growthRate, glucoseUptake, oxygenUptake, atpYield, isDead) {
  try {
    await db.prepare(
      'INSERT INTO experiment_logs (session_id, action_type, target, value, prev_value, growth_rate, glucose_uptake, oxygen_uptake, atp_yield, is_dead, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime("now"))'
    ).bind(sessionId, actionType, target, value, prevValue, growthRate, glucoseUptake, oxygenUptake, atpYield, isDead).run();
  } catch (err) {
    console.error('[D1 DB] logExperimentAction error:', err);
  }
}

// 21. Get all logs for an experiment session
export async function getExperimentLogs(db, sessionId) {
  try {
    const res = await db.prepare(
      'SELECT action_type, target, value, prev_value, growth_rate, glucose_uptake, oxygen_uptake, atp_yield, is_dead, created_at ' +
      'FROM experiment_logs WHERE session_id = ? ORDER BY id ASC'
    ).bind(sessionId).all();
    return res.results || [];
  } catch (err) {
    console.error('[D1 DB] getExperimentLogs error:', err);
    return [];
  }
}

// 22. Record reaction parameter changes (Vmax / Km counts) in database
export async function recordReactionActivity(db, reaction, vmaxChanged, kmChanged) {
  try {
    await db.prepare(
      'INSERT INTO reaction_activity (reaction, vmax_count, km_count) ' +
      'VALUES (?, ?, ?) ' +
      'ON CONFLICT(reaction) DO UPDATE SET ' +
      'vmax_count = vmax_count + excluded.vmax_count, ' +
      'km_count = km_count + excluded.km_count'
    ).bind(
      reaction,
      vmaxChanged ? 1 : 0,
      kmChanged ? 1 : 0
    ).run();
  } catch (err) {
    console.error('[D1 DB] recordReactionActivity error:', err);
  }
}

// 23. Increment guest session activity (AI chats and reports count)
export async function incrementGuestActivity(db, sessionId, dateStr, activityType) {
  if (!sessionId) return;
  try {
    const chatVal = activityType === 'chat' ? 1 : 0;
    const reportVal = activityType === 'report' ? 1 : 0;
    await db.prepare(
      'INSERT INTO guest_visits (session_id, visit_date, visit_count, chat_count, report_count) ' +
      'VALUES (?, ?, 0, ?, ?) ' +
      'ON CONFLICT(session_id, visit_date) DO UPDATE SET ' +
      'chat_count = chat_count + excluded.chat_count, ' +
      'report_count = report_count + excluded.report_count'
    ).bind(
      sessionId,
      dateStr,
      chatVal,
      reportVal
    ).run();
  } catch (err) {
    console.error('[D1 DB] incrementGuestActivity error:', err);
  }
}
