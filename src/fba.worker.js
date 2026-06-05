/**
 * src/fba.worker.js
 *
 * Web Worker for running the genome-scale FBA calculation and kinetic ODE
 * simulation client-side using HiGHS compiled to WebAssembly.
 */

import highsLoader from 'highs';

let highs = null;
let simulation = null;
let isPaused = true;
let speedMultiplier = 1.0;
let loopInterval = null;

class WorkerSimulation {
  constructor(escherMapData, modelData) {
    this.mapData = escherMapData;
    this.modelData = modelData;

    this.metabolites = {};
    this.reactions = {};
    this.normalFluxes = {};
    this.tickCounter = 0;

    this.reactionMapping = {
      'PPKr': 'PPK',
      'PPK2r': 'PPK2',
    };

    this.bufferedIds = new Set([
      'adp_c', 'amp_c',
      'nad_c',
      'nadp_c', 'nadph_c',
      'pi_c', 'pi_e',
      'coa_c',
      'q8_c', 'q8h2_c',
      'nh4_c', 'nh4_e',
      'co2_c', 'co2_e',
      'o2_c', 'o2_e',
      'h_c', 'h_e',
      'h2o_c', 'h2o_e',
      'for_e', 'for_c',
    ]);

    this.initialConcentrations = {
      'glc__D_e': 10.0,
      'glc__D_c': 2.0,
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
      'accoa_c': 0.5,
      'oaa_c': 0.2,
      'cit_c': 1.2,
      'icit_c': 0.3,
      'akg_c': 1.0,
      'succoa_c': 0.4,
      'succ_c': 0.8,
      'fum_c': 0.5,
      'mal__L_c': 0.8,
      '6pgl_c': 0.2,
      '6pgc_c': 0.4,
      'ru5p__D_c': 0.3,
      'r5p_c': 0.5,
      'xu5p__D_c': 0.4,
      's7p_c': 0.6,
      'e4p_c': 0.3,
      'ac_c': 1.0,
      'ac_e': 0.0,
      'etoh_c': 0.5,
      'etoh_e': 0.0,
      'lac__D_c': 0.5,
      'lac__D_e': 0.0,
      'pyr_e': 0.0,
      'succ_e': 0.0,
      'akg_e': 0.0,
      'mal__L_e': 0.0,
      'fum_e': 0.0,
      'glu__L_e': 0.0,
      'gln__L_e': 0.0,
      'fru_e': 0.0,
      'acald_e': 0.0,
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
      'for_e': 0.1
    };

    // Precompile model structures for high performance
    this.modelReactionsMap = {};
    this.originalBounds = {};
    for (const rxn of this.modelData.reactions) {
      this.modelReactionsMap[rxn.id] = rxn;
      this.originalBounds[rxn.id] = [rxn.lower_bound, rxn.upper_bound];
    }

    this.initialize();
    this.buildStaticLpHeader();

    // Calculate normal reference fluxes under default conditions
    this.solveFba();
    this.normalFluxes = {};
    for (const mId of Object.keys(this.metabolites)) {
      const info = this.getMetaboliteInfo(mId);
      this.normalFluxes[mId] = info ? Math.max(1.5, info.influx) : 1.0;
    }
  }

