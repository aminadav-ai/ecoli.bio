import fs from 'fs';
import path from 'path';
import { Simulation } from './simulation.js';
import { bulkIncrementUserTimeSpent, clearCachedUser } from './supabase_db.js';

const staticBoundsPath = path.resolve('src/static_bounds.json');
let staticBounds = {};
if (fs.existsSync(staticBoundsPath)) {
  staticBounds = JSON.parse(fs.readFileSync(staticBoundsPath, 'utf8'));
}

export { staticBounds };

// Load Escher map JSON data for server-side Simulation
const mapDataPath = path.resolve('public/iJO1366.Central metabolism.json');
let escherMapData = null;
if (fs.existsSync(mapDataPath)) {
  escherMapData = JSON.parse(fs.readFileSync(mapDataPath, 'utf8'));
} else {
  console.error(`[Solver] Escher map file not found at ${mapDataPath}`);
}

const userSimulations = new Map();
let referenceNormalFluxes = null;

function getOrCreateSimulation(guestId) {
  const id = guestId || 'default_user';
  if (!userSimulations.has(id)) {
    if (escherMapData) {
      const sim = new Simulation(escherMapData);
      if (referenceNormalFluxes) {
        sim.normalFluxes = { ...referenceNormalFluxes };
      }
      userSimulations.set(id, sim);
    } else {
      console.error('[Solver] Map data not loaded. Cannot initialize Simulation on server.');
      return null;
    }
  } else {
    const sim = userSimulations.get(id);
    if (Object.keys(sim.normalFluxes).length === 0 && referenceNormalFluxes) {
      sim.normalFluxes = { ...referenceNormalFluxes };
    }
  }
  return userSimulations.get(id);
}

function ensureReferenceNormalFluxes(highsInstance, staticLpHeader) {
  if (referenceNormalFluxes) return;
  if (!highsInstance) return;

  try {
    const refConcentrations = { 'o2_e': 1.0, 'glc__D_e': 10.0 };
    // Call solveFba with skipSimTick to avoid infinite loop/recursion
    const refResult = solveFba(highsInstance, staticLpHeader, refConcentrations, {}, { skipSimTick: true });
    if (refResult.status === 'Optimal' && escherMapData) {
      const refSim = new Simulation(escherMapData);
      refSim.updateFluxes(refResult.fluxes, refResult.biomass_flux);
      referenceNormalFluxes = { ...refSim.normalFluxes };
      console.log('[Solver] Pre-calculated referenceNormalFluxes successfully on server.');
    }
  } catch (e) {
    console.error('[Solver] Failed to pre-calculate referenceNormalFluxes:', e);
  }
}

