// src/d1_db.js
// Cloudflare D1 (SQLite) database helper functions

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

// 2. Check message limits & increment
export async function checkLimitAndIncrement(db, ip, guestId, authToken, timeZone) {
  const user = await getUserByToken(db, authToken);
  const isPremium = isPremiumActive(user);
  let limitMax = user ? (isPremium ? (user.premium_tier === 2 ? 500 : 100) : 5) : 2;

  const identifier = user ? `user:${user.email}` : `guest:${guestId || ip || 'unknown'}`;

  try {
    const record = await db.prepare('SELECT * FROM chat_limits WHERE identifier = ?').bind(identifier).first();
    const now = new Date();

    if (record) {
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
        await db.prepare(
          'UPDATE chat_limits SET count = 1, last_reset = ?, timezone = ? WHERE identifier = ?'
        ).bind(now.toISOString(), timeZone || 'UTC', identifier).run();
        return { allowed: true, isPremium, user, remaining: limitMax - 1 };
      } else {
        if (record.count >= limitMax) {
          return { allowed: false, isPremium, user, remaining: 0 };
        } else {
          const newCount = record.count + 1;
          await db.prepare(
            'UPDATE chat_limits SET count = ? WHERE identifier = ?'
          ).bind(newCount, identifier).run();
          return { allowed: true, isPremium, user, remaining: limitMax - newCount };
        }
      }
    } else {
      await db.prepare(
        'INSERT INTO chat_limits (identifier, count, last_reset, timezone) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (identifier) DO UPDATE SET count = 1, last_reset = excluded.last_reset, timezone = excluded.timezone'
      ).bind(identifier, 1, now.toISOString(), timeZone || 'UTC').run();
      return { allowed: true, isPremium, user, remaining: limitMax - 1 };
    }
  } catch (err) {
    console.error('[D1 DB] Check limit error:', err);
    return { allowed: true, isPremium, user, remaining: 1 };
  }
}

// 3. Google OAuth Token Verification & User Signup
export async function verifyGoogleTokenAndLogin(db, credential) {
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
  await db.prepare(
    'INSERT INTO users (email, name) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name'
  ).bind(email, name).run();

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
    user: {
      email: user.email,
      name: user.name,
      isPremium: isPremiumActive(user),
      premiumTier: user.premium_tier || 0,
      premiumUntil: user.premium_until,
      autoRenew: !!user.auto_renew,
      solverTicks: user.solver_ticks || 0
    }
  };
}

// 4. Get session status, user profile & remaining limits
export async function getUserStatus(db, token, ip, guestId, timeZone) {
  const user = await getUserByToken(db, token);
  
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
    const record = await db.prepare('SELECT * FROM chat_limits WHERE identifier = ?').bind(identifier).first();
    if (record) {
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
    console.error('[D1 DB] Failed to get limit count:', err);
  }

  return {
    loggedIn: !!user,
    googleClientId: "889111185997-rfd2qv356f0454k3ovtgaao9540em9bc.apps.googleusercontent.com", // Statically configured Google Client ID
    user: user ? {
      email: user.email,
      name: user.name,
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

// 5. Logout (destroy session)
export async function logoutSession(db, token) {
  if (!token) return;
  try {
    await db.prepare('DELETE FROM user_sessions WHERE token = ?').bind(token).run();
  } catch (err) {
    console.error('[D1 DB] Logout session error:', err);
  }
}

// 6. Simulate Premium Payment
export async function simulatePremiumPayment(db, token, tier, autoRenew) {
  const user = await getUserByToken(db, token);
  if (!user) {
    throw new Error('Unauthorized or invalid session.');
  }

  const premiumUntil = new Date();
  premiumUntil.setDate(premiumUntil.getDate() + 30);
  const chosenTier = parseInt(tier, 10) === 2 ? 2 : 1;

  await db.prepare(
    'UPDATE users SET premium_until = ?, premium_tier = ?, auto_renew = ? WHERE email = ?'
  ).bind(premiumUntil.toISOString(), chosenTier, autoRenew ? 1 : 0, user.email).run();

  return {
    success: true,
    premiumUntil: premiumUntil.toISOString(),
    premiumTier: chosenTier,
    autoRenew: !!autoRenew
  };
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

// 8. Increment user asked questions count
export async function incrementUserQuestions(db, email) {
  try {
    const user = await db.prepare('SELECT questions FROM users WHERE email = ?').bind(email).first();
    const questions = ((user ? user.questions : 0) || 0) + 1;
    await db.prepare(
      'UPDATE users SET questions = ? WHERE email = ?'
    ).bind(questions, email).run();
  } catch (err) {
    console.error('[D1 DB] Failed to increment user questions:', err);
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

// 13. Bulk increment user solver ticks (Batch API)
export async function bulkIncrementUserStats(db, updates) {
  if (!updates || updates.length === 0) return;
  try {
    const statements = updates.map(item => 
      db.prepare('UPDATE users SET solver_ticks = solver_ticks + ? WHERE email = ?')
        .bind(item.ticks, item.email)
    );
    await db.batch(statements);
  } catch (err) {
    console.error('[D1 DB] Failed to bulk increment user stats:', err);
  }
}

// 14. Record guest visit by session and date
export async function recordGuestVisit(db, sessionId, dateStr) {
  if (!sessionId) return;
  try {
    await db.prepare(
      'INSERT INTO guest_visits (session_id, visit_date, visit_count) VALUES (?, ?, 1) ' +
      'ON CONFLICT(session_id, visit_date) DO UPDATE SET visit_count = visit_count + 1'
    ).bind(sessionId, dateStr).run();
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
