import { defineConfig, loadEnv } from 'vite';
import fs from 'fs';
import path from 'path';
import highsLoader from 'highs';
import { trackVisit, trackChatQuery } from './tracker.js';
import { checkLimitAndIncrement, verifyGoogleTokenAndLogin, getUserStatus, logoutSession, simulatePremiumPayment, getUserByToken, incrementUserVisits, incrementUserQuestions, incrementUserTimeSpent, getAllUsersFromDb, deleteUserFromDb, saveChatMessage, getChatHistory, updateUserO2Preference, upsertSessionState } from './src/supabase_db.js';
import { solveFba, startActiveTimeFlusher, getOrCreateSimulation, serializeSimulation } from './src/fba_solver_core.js';

// Load static bounds once on startup
const staticBoundsPath = path.resolve('src/static_bounds.json');
let staticBounds = {};
if (fs.existsSync(staticBoundsPath)) {
  staticBounds = JSON.parse(fs.readFileSync(staticBoundsPath, 'utf8'));
}

const lpHeaderPath = path.resolve('public/static_lp_header.txt');
let staticLpHeader = '';
if (fs.existsSync(lpHeaderPath)) {
  staticLpHeader = fs.readFileSync(lpHeaderPath, 'utf8');
}

// Initialize HiGHS solver lazily
let highs = null;
let highsPromise = null;
const solveFbaRateLimits = new Map();

function getHighs() {
  if (!highsPromise) {
    highsPromise = highsLoader().then(h => {
      highs = h;
      console.log('[Vite Dev Server] HiGHS solver loaded successfully.');
      return h;
    }).catch(err => {
      console.error('[Vite Dev Server] Failed to load HiGHS solver:', err);
      highsPromise = null; // reset to try again
      throw err;
    });
  }
  return highsPromise;
}



