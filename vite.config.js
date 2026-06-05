import { defineConfig, loadEnv } from 'vite';
import fs from 'fs';
import path from 'path';
import highsLoader from 'highs';
import { trackVisit } from './tracker.js';
import { checkLimitAndIncrement, verifyGoogleTokenAndLogin, getUserStatus, logoutSession, simulatePremiumPayment } from './src/supabase_db.js';

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

function calculateBounds(concentrations, parameters) {
  const bounds = {};
  
  // Define default blocked bypasses
  const defaultBlocked = [
    'PFK_3', 'FBA3', 'F6PA', 'GLCDpp', 'XYLI2', 'GLCabcpp',
    'HPYRI', 'PROt2rpp', 'CA2t3pp', 'R15BPK', 'VPAMTr', 'ADK3'
  ];
  
  // Define coupled checkpoints
  const coupledCheckpoints = new Set(['GLCptspp', 'PFK', 'PYK', 'CS', 'ICDHyr', 'SUCDi']);
  
  // Stoichiometry needed for kinetic bounds calculation
  const reactionSubstrates = {
    'GLCptspp': ['pep_c'], // glc__D_p is buffered, only pep_c is checked
    'PFK': ['f6p_c'], // atp_c is buffered
    'PYK': ['pep_c'], // adp_c, h_c are buffered
    'CS': ['accoa_c', 'oaa_c'], // h2o_c is buffered
    'ICDHyr': ['icit_c'], // nadp_c is buffered
    'SUCDi': ['succ_c'] // q8_c is buffered
  };
  const reactionProducts = {
    'GLCptspp': [], // no reversible check
    'PFK': ['fdp_c'],
    'PYK': ['pyr_c'],
    'CS': ['cit_c'],
    'ICDHyr': ['akg_c'],
    'SUCDi': ['fum_c']
  };

  for (const rxnId of Object.keys(staticBounds)) {
    const orig = staticBounds[rxnId];

    // Apply default blocked bypasses
    if (defaultBlocked.includes(rxnId)) {
      bounds[rxnId] = { lowerBound: 0.0, upperBound: 0.0 };
      continue;
    }

    // Default Vmax and Km parameters (client simulation defaults)
    let defaultVmax = 10.0;
    let defaultKm = 0.8;

    if (rxnId === 'GLCptspp' || rxnId === 'EX_glc__D_e') {
      defaultVmax = 18.0;
      defaultKm = 0.5;
    } else if (rxnId === 'PFK' || rxnId === 'PYK') {
      defaultVmax = 15.0;
      defaultKm = 0.3;
    } else if (rxnId === 'CS' || rxnId === 'ICDHyr') {
      defaultVmax = 12.0;
      defaultKm = 0.4;
    } else if (rxnId === 'BIOMASS_Ecoli_core_w_GAM') {
      defaultVmax = 8.0;
      defaultKm = 1.0;
    }

    // Get current Vmax/Km (overridden by student if present in parameters)
    const param = parameters[rxnId] || {};
    const vMax = param.vMax !== undefined ? param.vMax : defaultVmax;
    const km = param.km !== undefined ? param.km : defaultKm;

    if (coupledCheckpoints.has(rxnId)) {
      // Check reversibility
      const isReversible = (orig.lb < -1e-5);

      if (isReversible) {
        let ubForward = vMax;
        let ubBackward = vMax;

        const subs = reactionSubstrates[rxnId] || [];
        for (const sId of subs) {
          const conc = concentrations[sId] !== undefined ? concentrations[sId] : 1.0;
          ubForward = Math.min(ubForward, vMax * (conc / (km + conc)));
        }
        const prods = reactionProducts[rxnId] || [];
        for (const pId of prods) {
          const conc = concentrations[pId] !== undefined ? concentrations[pId] : 1.0;
          ubBackward = Math.min(ubBackward, vMax * (conc / (km + conc)));
        }

        bounds[rxnId] = { lowerBound: -ubBackward, upperBound: ubForward };
      } else {
        let ubForward = vMax;
        const subs = reactionSubstrates[rxnId] || [];
        for (const sId of subs) {
          const conc = concentrations[sId] !== undefined ? concentrations[sId] : 1.0;
          ubForward = Math.min(ubForward, vMax * (conc / (km + conc)));
        }

        bounds[rxnId] = { lowerBound: 0.0, upperBound: ubForward };
      }
    } else {
      bounds[rxnId] = { lowerBound: orig.lb, upperBound: orig.ub };
    }
  }

  return bounds;
}

