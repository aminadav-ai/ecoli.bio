import crypto from 'crypto';

// Helper to make fetch calls to Supabase REST API
async function supabaseFetch(path, options = {}) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase is not configured in .env');
  }
  const url = `${supabaseUrl}/rest/v1/${path}`;
  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    ...options.headers
  };
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase error: ${response.status} - ${text}`);
  }
  return response;
}

// Get user profile by session token
export async function getUserByToken(token) {
  if (!token) return null;
  try {
    const res = await supabaseFetch(`user_sessions?token=eq.${encodeURIComponent(token)}`);
    const sessions = await res.json();
    if (sessions.length > 0) {
      const session = sessions[0];
      const userRes = await supabaseFetch(`users?email=eq.${encodeURIComponent(session.email)}`);
      const users = await userRes.json();
      if (users.length > 0) {
        return users[0];
      }
    }
  } catch (err) {
    console.error('[Supabase DB] Failed to get user by token:', err);
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
    const res = await supabaseFetch(`chat_limits?identifier=eq.${encodeURIComponent(identifier)}`);
    const records = await res.json();
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
        // Reset limit & store current timezone
        await supabaseFetch(`chat_limits?identifier=eq.${encodeURIComponent(identifier)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 1, last_reset: now.toISOString(), timezone: timeZone || 'UTC' })
        });
        return { allowed: true, isPremium, user, remaining: limitMax - 1 };
      } else {
        if (record.count >= limitMax) {
          return { allowed: false, isPremium, user, remaining: 0 };
        } else {
          const newCount = record.count + 1;
          await supabaseFetch(`chat_limits?identifier=eq.${encodeURIComponent(identifier)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ count: newCount })
          });
          return { allowed: true, isPremium, user, remaining: limitMax - newCount };
        }
      }
    } else {
      // Create first limit entry & store current timezone
      await supabaseFetch('chat_limits', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({ identifier, count: 1, last_reset: now.toISOString(), timezone: timeZone || 'UTC' })
      });
      return { allowed: true, isPremium, user, remaining: limitMax - 1 };
    }
  } catch (err) {
    console.error('[Supabase DB] Check limit error:', err);
    // Safe fallback: allow query if Supabase fails (avoids breaking chatbot if DB goes down)
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

  // Create user in Supabase (upsert)
  await supabaseFetch('users', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ email, name })
  });

  // Create session UUID
  const token = crypto.randomUUID();
  await supabaseFetch('user_sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, email })
  });

  // Fetch full user record to check premium state
  const userRes = await supabaseFetch(`users?email=eq.${encodeURIComponent(email)}`);
  const users = await userRes.json();
  const user = users[0] || { email, name };

  const visits = (user.visits || 0) + 1;
  const lastVisit = new Date().toISOString();

  await supabaseFetch(`users?email=eq.${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      visits,
      last_visit: lastVisit
    })
  });

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
      o2Preference: (user.o2_preference !== undefined && user.o2_preference !== null) ? parseFloat(user.o2_preference) : 1.0
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
    const res = await supabaseFetch(`chat_limits?identifier=eq.${encodeURIComponent(identifier)}`);
    const records = await res.json();
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
    console.error('[Supabase DB] Failed to get limit count:', err);
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
      o2Preference: (user.o2_preference !== undefined && user.o2_preference !== null) ? parseFloat(user.o2_preference) : 1.0
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
    await supabaseFetch(`user_sessions?token=eq.${encodeURIComponent(token)}`, {
      method: 'DELETE'
    });
  } catch (err) {
    console.error('[Supabase DB] Logout session error:', err);
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

  await supabaseFetch(`users?email=eq.${encodeURIComponent(user.email)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      premium_until: premiumUntil.toISOString(),
      premium_tier: chosenTier,
      auto_renew: !!autoRenew
    })
  });

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
    const userRes = await supabaseFetch(`users?email=eq.${encodeURIComponent(email)}`);
    const users = await userRes.json();
    if (users.length > 0) {
      const u = users[0];
      const visits = (u.visits || 0) + 1;
      const lastVisit = new Date().toISOString();

      await supabaseFetch(`users?email=eq.${encodeURIComponent(email)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visits,
          last_visit: lastVisit
        })
      });
    }
  } catch (err) {
    console.error('[Supabase DB] Failed to increment user visits:', err);
  }
}

