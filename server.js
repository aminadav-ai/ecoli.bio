import express from 'express';
import compression from 'compression';
import fs from 'fs';
import path from 'path';
import highsLoader from 'highs';
import { trackVisit, trackChatQuery } from './tracker.js';
import { checkLimitAndIncrement, verifyGoogleTokenAndLogin, getUserStatus, logoutSession, simulatePremiumPayment, getUserByToken, incrementUserVisits, incrementUserQuestions, incrementUserTimeSpent, getAllUsersFromDb, deleteUserFromDb, saveChatMessage, getChatHistory, updateUserO2Preference } from './src/supabase_db.js';
import { solveFba, startActiveTimeFlusher, getOrCreateSimulation } from './src/fba_solver_core.js';

// Load env variables from .env file locally if it exists
if (fs.existsSync('.env')) {
  const envConfig = fs.readFileSync('.env', 'utf8');
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

const app = express();
app.use(compression());
const PORT = process.env.PORT || 8080;
const solveFbaRateLimits = new Map();

app.use(express.json());

// Load static bounds and LP header once on startup
const staticBoundsPath = path.resolve('src/static_bounds.json');
let staticBounds = {};
if (fs.existsSync(staticBoundsPath)) {
  staticBounds = JSON.parse(fs.readFileSync(staticBoundsPath, 'utf8'));
} else {
  console.warn(`[Server] Warning: static_bounds.json not found at ${staticBoundsPath}`);
}

const lpHeaderPath = path.resolve('public/static_lp_header.txt');
let staticLpHeader = '';
if (fs.existsSync(lpHeaderPath)) {
  staticLpHeader = fs.readFileSync(lpHeaderPath, 'utf8');
} else {
  console.warn(`[Server] Warning: static_lp_header.txt not found at ${lpHeaderPath}`);
}

// Initialize HiGHS solver
let highs = null;
highsLoader().then(h => {
  highs = h;
  console.log('[Server] HiGHS solver loaded successfully.');
}).catch(err => {
  console.error('[Server] Failed to load HiGHS solver:', err);
});

// API Endpoints
app.post('/api/solve-fba', async (req, res) => {
  try {
    if (!highs) {
      return res.status(503).json({ error: 'Solver is still initializing' });
    }

    const guestId = req.headers['x-guest-id'] || req.ip;
    
    // Rate limit check: max 1 request per 150ms per guestId
    const now = Date.now();
    const lastTime = solveFbaRateLimits.get(guestId);
    if (lastTime && (now - lastTime < 150)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please wait.' });
    }
    solveFbaRateLimits.set(guestId, now);

    const concentrations = req.body.concentrations || {};
    const parameters = req.body.parameters || {};

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    const user = token ? await getUserByToken(token) : null;

    const options = {
      guestId,
      reset: req.body.reset,
      scenario: req.body.scenario,
      userEmail: user ? user.email : null
    };

    const result = solveFba(highs, staticLpHeader, concentrations, parameters, options);
    if (user) {
      const sim = getOrCreateSimulation(guestId);
      if (sim && !sim.userEmail) {
        sim.userEmail = user.email;
      }
      const now = Date.now();
      const elapsedSeconds = Math.min(75, (now - (sim ? sim.lastFlushTime : now)) / 1000);
      const totalActual = (user.solver_ticks || 0) + (sim ? (sim.solverTicksBuffer || 0) : 0);
      const totalPossible = (user.possible_solver_ticks ? parseInt(user.possible_solver_ticks, 10) : 0) +
                            (sim ? Math.floor((sim.possibleTicksBuffer || 0) + (elapsedSeconds * 4)) : 0);
      result.solverTicks = totalActual;
      result.solverLoad = totalPossible > 0 ? (totalActual / totalPossible) : 0.0;
    }
    return res.json(result);
  } catch (err) {
    console.error('Error in solve-fba API:', err);
    return res.status(500).json({ error: err.message });
  }
});

async function fetchGeminiWithRetry(url, options, retries = 2, delay = 1000) {
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 503 || response.status === 429) {
        if (i < retries) {
          console.warn(`[Gemini API] Got status ${response.status}. Retrying in ${delay}ms... (Attempt ${i + 1}/${retries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
      return response;
    } catch (err) {
      if (i < retries) {
        console.warn(`[Gemini API] Fetch failed: ${err.message}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history, context } = req.body;
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GOOGLE_API_KEY is not configured on the server.' });
    }

    // Rate-limiting check via Supabase
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    const guestId = req.headers['x-guest-id'];
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const timeZone = req.headers['x-timezone'];

    const limitCheck = await checkLimitAndIncrement(ip, guestId, token, timeZone);
    if (!limitCheck.user) {
      return res.status(401).json({ error: 'Authentication required. Please sign in.' });
    }
    if (!limitCheck.allowed) {
      return res.status(403).json({ error: 'Limit Reached' });
    }

    await incrementUserQuestions(limitCheck.user.email);

    const identifier = `user:${limitCheck.user.email}`;
    // Save user's question to Supabase history
    await saveChatMessage(identifier, 'user', message, context);

    const systemPrompt = `You are a helpful and expert AI Metabolic Assistant for a student using the E. coli Metabolic Live Atlas.

CRITICAL WARNING: The user interacts with a live simulation, meaning that fluxes, growth rates, and concentrations change in real time with every user action. Always look up all values, rates, and statuses from the CURRENT simulation state context below. DO NOT reuse numbers, fluxes (e.g. CYTBO3_4pp, growth rate, etc.) or parameter values from previous messages in the chat history, as they are now stale and incorrect.

Here is the current state of the metabolic simulation on the student's screen:
${JSON.stringify(context, null, 2)}

Instructions:
1. Explain metabolism in simple, clear terms (undergraduate biology level).
2. Use BiGG IDs (e.g. GLCptspp, PFK, PGI, PDH, PFL) when discussing specific reactions, but also mention their common names.
3. If a scenario is active, guide the student through it. If they submit an answer or ask a question about it, evaluate it and explain the biology (e.g. why PDH is more ATP-efficient than PFL, or why Vmax causes metabolic bottlenecks).
4. Do not make up facts. E. coli central metabolism is standard (glycolysis, pentose phosphate pathway, TCA cycle, respiration, fermentation).
`;

    const contents = [];
    if (history && history.length > 0) {
      for (const msg of history) {
        contents.push({
          role: msg.role === 'model' ? 'model' : 'user',
          parts: [{ text: msg.text }]
        });
      }
    }
    contents.push({
      role: 'user',
      parts: [{ text: message }]
    });

    const response = await fetchGeminiWithRetry(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents,
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API returned ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sorry, failed to get a response from the AI.';
    const usageMetadata = data.usageMetadata;

    // Track user's AI chat query in Telegram background (now with token counts!)
    trackChatQuery(req, message, usageMetadata).catch(err => console.error('[Server] Chat tracking error:', err));
    
    // Save model's reply to Supabase history
    await saveChatMessage(identifier, 'model', reply);

    return res.json({ reply, remaining: limitCheck.remaining });
  } catch (err) {
    console.error('Error in /api/chat API:', err);
    return res.status(500).json({ error: err.message });
  }
});

