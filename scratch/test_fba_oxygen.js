import fs from 'fs';
import highsLoader from 'highs';
import { solveFba } from '../src/fba_solver_worker.js';
import { Simulation } from '../src/simulation.js';

async function run() {
  const staticLpHeader = fs.readFileSync('./public/static_lp_header.txt', 'utf8');
  const escherMapData = JSON.parse(fs.readFileSync('./public/iJO1366.Central metabolism.json', 'utf8'));

  const highs = await highsLoader();
  console.log("Highs loaded successfully.");

  const points = [18.5, 4.0, 1.0, 0.5, 0.0];

  for (const o2 of points) {
    const sim = new Simulation(escherMapData);
    const concentrations = {
      o2_e: o2,
      glc__D_e: 8.0
    };
    const result = solveFba(highs, staticLpHeader, concentrations, {}, sim);
    const o2Uptake = result.fluxes['EX_o2_e'] ? -result.fluxes['EX_o2_e'] : 0;
    console.log(`o2_e = ${o2.toFixed(2)} | status = ${result.status} | growth = ${result.biomass_flux.toFixed(4)} | o2_uptake = ${o2Uptake.toFixed(2)} | PFL flux = ${result.fluxes['PFL'] || 0}`);
  }
}

run().catch(console.error);
