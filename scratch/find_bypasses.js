import fs from 'fs';
import path from 'path';
import highsLoader from 'highs';

const staticBounds = JSON.parse(fs.readFileSync('./src/static_bounds.json', 'utf8'));
const staticLpHeader = fs.readFileSync('./public/static_lp_header.txt', 'utf8');

// Load map reactions
const mapData = JSON.parse(fs.readFileSync('./public/iJO1366.Central metabolism.json', 'utf8'));
const mapReactions = new Set();
for (const rxn of Object.values(mapData[1].reactions)) {
  mapReactions.add(rxn.bigg_id);
}

// Add exchange reactions, biomass, and other standard ones we know are on map or expected
const commonAllowed = new Set([
  'BIOMASS_Ecoli_core_w_GAM',
  'BIOMASS_Ec_iJO1366_core_53p95M',
  'BIOMASS_Ec_iJO1366_WT_53p95M',
  'ATPS4rpp',
  'ATPS4r',
  'EX_glc__D_e',
  'EX_o2_e',
  'EX_co2_e',
  'EX_h2o_e',
  'EX_h_e',
  'EX_pi_e',
  'EX_nh4_e',
  'EX_so4_e',
  'EX_ac_e',
  'EX_etoh_e',
  'EX_lac__D_e',
  'EX_for_e',
  'EX_succ_e',
  'EX_pyr_e'
]);

function calculateBounds(concentrations, parameters, extraBlocked = []) {
  const bounds = {};
  const defaultBlocked = ['PFK_3', 'FBA3', 'F6PA', 'GLCDpp', 'XYLI2', 'GLCabcpp', ...extraBlocked];
  const coupledCheckpoints = new Set(['GLCptspp', 'PFK', 'PYK', 'CS', 'ICDHyr', 'SUCDi']);

  for (const rxnId of Object.keys(staticBounds)) {
    const orig = staticBounds[rxnId];
    if (defaultBlocked.includes(rxnId)) {
      bounds[rxnId] = { lb: 0.0, ub: 0.0 };
      continue;
    }

    let defaultVmax = 10.0;
    if (rxnId === 'GLCptspp' || rxnId === 'EX_glc__D_e') {
      defaultVmax = 18.0;
    } else if (rxnId === 'PFK' || rxnId === 'PYK') {
      defaultVmax = 15.0;
    } else if (rxnId === 'CS' || rxnId === 'ICDHyr') {
      defaultVmax = 12.0;
    } else if (rxnId === 'BIOMASS_Ecoli_core_w_GAM') {
      defaultVmax = 8.0;
    }

    const param = parameters[rxnId] || {};
    const vMax = param.vMax !== undefined ? param.vMax : defaultVmax;

    if (coupledCheckpoints.has(rxnId)) {
      bounds[rxnId] = { lb: 0.0, ub: vMax };
    } else {
      bounds[rxnId] = { lb: orig.lb, ub: orig.ub };
    }
  }

  return bounds;
}

async function runFbaAndReport(highs, extraBlocked = []) {
  const concentrations = {};
  const parameters = {};
  const bounds = calculateBounds(concentrations, parameters, extraBlocked);

  const boundsLines = [];
  for (const [rxnId, b] of Object.entries(bounds)) {
    const formatBound = (val, isUpper) => {
      if (val === null || val === undefined) return isUpper ? 'inf' : '-inf';
      if (val === Infinity || val >= 999999) return 'inf';
      if (val === -Infinity || val <= -999999) return '-inf';
      return val.toString();
    };
    boundsLines.push(`  ${formatBound(b.lb, false)} <= R_${rxnId} <= ${formatBound(b.ub, true)}`);
  }

  const lpString = staticLpHeader + boundsLines.join('\n') + '\nEnd';
  const sol = highs.solve(lpString, { "log_to_console": false, "output_flag": false });

  if (sol.Status !== 'Optimal') {
    console.log(`FBA status: ${sol.Status}`);
    return null;
  }

  const columns = sol.Columns;
  const growth = columns['R_BIOMASS_Ec_iJO1366_core_53p95M']?.Primal || 0.0;
  console.log(`Growth rate: ${growth.toFixed(4)}`);

  const activeUnmapped = [];
  const model = JSON.parse(fs.readFileSync('./public/iJO1366.json', 'utf8'));

  for (const colName of Object.keys(columns)) {
    if (colName.startsWith('R_')) {
      const rxnId = colName.substring(2);
      const flux = columns[colName].Primal;
      if (Math.abs(flux) > 0.1) {
        if (!mapReactions.has(rxnId) && !commonAllowed.has(rxnId)) {
          // Get reaction info from full model
          const modelRxn = model.reactions.find(r => r.id === rxnId) || {};
          activeUnmapped.push({
            id: rxnId,
            name: modelRxn.name || 'Unknown',
            flux: flux,
            equation: modelRxn.reaction_string || ''
          });
        }
      }
    }
  }

  // Sort by absolute flux descending
  activeUnmapped.sort((a, b) => Math.abs(b.flux) - Math.abs(a.flux));

  console.log(`Found ${activeUnmapped.length} active unmapped reactions:`);
  activeUnmapped.forEach(r => {
    console.log(`  [${r.id}] ${r.name} | Flux: ${r.flux.toFixed(4)} | Eq: ${r.equation}`);
  });

  return activeUnmapped;
}

async function run() {
  const highs = await highsLoader();
  console.log('--- FINDING BYPASSES WITH CURRENT BLOCKED LIST ---');
  await runFbaAndReport(highs);
}

run();
