// src/fba_solver_worker.js
// FBA solver core adapted for Cloudflare Workers (no fs/path dependencies)

import { Simulation } from './simulation.js';
import staticBounds from './static_bounds.json';
import escherMapData from '../public/iJO1366.Central metabolism.json';

export { staticBounds };

let referenceNormalFluxes = null;

export function serializeSimulation(sim) {
  const state = {
    metabolites: {},
    parameters: {},
    isDead: sim.isDead || false,
    tickCounter: sim.tickCounter || 0,
    lastTimestamp: sim.lastTimestamp || 0
  };
  for (const [mId, metab] of Object.entries(sim.metabolites)) {
    state.metabolites[mId] = {
      concentration: metab.concentration,
      targetConcentration: metab.targetConcentration
    };
  }
  for (const [rId, rxn] of Object.entries(sim.reactions)) {
    if (rxn.vMax !== rxn.defaultVmax || rxn.km !== rxn.defaultKm) {
      state.parameters[rId] = {
        vMax: rxn.vMax,
        km: rxn.km
      };
    }
  }
  return state;
}

export function deserializeSimulation(sim, state) {
  if (!state) return;
  if (state.metabolites) {
    for (const [mId, mState] of Object.entries(state.metabolites)) {
      if (sim.metabolites[mId]) {
        sim.metabolites[mId].concentration = mState.concentration;
        sim.metabolites[mId].targetConcentration = mState.targetConcentration;
      }
    }
  }
  if (state.parameters) {
    for (const [rId, rState] of Object.entries(state.parameters)) {
      if (sim.reactions[rId]) {
        sim.reactions[rId].vMax = rState.vMax;
        sim.reactions[rId].km = rState.km;
      }
    }
  }
  sim.isDead = !!state.isDead;
  sim.tickCounter = state.tickCounter || 0;
  sim.lastTimestamp = state.lastTimestamp || 0;
}

export function initializeNewSimulation() {
  if (escherMapData) {
    const sim = new Simulation(escherMapData);
    if (referenceNormalFluxes) {
      sim.normalFluxes = { ...referenceNormalFluxes };
    }
    return sim;
  }
  console.error('[Solver] Map data not loaded. Cannot initialize Simulation.');
  return null;
}

function ensureReferenceNormalFluxes(highsInstance, staticLpHeader) {
  if (referenceNormalFluxes) return;
  if (!highsInstance) return;

  try {
    const refConcentrations = { 'o2_e': 1.0, 'glc__D_e': 10.0 };
    const refResult = solveFba(highsInstance, staticLpHeader, refConcentrations, {}, { skipSimTick: true });
    if (refResult.status === 'Optimal' && escherMapData) {
      const refSim = new Simulation(escherMapData);
      refSim.updateFluxes(refResult.fluxes, refResult.biomass_flux);
      referenceNormalFluxes = { ...refSim.normalFluxes };
      console.log('[Solver] Pre-calculated referenceNormalFluxes successfully on worker.');
    }
  } catch (e) {
    console.error('[Solver] Failed to pre-calculate referenceNormalFluxes:', e);
  }
}

