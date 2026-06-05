import fs from 'fs';
import highsLoader from 'highs';

class MockSimulation {
  constructor(model, staticBounds, staticLpHeader) {
    this.model = model;
    this.staticBounds = staticBounds;
    this.staticLpHeader = staticLpHeader;
    
    this.metabolites = {
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

    this.reactions = {
      'GLCptspp': { flux: 0.0, vMax: 18.0, km: 0.5, defaultVmax: 18.0, defaultKm: 0.5 },
      'PFK': { flux: 0.0, vMax: 15.0, km: 0.3, defaultVmax: 15.0, defaultKm: 0.3 },
      'PYK': { flux: 0.0, vMax: 15.0, km: 0.3, defaultVmax: 15.0, defaultKm: 0.3 },
      'CS': { flux: 0.0, vMax: 12.0, km: 0.4, defaultVmax: 12.0, defaultKm: 0.4 },
      'ICDHyr': { flux: 0.0, vMax: 12.0, km: 0.4, defaultVmax: 12.0, defaultKm: 0.4 },
      'SUCDi': { flux: 0.0, vMax: 10.0, km: 0.8, defaultVmax: 10.0, defaultKm: 0.8 },
      'PGI': { flux: 0.0, vMax: 10.0, km: 0.8, defaultVmax: 10.0, defaultKm: 0.8 },
      'BIOMASS_Ecoli_core_w_GAM': { flux: 0.0, vMax: 8.0, km: 1.0, defaultVmax: 8.0, defaultKm: 1.0 }
    };

    // Load stoichiometry of reactions on the map
    this.mapStoichiometry = {};
    const mapData = JSON.parse(fs.readFileSync('./public/iJO1366.Central metabolism.json', 'utf8'));
    for (const rxn of Object.values(mapData[1].reactions)) {
      const stoich = {};
      rxn.metabolites.forEach(m => {
        stoich[m.bigg_id] = m.coefficient;
      });
      this.mapStoichiometry[rxn.bigg_id] = stoich;
    }
  }

  calculateBounds() {
    const bounds = {};
    const defaultBlocked = ['PFK_3', 'FBA3', 'F6PA', 'GLCDpp', 'XYLI2'];
    const coupledCheckpoints = new Set(['GLCptspp', 'PFK', 'PYK', 'CS', 'ICDHyr', 'SUCDi']);
    
    const reactionSubstrates = {
      'GLCptspp': ['pep_c'],
      'PFK': ['f6p_c'],
      'PYK': ['pep_c'],
      'CS': ['accoa_c', 'oaa_c'],
      'ICDHyr': ['icit_c'],
      'SUCDi': ['succ_c']
    };
    const reactionProducts = {
      'GLCptspp': [],
      'PFK': ['fdp_c'],
      'PYK': ['pyr_c'],
      'CS': ['cit_c'],
      'ICDHyr': ['akg_c'],
      'SUCDi': ['fum_c']
    };

    for (const [rxnId, b] of Object.entries(this.staticBounds)) {
      if (defaultBlocked.includes(rxnId)) {
        bounds[rxnId] = { lb: 0.0, ub: 0.0 };
        continue;
      }

      const rxn = this.reactions[rxnId] || { vMax: 10.0, km: 0.8 };
      let vMax = rxn.vMax;
      let km = rxn.km;

      const isReversible = (b.lb < -1e-5);
      if (isReversible) {
        let ubForward = vMax;
        let ubBackward = vMax;

        if (coupledCheckpoints.has(rxnId)) {
          const subs = reactionSubstrates[rxnId] || [];
          for (const sId of subs) {
            const conc = this.metabolites[sId] !== undefined ? this.metabolites[sId] : 1.0;
            ubForward = Math.min(ubForward, vMax * (conc / (km + conc)));
          }
          const prods = reactionProducts[rxnId] || [];
          for (const pId of prods) {
            const conc = this.metabolites[pId] !== undefined ? this.metabolites[pId] : 1.0;
            ubBackward = Math.min(ubBackward, vMax * (conc / (km + conc)));
          }
        }

        bounds[rxnId] = { lb: -ubBackward, ub: ubForward };
      } else {
        let ubForward = vMax;
        if (coupledCheckpoints.has(rxnId)) {
          const subs = reactionSubstrates[rxnId] || [];
          for (const sId of subs) {
            const conc = this.metabolites[sId] !== undefined ? this.metabolites[sId] : 1.0;
            ubForward = Math.min(ubForward, vMax * (conc / (km + conc)));
          }
        }

        bounds[rxnId] = { lb: 0.0, ub: ubForward };
      }
    }

    return bounds;
  }

  async solveFba(highs) {
    const bounds = this.calculateBounds();
    const boundsLines = [];
    for (const [rxnId, b] of Object.entries(bounds)) {
      const formatBound = (val, isUpper) => {
        if (val === null || val === undefined) return isUpper ? 'inf' : '-inf';
        if (val === Infinity || val >= 999999) return 'inf';
        if (val === -Infinity || val <= -999999) return '-inf';
        return val.toString();
      };
      boundsLines.push(`  ${formatBound(b.lb, false)} <= R_${rxnId} <= ${formatBound(b.ub, true)}`);
    }

    const lpString = this.staticLpHeader + boundsLines.join('\n') + '\nEnd';
    const sol = highs.solve(lpString, { "log_to_console": false, "output_flag": false });
    
    if (sol.Status === 'Optimal') {
      const columns = sol.Columns;
      for (const rxnId of Object.keys(this.reactions)) {
        const varName = 'R_' + rxnId;
        const val = columns[varName]?.Primal || 0.0;
        this.reactions[rxnId].flux = val;
      }
      this.reactions['BIOMASS_Ecoli_core_w_GAM'].flux = columns['R_BIOMASS_Ec_iJO1366_core_53p95M']?.Primal || 0.0;
    } else {
      for (const rxn of Object.values(this.reactions)) {
        rxn.flux = 0.0;
      }
    }
  }

  tick() {
    const dt = 0.01;
    // We only simulate metabolites that are on the map
    const influxes = {};
    const outfluxes = {};
    for (const mId of Object.keys(this.metabolites)) {
      influxes[mId] = 0.0;
      outfluxes[mId] = 0.0;
    }

    // Since we don't have all fluxes from the model, we use the ones we solved
    for (const [rxnId, rxn] of Object.entries(this.reactions)) {
      const flux = rxn.flux;
      const stoich = this.mapStoichiometry[rxnId];
      if (!stoich) continue;
      for (const [mId, coeff] of Object.entries(stoich)) {
        if (this.metabolites[mId] !== undefined) {
          const rate = coeff * flux;
          if (rate > 0) influxes[mId] += rate;
          else outfluxes[mId] += Math.abs(rate);
        }
      }
    }

    // Euler Integration
    for (const [mId, conc] of Object.entries(this.metabolites)) {
      if (mId === 'glc__D_e' || mId === 'glc__D_c') {
        // Buffered/fixed
        continue;
      }
      
      const J_in = influxes[mId];
      const J_out = outfluxes[mId];
      const target = 1.0 * (Math.max(0.01, J_in) / 1.0); // simple target
      let dC = J_in - J_out * (conc / target) - 0.02 * conc;
      const nextConc = conc + dC * dt;
      this.metabolites[mId] = Math.max(0.1, Math.min(nextConc, 150.0));
    }
  }
}

async function run() {
  const highs = await highsLoader();
  const model = JSON.parse(fs.readFileSync('./public/iJO1366.json', 'utf8'));
  const staticBounds = JSON.parse(fs.readFileSync('./src/static_bounds.json', 'utf8'));
  const staticLpHeader = fs.readFileSync('./public/static_lp_header.txt', 'utf8');

  // Test 1: PGI active
  const simActive = new MockSimulation(model, staticBounds, staticLpHeader);
  simActive.reactions['PGI'].vMax = 10.0;
  
  // Test 2: PGI blocked
  const simBlocked = new MockSimulation(model, staticBounds, staticLpHeader);
  simBlocked.reactions['PGI'].vMax = 0.0;

  console.log('--- Simulating 20 seconds (2000 ticks) ---');
  for (let i = 0; i < 2000; i++) {
    await simActive.solveFba(highs);
    simActive.tick();

    await simBlocked.solveFba(highs);
    simBlocked.tick();

    if (i === 0 || i === 100 || i === 500 || i === 1999) {
      console.log(`Tick ${i}:`);
      console.log(`  Active  - Biomass: ${simActive.reactions['BIOMASS_Ecoli_core_w_GAM'].flux.toFixed(4)}, g6p_c: ${simActive.metabolites['g6p_c']?.toFixed(2)}, f6p_c: ${simActive.metabolites['f6p_c']?.toFixed(2)}`);
      console.log(`  Blocked - Biomass: ${simBlocked.reactions['BIOMASS_Ecoli_core_w_GAM'].flux.toFixed(4)}, g6p_c: ${simBlocked.metabolites['g6p_c']?.toFixed(2)}, f6p_c: ${simBlocked.metabolites['f6p_c']?.toFixed(2)}`);
    }
  }
}

run();
