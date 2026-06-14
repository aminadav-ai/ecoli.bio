import fs from 'fs';
import path from 'path';
import highsLoader from 'highs';
import { initializeNewSimulation, solveFba, serializeSimulation } from '../src/fba_solver_worker.js';

let precalculatedGuestState = null;

function precalculateGuestState(highs, staticLpHeader) {
  const sim = initializeNewSimulation();
  if (!sim) return;
  
  sim.metabolites['o2_e'].concentration = 18.5;
  sim.metabolites['o2_e'].targetConcentration = 18.5;
  sim.metabolites['glc__D_e'].concentration = 10.0;
  sim.metabolites['glc__D_e'].targetConcentration = 10.0;
  
  for (let i = 0; i < 20; i++) {
    const concs = {};
    for (const [mId, metab] of Object.entries(sim.metabolites)) {
      concs[mId] = metab.concentration;
    }
    solveFba(highs, staticLpHeader, concs, {}, sim, { skipSimTick: false });
  }
  
  precalculatedGuestState = serializeSimulation(sim);
}

function getPrecalculatedGuestState() {
  return precalculatedGuestState;
}

async function main() {
  console.log('[Guest State Generator] Initializing HiGHS solver...');
  const highs = await highsLoader();
  
  const lpHeaderPath = path.resolve('public/static_lp_header.txt');
  const staticLpHeader = fs.readFileSync(lpHeaderPath, 'utf8');

  console.log('[Guest State Generator] Running simulation...');
  precalculateGuestState(highs, staticLpHeader);
  
  const guestState = getPrecalculatedGuestState();
  if (guestState) {
    const outputPath = path.resolve('public/guest_state.json');
    fs.writeFileSync(outputPath, JSON.stringify(guestState, null, 2), 'utf8');
    console.log(`[Guest State Generator] Successfully wrote guest state to ${outputPath}`);
  } else {
    console.error('[Guest State Generator] Failed to precalculate guest state.');
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('[Guest State Generator] Error:', err);
  process.exit(1);
});
