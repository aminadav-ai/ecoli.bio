import fs from 'fs';
import highsLoader from 'highs';
import { solveFba, getOrCreateSimulation } from '../src/fba_solver_core.js';
import { pool } from '../src/supabase_db.js';

async function test() {
  const highs = await highsLoader();
  const lpHeaderPath = './public/static_lp_header.txt';
  const staticLpHeader = fs.readFileSync(lpHeaderPath, 'utf8');

  // Set PGK Vmax to 0
  const concentrations = { 'o2_e': 1.6, 'glc__D_e': 10.0 };
  const parameters = { 'PGK': { vMax: 0.0 } };
  
  const options = {
    guestId: 'test_pgk_session',
    reset: true,
    userEmail: 'test@example.com'
  };

  const result = solveFba(highs, staticLpHeader, concentrations, parameters, options);
  
  console.log('Growth Rate (Biomass):', result.biomass_flux);
  console.log('Status:', result.status);
  
  // Find active fluxes
  const active = [];
  for (const [rId, flux] of Object.entries(result.fluxes)) {
    if (Math.abs(flux) > 0.01) {
      active.push({ id: rId, flux });
    }
  }
  
  active.sort((a, b) => Math.abs(b.flux) - Math.abs(a.flux));
  console.log('Top active reactions:');
  active.slice(0, 50).forEach(a => {
    console.log(`  ${a.id}: ${a.flux.toFixed(4)}`);
  });
  
  try { await pool.end(); } catch (e) {}
}
test();