  initialize() {
    const mapReactions = this.mapData[1].reactions;
    const mapNodes = this.mapData[1].nodes;

    // 1. Gather all metabolites in the map
    for (const node of Object.values(mapNodes)) {
      if (node.node_type === 'metabolite') {
        const mId = node.bigg_id;
        if (!this.metabolites[mId]) {
          const isBuffered = this.bufferedIds.has(mId);
          this.metabolites[mId] = {
            id: mId,
            name: node.name,
            concentration: this.initialConcentrations[mId] !== undefined ? this.initialConcentrations[mId] : 1.0,
            targetConcentration: this.initialConcentrations[mId] !== undefined ? this.initialConcentrations[mId] : 1.0,
            isBuffered: isBuffered
          };
        }
      }
    }

    // 2. Gather reactions and construct stoichiometry from map
    for (const rxn of Object.values(mapReactions)) {
      const biggId = rxn.bigg_id;
      const name = rxn.name;
      const reversibility = rxn.reversibility;

      const substrates = [];
      const products = [];
      const stoichiometry = {};

      rxn.metabolites.forEach(metab => {
        const mId = metab.bigg_id;
        const coeff = metab.coefficient;
        stoichiometry[mId] = coeff;
        if (coeff < 0) {
          substrates.push(mId);
        } else {
          products.push(mId);
        }

        // Ensure metabolite is registered
        if (!this.metabolites[mId]) {
          this.metabolites[mId] = {
            id: mId,
            name: mId,
            concentration: this.initialConcentrations[mId] !== undefined ? this.initialConcentrations[mId] : 1.0,
            targetConcentration: this.initialConcentrations[mId] !== undefined ? this.initialConcentrations[mId] : 1.0,
            isBuffered: this.bufferedIds.has(mId)
          };
        }
      });

      let defaultVmax = 10.0;
      let defaultKm = 0.8;

      if (biggId === 'GLCpts' || biggId === 'EX_glc__D_e') {
        defaultVmax = 18.0;
        defaultKm = 0.5;
      } else if (biggId === 'PFK' || biggId === 'PYK') {
        defaultVmax = 15.0;
        defaultKm = 0.3;
      } else if (biggId === 'CS' || biggId === 'ICDHyr') {
        defaultVmax = 12.0;
        defaultKm = 0.4;
      } else if (biggId === 'BIOMASS_Ecoli_core_w_GAM') {
        defaultVmax = 8.0;
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
        flux: 0.0
      };
    }
  }

  reset() {
    this.tickCounter = 0;
    for (const [id, metab] of Object.entries(this.metabolites)) {
      metab.concentration = this.initialConcentrations[id] !== undefined ? this.initialConcentrations[id] : 1.0;
      metab.targetConcentration = this.initialConcentrations[id] !== undefined ? this.initialConcentrations[id] : 1.0;
    }
    for (const rxn of Object.values(this.reactions)) {
      rxn.flux = 0.0;
      rxn.vMax = rxn.defaultVmax;
      rxn.km = rxn.defaultKm;
    }

    this.solveFba();
    this.normalFluxes = {};
    for (const mId of Object.keys(this.metabolites)) {
      const info = this.getMetaboliteInfo(mId);
      this.normalFluxes[mId] = info ? Math.max(1.5, info.influx) : 1.0;
    }
  }

  inject(metabId, amount) {
    if (this.metabolites[metabId]) {
      this.metabolites[metabId].concentration += amount;
      if (this.metabolites[metabId].concentration > 150.0) {
        this.metabolites[metabId].concentration = 150.0;
      }
    }
  }

  deplete(metabId) {
    if (this.metabolites[metabId]) {
      this.metabolites[metabId].concentration = 0.1;
    }
  }

  updateParameter(rxnId, param, value) {
    if (this.reactions[rxnId]) {
      if (param === 'vMax') {
        this.reactions[rxnId].vMax = Math.max(0.0, value);
      } else if (param === 'km') {
        this.reactions[rxnId].km = Math.max(0.05, value);
      }
    }
  }

