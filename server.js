import express from 'express';
import fs from 'fs';
import path from 'path';
import highsLoader from 'highs';
import { trackVisit } from './tracker.js';
import { checkLimitAndIncrement, verifyGoogleTokenAndLogin, getUserStatus, logoutSession, simulatePremiumPayment } from './src/supabase_db.js';

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
const PORT = process.env.PORT || 8080;

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

// API Endpoints
app.post('/api/solve-fba', async (req, res) => {
  try {
    if (!highs) {
      return res.status(503).json({ error: 'Solver is still initializing' });
    }

    const concentrations = req.body.concentrations || {};
    const parameters = req.body.parameters || {};

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

      return res.json({
        status: sol.Status,
        fluxes,
        biomass_flux: biomassFlux,
        is_dead: isDead
      });
    } else {
      return res.json({
        status: sol.Status,
        fluxes: {},
        biomass_flux: 0.0,
        is_dead: true
      });
    }
  } catch (err) {
    console.error('Error in solve-fba API:', err);
    return res.status(500).json({ error: err.message });
  }
});

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

    const limitCheck = await checkLimitAndIncrement(ip, guestId, token);
    if (!limitCheck.allowed) {
      return res.status(403).json({ error: 'Limit Reached' });
    }

    const systemPrompt = `You are a helpful and expert AI Metabolic Assistant for a student using the E. coli Metabolic Live Atlas.
Your goal is to guide the student, explain how pathways work, answer their questions about E. coli metabolism, and help them with the interactive learning scenarios.

IMPORTANT: Respond in the language of the user's query (e.g. if the user asks a question in Russian, reply in Russian; if in English, reply in English; etc.). Keep your answer concise, scientifically accurate, and encouraging.

NOTE: The active model and map are based on the genome-scale E. coli iJO1366 reconstruction (specifically its central carbon metabolism map), NOT the simplified e_coli_core model. The primary growth rate / biomass reaction is BIOMASS_Ec_iJO1366_core_53p95M. Keep this in mind when discussing pathways, connections, and reactions on the screen.

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

app.get('/api/auth/status', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    const guestId = req.headers['x-guest-id'];
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    
    const status = await getUserStatus(token, ip, guestId);
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
    const result = await simulatePremiumPayment(token);
    return res.json(result);
  } catch (err) {
    console.error('Payment simulation error:', err);
    return res.status(400).json({ error: err.message });
  }
});


// Middleware to track visits
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    trackVisit(req).catch(err => console.error('[Server] Visit tracking error:', err));
  }
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
});
