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
  
  // Run FBA 10 times to see if the flux solution fluctuates!
  console.log("Running FBA 5 times to check for solution oscillations:");
  const fluxHistory = [];
  for (let i = 0; i < 5; i++) {
    const res = solveFba(highs, lpHeader, getConcentrations(sim), getParameters(sim));
    console.log(`Run ${i+1}: Biomass=${res.biomass_flux.toFixed(6)}, PFL=${res.fluxes['PFL']?.toFixed(4)}, PDH=${res.fluxes['PDH']?.toFixed(4)}, ATPS4rpp=${res.fluxes['ATPS4rpp']?.toFixed(4)}, CYTBO3_4pp=${res.fluxes['CYTBO3_4pp']?.toFixed(4)}`);
    fluxHistory.push(res.fluxes);
  }
  
  // Print ATP stoichiometry for all reactions in the sim
  console.log("\nReactions containing atp_c in map stoichiometry:");
  for (const rxn of Object.values(sim.reactions)) {
    const coeff = rxn.stoichiometry['atp_c'];
    if (coeff) {
      console.log(`- ${rxn.id}: coeff=${coeff}, defaultVmax=${rxn.defaultVmax}`);
    }
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
