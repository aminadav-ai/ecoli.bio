import fs from 'fs';
import highsLoader from 'highs';

async function test() {
  const highs = await highsLoader();
  const modelData = JSON.parse(fs.readFileSync('./public/iJO1366.json', 'utf8'));
  const lpHeader = fs.readFileSync('./public/static_lp_header.txt', 'utf8');

  const boundsLines = [];
  for (const rxn of modelData.reactions) {
    let lb = rxn.lower_bound;
    let ub = rxn.upper_bound;
    
    // Default blocked and environment bounds logic similar to calculateBounds in worker
    const defaultBlocked = [
      'PFK_3', 'FBA3', 'F6PA', 'GLCDpp', 'XYLI2', 'GLCabcpp',
      'HPYRI', 'PROt2rpp', 'CA2t3pp', 'R15BPK', 'VPAMTr', 'ADK3'
    ];
    if (defaultBlocked.includes(rxn.id)) {
      lb = 0.0;
      ub = 0.0;
    } else if (rxn.id === 'EX_o2_e') {
      lb = -18.5 * 1.0; // o2_e = 1.0
    } else if (rxn.id === 'EX_glc__D_e') {
      lb = -12.0; // glc__D_e = 12.0
    }

    // Block PGM
    if (rxn.id === 'PGM') {
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
    console.log('--- Active Reactions with PGM Blocked ---');
    console.log('Biomass (Growth Rate):', columns['R_BIOMASS_Ec_iJO1366_core_53p95M']?.Primal);
    console.log('PGM Flux:', columns['R_PGM']?.Primal || 0.0);
    
    const active = [];
    for (const [colName, col] of Object.entries(columns)) {
      if (colName.startsWith('R_')) {
        const val = col.Primal;
        if (Math.abs(val) > 0.05) {
          active.push({ id: colName.substring(2), flux: val });
        }
      }
    }
    
    active.sort((a, b) => Math.abs(b.flux) - Math.abs(a.flux));
    
    console.log('Top active reactions carrying flux:');
    active.slice(0, 40).forEach(a => {
      console.log(`  ${a.id}: ${a.flux.toFixed(4)}`);
    });
  } else {
    console.log('Solver failed:', sol.Status);
  }
}
test();
