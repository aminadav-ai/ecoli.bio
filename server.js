import express from 'express';
import compression from 'compression';
import fs from 'fs';
import path from 'path';
import highsLoader from 'highs';
import { trackVisit, trackChatQuery } from './tracker.js';
import { pool, checkLimitAndIncrement, verifyGoogleTokenAndLogin, getUserStatus, logoutSession, simulatePremiumPayment, getUserByToken, incrementUserVisits, incrementUserQuestions, incrementUserTimeSpent, saveChatMessage, getChatHistory, updateUserO2Preference, upsertSessionState, getSessionState, clearCachedUser, bufferUserSolverTicks } from './src/supabase_db.js';
import { initializeDatabase } from './src/db_init.js';
import { solveFba, getOrCreateSimulation, serializeSimulation, deserializeSimulation, precalculateGuestState, getPrecalculatedGuestState } from './src/fba_solver_core.js';

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

// Periodically clean up rate limit entries older than 1 minute to prevent memory leak
const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, lastTime] of solveFbaRateLimits.entries()) {
    if (now - lastTime > 60 * 1000) {
      solveFbaRateLimits.delete(sessionId);
    }
  }
}, 60 * 1000);
if (rateLimitCleanupTimer && typeof rateLimitCleanupTimer.unref === 'function') {
  rateLimitCleanupTimer.unref();
}

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
    
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    const user = token ? await getUserByToken(token) : null;

    if (!user) {
      return res.status(401).json({ error: 'Please sign in to use the simulator.' });
    }

    const sessionId = req.headers['x-session-id'] || 'default_user';
    const concentrations = req.body.concentrations || {};
    const parameters = req.body.parameters || {};

    // Rate limit check: max 1 request per 150ms per sessionId
    const now = Date.now();
    const lastTime = solveFbaRateLimits.get(sessionId);
    if (lastTime && (now - lastTime < 150)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please wait.' });
    }
    solveFbaRateLimits.set(sessionId, now);

    const options = {
      guestId: sessionId,
      reset: req.body.reset,
      scenario: req.body.scenario,
      userEmail: user.email
    };

    const clientTimestamp = req.body.lastTimestamp;
    const sim = await getOrCreateSimulation(sessionId, user.email);

    if (sim && clientTimestamp && sim.lastTimestamp && sim.lastTimestamp !== clientTimestamp) {
      console.log(`[Solver Cache] Stale cache detected for session ${sessionId}. Server: ${sim.lastTimestamp}, Client: ${clientTimestamp}. Reloading from DB.`);
      const dbState = await getSessionState(sessionId);
      if (dbState) {
        deserializeSimulation(sim, dbState);
      }
    }

    const bufferBefore = sim ? sim.solverTicksBuffer : 0;
    const result = solveFba(highs, staticLpHeader, concentrations, parameters, options);
    const bufferAfter = sim ? sim.solverTicksBuffer : 0;

    console.log(`[Solver Debug] User: ${user.email}, Session: ${sessionId}, bufferBefore: ${bufferBefore}, bufferAfter: ${bufferAfter}`);

    if (sim) {
      sim.lastTimestamp = Date.now();
      const state = serializeSimulation(sim);
      // Asynchronously upsert state to database (do not await, prevents blocking response)
      upsertSessionState(sessionId, user.email, state).catch(err => {
        console.error('[Solver] Failed to save session to DB:', err);
      });

      const ticks = sim.solverTicksBuffer || 0;
      console.log(`[Solver Debug] Ticks to buffer: ${ticks}, current user solver_ticks: ${user.solver_ticks}`);
      if (ticks > 0) {
        sim.solverTicksBuffer = 0;
        user.solver_ticks = (user.solver_ticks || 0) + ticks;
        bufferUserSolverTicks(user.email, ticks);
        console.log(`[Solver Debug] Buffered solver_ticks. New local solver_ticks: ${user.solver_ticks}`);
      }
    }

    const totalActual = user.solver_ticks || 0;
    result.solverTicks = totalActual;
    result.lastTimestamp = sim ? sim.lastTimestamp : 0;
    console.log(`[Solver Debug] Returning solverTicks: ${totalActual}`);

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
Your goal is to guide the student, explain how pathways work, answer their questions about E. coli metabolism, and help them with the interactive learning scenarios.

IMPORTANT: Respond in the same language as the user's query (usually Russian or English). Keep your answer concise, scientifically accurate, and encouraging.

CRITICAL WARNING: The user interacts with a live simulation, meaning that fluxes, growth rates, and concentrations change in real time with every user action. Always look up all values, rates, and statuses from the CURRENT simulation state context below. DO NOT reuse numbers, fluxes (e.g. CYTBO3_4pp, growth rate, etc.) or parameter values from previous messages in the chat history, as they are now stale and incorrect.

NOTE: The active model and map shown on the student's screen are based on the genome-scale E. coli iJO1366 reconstruction (specifically its central carbon metabolism map). Almost all reaction and metabolite IDs in the provided context correspond to the standard iJO1366 BiGG IDs (e.g. GLCptspp, PFK, PGI, PDH, PFL, etc.).
However, due to client UI compatibility:
- The primary growth rate / biomass reaction is represented as BIOMASS_Ecoli_core_w_GAM in the reactions dictionary (and as growthRate at the root of the context).
- The ATP production/synthase reaction is represented as ATPS4r in the reactions dictionary (and as atpYield at the root of the context).
The context only contains reactions that are active (non-zero flux) or modified by the user, and metabolites that are active or buffered. All other reactions in the model have zero flux and default parameters, and other metabolites have concentration <= 0.0001 mM.

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
    // guestState is now fetched statically as /guest_state.json
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

app.patch('/api/user/preferences', (req, res) => {
  return res.json({ success: true });
});


// Middleware to track visits (including potential scanner requests)
app.use((req, res, next) => {
  trackVisit(req).catch(err => console.error('[Server] Visit tracking error:', err));
  next();
});

// Serve static assets from 'dist' folder with optimized caching
app.use(express.static(path.resolve('dist'), {
  maxAge: '1d', // Default to 1 day caching for static files
  setHeaders: (res, filePath) => {
    if (filePath.includes('/assets/')) {
      // Vite hashed assets are immutable and cached forever
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (filePath.endsWith('.html')) {
      // HTML entrypoints: must revalidate to check for updates
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  }
}));

// SPA Fallback: serve index.html for all non-api routes
app.get('*any', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.resolve('dist/index.html'));
});

// Start listening
initializeDatabase(pool)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[Server] Production Express server is listening on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('[Server] Database initialization failed. Exiting.', err);
    process.exit(1);
  });