  buildStaticLpHeader() {
    const lines = [];

    // 1. Objective function
    lines.push('Maximize');
    const objTerms = [];
    for (const rxn of this.modelData.reactions) {
      const objCoeff = parseFloat(rxn.objective_coefficient || 0);
      if (objCoeff !== 0) {
        objTerms.push(`${objCoeff} R_${rxn.id}`);
      }
    }
    if (objTerms.length === 0) {
      objTerms.push('1 R_BIOMASS_Ec_iJO1366_core_53p95M');
    }
    lines.push(`  obj: ${objTerms.join(' + ')}`);

    // 2. Constraints (Subject To)
    lines.push('Subject To');

    // Prebuild stoichiometry map
    const stoichiometryMap = {};
    for (const rxn of this.modelData.reactions) {
      for (const [metId, coeff] of Object.entries(rxn.metabolites)) {
        if (!stoichiometryMap[metId]) {
          stoichiometryMap[metId] = [];
        }
        stoichiometryMap[metId].push({
          reactionId: rxn.id,
          coefficient: coeff
        });
      }
    }

    // Write row for each metabolite
    for (const met of this.modelData.metabolites) {
      const metId = met.id;
      const terms = stoichiometryMap[metId];
      if (!terms || terms.length === 0) continue;

      const termStrings = terms.map(t => {
        const sign = t.coefficient >= 0 ? '+' : '-';
        const absVal = Math.abs(t.coefficient);
        return `${sign} ${absVal} R_${t.reactionId}`;
      });

      const constraintName = 'c_' + metId.replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`  ${constraintName}: ${termStrings.join(' ')} = 0`);
    }

