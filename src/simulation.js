/**
 * src/simulation.js
 * 
 * Client-side kinetic simulation engine for E. coli central metabolism.
 * Parses network stoichiometry from Escher map JSON, runs a 20Hz ODE solver
 * using Euler integration, and supports real-time parameter tweaking.
 */

export class Simulation {
  constructor(escherMapData) {
    this.mapData = escherMapData;
    this.metabolites = {}; // bigg_id -> { name, concentration, isBuffered, type }
    this.reactions = {};    // bigg_id -> { name, reversibility, substrates, products, stoichiometry, vMax, km, flux }
    
    this.activeModel = 'e_coli_core';
    this.fluxMultiplier = 1.0;
    this.kmMultiplier = 1.0;

    // Define cofactors and inorganic molecules to buffer (hold at constant physiological concentrations)
    this.bufferedIds = new Set([
      'atp_c', 'adp_c', 'amp_c',
      'nad_c', 'nadh_c',
      'nadp_c', 'nadph_c',
      'pi_c', 'pi_e',
      'coa_c',
      'q8_c', 'q8h2_c',
      'nh4_c', 'nh4_e',
      'co2_c', 'co2_e',
      'o2_c', 'o2_e',
      'h_c', 'h_e',
      'h2o_c', 'h2o_e',
      'for_e', 'for_c', // formate transport can accumulate, but buffer to keep stable
    ]);

    // Initial physiological concentrations (mM)
    this.initialConcentrations = {
      // Primary carbon sources
      'glc__D_e': 10.0, // Extracellular glucose starts abundant
      'glc__D_c': 2.0,
      
      // Glycolysis / Gluconeogenesis intermediates
      'g6p_c': 1.0,
      'f6p_c': 0.8,
      'fdp_c': 0.5,
      'dhap_c': 0.4,
      'g3p_c': 0.3,
      '13dpg_c': 0.1,
      '3pg_c': 0.5,
      '2pg_c': 0.2,
      'pep_c': 0.8,
      'pyr_c': 1.5,
      
      // TCA cycle intermediates
      'accoa_c': 0.5,
      'oaa_c': 0.2,
      'cit_c': 1.2,
      'icit_c': 0.3,
      'akg_c': 1.0,
      'succoa_c': 0.4,
      'succ_c': 0.8,
      'fum_c': 0.5,
      'mal__L_c': 0.8,
      
      // Pentose Phosphate Pathway (PPP)
      '6pgl_c': 0.2,
      '6pgc_c': 0.4,
      'ru5p__D_c': 0.3,
      'r5p_c': 0.5,
      'xu5p__D_c': 0.4,
      's7p_c': 0.6,
      'e4p_c': 0.3,
      
      // Fermentation products
      'ac_c': 1.0,
      'ac_e': 0.2,
      'etoh_c': 0.5,
      'etoh_e': 0.1,
      'lac__D_c': 0.5,
      'lac__D_e': 0.1,

      // Buffered cofactors / small molecules
      'atp_c': 4.0,
      'adp_c': 1.0,
      'amp_c': 0.2,
      'nad_c': 2.6,
      'nadh_c': 0.1,
      'nadp_c': 0.1,
      'nadph_c': 0.4,
      'pi_c': 10.0,
      'pi_e': 10.0,
      'coa_c': 1.0,
      'q8_c': 2.0,
      'q8h2_c': 1.0,
      'nh4_c': 10.0,
      'nh4_e': 10.0,
      'co2_c': 1.0,
      'co2_e': 1.0,
      'o2_c': 0.2,
      'o2_e': 0.2,
      'h_c': 1.0,
      'h_e': 1.0,
      'h2o_c': 55000.0,
      'h2o_e': 55000.0,
      'for_c': 0.1,
      'for_e': 0.1,
    };

    // Predefined strain multipliers
    this.strains = {
      e_coli_core: {
        name: 'Wild-Type Core (e_coli_core)',
        description: 'Standard wild-type core metabolic model. Balanced and stable.',
        fluxMultiplier: 1.0,
        kmMultiplier: 1.0
      },
      iJO1366: {
        name: 'Aerobic Growth Strain (iJO1366)',
        description: 'Accelerated glycolysis and oxygen uptake model.',
        fluxMultiplier: 1.25,
        kmMultiplier: 0.9
      },
      iML1515: {
        name: 'Optimized Mutant (iML1515)',
        description: 'Highly active metabolic network, optimized for growth rate.',
        fluxMultiplier: 1.5,
        kmMultiplier: 0.8
      },
      iAF1260: {
        name: 'Classic Strain (iAF1260)',
        description: 'Classic genome-scale reconstruction with moderate kinetics.',
        fluxMultiplier: 0.9,
        kmMultiplier: 1.0
      },
      iJR904: {
        name: 'Slow Fermenter (iJR904)',
        description: 'Slower substrate uptake and higher Km binding thresholds.',
        fluxMultiplier: 0.8,
        kmMultiplier: 1.3
      }
    };

    this.initialize();
  }

