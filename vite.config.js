import { defineConfig, loadEnv } from 'vite';
import fs from 'fs';
import path from 'path';
import highsLoader from 'highs';

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

// Initialize HiGHS solver
let highs = null;
highsLoader().then(h => {
  highs = h;
  console.log('[Vite Dev Server] HiGHS solver loaded successfully.');
}).catch(err => {
  console.error('[Vite Dev Server] Failed to load HiGHS solver:', err);
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

export default defineConfig(({ mode }) => {
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
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Solver is still initializing' }));
          return;
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

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: sol.Status,
            fluxes,
            biomass_flux: biomassFlux
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: sol.Status,
            fluxes: {},
            biomass_flux: 0.0
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
          server.middlewares.use(handleSolveFba);
        },
        configurePreviewServer(server) {
          server.middlewares.use(handleSolveFba);
        }
      }
    ]
  };
});