export function calculateBounds(concentrations, parameters) {
  const bounds = {};
  const repressed = {};
  
  const defaultBlocked = [
    'PFK_3', 'FBA3', 'F6PA', 'GLCDpp', 'XYLI2', 'GLCabcpp',
    'HPYRI', 'PROt2rpp', 'CA2t3pp', 'R15BPK', 'VPAMTr', 'ADK3'
  ];
  
  const coupledCheckpoints = new Set([]);
  
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

  const glcConc = concentrations['glc__D_e'] !== undefined ? concentrations['glc__D_e'] : 10.0;
  const isGlucoseRepressed = glcConc > 0.2;
  const o2Conc = concentrations['o2_e'] !== undefined ? concentrations['o2_e'] : 0.2;

  if (isGlucoseRepressed) {
    repressed['MALS'] = { repressed: true, reason: '(Repressed by Glucose 🔒)' };
    repressed['ICL'] = { repressed: true, reason: '(Repressed by Glucose 🔒)' };
  }
  if (o2Conc > 0.05) {
    repressed['PFL'] = { repressed: true, reason: '(Repressed by Oxygen 🔒)' };
  } else {
    repressed['PDH'] = { repressed: true, reason: '(Repressed by Anaerobiosis 🔒)' };
  }

  for (const rxnId of Object.keys(staticBounds)) {
    const orig = staticBounds[rxnId];

    if (defaultBlocked.includes(rxnId)) {
      bounds[rxnId] = { lowerBound: 0.0, upperBound: 0.0 };
      continue;
    }

    if (rxnId === 'EX_o2_e') {
      const o2ConcVal = concentrations['o2_e'] !== undefined ? concentrations['o2_e'] : 0.2;
      const maxO2Uptake = 18.5;
      bounds[rxnId] = { lowerBound: -maxO2Uptake * o2ConcVal, upperBound: 1000.0 };
      continue;
    }

    let defaultVmax = 10.0;
    let defaultKm = 0.8;

    if (rxnId === 'GLCptspp' || rxnId === 'EX_glc__D_e') {
      defaultVmax = 18.0;
      defaultKm = 0.5;
    } else if (rxnId === 'PFK' || rxnId === 'PYK') {
      defaultVmax = 15.0;
      defaultKm = 0.3;
    } else if (rxnId === 'CS' || rxnId === 'ICDHyr') {
      defaultVmax = 12.0;
      defaultKm = 0.4;
    } else if (rxnId === 'BIOMASS_Ecoli_core_w_GAM') {
      defaultVmax = 8.0;
      defaultKm = 1.0;
    }

    const param = parameters[rxnId] || {};
    let vMax = param.vMax !== undefined ? param.vMax : defaultVmax;
    const km = param.km !== undefined ? param.km : defaultKm;

    if ((rxnId === 'MALS' || rxnId === 'ICL') && isGlucoseRepressed) {
      vMax = 0.0;
    }

    if (rxnId === 'PFL' && o2Conc > 0.05) {
      vMax = 0.0;
    }
    if (rxnId === 'PDH' && o2Conc <= 0.05) {
      vMax = 0.0;
    }

    if (coupledCheckpoints.has(rxnId)) {
      const isReversible = (orig.lb < -1e-5);

      if (isReversible) {
        let ubForward = vMax;
        let ubBackward = vMax;

        const subs = reactionSubstrates[rxnId] || [];
        for (const sId of subs) {
          const conc = concentrations[sId] !== undefined ? concentrations[sId] : 1.0;
          ubForward = Math.min(ubForward, vMax * (conc / (km + conc)));
        }
        const prods = reactionProducts[rxnId] || [];
        for (const pId of prods) {
          const conc = concentrations[pId] !== undefined ? concentrations[pId] : 1.0;
          ubBackward = Math.min(ubBackward, vMax * (conc / (km + conc)));
        }

        bounds[rxnId] = { lowerBound: -ubBackward, upperBound: ubForward };
      } else {
        let ubForward = vMax;
        const subs = reactionSubstrates[rxnId] || [];
        for (const sId of subs) {
          const conc = concentrations[sId] !== undefined ? concentrations[sId] : 1.0;
          ubForward = Math.min(ubForward, vMax * (conc / (km + conc)));
        }

        bounds[rxnId] = { lowerBound: 0.0, upperBound: ubForward };
      }
    } else {
      let lb = orig.lb;
      let ub = orig.ub;
      
      const hasOverride = parameters[rxnId] && parameters[rxnId].vMax !== undefined;
      const isRegulated = rxnId === 'MALS' || rxnId === 'ICL' || rxnId === 'PFL' || rxnId === 'PDH';
      
      if (hasOverride || isRegulated) {
        ub = Math.min(ub, vMax);
        if (orig.lb < -1e-5) {
          lb = Math.max(lb, -vMax);
        }
      }
      bounds[rxnId] = { lowerBound: lb, upperBound: ub };
    }
  }

  return { bounds, repressed };
}