// OAuth and Subscription Routes
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: 'Missing credential.' });
    }
    const session = await verifyGoogleTokenAndLogin(credential);
    return res.json(session);
  } catch (err) {
    console.error('Auth Google error:', err);
    return res.status(401).json({ error: err.message });
  }
});

app.get('/api/chat/history', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    const guestId = req.headers['x-guest-id'];
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

    let identifier = `guest:${guestId || ip || 'unknown'}`;
    if (token) {
      const user = await getUserByToken(token);
      if (user && user.email) {
        identifier = `user:${user.email}`;
      }
    }

    const history = await getChatHistory(identifier);
    return res.json(history);
  } catch (err) {
    console.error('Error in /api/chat/history API:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/status', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    const guestId = req.headers['x-guest-id'];
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const timeZone = req.headers['x-timezone'];
    const visit = req.query.visit === 'true';
    
    let status = await getUserStatus(token, ip, guestId, timeZone);
    if (visit && status.loggedIn && status.user) {
      await incrementUserVisits(status.user.email);
      status = await getUserStatus(token, ip, guestId, timeZone);
    }
    return res.json(status);
  } catch (err) {
    console.error('Auth Status error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    if (token) {
      await logoutSession(token);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/heartbeat', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    const guestId = req.headers['x-guest-id'];
    let secondsSpent = null;
    let solverTicks = null;
    let possibleSolverTicks = null;
    let solverLoad = null;
    if (token) {
      const user = await getUserByToken(token);
      if (user) {
        const sim = getOrCreateSimulation(guestId);
        if (sim) {
          sim.userEmail = user.email;
        }
        const now = Date.now();
        const elapsedSeconds = Math.min(75, (now - (sim ? sim.lastFlushTime : now)) / 1000);
        
        secondsSpent = (user.seconds_spent || 0) + (sim ? Math.floor((sim.activeTimeBuffer || 0) + elapsedSeconds) : 0);
        solverTicks = (user.solver_ticks || 0) + (sim ? (sim.solverTicksBuffer || 0) : 0);
        possibleSolverTicks = (user.possible_solver_ticks ? parseInt(user.possible_solver_ticks, 10) : 0) +
                              (sim ? Math.floor((sim.possibleTicksBuffer || 0) + (elapsedSeconds * 4)) : 0);
        solverLoad = possibleSolverTicks > 0 ? (solverTicks / possibleSolverTicks) : 0.0;
      }
    }
    return res.json({
      success: true,
      secondsSpent: secondsSpent || 0,
      solverTicks: solverTicks || 0,
      possibleSolverTicks: possibleSolverTicks || 0,
      solverLoad: solverLoad || 0.0
    });
  } catch (err) {
    console.error('Heartbeat error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/reports/users', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    const user = await getUserByToken(token);
    if (!user || user.email !== 'fbhcdbhf@gmail.com') {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    const users = await getAllUsersFromDb();
    return res.json(users);
  } catch (err) {
    console.error('Admin Users report error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:email', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    const user = await getUserByToken(token);
    if (!user || user.email !== 'fbhcdbhf@gmail.com') {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    const targetEmail = req.params.email;
    if (!targetEmail) {
      return res.status(400).json({ error: 'Email parameter is required.' });
    }
    await deleteUserFromDb(targetEmail);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin Delete User error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/payments/simulate', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    const { tier, autoRenew } = req.body || {};
    const result = await simulatePremiumPayment(token, tier, autoRenew);
    return res.json(result);
  } catch (err) {
    console.error('Payment simulation error:', err);
    return res.status(400).json({ error: err.message });
  }
});

app.patch('/api/user/preferences', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    const user = await getUserByToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token.' });
    }
    const { o2Preference } = req.body || {};
    if (o2Preference !== undefined && o2Preference !== null) {
      await updateUserO2Preference(user.email, parseFloat(o2Preference));
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Preferences update error:', err);
    return res.status(500).json({ error: err.message });
  }
});


// Middleware to track visits (including potential scanner requests)
app.use((req, res, next) => {
  trackVisit(req).catch(err => console.error('[Server] Visit tracking error:', err));
  next();
});

// Serve static assets from 'dist' folder
app.use(express.static(path.resolve('dist')));

// SPA Fallback: serve index.html for all non-api routes
app.get('*any', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.resolve('dist/index.html'));
});

// Start listening
app.listen(PORT, () => {
  console.log(`[Server] Production Express server is listening on port ${PORT}`);
  startActiveTimeFlusher();
});