  /**
   * Parses the Escher map to extract all metabolites and reactions.
   */
  initialize() {
    const mapData = this.mapData[1];
    
    // 1. Gather all metabolites
    for (const [nodeId, node] of Object.entries(mapData.nodes)) {
      if (node.node_type === 'metabolite') {
        const id = node.bigg_id;
        if (!this.metabolites[id]) {
          const isBuffered = this.bufferedIds.has(id);
          let type = 'metabolite';
          
          if (id === 'glc__D_e' || id === 'glc__D_c') {
            type = 'substrate';
          } else if (id.includes('atp_c') || id.includes('adp_c') || id.includes('nad') || id.includes('nadh') || id.includes('coa')) {
            type = 'cofactor';
          }

          this.metabolites[id] = {
            id: id,
            name: node.name,
            concentration: this.initialConcentrations[id] || 1.0,
            isBuffered: isBuffered,
            type: type
          };
        }
      }
    }

    // 2. Gather reactions and construct stoichiometry
    for (const [rxnId, rxn] of Object.entries(mapData.reactions)) {
      const biggId = rxn.bigg_id;
      const name = rxn.name;
      const reversibility = rxn.reversibility;
      
      const substrates = [];
      const products = [];
      const stoichiometry = {};

      rxn.metabolites.forEach(metab => {
        const id = metab.bigg_id;
        const coeff = metab.coefficient;
        
        stoichiometry[id] = coeff;
        if (coeff < 0) {
          substrates.push(id);
        } else {
          products.push(id);
        }

        // Safety: Ensure metabolite exists in our register
        if (!this.metabolites[id]) {
          this.metabolites[id] = {
            id: id,
            name: id,
            concentration: this.initialConcentrations[id] || 1.0,
            isBuffered: this.bufferedIds.has(id),
            type: 'metabolite'
          };
        }
      });

      // Assign realistic Vmax and Km parameters based on reaction type
      let defaultVmax = 10.0;
      let defaultKm = 0.8;

      // Make primary pathway transport and checkpoints highly active
      if (biggId === 'GLCpts' || biggId === 'EX_glc__D_e') {
        defaultVmax = 18.0;
        defaultKm = 0.5;
      } else if (biggId === 'PFK' || biggId === 'PYK') {
        defaultVmax = 15.0; // Rate-limiting glycolytic checkpoints
        defaultKm = 0.3;
      } else if (biggId === 'CS' || biggId === 'ICDHyr') {
        defaultVmax = 12.0; // TCA entry and checkpoints
        defaultKm = 0.4;
      } else if (biggId === 'BIOMASS_Ecoli_core_w_GAM') {
        defaultVmax = 8.0; // Biomass production rate
        defaultKm = 1.0;
      }

      this.reactions[biggId] = {
        id: biggId,
        name: name,
        reversibility: reversibility,
        substrates: substrates,
        products: products,
        stoichiometry: stoichiometry,
        vMax: defaultVmax,
        km: defaultKm,
        defaultVmax: defaultVmax,
        defaultKm: defaultKm,
        perturbationMultiplier: 1.0,
        flux: 0.0
      };
    }
  }

  /**
   * Reset simulation concentrations and fluxes to initial steady state.
   */
  reset() {
    for (const [id, metab] of Object.entries(this.metabolites)) {
      metab.concentration = this.initialConcentrations[id] || 1.0;
    }
    for (const rxn of Object.values(this.reactions)) {
      rxn.flux = 0.0;
    }
  }

  /**
   * Injects a specified amount of metabolite (mM).
   */
  inject(metabId, amount) {
    if (this.metabolites[metabId]) {
      this.metabolites[metabId].concentration += amount;
      // Clamp to prevent overflow
      if (this.metabolites[metabId].concentration > 150.0) {
        this.metabolites[metabId].concentration = 150.0;
      }
    }
  }

  /**
   * Tweaks Vmax or Km for a specific reaction.
   */
  updateParameter(rxnId, param, value) {
    if (this.reactions[rxnId]) {
      if (param === 'vMax') {
        this.reactions[rxnId].vMax = Math.max(0.0, value);
      } else if (param === 'km') {
        this.reactions[rxnId].km = Math.max(0.05, value);
      }
    }
  }