export default defineConfig(({ mode }) => {
  // Load env variables to ensure Telegram credentials are available on process.env
  const env = loadEnv(mode, process.cwd(), '');
  process.env.TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID;

  const handleTrackVisit = async (req, res, next) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      trackVisit(req).catch(err => console.error('[Vite Dev Server] Visit tracking error:', err));
    }
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

        const body = await getPostBody(req);
        const concentrations = body.concentrations || {};
        const parameters = body.parameters || {};

        const bounds = calculateBounds(concentrations, parameters);

        const boundsLines = [];
        for (const [rxnId, b] of Object.entries(bounds)) {
          const formatBound = (val, isUpper) => {
            if (val === null || val === undefined) return isUpper ? 'inf' : '-inf';
            if (val === Infinity || val >= 999999) return 'inf';
            if (val === -Infinity || val <= -999999) return '-inf';
            return val.toString();
          };
          boundsLines.push(`  ${formatBound(b.lowerBound, false)} <= R_${rxnId} <= ${formatBound(b.upperBound, true)}`);
        }

        const lpString = staticLpHeader + boundsLines.join('\n') + '\nEnd';

        const sol = highs.solve(lpString, {
          "log_to_console": false,
          "output_flag": false
        });

        if (sol.Status === 'Optimal') {
          const columns = sol.Columns;
          const fluxes = {};
          for (const colName of Object.keys(columns)) {
            if (colName.startsWith('R_')) {
              const rxnId = colName.substring(2);
              fluxes[rxnId] = columns[colName].Primal;
            }
          }
          const biomassFlux = columns['R_BIOMASS_Ec_iJO1366_core_53p95M']?.Primal || 0.0;
          const isDead = biomassFlux < 0.005;

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: sol.Status,
            fluxes,
            biomass_flux: biomassFlux,
            is_dead: isDead
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: sol.Status,
            fluxes: {},
            biomass_flux: 0.0,
            is_dead: true
          }));
        }
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
        
        const status = await getUserStatus(token, ip, guestId);
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
    } else if (url.pathname === '/api/payments/simulate' && req.method === 'POST') {
      try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        if (!token) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized.' }));
          return;
        }
        const result = await simulatePremiumPayment(token);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('Vite Payment simulation error:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      next();
    }
  };

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

        const limitCheck = await checkLimitAndIncrement(ip, guestId, token);
        if (!limitCheck.allowed) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Limit Reached' }));
          return;
        }

        const systemPrompt = `You are a helpful and expert AI Metabolic Assistant for a student using the E. coli Metabolic Live Atlas.
Your goal is to guide the student, explain how pathways work, answer their questions about E. coli metabolism, and help them with the interactive learning scenarios.

IMPORTANT: Respond in the language of the user's query (e.g. if the user asks a question in Russian, reply in Russian; if in English, reply in English; etc.). Keep your answer concise, scientifically accurate, and encouraging.

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

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
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
          server.middlewares.use(handleTrackVisit);
          server.middlewares.use(handleSolveFba);
          server.middlewares.use(handleAuth);
          server.middlewares.use(handleChat);
        },
        configurePreviewServer(server) {
          getHighs().catch(() => {});
          server.middlewares.use(handleTrackVisit);
          server.middlewares.use(handleSolveFba);
          server.middlewares.use(handleAuth);
          server.middlewares.use(handleChat);
        }
      }
    ]
  };
});