export function solveFba(highsInstance, staticLpHeader, concentrations, parameters, simInstance = null, options = {}) {
  const { reset, scenario, skipSimTick } = options;

  if (!skipSimTick) {
    ensureReferenceNormalFluxes(highsInstance, staticLpHeader);
  }

  const { bounds, repressed } = calculateBounds(concentrations, parameters);

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

  const sol = highsInstance.solve(lpString, {
    "log_to_console": false,
    "output_flag": false
  });

  let fluxes = {};
  let biomassFlux = 0.0;
  let isDead = true;
  let status = sol.Status;

  if (status === 'Optimal') {
    const columns = sol.Columns;
    for (const colName of Object.keys(columns)) {
      if (colName.startsWith('R_')) {
        const rxnId = colName.substring(2);
        fluxes[rxnId] = columns[colName].Primal;
      }
    }
    biomassFlux = columns['R_BIOMASS_Ec_iJO1366_core_53p95M']?.Primal || 0.0;
    isDead = biomassFlux < 0.005;
  }

  const result = {
    status,
    fluxes,
    biomass_flux: biomassFlux,
    is_dead: isDead,
    repressed
  };

  if (skipSimTick || !simInstance) {
    return result;
  }

  const sim = simInstance;
  const prevConc = {};
  for (const [mId, metab] of Object.entries(sim.metabolites)) {
    prevConc[mId] = metab.concentration;
  }
  const prevFlux = {};
  for (const [rId, rxn] of Object.entries(sim.reactions)) {
    prevFlux[rId] = rxn.flux;
  }

  if (reset) {
    sim.reset();
  }
  if (scenario) {
    sim.applyScenario(scenario);
  }

  if (concentrations) {
    if (concentrations.o2_e !== undefined) {
      sim.metabolites['o2_e'].concentration = concentrations.o2_e;
      sim.metabolites['o2_e'].targetConcentration = concentrations.o2_e;
    }
    if (concentrations.glc__D_e !== undefined) {
      sim.metabolites['glc__D_e'].concentration = concentrations.glc__D_e;
      sim.metabolites['glc__D_e'].targetConcentration = concentrations.glc__D_e;
    }
  }

  for (const rxn of Object.values(sim.reactions)) {
    rxn.vMax = rxn.defaultVmax;
    rxn.km = rxn.defaultKm;
  }
  if (parameters) {
    for (const [rxnId, param] of Object.entries(parameters)) {
      if (sim.reactions[rxnId]) {
        if (param.vMax !== undefined) sim.reactions[rxnId].vMax = param.vMax;
        if (param.km !== undefined) sim.reactions[rxnId].km = param.km;
      }
    }
  }

  if (status === 'Optimal') {
    sim.updateFluxes(fluxes, biomassFlux);
    sim.tick(1.0);
    sim.solverTicksBuffer = (sim.solverTicksBuffer || 0) + 1;
  }

  const calculatedConcentrations = {};
  for (const [mId, metab] of Object.entries(sim.metabolites)) {
    calculatedConcentrations[mId] = metab.concentration;
  }
  result.concentrations = calculatedConcentrations;

  const changingMetabolites = [];
  const changingReactions = [];
  const epsilon = 1e-4;

  for (const [mId, metab] of Object.entries(sim.metabolites)) {
    const oldC = prevConc[mId] !== undefined ? prevConc[mId] : metab.concentration;
    const newC = metab.concentration;
    if (mId.endsWith('_e')) continue;
    
    const delta = newC - oldC;
    if (Math.abs(delta) > epsilon) {
      changingMetabolites.push({
        id: mId,
        name: metab.name || mId,
        delta: delta
      });
    }
  }

  for (const [rId, rxn] of Object.entries(sim.reactions)) {
    const oldF = prevFlux[rId] !== undefined ? prevFlux[rId] : rxn.flux;
    const newF = rxn.flux;
    const delta = newF - oldF;
    if (Math.abs(delta) > epsilon) {
      changingReactions.push({
        id: rId,
        name: rxn.name || rId,
        delta: delta
      });
    }
  }

  changingMetabolites.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  changingReactions.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  result.stabilized = (changingMetabolites.length === 0 && changingReactions.length === 0);
  result.changingMetabolites = changingMetabolites;
  result.changingReactions = changingReactions;

  return result;
}