    lines.push('Bounds');
    this.staticLpHeader = lines.join('\n') + '\n';
  }

  formatBound(val, isUpper) {
    if (val === null || val === undefined) {
      return isUpper ? 'inf' : '-inf';
    }
    if (val === Infinity || val >= 999999) {
      return 'inf';
    }
    if (val === -Infinity || val <= -999999) {
      return '-inf';
    }
    return val.toString();
  }

  solveFba() {
    // 1. Get original bounds
    const bounds = {};
    for (const rxn of this.modelData.reactions) {
      const orig = this.originalBounds[rxn.id];
      bounds[rxn.id] = {
        lowerBound: orig[0],
        upperBound: orig[1]
      };
    }

    // 2. Apply kinetic bounds on checkpoints
    const coupledCheckpoints = new Set(['GLCptspp', 'PFK', 'PYK', 'CS', 'ICDHyr', 'SUCDi']);

    for (const [coreRxnId, coreRxn] of Object.entries(this.reactions)) {
      const modelRxnId = this.reactionMapping[coreRxnId] || coreRxnId;
      const modelRxn = this.modelReactionsMap[modelRxnId];
      if (!modelRxn) continue;

      const vMax = coreRxn.vMax;
      const km = coreRxn.km;
      const orig = this.originalBounds[modelRxnId];

      const hasExtracellularSubstrate = coreRxn.substrates.some(sId => sId.endsWith('_e'));

      if (coreRxn.reversibility) {
        let ubForward = vMax;
        let ubBackward = vMax;

        if (coupledCheckpoints.has(modelRxnId) || hasExtracellularSubstrate) {
          for (const sId of coreRxn.substrates) {
            if (this.metabolites[sId] && !this.metabolites[sId].isBuffered) {
              const conc = this.metabolites[sId].concentration;
              ubForward = Math.min(ubForward, vMax * (conc / (km + conc)));
            }
          }
          for (const pId of coreRxn.products) {
            if (this.metabolites[pId] && !this.metabolites[pId].isBuffered) {
              const conc = this.metabolites[pId].concentration;
              ubBackward = Math.min(ubBackward, vMax * (conc / (km + conc)));
            }
          }
        }

        const lb = (orig[0] < -1e-5) ? -ubBackward : 0.0;
        const ub = (orig[1] > 1e-5) ? ubForward : 0.0;

        bounds[modelRxnId] = { lowerBound: lb, upperBound: ub };
      } else {
        let ubForward = vMax;
        if (coupledCheckpoints.has(modelRxnId) || hasExtracellularSubstrate) {
          for (const sId of coreRxn.substrates) {
            if (this.metabolites[sId] && !this.metabolites[sId].isBuffered) {
              const conc = this.metabolites[sId].concentration;
              ubForward = Math.min(ubForward, vMax * (conc / (km + conc)));
            }
          }
        }

        const lb = 0.0;
        const ub = (orig[1] > 1e-5) ? ubForward : 0.0;

        bounds[modelRxnId] = { lowerBound: lb, upperBound: ub };
      }
    }

    // 3. Write bounds section
    const boundsLines = [];
    for (const rxn of this.modelData.reactions) {
      const rxnId = rxn.id;
      const b = bounds[rxnId];
      const lbStr = this.formatBound(b.lowerBound, false);
      const ubStr = this.formatBound(b.upperBound, true);
      boundsLines.push(`  ${lbStr} <= R_${rxnId} <= ${ubStr}`);
    }

    const lpString = this.staticLpHeader + boundsLines.join('\n') + '\nEnd';

    // 4. Solve LP using HiGHS Wasm
    try {
      const sol = highs.solve(lpString, {
        "log_to_console": false,
        "output_flag": false
      });

      if (sol.Status === 'Optimal') {
        const columns = sol.Columns;

        // Map fluxes back to map reactions
        for (const [coreRxnId, coreRxn] of Object.entries(this.reactions)) {
          const modelRxnId = this.reactionMapping[coreRxnId] || coreRxnId;
          const varName = 'R_' + modelRxnId;
          if (columns[varName]) {
            coreRxn.flux = columns[varName].Primal;
          } else {
            coreRxn.flux = 0.0;
          }
        }

        // Map specific model objectives & special reactions
        const biomassFlux = columns['R_BIOMASS_Ec_iJO1366_core_53p95M']?.Primal || 0.0;
        if (this.reactions['BIOMASS_Ecoli_core_w_GAM']) {
          this.reactions['BIOMASS_Ecoli_core_w_GAM'].flux = biomassFlux;
        }

        if (this.reactions['ATPS4r']) {
          const atpsFlux = columns['R_ATPS4rpp']?.Primal || 0.0;
          this.reactions['ATPS4r'].flux = atpsFlux;
        }
      } else {
        console.warn(`[Worker] FBA solve failed: ${sol.Status}`);
        for (const coreRxn of Object.values(this.reactions)) {
          coreRxn.flux = 0.0;
        }
      }
    } catch (err) {
      console.error('[Worker] Error during highs.solve:', err);
      for (const coreRxn of Object.values(this.reactions)) {
        coreRxn.flux = 0.0;
      }
    }
  }

  tick(speedMultiplier = 1.0) {
    const dt = 0.01 * speedMultiplier;

    if (this.tickCounter % 5 === 0) {
      this.solveFba();
    }
    this.tickCounter = (this.tickCounter + 1) % 5;

    // Calculate Influxes and Outfluxes
    const influxes = {};
    const outfluxes = {};
    for (const mId of Object.keys(this.metabolites)) {
      influxes[mId] = 0.0;
      outfluxes[mId] = 0.0;
    }

    for (const rxn of Object.values(this.reactions)) {
      const flux = rxn.flux;
      for (const [mId, coeff] of Object.entries(rxn.stoichiometry)) {
        if (this.metabolites[mId]) {
          const rate = coeff * flux;
          if (rate > 0) {
            influxes[mId] += rate;
          } else {
            outfluxes[mId] += Math.abs(rate);
          }
        }
      }
    }

    // Euler Integration
    for (const [mId, metab] of Object.entries(this.metabolites)) {
      if (metab.isBuffered) {
        metab.targetConcentration = metab.concentration;
        continue;
      }

      if (mId.endsWith('_e')) {
        if (mId === 'glc__D_e') {
          metab.targetConcentration = metab.concentration;
          continue;
        }
        const nextConc = metab.concentration + (influxes[mId] - outfluxes[mId]) * dt;
        metab.concentration = Math.max(0.0, Math.min(nextConc, 150.0));
        metab.targetConcentration = metab.concentration;
      } else {
        const J_in = influxes[mId];
        const J_out = outfluxes[mId];
        const J = J_in;
        const J_normal = this.normalFluxes[mId] || 1.0;

        let vMaxSum = 0.0;
        let vMaxDefaultSum = 0.0;
        for (const rxn of Object.values(this.reactions)) {
          const coeff = rxn.stoichiometry[mId];
          if (coeff) {
            if (coeff < 0 || (coeff > 0 && rxn.reversibility)) {
              vMaxSum += rxn.vMax;
              vMaxDefaultSum += rxn.defaultVmax;
            }
          }
        }

        let activityRatio = 1.0;
        if (vMaxSum > 0 && vMaxDefaultSum > 0) {
          activityRatio = vMaxSum / vMaxDefaultSum;
        }

        const baseline = this.initialConcentrations[mId] || 1.0;
        let target = baseline * (Math.max(0.01, J) / J_normal) / activityRatio;
        target = Math.max(0.1, Math.min(target, 150.0));
        metab.targetConcentration = target;

        let dC = J_in - J_out * (metab.concentration / target) - 0.02 * metab.concentration;
        if (mId === 'h2o2_c') {
          // Simulate rapid degradation of hydrogen peroxide by catalase/peroxidase (sink)
          dC -= 10.0 * metab.concentration;
        }
        const nextConc = metab.concentration + dC * dt;
        metab.concentration = Math.max(0.1, Math.min(nextConc, 150.0));
      }
    }
  }

  getMetaboliteInfo(id) {
    const metab = this.metabolites[id];
    if (!metab) return null;

    let influx = 0;
    let outflux = 0;

    for (const rxn of Object.values(this.reactions)) {
      const coeff = rxn.stoichiometry ? rxn.stoichiometry[id] : undefined;
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

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === 'init') {
    try {
      console.log('[Worker] Loading HiGHS WASM solver...');
      highs = await highsLoader({
        locateFile: () => msg.wasmUrl
      });
      console.log('[Worker] HiGHS WASM loaded successfully.');

      console.log('[Worker] Fetching model and map JSON files...');
      const [modelRes, mapRes] = await Promise.all([
        fetch(msg.modelUrl),
        fetch(msg.mapUrl)
      ]);
      const modelData = await modelRes.json();
      const mapData = await mapRes.json();
      console.log('[Worker] JSON files fetched successfully.');

      console.log('[Worker] Initializing simulation state...');
      simulation = new WorkerSimulation(mapData, modelData);
      console.log('[Worker] Simulation state initialized.');

      self.postMessage({ type: 'ready' });

      startSimulationLoop();
    } catch (err) {
      console.error('[Worker] Failed to initialize worker:', err);
    }
  } else if (msg.type === 'pause') {
    isPaused = msg.value;
  } else if (msg.type === 'speed') {
    speedMultiplier = msg.value;
  } else if (msg.type === 'inject') {
    if (simulation) simulation.inject(msg.metab_id, msg.amount);
  } else if (msg.type === 'deplete') {
    if (simulation) simulation.deplete(msg.metab_id);
  } else if (msg.type === 'update_parameter') {
    if (simulation) simulation.updateParameter(msg.rxn_id, msg.param, msg.value);
  } else if (msg.type === 'bulk_update_parameters') {
    if (simulation) {
      for (const u of msg.updates) {
        simulation.updateParameter(u.rxn_id, u.param, u.value);
      }
    }
  } else if (msg.type === 'reset') {
    if (simulation) {
      simulation.reset();
      sendState();
    }
  }
};

function startSimulationLoop() {
  if (loopInterval) clearInterval(loopInterval);
  loopInterval = setInterval(() => {
    if (!isPaused && simulation) {
      simulation.tick(speedMultiplier);
      sendState();
    }
  }, 50); // 20Hz (50ms)
}

function sendState() {
  if (!simulation) return;

  const biomassFlux = simulation.reactions['BIOMASS_Ecoli_core_w_GAM']?.flux || 0.0;

  const state = {
    metabolites: {},
    reactions: {},
    biomass_flux: Math.max(0.0, biomassFlux)
  };

  for (const [m_id, m] of Object.entries(simulation.metabolites)) {
    state.metabolites[m_id] = {
      concentration: m.concentration
    };
  }
  for (const [r_id, r] of Object.entries(simulation.reactions)) {
    state.reactions[r_id] = {
      flux: r.flux
    };
  }

  self.postMessage({
    type: 'tick',
    state
  });
}