// 7. Increment user asked questions count
export async function incrementUserQuestions(email) {
  try {
    const userRes = await supabaseFetch(`users?email=eq.${encodeURIComponent(email)}`);
    const users = await userRes.json();
    if (users.length > 0) {
      const u = users[0];
      const questions = (u.questions || 0) + 1;

      await supabaseFetch(`users?email=eq.${encodeURIComponent(email)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questions
        })
      });
    }
  } catch (err) {
    console.error('[Supabase DB] Failed to increment user questions:', err);
  }
}

// 8. Increment user active session seconds spent
export async function incrementUserTimeSpent(email, seconds) {
  try {
    const userRes = await supabaseFetch(`users?email=eq.${encodeURIComponent(email)}`);
    const users = await userRes.json();
    if (users.length > 0) {
      const u = users[0];
      const secondsSpent = (u.seconds_spent || 0) + seconds;

      await supabaseFetch(`users?email=eq.${encodeURIComponent(email)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seconds_spent: secondsSpent
        })
      });
    }
  } catch (err) {
    console.error('[Supabase DB] Failed to increment user time spent:', err);
  }
}

// 9. Fetch and format all user statistics for admin report
export async function getAllUsersFromDb() {
  const res = await supabaseFetch('users');
  const dbUsers = await res.json();
  
  return dbUsers.map(u => {
    return {
      email: u.email,
      name: u.name,
      created_at: u.created_at,
      premium_tier: u.premium_tier,
      visits: u.visits || 0,
      last_visit: u.last_visit || u.created_at || null,
      questions: u.questions || 0,
      hours_spent: parseFloat(((u.seconds_spent || 0) / 3600).toFixed(2)),
      auto_renew: !!u.auto_renew
    };
  });
}

// 10. Delete user and their associated data
export async function deleteUserFromDb(email) {
  try {
    // delete user sessions
    await supabaseFetch(`user_sessions?email=eq.${encodeURIComponent(email)}`, {
      method: 'DELETE'
    });
  } catch (err) {
    console.error('[Supabase DB] Failed to delete user sessions:', err);
  }

  try {
    // delete chat limits
    const identifier = `user:${email}`;
    await supabaseFetch(`chat_limits?identifier=eq.${encodeURIComponent(identifier)}`, {
      method: 'DELETE'
    });
  } catch (err) {
    console.error('[Supabase DB] Failed to delete chat limits:', err);
  }

  try {
    // delete user
    await supabaseFetch(`users?email=eq.${encodeURIComponent(email)}`, {
      method: 'DELETE'
    });
  } catch (err) {
    console.error('[Supabase DB] Failed to delete user:', err);
    throw err;
  }
}

// 11. Save chat message to history
export async function saveChatMessage(identifier, role, message, context = null) {
  try {
    await supabaseFetch('chat_history', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        identifier,
        role,
        message,
        context: context ? (typeof context === 'object' ? context : JSON.parse(context)) : null
      })
    });
  } catch (err) {
    console.warn('[Supabase DB] Failed to save chat message (make sure chat_history table is created in Supabase):', err.message);
  }
}

// 12. Load chat history for identifier
export async function getChatHistory(identifier, limit = 50) {
  try {
    const res = await supabaseFetch(`chat_history?identifier=eq.${encodeURIComponent(identifier)}&order=created_at.asc&limit=${limit}`);
    return await res.json();
  } catch (err) {
    console.warn('[Supabase DB] Failed to load chat history (make sure chat_history table is created in Supabase):', err.message);
    return [];
  }
}

// 13. Update user O2 preference
export async function updateUserO2Preference(email, o2Val) {
  try {
    await supabaseFetch(`users?email=eq.${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        o2_preference: o2Val
      })
    });
  } catch (err) {
    console.error('[Supabase DB] Failed to update O2 preference:', err);
    throw err;
  }
}