export function calculateBounds(concentrations, parameters) {
  const bounds = {};
  const repressed = {};
  
  // Define default blocked bypasses
  const defaultBlocked = [
    'PFK_3', 'FBA3', 'F6PA', 'GLCDpp', 'XYLI2', 'GLCabcpp',
    'HPYRI', 'PROt2rpp', 'CA2t3pp', 'R15BPK', 'VPAMTr', 'ADK3'
  ];
  
  // Define coupled checkpoints
  const coupledCheckpoints = new Set([]);
  
  // Stoichiometry needed for kinetic bounds calculation
  const reactionSubstrates = {
    'GLCptspp': ['pep_c'], // glc__D_p is buffered, only pep_c is checked
    'PFK': ['f6p_c'], // atp_c is buffered
    'PYK': ['pep_c'], // adp_c, h_c are buffered
    'CS': ['accoa_c', 'oaa_c'], // h2o_c is buffered
    'ICDHyr': ['icit_c'], // nadp_c is buffered
    'SUCDi': ['succ_c'] // q8_c is buffered
  };
  const reactionProducts = {
    'GLCptspp': [], // no reversible check
    'PFK': ['fdp_c'],
    'PYK': ['pyr_c'],
    'CS': ['cit_c'],
    'ICDHyr': ['akg_c'],
    'SUCDi': ['fum_c']
  };

  // Determine if catabolite repression is active (based on extracellular glucose)
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

    // Apply default blocked bypasses
    if (defaultBlocked.includes(rxnId)) {
      bounds[rxnId] = { lowerBound: 0.0, upperBound: 0.0 };
      continue;
    }

    // Special handling for oxygen exchange based on extracellular oxygen concentration
    if (rxnId === 'EX_o2_e') {
      const o2ConcVal = concentrations['o2_e'] !== undefined ? concentrations['o2_e'] : 0.2;
      const maxO2Uptake = 18.5;
      bounds[rxnId] = { lowerBound: -maxO2Uptake * o2ConcVal, upperBound: 1000.0 };
      continue;
    }

    // Default Vmax and Km parameters (client simulation defaults)
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

    // Get current Vmax/Km (overridden by student if present in parameters)
    const param = parameters[rxnId] || {};
    let vMax = param.vMax !== undefined ? param.vMax : defaultVmax;
    const km = param.km !== undefined ? param.km : defaultKm;

    // Apply Regulatory FBA: MALS and ICL are repressed (vMax = 0.0) when glucose is present
    if ((rxnId === 'MALS' || rxnId === 'ICL') && isGlucoseRepressed) {
      vMax = 0.0;
    }

    // Apply Regulatory FBA: PFL repressed by oxygen, PDH repressed anaerobically
    if (rxnId === 'PFL' && o2Conc > 0.05) {
      vMax = 0.0;
    }
    if (rxnId === 'PDH' && o2Conc <= 0.05) {
      vMax = 0.0;
    }

    if (coupledCheckpoints.has(rxnId)) {
      // Check reversibility
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

export function solveFba(highsInstance, staticLpHeader, concentrations, parameters, options = {}) {
  const { guestId, reset, scenario, skipSimTick, userEmail } = options;

  // Make sure reference normal fluxes are initialized on server
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

  if (skipSimTick) {
    return result;
  }

  const sim = getOrCreateSimulation(guestId);
  if (sim) {
    if (userEmail) {
      sim.userEmail = userEmail;
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

    // Reset enzyme parameters to defaults, then apply active user tweaks
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

      // Track active simulation time spent
      if (userEmail && !skipSimTick) {
        const now = Date.now();
        if (sim.lastSolveTime) {
          const elapsed = (now - sim.lastSolveTime) / 1000;
          if (elapsed < 1.5) {
            sim.activeTimeBuffer = (sim.activeTimeBuffer || 0) + elapsed;
          }
        }
        sim.lastSolveTime = now;
      }
    }

    const calculatedConcentrations = {};
    for (const [mId, metab] of Object.entries(sim.metabolites)) {
      calculatedConcentrations[mId] = metab.concentration;
    }
    result.concentrations = calculatedConcentrations;
  }

  return result;
}

let activeTimeFlusherIntervalId = null;

// Start the periodic active time flush loop (every 60 seconds)
export function startActiveTimeFlusher() {
  if (activeTimeFlusherIntervalId) return;

  activeTimeFlusherIntervalId = setInterval(async () => {
    const emailSecondsMap = new Map();
    
    for (const sim of userSimulations.values()) {
      if (sim.userEmail && sim.activeTimeBuffer >= 1) {
        const email = sim.userEmail;
        const seconds = Math.floor(sim.activeTimeBuffer);
        emailSecondsMap.set(email, (emailSecondsMap.get(email) || 0) + seconds);
        sim.activeTimeBuffer = sim.activeTimeBuffer - seconds;
      }
    }

    if (emailSecondsMap.size === 0) return;

    const pendingUpdates = Array.from(emailSecondsMap.entries()).map(([email, seconds]) => ({
      email,
      seconds
    }));

    console.log(`[Solver] Flushing active simulation time to DB for ${pendingUpdates.length} users:`, pendingUpdates);
    await bulkIncrementUserTimeSpent(pendingUpdates);
  }, 60000);
}
