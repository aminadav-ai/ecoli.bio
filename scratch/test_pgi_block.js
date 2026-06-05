import fs from 'fs';
import highsLoader from 'highs';

async function test() {
  const highs = await highsLoader();
  const model = JSON.parse(fs.readFileSync('./public/iJO1366.json', 'utf8'));
  const staticBounds = JSON.parse(fs.readFileSync('./src/static_bounds.json', 'utf8'));
  const staticLpHeader = fs.readFileSync('./public/static_lp_header.txt', 'utf8');

  function getSolve(pgiVmax) {
    const defaultBlocked = ['PFK_3', 'FBA3', 'F6PA', 'GLCDpp', 'XYLI2'];
    const coupledCheckpoints = new Set(['GLCptspp', 'PFK', 'PYK', 'CS', 'ICDHyr', 'SUCDi']);
    
    // Setup concentrations and parameters
    const concentrations = {
      'glc__D_e': 10.0,
      'glc__D_c': 2.0,
      'g6p_c': 1.0,
      'f6p_c': 0.8,
      'fdp_c': 0.5,
      'dhap_c': 0.4,
      'g3p_c': 0.3,
      'pep_c': 0.8,
      'pyr_c': 1.5,
      'accoa_c': 0.5,
      'oaa_c': 0.2,
      'cit_c': 1.2,
      'icit_c': 0.3,
      'akg_c': 1.0,
      'succoa_c': 0.4,
      'succ_c': 0.8,
      'fum_c': 0.5,
      'mal__L_c': 0.8,
      'ac_c': 1.0,
      'ac_e': 0.0,
      'etoh_c': 0.5,
      'etoh_e': 0.0,
      'lac__D_c': 0.5,
      'lac__D_e': 0.0
    };
    
    const parameters = {
      'PGI': { vMax: pgiVmax, km: 0.8 }
    };

    const bounds = {};
    for (const [rxnId, b] of Object.entries(staticBounds)) {
      if (defaultBlocked.includes(rxnId)) {
        bounds[rxnId] = { lowerBound: 0.0, upperBound: 0.0 };
        continue;
      }
      
      let vMax = 10.0;
      let km = 0.8;
      
      if (rxnId === 'GLCptspp' || rxnId === 'EX_glc__D_e') {
        vMax = 18.0;
        km = 0.5;
      } else if (rxnId === 'PFK' || rxnId === 'PYK') {
        vMax = 15.0;
        km = 0.3;
      } else if (rxnId === 'CS' || rxnId === 'ICDHyr') {
        vMax = 12.0;
        km = 0.4;
      } else if (rxnId === 'BIOMASS_Ecoli_core_w_GAM') {
        vMax = 8.0;
        km = 1.0;
      }

      if (parameters[rxnId]) {
        vMax = parameters[rxnId].vMax;
        km = parameters[rxnId].km;
      }

      const isReversible = (b.lb < -1e-5);
      if (isReversible) {
        let ubForward = vMax;
        let ubBackward = vMax;
        if (coupledCheckpoints.has(rxnId)) {
          // apply concentrations
          ubForward = vMax * 0.5; // dummy kinetics
          ubBackward = vMax * 0.5;
        }
        bounds[rxnId] = { lowerBound: -ubBackward, upperBound: ubForward };
      } else {
        let ubForward = vMax;
        if (coupledCheckpoints.has(rxnId)) {
          ubForward = vMax * 0.5;
        }
        bounds[rxnId] = { lowerBound: 0.0, upperBound: ubForward };
      }
    }

    // Solve
    const boundsLines = [];
    for (const [rxnId, b] of Object.entries(bounds)) {
      const formatBound = (val, isUpper) => {
        if (val === null || val === undefined) return isUpper ? 'inf' : '-inf';
        if (val === Infinity || val >= 999999) return 'inf';
        if (val === -Infinity || val <= -999999) return '-inf';
        return val.toString();
      };
      boundsLines.push(`  ${formatBound(b.lowerBound, false)} <= R_${rxnId} <= ${formatBound(b.upperBound, true)}`);
    }

    const lpString = staticLpHeader + boundsLines.join('\n') + '\nEnd';
    const sol = highs.solve(lpString, { "log_to_console": false, "output_flag": false });
    return {
      status: sol.Status,
      biomass: sol.Columns?.['R_BIOMASS_Ec_iJO1366_core_53p95M']?.Primal || 0,
      pgiFlux: sol.Columns?.['R_PGI']?.Primal || 0
    };
  }

  console.log('PGI active:', getSolve(10.0));
  console.log('PGI blocked:', getSolve(0.0));
}

test();
