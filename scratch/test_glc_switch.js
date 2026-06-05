import fs from 'fs';
import path from 'path';
import highsLoader from 'highs';

const staticBounds = JSON.parse(fs.readFileSync('./src/static_bounds.json', 'utf8'));
const staticLpHeader = fs.readFileSync('./public/static_lp_header.txt', 'utf8');

function calculateBounds(concentrations, parameters) {
  const bounds = {};
  const defaultBlocked = ['PFK_3', 'FBA3', 'F6PA', 'GLCDpp', 'XYLI2', 'GLCabcpp'];
  const coupledCheckpoints = new Set(['GLCptspp', 'PFK', 'PYK', 'CS', 'ICDHyr', 'SUCDi']);
  
  const reactionSubstrates = {
    'GLCptspp': ['pep_c'],
    'PFK': ['f6p_c'],
    'PYK': ['pep_c'],
    'CS': ['accoa_c', 'oaa_c'],
    'ICDHyr': ['icit_c'],
    'SUCDi': ['succ_c']
  };
  const reactionProducts = {
    'GLCptspp': [],
    'PFK': ['fdp_c'],
    'PYK': ['pyr_c'],
    'CS': ['cit_c'],
    'ICDHyr': ['akg_c'],
    'SUCDi': ['fum_c']
  };

  for (const rxnId of Object.keys(staticBounds)) {
    const orig = staticBounds[rxnId];
    if (defaultBlocked.includes(rxnId)) {
      bounds[rxnId] = { lowerBound: 0.0, upperBound: 0.0 };
      continue;
    }

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

    const param = parameters[rxnId] || {};
    const vMax = param.vMax !== undefined ? param.vMax : defaultVmax;
    const km = param.km !== undefined ? param.km : defaultKm;

    if (coupledCheckpoints.has(rxnId)) {
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

async function solveFba(highs, concentrations, parameters) {
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
  const sol = highs.solve(lpString, { "log_to_console": false, "output_flag": false });
  
  if (sol.Status === 'Optimal') {
    const columns = sol.Columns;
    return {
      status: sol.Status,
      biomass: columns['R_BIOMASS_Ec_iJO1366_core_53p95M']?.Primal || 0.0,
      glc_pts: columns['R_GLCptspp']?.Primal || 0.0,
      glc_t2: columns['R_GLCt2pp']?.Primal || 0.0,
      hex1: columns['R_HEX1']?.Primal || 0.0
    };
  } else {
    return { status: sol.Status, biomass: 0, glc_pts: 0, glc_t2: 0, hex1: 0 };
  }
}

async function run() {
  const highs = await highsLoader();
  
  const concentrations = {
    'pep_c': 1.0,
    'f6p_c': 1.0,
    'pyr_c': 1.0,
    'cit_c': 1.0,
    'akg_c': 1.0,
    'fum_c': 1.0,
    'succ_c': 1.0,
    'accoa_c': 1.0,
    'oaa_c': 1.0,
    'icit_c': 1.0,
    'fdp_c': 1.0
  };

  console.log('=== CASE 1: GLCptspp active (Vmax = 18.0) ===');
  const res1 = await solveFba(highs, concentrations, {
    'GLCptspp': { vMax: 18.0, km: 0.5 }
  });
  console.log(res1);

  console.log('\n=== CASE 2: GLCptspp blocked (Vmax = 0.0) ===');
  const res2 = await solveFba(highs, concentrations, {
    'GLCptspp': { vMax: 0.0, km: 0.5 }
  });
  console.log(res2);
}

run();
