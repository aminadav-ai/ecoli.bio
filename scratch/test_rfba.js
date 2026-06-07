import fs from 'fs';
import highsLoader from 'highs';
import { solveFba, calculateBounds } from '../src/fba_solver_core.js';

const staticLpHeader = fs.readFileSync('./public/static_lp_header.txt', 'utf8');

async function run() {
  const highs = await highsLoader();
  
  const baseConcentrations = {
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
    'fdp_c': 1.0,
    'o2_e': 0.2
  };

  console.log('=== CASE 1: Glucose Present (glc__D_e = 10.0) ===');
  const concentrations1 = { ...baseConcentrations, 'glc__D_e': 10.0 };
  const params1 = {
    'MALS': { vMax: 10.0, km: 0.8 },
    'ICL': { vMax: 10.0, km: 0.8 }
  };
  
  const bounds1 = calculateBounds(concentrations1, params1);
  console.log(`MALS calculated bounds: ${JSON.stringify(bounds1['MALS'])}`);
  console.log(`ICL calculated bounds: ${JSON.stringify(bounds1['ICL'])}`);
  
  const res1 = solveFba(highs, staticLpHeader, concentrations1, params1);
  console.log(`FBA solve status: ${res1.status}`);
  console.log(`MALS flux: ${res1.fluxes['MALS']}`);
  console.log(`ICL flux: ${res1.fluxes['ICL']}`);

  console.log('\n=== CASE 2: Glucose Depleted (glc__D_e = 0.0) ===');
  const concentrations2 = { ...baseConcentrations, 'glc__D_e': 0.0 };
  const params2 = {
    'MALS': { vMax: 10.0, km: 0.8 },
    'ICL': { vMax: 10.0, km: 0.8 }
  };
  
  const bounds2 = calculateBounds(concentrations2, params2);
  console.log(`MALS calculated bounds: ${JSON.stringify(bounds2['MALS'])}`);
  console.log(`ICL calculated bounds: ${JSON.stringify(bounds2['ICL'])}`);
  
  // To verify they can carry flux when derepressed, let's solve FBA.
  // Note: the solver maximizes biomass, so it might or might not use the glyoxylate shunt
  // unless we force/limit other pathways or if it is optimal for biomass.
  const res2 = solveFba(highs, staticLpHeader, concentrations2, params2);
  console.log(`FBA solve status: ${res2.status}`);
  console.log(`MALS flux: ${res2.fluxes['MALS']}`);
  console.log(`ICL flux: ${res2.fluxes['ICL']}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
