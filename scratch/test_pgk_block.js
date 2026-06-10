import fs from 'fs';
import highsLoader from 'highs';

async function test() {
  const highs = await highsLoader();
  const modelData = JSON.parse(fs.readFileSync('./public/iJO1366.json', 'utf8'));
  const lpHeader = fs.readFileSync('./public/static_lp_header.txt', 'utf8');

  // Let's modify the bounds for PGK (R_PGK) to be 0
  const originalBounds = {};
  for (const rxn of modelData.reactions) {
    originalBounds[rxn.id] = [rxn.lower_bound, rxn.upper_bound];
  }

  const boundsLines = [];
  for (const rxn of modelData.reactions) {
    let lb = rxn.lower_bound;
    let ub = rxn.upper_bound;
    
    // Block PGK
    if (rxn.id === 'PGK') {
      lb = 0.0;
      ub = 0.0;
    }
    
    const formatBound = (val, isUpper) => {
      if (val === null || val === undefined) return isUpper ? 'inf' : '-inf';
      if (val === Infinity || val >= 999999) return 'inf';
      if (val === -Infinity || val <= -999999) return '-inf';
      return val.toString();
    };
    boundsLines.push(`  ${formatBound(lb, false)} <= R_${rxn.id} <= ${formatBound(ub, true)}`);
  }

  const lpString = lpHeader + boundsLines.join('\n') + '\nEnd';
  const sol = highs.solve(lpString, { "log_to_console": false, "output_flag": false });

  if (sol.Status === 'Optimal') {
    const columns = sol.Columns;
    console.log('--- Active Reactions with PGK Blocked ---');
    console.log('Biomass (Growth Rate):', columns['R_BIOMASS_Ec_iJO1366_core_53p95M']?.Primal);
    
    const active = [];
    for (const [colName, col] of Object.entries(columns)) {
      if (colName.startsWith('R_')) {
        const val = col.Primal;
        if (Math.abs(val) > 0.05) {
          active.push({ id: colName.substring(2), flux: val });
        }
      }
    }
    
    // Sort by absolute flux descending
    active.sort((a, b) => Math.abs(b.flux) - Math.abs(a.flux));
    
    console.log('Top active reactions carrying flux:');
    active.slice(0, 30).forEach(a => {
      console.log(`  ${a.id}: ${a.flux.toFixed(4)}`);
    });
  } else {
    console.log('Solver failed:', sol.Status);
  }
}
test();
