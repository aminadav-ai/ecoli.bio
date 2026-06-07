import fs from 'fs';
import { Simulation } from '../src/simulation.js';
import highsLoader from 'highs';
import { solveFba } from '../src/fba_solver_core.js';

async function run() {
  const highs = await highsLoader();
  const lpHeader = fs.readFileSync('./public/static_lp_header.txt', 'utf8');
  const escherMapData = JSON.parse(fs.readFileSync('./public/iJO1366.Central metabolism.json', 'utf8'));
  
  const sim = new Simulation(escherMapData);
  
  // Set oxygen to 1.0 and glucose to 10.0 (default startup)
  sim.metabolites['o2_e'].concentration = 1.0;
  sim.metabolites['o2_e'].targetConcentration = 1.0;
  sim.metabolites['glc__D_e'].concentration = 10.0;
  sim.metabolites['glc__D_e'].targetConcentration = 10.0;
  
  console.log("Simulating 15 iterations of the FBA-concentration feedback loop:");
  for (let i = 0; i < 15; i++) {
    const res = solveFba(highs, lpHeader, getConcentrations(sim), getParameters(sim));
    sim.updateFluxes(res.fluxes, res.biomass_flux);
    
    // Run 5 ticks (matching the 250ms update interval where FBA solves)
    for (let t = 0; t < 5; t++) {
      sim.tick(1.0);
    }
    
    console.log(`Step ${i+1}: Biomass=${res.biomass_flux.toFixed(4)}, ATPS4rpp=${res.fluxes['ATPS4rpp']?.toFixed(2)}, atp_c=${sim.metabolites['atp_c'].concentration.toFixed(3)}, f6p_c=${sim.metabolites['f6p_c']?.concentration.toFixed(3)}, pep_c=${sim.metabolites['pep_c']?.concentration.toFixed(3)}`);
  }
}

function getConcentrations(sim) {
  const conc = {};
  for (const [id, m] of Object.entries(sim.metabolites)) {
    conc[id] = m.concentration;
  }
  return conc;
}

function getParameters(sim) {
  const params = {};
  for (const [id, r] of Object.entries(sim.reactions)) {
    if (r.vMax !== r.defaultVmax || r.km !== r.defaultKm) {
      params[id] = { vMax: r.vMax, km: r.km };
    }
  }
  return params;
}

run();
