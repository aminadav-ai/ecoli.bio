import fs from 'fs';
import { Simulation } from '../src/simulation.js';
import highsLoader from 'highs';
import { solveFba } from '../src/fba_solver_core.js';

async function run() {
  const highs = await highsLoader();
  const lpHeader = fs.readFileSync('./public/static_lp_header.txt', 'utf8');
  const escherMapData = JSON.parse(fs.readFileSync('./public/iJO1366.Central metabolism.json', 'utf8'));
  
  // Simulation of a request
  const clientO2 = 1.0;
  const clientGlc = 10.0;
  const clientParams = {}; // no overrides
  
  // 1. Solve FBA on server
  const bounds = {};
  const repressed = {};
  const isGlucoseRepressed = clientGlc > 0.2;
  if (isGlucoseRepressed) {
    repressed['MALS'] = { repressed: true, reason: '(Repressed by Glucose 🔒)' };
    repressed['ICL'] = { repressed: true, reason: '(Repressed by Glucose 🔒)' };
  }
  if (clientO2 > 0.05) {
    repressed['PFL'] = { repressed: true, reason: '(Repressed by Oxygen 🔒)' };
  } else {
    repressed['PDH'] = { repressed: true, reason: '(Repressed by Anaerobiosis 🔒)' };
  }
  
  // Load static bounds
  const staticBounds = JSON.parse(fs.readFileSync('./src/static_bounds.json', 'utf8'));
  for (const rxnId of Object.keys(staticBounds)) {
    const orig = staticBounds[rxnId];
    if (rxnId === 'EX_o2_e') {
      bounds[rxnId] = { lowerBound: -18.5 * clientO2, upperBound: 1000.0 };
      continue;
    }
    let vMax = 10.0;
    if (rxnId === 'GLCptspp' || rxnId === 'EX_glc__D_e') vMax = 18.0;
    else if (rxnId === 'PFK' || rxnId === 'PYK') vMax = 15.0;
    else if (rxnId === 'CS' || rxnId === 'ICDHyr') vMax = 12.0;
    else if (rxnId === 'BIOMASS_Ecoli_core_w_GAM') vMax = 8.0;
    
    if (repressed[rxnId]) {
      vMax = 0.0;
    }
    bounds[rxnId] = { lowerBound: orig.lb < -1e-5 ? -vMax : 0.0, upperBound: vMax };
  }
  
  const boundsLines = [];
  for (const [rxnId, b] of Object.entries(bounds)) {
    boundsLines.push(`  ${b.lowerBound} <= R_${rxnId} <= ${b.upperBound}`);
  }
  const lpString = lpHeader + boundsLines.join('\n') + '\nEnd';
  const sol = highs.solve(lpString, { "log_to_console": false, "output_flag": false });
  
  // 2. Parse fluxes
  const fluxes = {};
  for (const colName of Object.keys(sol.Columns)) {
    if (colName.startsWith('R_')) {
      fluxes[colName.substring(2)] = sol.Columns[colName].Primal;
    }
  }
  const biomassFlux = sol.Columns['R_BIOMASS_Ec_iJO1366_core_53p95M']?.Primal || 0.0;
  
  // 3. Create a fresh Simulation instance to calculate concentrations
  const sim = new Simulation(escherMapData);
  sim.normalFluxes = globalNormalFluxes; // copy reference normal fluxes!
  // Set the inputs
  sim.metabolites['o2_e'].concentration = clientO2;
  sim.metabolites['o2_e'].targetConcentration = clientO2;
  sim.metabolites['glc__D_e'].concentration = clientGlc;
  sim.metabolites['glc__D_e'].targetConcentration = clientGlc;
  
  // Apply fluxes
  sim.updateFluxes(fluxes, biomassFlux);
  
  // Run 1 tick (or 25 ticks, since it's direct assignment for intracellular, 1 tick is enough!)
  sim.tick(1.0);
  
  console.log("Calculated concentrations on server:");
  console.log("atp_c:", sim.metabolites['atp_c'].concentration);
  console.log("pyr_c:", sim.metabolites['pyr_c'].concentration);
  console.log("f6p_c:", sim.metabolites['f6p_c'].concentration);
}

run();