  /**
   * Applies the strain parameter scaling factors.
   */
  selectStrain(strainId) {
    const strain = this.strains[strainId];
    if (strain) {
      this.activeModel = strainId;
      this.fluxMultiplier = strain.fluxMultiplier;
      this.kmMultiplier = strain.kmMultiplier;
      this.reset();
      console.log(`[Simulation] Switched to strain: ${strain.name}`);
    }
  }

  /**
   * Solves a Linear Programming problem of the form:
   * Maximize c^T x subject to A x <= b, x >= 0
   * using the standard Primal Simplex algorithm.
   */
  solveLP(c, A, b) {
    const M = A.length;
    const N = A[0].length;

    // Create tableau of size (M+1) x (N+M+1)
    const T = [];
    for (let i = 0; i <= M; i++) {
      T.push(new Float64Array(N + M + 1));
    }

    // Fill constraints matrix and RHS
    for (let i = 0; i < M; i++) {
      for (let j = 0; j < N; j++) {
        T[i][j] = A[i][j];
      }
      T[i][N + i] = 1.0; // Slack variable
      T[i][N + M] = b[i];
    }

    // Fill objective row (c coefficients are negated in standard form)
    for (let j = 0; j < N; j++) {
      T[M][j] = -c[j];
    }
    T[M][N + M] = 0.0;

    // Track basic variables corresponding to each constraint row
    const basis = new Int32Array(M);
    for (let i = 0; i < M; i++) {
      basis[i] = N + i;
    }

    const maxIterations = 200;
    for (let iter = 0; iter < maxIterations; iter++) {
      // 1. Find entering variable (Bland's rule: first column with a negative coefficient)
      let q = -1;
      for (let j = 0; j < N + M; j++) {
        if (T[M][j] < -1e-5) {
          q = j;
          break;
        }
      }
      if (q === -1) {
        break; // Optimal found
      }

      // 2. Find leaving variable (Minimum ratio test)
      let p = -1;
      let minRatio = Infinity;
      for (let i = 0; i < M; i++) {
        if (T[i][q] > 1e-5) {
          const ratio = T[i][N + M] / T[i][q];
          if (ratio < minRatio - 1e-5) {
            minRatio = ratio;
            p = i;
          } else if (Math.abs(ratio - minRatio) < 1e-5) {
            if (p === -1 || basis[i] < basis[p]) {
              p = i;
            }
          }
        }
      }

      if (p === -1) {
        return null; // Unbounded solution (not possible with standard vMax boundaries)
      }

      // 3. Pivot operation
      const pivotVal = T[p][q];
      for (let j = 0; j <= N + M; j++) {
        T[p][j] /= pivotVal;
      }

      for (let i = 0; i <= M; i++) {
        if (i !== p) {
          const factor = T[i][q];
          for (let j = 0; j <= N + M; j++) {
            T[i][j] -= factor * T[p][j];
          }
        }
      }

      basis[p] = q;
    }

    // Extract values
    const x = new Float64Array(N);
    for (let i = 0; i < M; i++) {
      if (basis[i] < N) {
        x[basis[i]] = T[i][N + M];
      }
    }

    return {
      objVal: T[M][N + M],
      x: x
    };
  }

