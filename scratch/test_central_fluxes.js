import fs from 'fs';
import path from 'path';
import highsLoader from 'highs';

const staticBounds = JSON.parse(fs.readFileSync('./src/static_bounds.json', 'utf8'));
const staticLpHeader = fs.readFileSync('./public/static_lp_header.txt', 'utf8');

// Load map reactions
const mapData = JSON.parse(fs.readFileSync('./public/iJO1366.Central metabolism.json', 'utf8'));
const mapReactions = {};
for (const rxn of Object.values(mapData[1].reactions)) {
  mapReactions[rxn.bigg_id] = rxn.name;
}

function calculateBounds(concentrations, parameters) {
  const bounds = {};
  const defaultBlocked = ['PFK_3', 'FBA3', 'F6PA', 'GLCDpp', 'XYLI2', 'GLCabcpp'];
  const coupledCheckpoints = new Set(['GLCptspp', 'PFK', 'PYK', 'CS', 'ICDHyr', 'SUCDi']);

  for (const rxnId of Object.keys(staticBounds)) {
    const orig = staticBounds[rxnId];
    if (defaultBlocked.includes(rxnId)) {
      bounds[rxnId] = { lb: 0.0, ub: 0.0 };
      continue;
    }

    let defaultVmax = 10.0;
    if (rxnId === 'GLCptspp' || rxnId === 'EX_glc__D_e') defaultVmax = 18.0;
    else if (rxnId === 'PFK' || rxnId === 'PYK') defaultVmax = 15.0;
    else if (rxnId === 'CS' || rxnId === 'ICDHyr') defaultVmax = 12.0;
    else if (rxnId === 'BIOMASS_Ecoli_core_w_GAM') defaultVmax = 8.0;

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

async function run() {
  const highs = await highsLoader();
  const bounds = calculateBounds({}, {});

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

  if (sol.Status === 'Optimal') {
    const columns = sol.Columns;
    console.log('--- MAP REACTION FLUXES ---');
    const fluxes = [];
    for (const [rxnId, name] of Object.entries(mapReactions)) {
      const varName = 'R_' + rxnId;
      const flux = columns[varName]?.Primal || 0.0;
      fluxes.push({ id: rxnId, name: name, flux: flux });
    }

    // Sort by absolute flux descending
    fluxes.sort((a, b) => Math.abs(b.flux) - Math.abs(a.flux));
    
    console.log('Active map reactions (flux != 0):');
    fluxes.filter(f => Math.abs(f.flux) > 0.01).forEach(f => {
      console.log(`  [${f.id}] ${f.name}: ${f.flux.toFixed(4)}`);
    });

    console.log('\nInactive map reactions (flux = 0):');
    fluxes.filter(f => Math.abs(f.flux) <= 0.01).forEach(f => {
      console.log(`  [${f.id}] ${f.name}`);
    });
  } else {
    console.log('FBA failed:', sol.Status);
  }
}

run();