export default defineConfig(({ mode }) => {
  // Load env variables to ensure credentials are available on process.env
  const env = loadEnv(mode, process.cwd(), '');
  for (const [key, value] of Object.entries(env)) {
    if (key) {
      process.env[key] = value;
    }
  }

  const handleTrackVisit = async (req, res, next) => {
    trackVisit(req).catch(err => console.error('[Vite Dev Server] Visit tracking error:', err));
    next();
  };

  const getPostBody = (req) => {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({});
        }
      });
      req.on('error', err => reject(err));
    });
  };

  const handleSolveFba = async (req, res, next) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/solve-fba' && req.method === 'POST') {
      try {
        if (!highs) {
          try {
            await getHighs();
          } catch (e) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Solver failed to initialize: ' + e.message }));
            return;
          }
        }

        const guestId = req.headers['x-guest-id'] || 'unknown';
        
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(token) : null;

        if (!user) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Пожалуйста, авторизуйтесь для работы с симулятором.' }));
          return;
        }

        const sessionId = req.headers['x-session-id'] || 'default_user';
        
        // Rate limit check: max 1 request per 150ms per sessionId
        const now = Date.now();
        const lastTime = solveFbaRateLimits.get(sessionId);
        if (lastTime && (now - lastTime < 150)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Rate limit exceeded. Please wait.' }));
          return;
        }
        solveFbaRateLimits.set(sessionId, now);

        const body = await getPostBody(req);
        const concentrations = body.concentrations || {};
        const parameters = body.parameters || {};

        const options = {
          guestId: sessionId,
          reset: body.reset,
          scenario: body.scenario,
          userEmail: user.email
        };

        const sim = await getOrCreateSimulation(sessionId, user.email);
        const result = solveFba(highs, staticLpHeader, concentrations, parameters, options);

        if (sim) {
          // Async state save in background
          const state = serializeSimulation(sim);
          upsertSessionState(sessionId, user.email, state).catch(err => {
            console.error('[Solver] Failed to save session to DB:', err);
          });
        }

        const totalActual = (user.solver_ticks || 0) + (sim ? (sim.solverTicksBuffer || 0) : 0);
        result.solverTicks = totalActual;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('Error in solve-fba API (Vite Dev):', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      next();
    }
  };

  const handleAuth = async (req, res, next) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    
    if (url.pathname === '/api/auth/google' && req.method === 'POST') {
      try {
        const { credential } = await getPostBody(req);
        if (!credential) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing credential.' }));
          return;
        }
        const session = await verifyGoogleTokenAndLogin(credential);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session));
      } catch (err) {
        console.error('Vite Auth Google error:', err);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (url.pathname === '/api/auth/status' && req.method === 'GET') {
      try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const guestId = req.headers['x-guest-id'];
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        const timeZone = req.headers['x-timezone'];

        const visit = url.searchParams.get('visit') === 'true';
        let status = await getUserStatus(token, ip, guestId, timeZone);
        if (visit && status.loggedIn && status.user) {
          await incrementUserVisits(status.user.email);
          status = await getUserStatus(token, ip, guestId, timeZone);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
      } catch (err) {
        console.error('Vite Auth Status error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        if (token) {
          await logoutSession(token);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error('Vite Logout error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }

    } else if (url.pathname === '/api/admin/reports/users' && req.method === 'GET') {
      try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        if (!token) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized.' }));
          return;
        }
        const user = await getUserByToken(token);
        if (!user || user.email !== 'fbhcdbhf@gmail.com') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden.' }));
          return;
        }
        const users = await getAllUsersFromDb();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(users));
      } catch (err) {
        console.error('Vite Admin Users report error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (url.pathname.startsWith('/api/admin/users/') && req.method === 'DELETE') {
      try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        if (!token) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized.' }));
          return;
        }
        const user = await getUserByToken(token);
        if (!user || user.email !== 'fbhcdbhf@gmail.com') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden.' }));
          return;
        }
        
        const targetEmail = decodeURIComponent(url.pathname.substring('/api/admin/users/'.length));
        if (!targetEmail) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Email parameter is required.' }));
          return;
        }
        
        await deleteUserFromDb(targetEmail);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error('Vite Admin Delete User error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (url.pathname === '/api/payments/simulate' && req.method === 'POST') {
      try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        if (!token) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized.' }));
          return;
        }
        const { tier, autoRenew } = await getPostBody(req);
        const result = await simulatePremiumPayment(token, tier, autoRenew);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('Vite Payment simulation error:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (url.pathname === '/api/user/preferences' && req.method === 'PATCH') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } else {
      next();
    }
  };

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

  const handleChat = async (req, res, next) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      try {
        const body = await getPostBody(req);
        const { message, history, context } = body;
        const apiKey = process.env.GOOGLE_API_KEY;
        if (!apiKey) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'GOOGLE_API_KEY is not configured on the server.' }));
          return;
        }

        // Rate-limiting check via Supabase
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const guestId = req.headers['x-guest-id'];
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        const timeZone = req.headers['x-timezone'];

        const limitCheck = await checkLimitAndIncrement(ip, guestId, token, timeZone);
        if (!limitCheck.user) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Authentication required. Please sign in.' }));
          return;
        }
        if (!limitCheck.allowed) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Limit Reached' }));
          return;
        }

        await incrementUserQuestions(limitCheck.user.email);

        const identifier = `user:${limitCheck.user.email}`;
        // Save user's question to Supabase history
        await saveChatMessage(identifier, 'user', message, context);

        const systemPrompt = `You are a helpful and expert AI Metabolic Assistant for a student using the E. coli Metabolic Live Atlas.
Your goal is to guide the student, explain how pathways work, answer their questions about E. coli metabolism, and help them with the interactive learning scenarios.

IMPORTANT: Respond in the same language as the user's query. Keep your answer concise, scientifically accurate, and encouraging.

CRITICAL WARNING: The user interacts with a live simulation, meaning that fluxes, growth rates, and concentrations change in real time with every user action. Always look up all values, rates, and statuses from the CURRENT simulation state context below. DO NOT reuse numbers, fluxes (e.g. CYTBO3_4pp, growth rate, etc.) or parameter values from previous messages in the chat history, as they are now stale and incorrect.

NOTE: The active model and map are based on the genome-scale E. coli iJO1366 reconstruction (specifically its central carbon metabolism map), NOT the simplified e_coli_core model. The primary growth rate / biomass reaction is BIOMASS_Ec_iJO1366_core_53p95M. Keep this in mind when discussing pathways, connections, and reactions on the screen.

Here is the current state of the metabolic simulation on the student's screen:
${JSON.stringify(context, null, 2)}
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
        trackChatQuery(req, message, usageMetadata).catch(err => console.error('[Vite Dev Server] Chat tracking error:', err));
        
        // Save model's reply to Supabase history
        await saveChatMessage(identifier, 'model', reply);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply, remaining: limitCheck.remaining }));
      } catch (err) {
        console.error('Error in chat API (Vite Dev):', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      next();
    }
  };

  const handleChatHistory = async (req, res, next) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/chat/history' && req.method === 'GET') {
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(history));
      } catch (err) {
        console.error('Error in chat history API (Vite Dev):', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      next();
    }
  };

  return {
    build: {
      chunkSizeWarningLimit: 1000
    },
    preview: {
      port: parseInt(process.env.PORT || '8080', 10),
      host: '0.0.0.0',
      allowedHosts: true
    },
    plugins: [
      {
        name: 'fba-solver-middleware',
        configureServer(server) {
          getHighs().catch(() => {}); // start loading solver in the background on dev server startup
          startActiveTimeFlusher();
          server.middlewares.use(handleTrackVisit);
          server.middlewares.use(handleSolveFba);
          server.middlewares.use(handleAuth);
          server.middlewares.use(handleChatHistory);
          server.middlewares.use(handleChat);
        },
        configurePreviewServer(server) {
          getHighs().catch(() => {});
          startActiveTimeFlusher();
          server.middlewares.use(handleTrackVisit);
          server.middlewares.use(handleSolveFba);
          server.middlewares.use(handleAuth);
          server.middlewares.use(handleChatHistory);
          server.middlewares.use(handleChat);
        }
      }
    ]
  };
});