  /**
   * Formulates and solves the Flux Balance Analysis (FBA) problem.
   * Maximizes biomass production rate under current substrate limitations.
   */
  solveFBA() {
    const internalMetabs = Object.keys(this.metabolites).filter(id => id.endsWith('_c'));
    const rxnIds = Object.keys(this.reactions);

    // 1. Build variables mapping. Split reversible reactions into forward/backward components.
    const varMap = [];
    for (const rxnId of rxnIds) {
      const rxn = this.reactions[rxnId];
      varMap.push({ rxnId, direction: 1 });
      if (rxn.reversibility) {
        varMap.push({ rxnId, direction: -1 });
      }
    }
    const N = varMap.length;

    // 2. Setup constraints
    // - For each internal metabolite, we enforce steady state (S * v = 0 -> 2 constraints: <=0 and >=0)
    // - For each variable, we enforce upper bounds (x_k <= UB_k -> N constraints)
    const M_eq = internalMetabs.length * 2;
    const M = M_eq + N;

    const A = [];
    for (let i = 0; i < M; i++) {
      A.push(new Float64Array(N));
    }
    const b = new Float64Array(M);
    const c = new Float64Array(N);

    // 3. Fill equality constraints (S * v = 0)
    for (let i = 0; i < internalMetabs.length; i++) {
      const metabId = internalMetabs[i];
      const row1 = i * 2;
      const row2 = i * 2 + 1;

      for (let k = 0; k < N; k++) {
        const { rxnId, direction } = varMap[k];
        const coeff = this.reactions[rxnId].stoichiometry[metabId] || 0;
        const val = coeff * direction;
        A[row1][k] = val;
        A[row2][k] = -val;
      }
      b[row1] = 0.0;
      b[row2] = 0.0;
    }

    // 4. Fill upper bound constraints (v_k <= UB_k)
    for (let k = 0; k < N; k++) {
      const row = M_eq + k;
      A[row][k] = 1.0;

      const { rxnId, direction } = varMap[k];
      const rxn = this.reactions[rxnId];
      const vMax = rxn.vMax * this.fluxMultiplier * (rxn.perturbationMultiplier !== undefined ? rxn.perturbationMultiplier : 1.0);
      const km = rxn.km * this.kmMultiplier;

      let UB = vMax;

      // Restrict transport upper bounds by substrate/product concentration in medium
      if (direction === 1) {
        for (const subId of rxn.substrates) {
          if (subId.endsWith('_e')) {
            const conc = this.metabolites[subId].concentration;
            UB = Math.min(UB, vMax * (conc / (km + conc)));
          }
        }
      } else {
        for (const prodId of rxn.products) {
          if (prodId.endsWith('_e')) {
            const conc = this.metabolites[prodId].concentration;
            UB = Math.min(UB, vMax * (conc / (km + conc)));
          }
        }
      }

      b[row] = UB;
    }

    // 5. Setup objective vector: maximize biomass yield
    let biomassRxnId = rxnIds.find(id => id.toUpperCase().includes('BIOMASS'));
    if (!biomassRxnId) biomassRxnId = 'BIOMASS_Ecoli_core_w_GAM';

    for (let k = 0; k < N; k++) {
      if (varMap[k].rxnId === biomassRxnId && varMap[k].direction === 1) {
        c[k] = 1.0;
      }
    }

    // 6. Execute LP Simplex solver
    const res = this.solveLP(c, A, b);

    // 7. Extract resulting fluxes
    for (const rxn of Object.values(this.reactions)) {
      rxn.flux = 0.0;
    }

    if (res && res.x) {
      for (let k = 0; k < N; k++) {
        const { rxnId, direction } = varMap[k];
        this.reactions[rxnId].flux += res.x[k] * direction;
      }
    }

    return res;
  }

  /**
   * Refactored simulation step: Executes dynamic FBA (dFBA)
   * and dynamically updates metabolite pools using FBA flux turnover.
   */
  tick(speedMultiplier = 1.0) {
    const dt = 0.01 * speedMultiplier;

    // 1. Solve FBA optimization to get active fluxes
    this.solveFBA();

    // 2. Accumulate influx and outflux rates for each metabolite
    const influxes = {};
    const outfluxes = {};
    for (const id of Object.keys(this.metabolites)) {
      influxes[id] = 0.0;
      outfluxes[id] = 0.0;
    }

    for (const rxn of Object.values(this.reactions)) {
      const flux = rxn.flux;
      for (const [metabId, coeff] of Object.entries(rxn.stoichiometry)) {
        if (this.metabolites[metabId]) {
          const rate = coeff * flux;
          if (rate > 0) {
            influxes[metabId] += rate;
          } else {
            outfluxes[metabId] += Math.abs(rate);
          }
        }
      }
    }

    // 3. Integrate concentrations (Euler step)
    for (const [id, metab] of Object.entries(this.metabolites)) {
      if (metab.isBuffered) continue;

      const baseline = this.initialConcentrations[id] || 1.0;

      if (id.endsWith('_e')) {
        // Extracellular pool decays or grows based on net transport
        let nextConc = metab.concentration + (influxes[id] - outfluxes[id]) * dt;
        metab.concentration = Math.max(0.1, Math.min(nextConc, 150.0));
      } else {
        // Intracellular pool adapts to local flux turnover, stabilizing around baseline
        const J_in = influxes[id];
        const J_out = outfluxes[id];
        let dC = J_in - J_out * (metab.concentration / baseline) - 0.02 * metab.concentration;
        let nextConc = metab.concentration + dC * dt;
        metab.concentration = Math.max(0.1, Math.min(nextConc, 150.0));
      }
    }
  }

  /**
   * Helper to return dynamic details of a metabolite.
   */
  getMetaboliteInfo(id) {
    const metab = this.metabolites[id];
    if (!metab) return null;

    // Calculate dynamic influx and outflux
    let influx = 0;
    let outflux = 0;

    for (const rxn of Object.values(this.reactions)) {
      const coeff = rxn.stoichiometry[id];
      if (coeff) {
        const rate = rxn.flux * coeff;
        if (rate > 0) influx += rate;
        else outflux += Math.abs(rate);
      }
    }

    return {
      ...metab,
      influx: influx,
      outflux: outflux,
      netFlux: influx - outflux
    };
  }
}
