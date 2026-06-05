import express from 'express';
import fs from 'fs';
import path from 'path';
import highsLoader from 'highs';

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
  const defaultBlocked = ['PFK_3', 'FBA3', 'F6PA', 'GLCDpp', 'XYLI2', 'GLCabcpp'];
  
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

  // We only calculate bounds for reactions that are blocked, coupled, or modified
  const reactionsToProcess = new Set([
    ...defaultBlocked,
    ...coupledCheckpoints,
    ...Object.keys(parameters)
  ]);

  for (const rxnId of reactionsToProcess) {
    const orig = staticBounds[rxnId];
    if (!orig) continue;

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

    // Check reversibility
    const isReversible = (orig.lb < -1e-5);

    if (isReversible) {
      let ubForward = vMax;
      let ubBackward = vMax;

      if (coupledCheckpoints.has(rxnId)) {
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
      }

      const lb = -ubBackward;
      const ub = ubForward;
      bounds[rxnId] = { lowerBound: lb, upperBound: ub };
    } else {
      let ubForward = vMax;
      if (coupledCheckpoints.has(rxnId)) {
        const subs = reactionSubstrates[rxnId] || [];
        for (const sId of subs) {
          const conc = concentrations[sId] !== undefined ? concentrations[sId] : 1.0;
          ubForward = Math.min(ubForward, vMax * (conc / (km + conc)));
        }
      }

      const lb = 0.0;
      const ub = ubForward;
      bounds[rxnId] = { lowerBound: lb, upperBound: ub };
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

      return res.json({
        status: sol.Status,
        fluxes,
        biomass_flux: biomassFlux
      });
    } else {
      return res.json({
        status: sol.Status,
        fluxes: {},
        biomass_flux: 0.0
      });
    }
  } catch (err) {
    console.error('Error in solve-fba API:', err);
    return res.status(500).json({ error: err.message });
  }
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
