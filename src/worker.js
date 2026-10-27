// src/worker.js
// Cloudflare Worker + Durable Objects entry point

import './polyfill.js';
import highsLoader from 'highs';
import highsWasm from 'highs/build/highs.wasm';
import staticLpHeader from '../public/static_lp_header.txt';

import { 
  deserializeSimulation, 
  initializeNewSimulation, 
  serializeSimulation, 
  solveFba 
} from './fba_solver_worker.js';

import { 
  getUserByToken, 
  verifyGoogleTokenAndLogin, 
  getUserStatus, 
  logoutSession, 
  saveChatMessage, 
  getChatHistory, 
  getRecentChatHistory,
  incrementChatRateLimit,
  bulkIncrementUserStats,
  incrementUserVisits,
  recordGuestVisit,
  getSimulationSessions,
  getSimulationSession,
  upsertSimulationSession,
  renameSimulationSession,
  deleteSimulationSession,
  deleteChatHistoryForSession,
  getExperimentCount,
  logExperimentAction,
  getExperimentLogs,
  deductUserCredits,
  recordReactionActivity,
  incrementGuestActivity
} from './d1_db.js';

// AI chat abuse protection (caps Gemini token spend)
const CHAT_LIMITS = {
  guestPerDay: 10,          // messages per guest IP per UTC day
  userPerDay: 100,          // messages per registered account per UTC day
  guestTotalPerDay: 300,    // circuit breaker: all guest messages combined per UTC day
  guestTotalAlertRatio: 0.8, // Telegram alert when this share of guestTotalPerDay is used
  messageChars: 3000,       // regular question (incl. scenario reflection template)
  reportMessageChars: 20000, // "analyze experiment report" request includes the timeline
  contextChars: 120000,     // serialized simulation context (all map reactions/metabolites), ~30k tokens max
  historyMessages: 10,      // previous messages loaded from D1
  historyItemChars: 4000,   // per history message
  outputTokens: 2048,
  reportOutputTokens: 4096
};
// Gemini model for chat, rename and translation (gemini-2.5-flash is unavailable to new projects)
const GEMINI_MODEL = 'gemini-3.8-flash';
const REPORT_PROMPT_PREFIX = 'Please write a scientific, neutral analysis of the biological meaning and impact of this metabolic experiment';

// IPv6 clients usually own a whole /64, so rate-limit by that prefix instead of the full address
function rateLimitIpKey(ip) {
  if (!ip || !ip.includes(':')) return ip || 'unknown';
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail !== undefined ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}

function isDefaultOrAutoName(name) {
  if (!name || name === "Experiment") return true;
  const regex = /^Experiment \(\d{4}-\d{2}-\d{2} #\d+\)$/;
  return regex.test(name);
}

// Helper to log reaction parameter changes on the server side
async function logReactionChanges(db, simulation, incomingParams, singleId = null, singleParam = null, singleVal = null) {
  const changes = {}; // reactionId -> { vmaxChanged: bool, kmChanged: bool }
  
  if (incomingParams) {
    for (const [rId, paramObj] of Object.entries(incomingParams)) {
      const rxn = simulation.reactions[rId];
      if (rxn) {
        let vmaxChanged = false;
        let kmChanged = false;
        if (paramObj.vMax !== undefined && paramObj.vMax !== rxn.vMax) {
          vmaxChanged = true;
        }
        if (paramObj.km !== undefined && paramObj.km !== rxn.km) {
          kmChanged = true;
        }
        if (vmaxChanged || kmChanged) {
          changes[rId] = { vmaxChanged, kmChanged };
        }
      }
    }
  }
  
  if (singleId && singleParam && singleVal !== null && singleVal !== undefined) {
    const rxn = simulation.reactions[singleId];
    if (rxn) {
      let vmaxChanged = false;
      let kmChanged = false;
      if (singleParam === 'vMax' && parseFloat(singleVal) !== rxn.vMax) {
        vmaxChanged = true;
      }
      if (singleParam === 'km' && parseFloat(singleVal) !== rxn.km) {
        kmChanged = true;
      }
      if (vmaxChanged || kmChanged) {
        if (!changes[singleId]) {
          changes[singleId] = { vmaxChanged: false, kmChanged: false };
        }
        changes[singleId].vmaxChanged = changes[singleId].vmaxChanged || vmaxChanged;
        changes[singleId].kmChanged = changes[singleId].kmChanged || kmChanged;
      }
    }
  }

  for (const [rId, chg] of Object.entries(changes)) {
    await recordReactionActivity(db, rId, chg.vmaxChanged, chg.kmChanged);
  }
}

function getChatIdentifier(userEmail, sessionId, guestId) {
  if (userEmail && !userEmail.startsWith('guest')) {
    return sessionId ? `user:${userEmail}:${sessionId}` : `user:${userEmail}`;
  } else {
    const gId = guestId || (userEmail && userEmail.startsWith('guest:') ? userEmail.split(':')[1] : 'unknown');
    return sessionId ? `guest:${gId}:${sessionId}` : `guest:${gId}`;
  }
}

// ==========================================
// 1. Durable Object: SolverDO
// ==========================================
export class SolverDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.simulation = null;
    this.highs = null;
    this.lastSolveTime = 0;

    // Session fields
    this.sessionId = this.state.id.toString();
    this.baseName = "Experiment";
    this.name = "Experiment";
    this.activeRenamePromise = null;
    this.isSolving = false;
    this.isFreshSession = true;
    this.hasCheckedInitialLog = false;
    this.stabilized = false;
    this.ticksRun = 0;
    this.isRenamePending = false;

    // In-memory buffering state
    this.bufferedTicks = 0;
    this.pendingLogAction = null;
    this.lastFlushTime = 0;
    this.userEmail = null;
    this.alarmScheduled = false;
    this.credits = undefined;

    // Block DO concurrency until WASM solver is loaded and state is restored
    this.state.blockConcurrencyWhile(async () => {
      try {
        console.log('[DO] Loading HiGHS solver WebAssembly...');
        this.highs = await highsLoader({
          instantiateWasm(imports, successCallback) {
            console.log('[DO] instantiating WASM...');
            WebAssembly.instantiate(highsWasm, imports)
              .then(result => {
                console.log('[DO] WASM instantiation successful.');
                if (result.instance) {
                  successCallback(result.instance, result.module);
                } else {
                  successCallback(result, highsWasm);
                }
              })
              .catch(err => {
                console.error('[DO] WebAssembly.instantiate error:', err);
              });
            return {};
          }
        });
        console.log('[DO] HiGHS solver WebAssembly loaded successfully.');
        
        // Restore simulation state from DO storage
        const savedState = await this.state.storage.get('sim_state');
        this.isCustomName = await this.state.storage.get('is_custom_name') || false;
        this.simulation = initializeNewSimulation();
        if (savedState && this.simulation) {
          deserializeSimulation(this.simulation, savedState);
          console.log('[DO] Restored active simulation state from storage.');
          const hasFluxes = Object.values(this.simulation.reactions).some(r => r.flux !== 0);
          if (hasFluxes || (this.simulation.tickCounter && this.simulation.tickCounter > 0)) {
            this.isFreshSession = false;
          }
        } else {
          console.log('[DO] Initialized new simulation state.');
        }

        // Restore buffered ticks and user email
        const bufferedState = await this.state.storage.get('buffered_state');
        if (bufferedState) {
          this.bufferedTicks = bufferedState.ticks || 0;
          this.userEmail = bufferedState.email || null;
          console.log(`[DO] Restored buffered state: ${this.bufferedTicks} ticks for ${this.userEmail}`);
        }
      } catch (err) {
        console.error('[DO] Failed DO initialization:', err);
      }
    });
  }

  async ensureInitialLog(result) {
    if (this.hasCheckedInitialLog) return;
    this.hasCheckedInitialLog = true;
    try {
      const logs = await getExperimentLogs(this.env.DB, this.sessionId);
      if (logs.length === 0) {
        const biomass = result.biomass_flux || 0.0;
        const glcFlux = result.fluxes ? (result.fluxes['EX_glc__D_e'] || 0.0) : 0.0;
        const o2Flux = result.fluxes ? (result.fluxes['EX_o2_e'] || 0.0) : 0.0;
        const glcUptake = Math.max(0.0, -glcFlux);
        const o2Uptake = Math.max(0.0, -o2Flux);
        const atpYield = Math.max(0.0, Math.abs(result.fluxes ? (result.fluxes['ATPS4rpp'] || result.fluxes['ATPS4r'] || 0.0) : 0.0));
        const isDead = result.is_dead ? 1 : 0;

        await logExperimentAction(
          this.env.DB,
          this.sessionId,
          'initial',
          'Initial State',
          null, // value
          null, // prev_value
          biomass,
          glcUptake,
          o2Uptake,
          atpYield,
          isDead
        );
        console.log('[DO] Logged Initial State to D1 successfully.');
      }
    } catch (err) {
      this.hasCheckedInitialLog = false; // reset to try again next time if there was a DB error
      console.error('[DO] ensureInitialLog error:', err);
    }
  }

  async flushTicks() {
    if (this.bufferedTicks > 0 && this.userEmail) {
      const email = this.userEmail;
      const ticks = this.bufferedTicks;
      console.log(`[DO] Flushing ${ticks} buffered ticks to D1 for ${email}...`);
      
      this.bufferedTicks = 0;
      this.lastFlushTime = Date.now();
      await this.state.storage.delete('buffered_state');

      this.state.waitUntil(
        bulkIncrementUserStats(this.env.DB, [{ email, ticks }]).catch(err => {
          console.error('[DO] Failed to increment user solver ticks in D1:', err);
        })
      );
    }
  }

  async alarm() {
    console.log('[DO Alarm] Alarm triggered. Flushing ticks...');
    this.alarmScheduled = false;
    await this.flushTicks();
  }

  broadcast(data) {
    const message = JSON.stringify(data);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(message);
      } catch (err) {
        console.error("[DO WS] Failed to send broadcast message:", err);
      }
    }
  }

  async startSolveLoop() {
    if (this.isSolving) {
      this.stabilized = false;
      this.ticksRun = 0;
      return;
    }
    this.isSolving = true;
    this.stabilized = false;
    this.ticksRun = 0;
    
    // Broadcast WORK state to all clients
    this.broadcast({ type: "STATUS", status: "WORK" });

    // Reload the latest credits from the DB to stay in sync with refills and AI chat deductions
    if (this.userEmail) {
      try {
        const user = await this.env.DB.prepare('SELECT credits FROM users WHERE email = ?').bind(this.userEmail).first();
        if (user && user.credits !== undefined && user.credits !== null) {
          this.credits = parseFloat(user.credits);
        }
      } catch (err) {
        console.error('[DO LOOP] Failed to reload user credits:', err);
      }
    }
    
    try {
      while (!this.stabilized && this.ticksRun < 100 && this.isSolving) {
        // Solver is free, do not check or pause for credits
        const currentParams = {};
        for (const [rId, rxn] of Object.entries(this.simulation.reactions)) {
          if (rxn.vMax !== rxn.defaultVmax || rxn.km !== rxn.defaultKm) {
            currentParams[rId] = { vMax: rxn.vMax, km: rxn.km };
          }
        }
        const currentConcs = {
          o2_e: this.simulation.metabolites['o2_e'].concentration,
          glc__D_e: this.simulation.metabolites['glc__D_e'].concentration
        };
        
        // Solve FBA
        const result = solveFba(this.highs, staticLpHeader, currentConcs, currentParams, this.simulation);
        this.ticksRun++;

        if (!this.hasCheckedInitialLog) {
          this.state.waitUntil(this.ensureInitialLog(result));
        }

        if (this.pendingLogAction) {
          const log = this.pendingLogAction;
          this.pendingLogAction = null;

          const biomass = result.biomass_flux || 0.0;
          const glcFlux = result.fluxes ? (result.fluxes['EX_glc__D_e'] || 0.0) : 0.0;
          const o2Flux = result.fluxes ? (result.fluxes['EX_o2_e'] || 0.0) : 0.0;
          const glcUptake = Math.max(0.0, -glcFlux);
          const o2Uptake = Math.max(0.0, -o2Flux);
          const atpYield = Math.max(0.0, Math.abs(result.fluxes ? (result.fluxes['ATPS4rpp'] || result.fluxes['ATPS4r'] || 0.0) : 0.0));
          const isDead = result.is_dead ? 1 : 0;

          this.state.waitUntil(logExperimentAction(
            this.env.DB,
            this.sessionId,
            log.type,
            log.target,
            log.value,
            log.prevValue,
            biomass,
            glcUptake,
            o2Uptake,
            atpYield,
            isDead
          ));
        }
        
        // Save state to DO storage
        const stateToSave = serializeSimulation(this.simulation);
        await this.state.storage.put('sim_state', stateToSave);
        
        // Increment solver ticks
        if (this.simulation.solverTicksBuffer) {
          this.simulation.solverTicksBuffer = 0;
        }
        
        // Broadcast tick update
        this.broadcast({
          type: "TICK_UPDATE",
          status: "WORK",
          fluxes: result.fluxes,
          biomass_flux: result.biomass_flux,
          is_dead: result.is_dead,
          repressed: result.repressed,
          concentrations: result.concentrations,
          changingMetabolites: result.changingMetabolites,
          changingReactions: result.changingReactions,
          stabilized: result.stabilized,
          solverTicks: 0,
          dailySolverTicks: 0,
          credits: (this.credits !== undefined && this.credits !== null) ? this.credits : undefined
        });
        
        this.stabilized = result.stabilized;
        
        // Delay slightly between ticks to simulate steps smoothly
        await new Promise(resolve => setTimeout(resolve, 80));
      }

      // Save to D1 database for persistence if logged in (once at the end of the loop)
      if (this.userEmail) {
        const finalState = serializeSimulation(this.simulation);
        this.state.waitUntil(
          upsertSimulationSession(
            this.env.DB,
            this.sessionId,
            this.userEmail,
            this.baseName || "Experiment",
            this.name || "Experiment",
            JSON.stringify(finalState)
          ).catch(err => console.error("[DO] Failed to upsert session in D1 after loop:", err))
        );
      }
    } catch (err) {
      console.error("[DO] Solve loop error:", err);
    } finally {
      this.isSolving = false;
      this.broadcast({ type: "STATUS", status: "RELAX" });
    }
  }

  triggerAiRename() {
    if (!this.env.GOOGLE_API_KEY || !this.userEmail) return;
    
    if (this.activeRenamePromise) {
      this.isRenamePending = true;
      return;
    }
    
    this.state.waitUntil((async () => {
      await this.performAiRename();
    })());
  }

  async performAiRename() {
    this.isRenamePending = false;
    
    this.activeRenamePromise = (async () => {
      try {
        if (this.isCustomName) {
          console.log(`[DO] Skipping AI rename because session ${this.sessionId} has a custom name.`);
          return;
        }
        const modifiedList = [];
        for (const [rId, rxn] of Object.entries(this.simulation.reactions)) {
          if (rxn.vMax !== rxn.defaultVmax || rxn.km !== rxn.defaultKm) {
            modifiedList.push(`Reaction ${rxn.name || rId}: vMax=${rxn.vMax}, km=${rxn.km}`);
          }
        }
        const o2 = this.simulation.metabolites['o2_e'].concentration;
        const glc = this.simulation.metabolites['glc__D_e'].concentration;
        if (o2 !== 18.5) modifiedList.push(`Oxygen Concentration o2_e: ${o2}`);
        if (glc !== 10.0) modifiedList.push(`Glucose Concentration glc__D_e: ${glc}`);
        
        if (modifiedList.length === 0) {
          const baseName = "Experiment";
          if (this.baseName === baseName) return;
          
          const dateStr = new Date().toISOString().split('T')[0];
          const count = await getExperimentCount(this.env.DB, this.userEmail, baseName, dateStr);
          const fullName = `${baseName} (${dateStr} #${count + 1})`;
          
          this.baseName = baseName;
          this.name = fullName;
          
          await upsertSimulationSession(
            this.env.DB,
            this.sessionId,
            this.userEmail,
            this.baseName,
            this.name,
            JSON.stringify(serializeSimulation(this.simulation))
          );
          
          this.broadcast({
            type: "RENAME_SESSION",
            base_name: this.baseName,
            name: this.name
          });
          return;
        }
        
        const prompt = `Based on these modifications in E. coli metabolic atlas simulation parameters, generate a short, creative, and precise scientific experiment title in English (maximum 4 words, no punctuation, e.g. 'Anaerobic Glucose Fermentation', 'Lactate Production Shift', 'Succinate Optimization').
Parameters modified:
${modifiedList.join('\n')}

Return ONLY the raw title string, with no other text, comments, markdown, or quotation marks.`;

        const apiKey = this.env.GOOGLE_API_KEY;
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [{ text: prompt }]
            }]
          })
        });
        
        if (!response.ok) {
          throw new Error(`Gemini API rename fetch failed: ${response.status}`);
        }
        
        const data = await response.json();
        let baseName = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Experiment";
        baseName = baseName.replace(/["'`.#]/g, '').trim();
        
        if (baseName.length > 50) {
          baseName = baseName.substring(0, 50);
        }
        if (!baseName) baseName = "Experiment";
        
        if (this.baseName === baseName) return;
        
        const dateStr = new Date().toISOString().split('T')[0];
        const count = await getExperimentCount(this.env.DB, this.userEmail, baseName, dateStr);
        const fullName = `${baseName} (${dateStr} #${count + 1})`;
        
        this.baseName = baseName;
        this.name = fullName;
        
        await upsertSimulationSession(
          this.env.DB,
          this.sessionId,
          this.userEmail,
          this.baseName,
          this.name,
          JSON.stringify(serializeSimulation(this.simulation))
        );
        
        this.broadcast({
          type: "RENAME_SESSION",
          base_name: this.baseName,
          name: this.name
        });
      } catch (err) {
        console.error("[DO] Error in performAiRename:", err);
      } finally {
        this.activeRenamePromise = null;
        if (this.isRenamePending) {
          this.state.waitUntil(this.performAiRename());
        }
      }
    })();
    
    await this.activeRenamePromise;
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'INIT') {
        const { userEmail, credits } = data;
        console.log(`[DO INIT] Received userEmail=${userEmail}, credits=${credits}`);
        this.userEmail = userEmail || (this.guestId ? 'guest:' + this.guestId : 'guest');
        if (credits !== undefined && credits !== null) {
          this.credits = parseFloat(credits);
        }
        
        if (this.userEmail && !this.userEmail.startsWith('guest')) {
          try {
            const user = await this.env.DB.prepare('SELECT credits FROM users WHERE email = ?').bind(this.userEmail).first();
            if (user && user.credits !== undefined && user.credits !== null) {
              this.credits = parseFloat(user.credits);
            } else {
              this.credits = 0.0;
            }
          } catch (err) {
            console.error('[DO INIT] Failed to load user credits:', err);
            if (this.credits === undefined) {
              this.credits = 0.0;
            }
          }
        } else {
          this.credits = 0.0;
        }

        const dbSession = await getSimulationSession(this.env.DB, this.sessionId);
        if (dbSession) {
          this.baseName = dbSession.base_name;
          this.name = dbSession.name;
          this.isCustomName = !!dbSession.is_custom_name;
          await this.state.storage.put('is_custom_name', this.isCustomName);
          if (dbSession.state) {
            try {
              const stateObj = JSON.parse(dbSession.state);
              deserializeSimulation(this.simulation, stateObj);
              const hasFluxes = Object.values(this.simulation.reactions).some(r => r.flux !== 0);
              if (hasFluxes || (stateObj.tickCounter && stateObj.tickCounter > 0)) {
                this.isFreshSession = false;
              }
            } catch (e) {
              console.error("[DO] Failed to parse saved session state:", e);
            }
          }
        } else {
          this.baseName = "Experiment";
          this.name = this.name || "Experiment";
          this.isCustomName = false;
          await this.state.storage.put('is_custom_name', false);
        }
        
        let hasLogs = false;
        if (this.userEmail) {
          try {
            const logsCheck = await this.env.DB.prepare(
              'SELECT 1 FROM experiment_logs WHERE session_id = ? AND action_type != "initial" LIMIT 1'
            ).bind(this.sessionId).first();
            hasLogs = !!logsCheck;
          } catch (err) {
            console.error('[DO INIT] Failed to check if logs exist:', err);
          }
        }
        
        ws.send(JSON.stringify({
          type: "INIT_STATE",
          state: serializeSimulation(this.simulation),
          base_name: this.baseName,
          name: this.name,
          solverTicks: 0,
          dailySolverTicks: 0,
          isSolving: !!this.isSolving,
          credits: (this.credits !== undefined && this.credits !== null) ? this.credits : 250.0,
          hasLogs: hasLogs
        }));
        
        if (this.isFreshSession) {
          this.isFreshSession = false;
          this.state.waitUntil(this.startSolveLoop());
        }
        return;
      }
      
      // Credits constraints removed
      
      if (data.type === 'UPDATE_PARAMETER') {
        const { id, param, value, concentrations, parameters, logAction } = data;
        
        // Log changes on the server BEFORE applying them
        this.state.waitUntil(logReactionChanges(this.env.DB, this.simulation, parameters, id, param, value).catch(err => {
          console.error('[DO] Failed to log reaction parameter changes:', err);
        }));

        if (logAction) {
          this.pendingLogAction = logAction;
        }
        if (concentrations) {
          for (const [mId, val] of Object.entries(concentrations)) {
            if (this.simulation.metabolites[mId]) {
              this.simulation.metabolites[mId].concentration = val;
              this.simulation.metabolites[mId].targetConcentration = val;
            }
          }
        }
        if (parameters) {
          for (const rxn of Object.values(this.simulation.reactions)) {
            rxn.vMax = rxn.defaultVmax;
            rxn.km = rxn.defaultKm;
          }
          for (const [rxnId, paramObj] of Object.entries(parameters)) {
            if (this.simulation.reactions[rxnId]) {
              if (paramObj.vMax !== undefined) this.simulation.reactions[rxnId].vMax = paramObj.vMax;
              if (paramObj.km !== undefined) this.simulation.reactions[rxnId].km = paramObj.km;
            }
          }
        }
        if (id) {
          if (id === 'o2_e' || id === 'glc__D_e') {
            if (this.simulation.metabolites[id]) {
              this.simulation.metabolites[id].concentration = value;
              this.simulation.metabolites[id].targetConcentration = value;
            }
          } else {
            if (this.simulation.reactions[id]) {
              if (param === 'vMax') this.simulation.reactions[id].vMax = value;
              if (param === 'km') this.simulation.reactions[id].km = value;
            }
          }
        }
        
        this.state.waitUntil(this.startSolveLoop());
        if (logAction) {
          this.triggerAiRename();
        }
        return;
      }
      
      if (data.type === 'RESET_SIMULATION') {
        this.simulation.reset();
        this.pendingLogAction = data.logAction || null;
        this.hasCheckedInitialLog = false;
        this.state.waitUntil(this.startSolveLoop());
        return;
      }
      
      if (data.type === 'APPLY_SCENARIO') {
        const { scenarioId, logAction } = data;
        if (logAction) {
          this.pendingLogAction = logAction;
        }
        this.simulation.applyScenario(scenarioId);
        this.state.waitUntil(this.startSolveLoop());
        this.triggerAiRename();
        return;
      }
      
      if (data.type === 'RENAME_PROJECT') {
        const { name } = data;
        this.baseName = name;
        this.name = name;
        this.isCustomName = true;
        await this.state.storage.put('is_custom_name', true);
        if (this.userEmail) {
          await renameSimulationSession(this.env.DB, this.sessionId, name);
        }
        this.broadcast({
          type: "RENAME_SESSION",
          base_name: this.baseName,
          name: this.name
        });
        return;
      }
      
    } catch (err) {
      console.error("[DO] Error parsing WebSocket message:", err);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    console.log(`[DO WS] Connection closed: ${code} - ${reason}`);
  }

  async webSocketError(ws, error) {
    console.error("[DO WS] Connection error:", error);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const qSessionId = url.searchParams.get('sessionId') || request.headers.get('x-session-id');
    if (qSessionId) {
      this.sessionId = qSessionId;
    }
    const qGuestId = url.searchParams.get('guestId') || request.headers.get('x-guest-id');
    if (qGuestId) {
      this.guestId = qGuestId;
    }

    if (url.pathname === '/api/session-websocket') {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 400 });
      }
      
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/delete-check') {
      const activeSockets = this.state.getWebSockets();
      const isDeletingActive = request.headers.get('x-is-active-session') === 'true';
      const otherTabsCount = activeSockets.length - (isDeletingActive ? 1 : 0);

      if (otherTabsCount > 0) {
        return new Response(JSON.stringify({ error: 'conflict_open_elsewhere' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }


    if (url.pathname === '/rename') {
      const { name } = await request.json();
      this.baseName = name;
      this.name = name;
      this.isCustomName = true;
      await this.state.storage.put('is_custom_name', true);

      this.broadcast({
        type: "RENAME_SESSION",
        base_name: this.baseName,
        name: this.name
      });
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/clear') {
      this.pendingLogAction = null;
      this.hasCheckedInitialLog = false;

      const baseName = "Experiment";
      const dateStr = new Date().toISOString().split('T')[0];
      let count = 0;
      if (this.userEmail) {
        count = await getExperimentCount(this.env.DB, this.userEmail, baseName, dateStr);
      }
      const fullName = `${baseName} (${dateStr} #${count + 1})`;

      this.baseName = baseName;
      this.name = fullName;
      this.isCustomName = false;
      await this.state.storage.put('is_custom_name', false);

      if (this.userEmail) {
        this.state.waitUntil(
          upsertSimulationSession(
            this.env.DB,
            this.sessionId,
            this.userEmail,
            this.baseName,
            this.name,
            JSON.stringify(serializeSimulation(this.simulation)),
            false
          ).catch(err => console.error('[DO] Failed to update session in D1 on clear:', err))
        );
      }

      this.broadcast({
        type: "RENAME_SESSION",
        base_name: this.baseName,
        name: this.name
      });

      this.broadcast({
        type: "CLEAR_LOGS_SUCCESS"
      });

      return new Response(JSON.stringify({ success: true, name: fullName }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/update-credits') {
      const { credits } = await request.json();
      this.credits = parseFloat(credits);

      // Broadcast update to all connected clients
      this.broadcast({
        type: "TICK_UPDATE",
        status: this.isSolving ? "WORK" : "RELAX",
        stabilized: !this.isSolving,
        solverTicks: 0,
        dailySolverTicks: 0,
        credits: this.credits
      });

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/chat') {
      const body = await request.json();
      // NOTE: client-supplied `history` is intentionally ignored; history is loaded from D1 below.
      const { message, context } = body;
      const isReportRequest = typeof message === 'string' && message.startsWith(REPORT_PROMPT_PREFIX);
      const maxMessageChars = isReportRequest ? CHAT_LIMITS.reportMessageChars : CHAT_LIMITS.messageChars;
      if (typeof message !== 'string' || !message.trim()) {
        return new Response(JSON.stringify({ error: 'empty_message' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (message.length > maxMessageChars) {
        return new Response(JSON.stringify({ error: 'message_too_long', limit: maxMessageChars }), {
          status: 413,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (context && JSON.stringify(context).length > CHAT_LIMITS.contextChars) {
        return new Response(JSON.stringify({ error: 'context_too_large' }), {
          status: 413,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const apiKey = this.env.GOOGLE_API_KEY;
      if (!apiKey) {
        return new Response(JSON.stringify({ error: 'GOOGLE_API_KEY is not configured.' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (!this.userEmail) {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(this.env.DB, token) : null;
        if (user) {
          this.userEmail = user.email;
          if (this.credits === undefined || this.credits === null) {
            this.credits = parseFloat(user.credits);
          }
        } else {
          this.userEmail = 'guest';
        }
      }

      const guestId = request.headers.get('x-guest-id');
      const ip = request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip') || 'unknown';
      let identifier;
      if (this.userEmail && !this.userEmail.startsWith('guest')) {
        identifier = this.sessionId 
          ? `user:${this.userEmail}:${this.sessionId}` 
          : `user:${this.userEmail}`;
      } else {
        identifier = this.sessionId
          ? `guest:${guestId || ip || 'unknown'}:${this.sessionId}`
          : `guest:${guestId || ip || 'unknown'}`;
      }
      
      // Load recent history from D1 BEFORE saving the current message
      const history = await getRecentChatHistory(this.env.DB, identifier, CHAT_LIMITS.historyMessages);

      this.state.waitUntil(saveChatMessage(this.env.DB, identifier, 'user', message, context));

      const systemPrompt = `You are a helpful and expert AI Metabolic Assistant for a student using the ecoli.bio portal (E. coli Central Metabolism Lab).
Your goal is to guide the student, explain how pathways work, answer their questions about E. coli metabolism, and help them with the interactive learning scenarios.

IMPORTANT: Respond in the same language as the user's query (usually Russian or English). Keep your answer concise, scientifically accurate, and encouraging.

CRITICAL WARNING: The user interacts with a live simulation, meaning that fluxes, growth rates, and concentrations change in real time with every user action. Always look up all values, rates, and statuses from the CURRENT simulation state context below. DO NOT reuse numbers, fluxes (e.g. CYTBO3_4pp, growth rate, etc.) or parameter values from previous messages in the chat history, as they are now stale and incorrect.

NOTE: The active model and map shown on the student's screen are based on the genome-scale E. coli iJO1366 reconstruction (specifically its central carbon metabolism map). 
To ensure that reactions and metabolites mentioned in the chat are clickable and highlightable on the map, you MUST refer to them using the EXACT BiGG IDs present on our central metabolism map iJO1366.
- The primary growth rate / biomass reaction on the map is represented as BIOMASS_Ecoli_core_w_GAM.
- The ATP production/synthase reaction on the map is represented as ATPS4rpp (NOT ATPS4r).
- Respiration / Cytochrome oxidases are CYTBO3_4pp and CYTBDpp.
- Active metabolites must include their exact compartment suffixes: extracellular carbon sources/fermentation products must end with _e (e.g., use glc__D_e for glucose, ac_e for extracellular acetate, lac__D_e for extracellular D-lactate, etoh_e for extracellular ethanol). Cytoplasmic metabolites must end with _c (e.g. g6p_c, pyr_c, accoa_c).
You should output these exact IDs (e.g. ATPS4rpp, ac_e, lac__D_e, GLCptspp, pyr_c) in your text. The client-side link detector will automatically find them and highlight them. Do NOT wrap these IDs in backticks (\`), quotes, or any other formatting; just write them as plain text (e.g. write ATPS4rpp, ac_e, lac__D_e). Do NOT use simplified names like "ace", "lacDe", "ATPS4r", or "glucose", as they will not be recognized by the map.

PORTAL FEATURES:
- Experiment Management: Both registered users and unregistered guests can create, rename, delete, and switch between multiple saved simulation sessions (experiments) via the header dropdown on desktop or the side drawer on mobile. The custom metabolite concentrations and modified reaction parameters for each experiment are stored dynamically in the cloud (using Durable Objects and D1 database). Guests use a unique session identifier stored in Local Storage to persist their experiments.
- Experiment Report: The "Report" button is located in the center of the bottom dock panel (floating dock on desktop, full-width on mobile), between the Scenarios tab and the AI Chat button. It opens the Experiment Report modal showing a timeline of user actions and biological impacts.
- Chat Context: The chat header features an "👁️ Context" button to view raw JSON simulation context sent to the AI. This button is hidden in production (ecoli.bio / www.ecoli.bio) and only visible in development and staging environments.
- Guest Mode: Unregistered guests have full interactive access to all capabilities of the platform. They can adjust sliders, run simulations, spikes, and depletions, use Scenarios, manage multiple experiments, view logs and reports, and chat with the AI assistant. Their state and histories are preserved across browser restarts via local identifiers.
- Free Public Preview: The simulation itself is free. The AI assistant has a small daily message allowance for guests (${CHAT_LIMITS.guestPerDay} messages per day); signing in with Google gives a larger allowance. If users ask about limits, explain this briefly and politely.

Here is the current state of the metabolic simulation on the student's screen:
${JSON.stringify(context, null, 2)}

Instructions:
1. Explain metabolism in simple, clear terms (undergraduate biology level).
2. Use the exact iJO1366 map BiGG IDs (e.g., ATPS4rpp, GLCptspp, ac_e, lac__D_e, PFK, PGI, PDH, PFL, pyr_c) as plain text (without backticks or quotes) in your text when discussing specific reactions or metabolites. Always mention their common names alongside the IDs.
3. If a scenario is active, guide the student through it. If they submit an answer or ask a question about it, evaluate it and explain the biology (e.g. why PDH is more ATP-efficient than PFL, or why Vmax causes metabolic bottlenecks).
4. Do not make up facts. E. coli central metabolism is standard (glycolysis, pentose phosphate pathway, TCA cycle, respiration, fermentation).
5. If the user asks to explain or analyze an experiment report or timeline: Respond in a strictly neutral, academic, and scientific tone. Do NOT address the user directly (avoid pronouns like 'you', 'your', 'we', 'I' or their equivalents in other languages). The analysis must be written as a standalone scientific description/article section that can be copied and pasted directly into a research paper or report without any edits.
`;

      const contents = [];
      for (const msg of history) {
        const text = String(msg.message || '').slice(0, CHAT_LIMITS.historyItemChars);
        if (!text) continue;
        contents.push({
          role: msg.role === 'model' ? 'model' : 'user',
          parts: [{ text }]
        });
      }
      contents.push({
        role: 'user',
        parts: [{ text: message }]
      });

      // Request Gemini API
      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: {
            parts: [{ text: systemPrompt }]
          },
          generationConfig: {
            maxOutputTokens: isReportRequest ? CHAT_LIMITS.reportOutputTokens : CHAT_LIMITS.outputTokens
          }
        })
      });

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        throw new Error(`Gemini API returned ${geminiRes.status}: ${errText}`);
      }

      const data = await geminiRes.json();
      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sorry, failed to get a response from the AI.';
      
      this.state.waitUntil(saveChatMessage(this.env.DB, identifier, 'model', reply));

      const usageMetadata = data.usageMetadata;
      let creditsCost = 0.0;
      if (usageMetadata) {
        const promptTokens = usageMetadata.promptTokenCount || 0;
        const candidatesTokens = usageMetadata.candidatesTokenCount || 0;
        const cachedTokens = usageMetadata.cachedContentTokenCount || 0;
        
        const regularTokens = (promptTokens - cachedTokens) + candidatesTokens;
        creditsCost = (regularTokens * (1 / 11000)) + (cachedTokens * (1 / 44000));
      }

      if (this.userEmail && !this.userEmail.startsWith('guest')) {
        await deductUserCredits(this.env.DB, this.userEmail, creditsCost);
        const updatedUser = await this.env.DB.prepare('SELECT credits FROM users WHERE email = ?').bind(this.userEmail).first();
        const updatedCredits = updatedUser ? parseFloat(updatedUser.credits) : 0.0;
        this.credits = updatedCredits;
      } else {
        this.credits = 0.0;
      }

      // Broadcast update to all clients
      this.broadcast({
        type: "TICK_UPDATE",
        status: this.isSolving ? "WORK" : "RELAX",
        stabilized: !this.isSolving,
        solverTicks: 0,
        dailySolverTicks: 0,
        credits: this.credits
      });

      this.state.waitUntil(trackWorkerChatQuery(this.env, request, this.userEmail, message, reply, usageMetadata));

      return new Response(JSON.stringify({ 
        reply, 
        count: 0,
        credits: this.credits
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/state') {
      const state = serializeSimulation(this.simulation);
      return new Response(JSON.stringify(state), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname !== '/solve') {
      return new Response('Not found', { status: 404 });
    }

    // Keep HTTP fallback for non-websocket clients
    const now = Date.now();
    if (this.lastSolveTime && (now - this.lastSolveTime < 150)) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please wait.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    this.lastSolveTime = now;

    if (!this.highs || !this.simulation) {
      return new Response(JSON.stringify({ error: 'Solver is still initializing' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      const data = await request.json();
      const concentrations = data.concentrations || {};
      const parameters = data.parameters || {};
      const options = {
        reset: data.reset,
        scenario: data.scenario
      };

      // Log changes on the server BEFORE applying them
      this.state.waitUntil(logReactionChanges(this.env.DB, this.simulation, parameters).catch(err => {
        console.error('[DO] Failed to log HTTP solve reaction parameter changes:', err);
      }));

      if (data.reset) {
        this.pendingLogAction = data.logAction || null;
        this.hasCheckedInitialLog = false;
      }

      const result = solveFba(this.highs, staticLpHeader, concentrations, parameters, this.simulation, options);
      
      if (!this.hasCheckedInitialLog) {
        this.state.waitUntil(this.ensureInitialLog(result));
      }

      const stateToSave = serializeSimulation(this.simulation);
      this.state.storage.put('sim_state', stateToSave);

      if (data.dbTicks !== undefined) {
        this.totalSolverTicks = Math.max(this.totalSolverTicks, data.dbTicks);
      }
      if (data.dailyTicks !== undefined) {
        this.dailySolverTicks = Math.max(this.dailySolverTicks, data.dailyTicks);
      }
      if (data.userEmail) {
        this.userEmail = data.userEmail;
        if (data.credits !== undefined && data.credits !== null) {
          this.credits = parseFloat(data.credits);
        }
      }

      if (this.simulation.solverTicksBuffer) {
        this.simulation.solverTicksBuffer = 0;
      }

      result.solverTicks = 0;
      result.dailySolverTicks = 0;
      result.credits = (this.credits !== undefined && this.credits !== null) ? this.credits : undefined;

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (err) {
      console.error('[DO] Error in solve FBA DO handler:', err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
}

// Helper to parse User Agent into OS and Browser info
function parseUserAgent(ua = '') {
  let os = 'Unknown OS';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  else if (ua.includes('Macintosh')) os = 'macOS';
  else if (ua.includes('Linux')) os = 'Linux';

  let browser = 'Unknown Browser';
  if (ua.includes('Chrome')) browser = 'Chrome';
  else if (ua.includes('Safari')) browser = 'Safari';
  else if (ua.includes('Firefox')) browser = 'Firefox';
  else if (ua.includes('Edge')) browser = 'Edge';

  return `${os} (${browser})`;
}

// Helper to send message using Telegram Bot API
async function sendTelegramNotification(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  const mode = env.MODE || 'production';
  const textWithMode = `⚙️ <b>Mode:</b> <code>${mode}</code>\n\n` + text;

  if (!token || !chatId) {
    console.log(`[Telegram Notification (Console-only)]: ${textWithMode.replace(/<[^>]*>/g, '')}`);
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: textWithMode,
        parse_mode: 'HTML'
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Telegram] API error: ${res.status} - ${errText}`);
    } else {
      console.log(`[Telegram Bot] Message sent successfully.`);
    }
  } catch (err) {
    console.error('[Telegram] Failed to send message:', err);
  }
}

// Helper to send message using Telegram Support Bot API
async function sendTelegramSupportNotification(env, text) {
  const token = env.TELEGRAM_SUPPORT_BOT_TOKEN;
  const chatId = env.TELEGRAM_SUPPORT_CHAT_ID;
  const mode = env.MODE || 'production';
  const textWithMode = `⚙️ <b>mode:</b> <code>${mode}</code>\n\n` + text;

  if (!token || !chatId) {
    console.log(`[Telegram Support Notification (Console-only)]: ${textWithMode.replace(/<[^>]*>/g, '')}`);
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: textWithMode,
        parse_mode: 'HTML'
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Telegram Support] API error: ${res.status} - ${errText}`);
    } else {
      console.log(`[Telegram Support Bot] Message sent successfully.`);
    }
  } catch (err) {
    console.error('[Telegram Support] Failed to send message:', err);
  }
}

// Track new user signup in Telegram
async function trackUserSignup(env, request, email, name) {
  try {
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'Unknown IP';
    const ua = request.headers.get('user-agent') || '';
    const device = parseUserAgent(ua);

    const text = `🆕 <b>New user registered!</b>\n\n` +
                 `<b>Name:</b> <code>${name}</code>\n` +
                 `<b>Email:</b> <code>${email}</code>\n` +
                 `<b>IP:</b> <code>${ip}</code>\n` +
                 `<b>Device:</b> <code>${device}</code>`;
    await sendTelegramNotification(env, text);
  } catch (err) {
    console.error('[Telegram Tracker] Error tracking user signup:', err);
  }
}

// Check if text contains Russian characters
function isRussianText(text) {
  return /[а-яА-ЯёЁ]/.test(text || '');
}

// Translate query and response to Russian using Gemini API
async function translateToRussian(apiKey, query, response) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{
            text: `Translate the following user query and AI response to Russian. Keep the biological/scientific terminology accurate.\n\nUser Query:\n${query}\n\nAI Response:\n${response}`
          }]
        }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              translatedQuery: { type: "STRING" },
              translatedResponse: { type: "STRING" }
            },
            required: ["translatedQuery", "translatedResponse"]
          }
        }
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Translation] API returned ${res.status}: ${errText}`);
      return null;
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      return JSON.parse(text);
    }
  } catch (err) {
    console.error('[Translation] Error translating text:', err);
  }
  return null;
}

// Track chat queries in Telegram
async function trackWorkerChatQuery(env, request, email, message, reply, usageMetadata = null) {
  try {
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'Unknown IP';
    const ua = request.headers.get('user-agent') || '';
    const device = parseUserAgent(ua);

    const maxPartLength = 800;
    const maxReplyLength = 1200;

    const truncatedMessage = (message || '').length > maxPartLength 
      ? message.substring(0, maxPartLength) + '... [truncated]' 
      : message;

    const safeMessage = (truncatedMessage || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    let tokensInfo = '';
    if (usageMetadata) {
      const promptTokens = usageMetadata.promptTokenCount || 0;
      const candidatesTokens = usageMetadata.candidatesTokenCount || 0;
      const totalTokens = usageMetadata.totalTokenCount || 0;
      tokensInfo = `\n\n<b>Tokens:</b>\n` +
                   `• Prompt: <b>${promptTokens}</b>\n` +
                   `• Response: <b>${candidatesTokens}</b>\n` +
                   `• Total: <b>${totalTokens}</b>`;
    }

    const isReport = message.includes("Please write a scientific, neutral analysis of the biological meaning and impact of this metabolic experiment");

    let text = `💬 <b>AI Chat Request!</b>\n\n` +
               `<b>User:</b> <code>${email}</code>\n` +
               `<b>IP:</b> <code>${ip}</code>\n` +
               `<b>Device:</b> <code>${device}</code>\n\n` +
               `<b>Prompt:</b>\n<blockquote>${safeMessage}</blockquote>`;

    if (!isReport) {
      const truncatedReply = (reply || '').length > maxReplyLength 
        ? reply.substring(0, maxReplyLength) + '... [truncated]' 
        : reply;

      const safeReply = (truncatedReply || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      
      text += `\n\n<b>AI Response:</b>\n<blockquote>${safeReply}</blockquote>`;

      if (!isRussianText(message) && env.GOOGLE_API_KEY) {
        const translation = await translateToRussian(env.GOOGLE_API_KEY, message, reply);
        if (translation) {
          const truncatedTransQuery = (translation.translatedQuery || '').length > maxPartLength 
            ? translation.translatedQuery.substring(0, maxPartLength) + '... [truncated]' 
            : translation.translatedQuery;
          const truncatedTransResponse = (translation.translatedResponse || '').length > maxReplyLength 
            ? translation.translatedResponse.substring(0, maxReplyLength) + '... [truncated]' 
            : translation.translatedResponse;

          const safeTranslatedQuery = (truncatedTransQuery || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
          const safeTranslatedResponse = (truncatedTransResponse || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

          text += `\n\n<b>[RU] Translated Prompt:</b>\n<blockquote>${safeTranslatedQuery}</blockquote>\n\n` +
                  `<b>[RU] Translated Response:</b>\n<blockquote>${safeTranslatedResponse}</blockquote>`;
        }
      }
    }

    text += tokensInfo;

    await sendTelegramNotification(env, text);
  } catch (err) {
    console.error('[Telegram Tracker] Error tracking chat query:', err);
  }
}

// ==========================================
// 2. Default Worker Fetch Handler
// ==========================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 1. Force HTTPS (except for local dev environment or localhost/127.0.0.1)
    const proto = request.headers.get('x-forwarded-proto') || url.protocol.slice(0, -1);
    const clientIp = request.headers.get('cf-connecting-ip') || '';
    if (proto === 'http' && 
        !url.hostname.includes('localhost') && 
        !url.hostname.includes('127.0.0.1') && 
        clientIp !== '127.0.0.1' && 
        clientIp !== '::1') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

    // 2. Redirect www.ecoli.bio to ecoli.bio to ensure unified Google Sign-In origin and SEO consistency
    if (url.hostname === 'www.ecoli.bio') {
      url.hostname = 'ecoli.bio';
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

    // Serve static assets if not an API route
    if (!url.pathname.startsWith('/api/')) {
      const isStagingDomain = url.hostname !== 'ecoli.bio' && url.hostname !== 'www.ecoli.bio';

      // Intercept robots.txt on staging domains to prevent search crawlers
      if (url.pathname === '/robots.txt' && isStagingDomain) {
        return new Response('User-agent: *\nDisallow: /\n', {
          headers: {
            'Content-Type': 'text/plain; charset=UTF-8',
            'X-Robots-Tag': 'noindex, nofollow'
          }
        });
      }

      const response = await env.ASSETS.fetch(request);
      if (response.status === 200) {
        const newResponse = new Response(response.body, response);
        if (isStagingDomain) {
          newResponse.headers.set('X-Robots-Tag', 'noindex, nofollow');
        }
        if (url.pathname.startsWith('/assets/')) {
          // Vite hashed assets are immutable and can be cached forever
          newResponse.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (
          url.pathname.endsWith('.json') ||
          url.pathname.endsWith('.txt') ||
          url.pathname.endsWith('.svg') ||
          url.pathname.endsWith('.png') ||
          url.pathname.endsWith('.ico')
        ) {
          // Large static assets like metabolic maps, solver states, text and images
          newResponse.headers.set('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
        } else {
          // HTML pages: must revalidate to check for application updates
          newResponse.headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
        }
        return newResponse;
      }
      if (isStagingDomain && response) {
        const newResponse = new Response(response.body, response);
        newResponse.headers.set('X-Robots-Tag', 'noindex, nofollow');
        return newResponse;
      }
      return response;
    }

    // CORS Headers for API
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-guest-id, x-session-id, x-timezone',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 0. WebSocket Upgrade Route
      if (url.pathname === '/api/session-websocket') {
        const sessionId = url.searchParams.get('sessionId') || 'default_user';
        const doId = env.SOLVER_DO.idFromName(sessionId);
        const doStub = env.SOLVER_DO.get(doId);
        return doStub.fetch(request);
      }

      // Admin credits refill endpoint
      if (url.pathname === '/api/admin/add-credits' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const secret = env.ADMIN_SECRET || 'admin_secret_dev';
        if (!token || token !== secret) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const { email, amount } = await request.json();
        if (!email || isNaN(amount)) {
          return new Response(JSON.stringify({ error: 'Invalid email or amount' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const userEmail = email.trim().toLowerCase();

        // Update DB
        await env.DB.prepare('UPDATE users SET credits = MAX(0.0, COALESCE(credits, 250.0) + ?) WHERE email = ?').bind(amount, userEmail).run();
        const user = await env.DB.prepare('SELECT name, credits FROM users WHERE email = ?').bind(userEmail).first();
        if (!user) {
          return new Response(JSON.stringify({ error: 'User not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const newCredits = parseFloat(user.credits);

        // Get all active sessions for this user from D1 database
        let sessionIds = [];
        try {
          const sessions = await env.DB.prepare('SELECT id FROM simulation_sessions WHERE email = ?').bind(userEmail).all();
          if (sessions.results) {
            sessionIds = sessions.results.map(s => s.id);
          }
        } catch (err) {
          console.error('[Admin Add Credits] Failed to fetch user sessions:', err);
        }

        // Notify DO for each session
        for (const sessionId of sessionIds) {
          const doId = env.SOLVER_DO.idFromName(sessionId);
          const doStub = env.SOLVER_DO.get(doId);
          ctx.waitUntil(doStub.fetch(new Request(new URL('/update-credits', url.origin), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credits: newCredits })
          })).catch(err => console.error(`Failed to notify DO for session ${sessionId}:`, err)));
        }

        return new Response(JSON.stringify({
          success: true,
          email: userEmail,
          name: user.name,
          credits: newCredits
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 1. solve-fba endpoint
      if (url.pathname === '/api/solve-fba' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(env.DB, token) : null;
        const guestId = request.headers.get('x-guest-id');

        const sessionId = request.headers.get('x-session-id') || 'default_user';
        const body = await request.json();

        // Forward request to Durable Object
        const doId = env.SOLVER_DO.idFromName(sessionId);
        const doStub = env.SOLVER_DO.get(doId);

        // Fetch solve result from DO
        const solveRequest = new Request(new URL('/solve', url.origin), {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-session-id': sessionId,
            'x-guest-id': guestId || ''
          },
          body: JSON.stringify({
            concentrations: body.concentrations,
            parameters: body.parameters,
            reset: body.reset,
            scenario: body.scenario,
            userEmail: user ? user.email : (guestId ? 'guest:' + guestId : 'guest'),
            dbTicks: 0,
            dailyTicks: 0,
            credits: user ? user.credits : null
          })
        });

        const doRes = await doStub.fetch(solveRequest);
        if (!doRes.ok) {
          return new Response(doRes.body, { status: doRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const result = await doRes.json();
        
        result.solverTicks = 0;
        result.dailySolverTicks = 0;
        result.credits = result.credits !== undefined ? result.credits : (user ? user.credits : null);
        result.lastTimestamp = Date.now();

        if (body.logAction) {
          const biomass = result.biomass_flux || 0.0;
          const glcFlux = result.fluxes ? (result.fluxes['EX_glc__D_e'] || 0.0) : 0.0;
          const o2Flux = result.fluxes ? (result.fluxes['EX_o2_e'] || 0.0) : 0.0;
          const glcUptake = Math.max(0.0, -glcFlux);
          const o2Uptake = Math.max(0.0, -o2Flux);
          const atpYield = Math.max(0.0, Math.abs(result.fluxes ? (result.fluxes['ATPS4rpp'] || result.fluxes['ATPS4r'] || 0.0) : 0.0));
          const isDead = result.is_dead ? 1 : 0;

          ctx.waitUntil(logExperimentAction(
            env.DB,
            sessionId,
            body.logAction.type,
            body.logAction.target,
            body.logAction.value,
            body.logAction.prevValue,
            biomass,
            glcUptake,
            o2Uptake,
            atpYield,
            isDead
          ));
        }

        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 1b. Get list of sessions (experiments) for active user
      if (url.pathname === '/api/experiments' && request.method === 'GET') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(env.DB, token) : null;
        let email;

        if (user) {
          email = user.email;
        } else {
          const guestId = request.headers.get('x-guest-id');
          if (!guestId) {
            return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          email = 'guest:' + guestId;
          await env.DB.prepare('INSERT OR IGNORE INTO users (email, name, credits) VALUES (?, ?, 0.0)')
            .bind(email, 'Guest User')
            .run();
        }

        const list = await getSimulationSessions(env.DB, email);
        return new Response(JSON.stringify(list), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 1c. Create new experiment
      if (url.pathname === '/api/experiments/new' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(env.DB, token) : null;
        let email;

        if (user) {
          email = user.email;
        } else {
          const guestId = request.headers.get('x-guest-id');
          if (!guestId) {
            return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          email = 'guest:' + guestId;
          await env.DB.prepare('INSERT OR IGNORE INTO users (email, name, credits) VALUES (?, ?, 0.0)')
            .bind(email, 'Guest User')
            .run();
        }

        const sessionId = 'session_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        
        // Calculate initial formatted name
        const baseName = "Experiment";
        const dateStr = new Date().toISOString().split('T')[0];
        const count = await getExperimentCount(env.DB, email, baseName, dateStr);
        const fullName = `${baseName} (${dateStr} #${count + 1})`;
        
        const defaultState = JSON.stringify({
          metabolites: {},
          parameters: {},
          isDead: false,
          tickCounter: 0,
          lastTimestamp: 0
        });

        await upsertSimulationSession(env.DB, sessionId, email, baseName, fullName, defaultState);

        return new Response(JSON.stringify({ id: sessionId, base_name: baseName, name: fullName }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 1d. Delete experiment
      if (url.pathname === '/api/experiments/delete' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(env.DB, token) : null;
        let email;

        if (user) {
          email = user.email;
        } else {
          const guestId = request.headers.get('x-guest-id');
          if (!guestId) {
            return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          email = 'guest:' + guestId;
        }

        const { id } = await request.json();
        if (!id) {
          return new Response(JSON.stringify({ error: 'Experiment ID is required.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // Check if DO has other active WebSocket connections (open in other tabs)
        const doId = env.SOLVER_DO.idFromName(id);
        const doStub = env.SOLVER_DO.get(doId);

        const checkRequest = new Request(new URL('/delete-check', url.origin), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-is-active-session': request.headers.get('x-is-active-session') || 'false'
          }
        });

        const doRes = await doStub.fetch(checkRequest);
        if (doRes.status === 409) {
          return new Response(JSON.stringify({ error: 'conflict_open_elsewhere' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // Delete from D1 database
        await deleteSimulationSession(env.DB, id);

        // Delete chat history for this session
        await deleteChatHistoryForSession(env.DB, email, id);

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 1e. Rename experiment
      if (url.pathname === '/api/experiments/rename' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(env.DB, token) : null;

        if (!user) {
          const guestId = request.headers.get('x-guest-id');
          if (!guestId) {
            return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
        }

        const { id, name } = await request.json();
        if (!id || !name) {
          return new Response(JSON.stringify({ error: 'Experiment ID and Name are required.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // Update in D1 database
        await renameSimulationSession(env.DB, id, name);

        // Notify active DO of rename
        const doId = env.SOLVER_DO.idFromName(id);
        const doStub = env.SOLVER_DO.get(doId);
        
        const doRenameReq = new Request(new URL('/rename', url.origin), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        await doStub.fetch(doRenameReq);

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 1g. Clear experiment logs and reset name
      if (url.pathname === '/api/experiments/clear' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(env.DB, token) : null;

        if (!user) {
          const guestId = request.headers.get('x-guest-id');
          if (!guestId) {
            return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
        }

        const { id } = await request.json();
        if (!id) {
          return new Response(JSON.stringify({ error: 'Experiment ID is required.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // Delete logs from D1 database
        await env.DB.prepare('DELETE FROM experiment_logs WHERE session_id = ?').bind(id).run();

        // Notify active DO of clear
        const doId = env.SOLVER_DO.idFromName(id);
        const doStub = env.SOLVER_DO.get(doId);
        
        const doClearReq = new Request(new URL('/clear', url.origin), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const doRes = await doStub.fetch(doClearReq);
        const doResData = await doRes.json();

        return new Response(JSON.stringify({ success: true, name: doResData.name }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 1f. Generate experiment report
      if (url.pathname === '/api/experiments/report' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(env.DB, token) : null;

        const body = await request.json();
        const sessionId = body.sessionId || request.headers.get('x-session-id');
        if (!sessionId) {
          return new Response(JSON.stringify({ error: 'Session ID is required.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // Log guest report activity if not logged in
        if (!user) {
          const dateStr = new Date().toISOString().slice(0, 10);
          ctx.waitUntil(incrementGuestActivity(env.DB, sessionId, dateStr, 'report').catch(err => {
            console.error('[Worker] Failed to increment guest report count:', err);
          }));
        }

        const doId = env.SOLVER_DO.idFromName(sessionId);
        const doStub = env.SOLVER_DO.get(doId);

        // Fetch current live state from DO
        const stateRes = await doStub.fetch(new Request(new URL('/state', url.origin)));
        if (!stateRes.ok) {
          return new Response(JSON.stringify({ error: 'Failed to retrieve simulation state.' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        const simState = await stateRes.json();

        const session = await getSimulationSession(env.DB, sessionId);
        const expName = session ? session.name : 'Unknown Experiment';
        let logs = await getExperimentLogs(env.DB, sessionId);

        const isDead = simState.is_dead || simState.isDead || false;
        const currentGrowth = Math.max(0.0, simState.biomass_flux || 0.0);
        const glcFlux = simState.fluxes ? (simState.fluxes['EX_glc__D_e'] || 0.0) : 0.0;
        const currentGlcUptake = Math.max(0.0, -glcFlux);
        const o2Flux = simState.fluxes ? (simState.fluxes['EX_o2_e'] || 0.0) : 0.0;
        const currentO2Uptake = Math.max(0.0, -o2Flux);
        const atpFlux = Math.max(0.0, Math.abs(simState.fluxes ? (simState.fluxes['ATPS4rpp'] || simState.fluxes['ATPS4r'] || 0.0) : 0.0));

        if (logs.length === 0) {
          const isDeadVal = isDead ? 1 : 0;
          try {
            await logExperimentAction(
              env.DB,
              sessionId,
              'initial',
              'Initial State',
              null,
              null,
              currentGrowth,
              currentGlcUptake,
              currentO2Uptake,
              atpFlux,
              isDeadVal
            );
            logs = await getExperimentLogs(env.DB, sessionId);
          } catch (err) {
            console.error('[Worker] Failed to write initial state log:', err);
          }
        }

        let reportText = `Experiment: ${expName}\n`;
        reportText += `Current Status: ${isDead ? 'Dead 💀' : 'Alive (Optimal) 🟢'}\n`;
        reportText += `Current Growth Rate: ${parseFloat(currentGrowth).toFixed(2)} hr⁻¹\n`;
        reportText += `Current Glucose Uptake: ${parseFloat(currentGlcUptake).toFixed(1)} mM/s\n`;
        reportText += `Current Oxygen Uptake: ${parseFloat(currentO2Uptake).toFixed(1)} mM/s\n`;
        reportText += `Current ATP Yield: ${parseFloat(atpFlux).toFixed(1)} mM/s\n\n`;

        reportText += `Timeline of Actions & Biological Impact:\n`;
        if (logs.length === 0) {
          reportText += `  - No actions recorded in this experiment yet.\n`;
        } else {
          logs.forEach((log) => {
            let timeStr = '';
            if (log.created_at) {
              try {
                const dateUtc = new Date(log.created_at + 'Z');
                timeStr = dateUtc.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              } catch(e) {
                timeStr = log.created_at;
              }
            }

            let actionDesc = '';
            if (log.action_type === 'initial') {
              actionDesc = `Initial State`;
            } else if (log.action_type === 'slider') {
              if (log.prev_value !== null && log.prev_value !== undefined) {
                actionDesc = `Changed ${log.target} from ${log.prev_value.toFixed(1)} to ${log.value.toFixed(1)}`;
              } else {
                actionDesc = `Changed ${log.target} to ${log.value.toFixed(1)}`;
              }
            } else if (log.action_type === 'injection') {
              actionDesc = `Spiked (Injected) ${log.target} by +${log.value.toFixed(1)} mM`;
            } else if (log.action_type === 'depletion') {
              actionDesc = `Depleted ${log.target}`;
            } else if (log.action_type === 'reset') {
              actionDesc = `Reset simulation`;
            } else if (log.action_type === 'scenario') {
              actionDesc = log.value > 0 ? `Applied scenario: "${log.target}"` : `Exited scenario`;
            }

            const stateDesc = `[Result: Growth = ${log.growth_rate.toFixed(2)} hr⁻¹, Glucose Uptake = ${log.glucose_uptake.toFixed(1)} mM/s, Oxygen Uptake = ${log.oxygen_uptake.toFixed(1)} mM/s, ATP Yield = ${log.atp_yield.toFixed(1)} mM/s, Status = ${log.is_dead ? 'Dead' : 'Alive'}]`;

            reportText += `  - ${timeStr}: ${actionDesc}\n    ${stateDesc}\n`;
          });
        }

        return new Response(JSON.stringify({ reportText }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 2. Chat AI endpoint
      if (url.pathname === '/api/chat' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(env.DB, token) : null;

        const sessionId = request.headers.get('x-session-id') || 'default_user';

        // Daily AI chat cap: per IP for guests (client cannot spoof cf-connecting-ip), per account for users
        const day = new Date().toISOString().slice(0, 10);
        const ip = request.headers.get('cf-connecting-ip') || 'unknown';
        const limitKey = user ? `user:${user.email}` : `ip:${rateLimitIpKey(ip)}`;
        const dailyLimit = user ? CHAT_LIMITS.userPerDay : CHAT_LIMITS.guestPerDay;
        let usedToday = 0;
        try {
          usedToday = await incrementChatRateLimit(env.DB, limitKey, day);
        } catch (err) {
          console.error('[Worker] Chat rate limit check failed:', err);
          return new Response(JSON.stringify({ error: 'rate_limit_unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        if (usedToday > dailyLimit) {
          return new Response(JSON.stringify({
            error: 'daily_limit_reached',
            limit: dailyLimit,
            guest: !user,
            resetAt: `${day}T23:59:59Z`
          }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // Global guest circuit breaker (protects against many IPs / proxies)
        if (!user) {
          let guestTotal = 0;
          try {
            guestTotal = await incrementChatRateLimit(env.DB, 'guests:total', day);
          } catch (err) {
            console.error('[Worker] Guest total limit check failed:', err);
            return new Response(JSON.stringify({ error: 'rate_limit_unavailable' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          const alertAt = Math.floor(CHAT_LIMITS.guestTotalPerDay * CHAT_LIMITS.guestTotalAlertRatio);
          if (guestTotal === alertAt || guestTotal === CHAT_LIMITS.guestTotalPerDay + 1) {
            const pct = guestTotal > CHAT_LIMITS.guestTotalPerDay ? 100 : Math.round(CHAT_LIMITS.guestTotalAlertRatio * 100);
            ctx.waitUntil(sendTelegramNotification(env,
              `⚠️ <b>Гостевой AI-чат: использовано ${pct}% суточного лимита</b>\n` +
              `${Math.min(guestTotal, CHAT_LIMITS.guestTotalPerDay)} / ${CHAT_LIMITS.guestTotalPerDay} сообщений за ${day} (UTC).\n` +
              `Последний IP: <code>${ip}</code>`
            ).catch(err => console.error('[Worker] Telegram alert failed:', err)));
          }
          if (guestTotal > CHAT_LIMITS.guestTotalPerDay) {
            return new Response(JSON.stringify({
              error: 'guest_quota_exhausted',
              guest: true,
              resetAt: `${day}T23:59:59Z`
            }), {
              status: 429,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
        }
        // Log guest chat activity if not logged in
        if (!user) {
          const dateStr = new Date().toISOString().slice(0, 10);
          ctx.waitUntil(incrementGuestActivity(env.DB, sessionId, dateStr, 'chat').catch(err => {
            console.error('[Worker] Failed to increment guest chat count:', err);
          }));
        }

        const doId = env.SOLVER_DO.idFromName(sessionId);
        const doStub = env.SOLVER_DO.get(doId);

        // Forward chat request to Durable Object
        const doRes = await doStub.fetch(new Request(new URL('/chat', url.origin), {
          method: 'POST',
          headers: request.headers,
          body: await request.text()
        }));

        return new Response(doRes.body, {
          status: doRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 2b. Grant complimentary credits endpoint
      if (url.pathname === '/api/credits/grant-complimentary' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(env.DB, token) : null;

        if (!user) {
          return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const userEmail = user.email.trim().toLowerCase();

        // Add 50.0 credits to user
        await env.DB.prepare('UPDATE users SET credits = COALESCE(credits, 0.0) + 50.0 WHERE email = ?').bind(userEmail).run();
        const updatedUser = await env.DB.prepare('SELECT credits FROM users WHERE email = ?').bind(userEmail).first();
        const newCredits = updatedUser ? parseFloat(updatedUser.credits) : 0.0;

        // Get all active sessions for this user from D1 database to notify DOs
        let sessionIds = [];
        try {
          const sessions = await env.DB.prepare('SELECT id FROM simulation_sessions WHERE email = ?').bind(userEmail).all();
          if (sessions.results) {
            sessionIds = sessions.results.map(s => s.id);
          }
        } catch (err) {
          console.error('[Grant Complimentary Credits] Failed to fetch user sessions:', err);
        }

        // Notify DO for each session
        for (const sessionId of sessionIds) {
          const doId = env.SOLVER_DO.idFromName(sessionId);
          const doStub = env.SOLVER_DO.get(doId);
          ctx.waitUntil(doStub.fetch(new Request(new URL('/update-credits', url.origin), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credits: newCredits })
          })).catch(err => console.error(`Failed to notify DO for session ${sessionId}:`, err)));
        }

        return new Response(JSON.stringify({ success: true, credits: newCredits }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 3. OAuth login
      if (url.pathname === '/api/auth/google' && request.method === 'POST') {
        const { credential, consentGiven } = await request.json();
        if (!credential) {
          return new Response(JSON.stringify({ error: 'Missing credential.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        const session = await verifyGoogleTokenAndLogin(env.DB, credential, !!consentGiven);
        if (session.limitReached) {
          return new Response(JSON.stringify({ error: 'registration_limit_reached' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        if (session.isNewUser && !session.token) {
          // New user checked, not yet completed onboarding consent
          return new Response(JSON.stringify({ isNewUser: true }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        if (session.isNewUser) {
          ctx.waitUntil(trackUserSignup(env, request, session.user.email, session.user.name));
        }
        return new Response(JSON.stringify(session), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 4. Auth status
      if (url.pathname === '/api/auth/status' && request.method === 'GET') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const guestId = request.headers.get('x-guest-id');
        const ip = request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip') || 'unknown';
        const timeZone = request.headers.get('x-timezone');
        const visit = url.searchParams.get('visit') === 'true';

        let status = await getUserStatus(env.DB, token, ip, guestId, timeZone, env.GOOGLE_CLIENT_ID);
        if (visit) {
          if (status.loggedIn && status.user) {
            await incrementUserVisits(env.DB, status.user.email);
            status = await getUserStatus(env.DB, token, ip, guestId, timeZone, env.GOOGLE_CLIENT_ID);
          } else {
            const sessionId = request.headers.get('x-session-id') || guestId || ip || 'unknown';
            const dateStr = new Date().toISOString().slice(0, 10);
            const userAgent = request.headers.get('user-agent');
            const country = request.cf?.country || request.headers.get('cf-ipcountry') || null;
            const city = request.cf?.city || null;
            const asnOrg = request.cf?.asOrganization || (request.cf?.asn ? `ASN ${request.cf.asn}` : null) || null;
            ctx.waitUntil(recordGuestVisit(env.DB, sessionId, dateStr, { ip, userAgent, country, city, asnOrg }));
          }
        }
        return new Response(JSON.stringify(status), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 5. Chat History
      if (url.pathname === '/api/chat/history') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const guestId = request.headers.get('x-guest-id');
        const ip = request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip') || 'unknown';
        const sessionId = request.headers.get('x-session-id');

        let identifier = sessionId 
          ? `guest:${guestId || ip || 'unknown'}:${sessionId}` 
          : `guest:${guestId || ip || 'unknown'}`;
        if (token) {
          const user = await getUserByToken(env.DB, token);
          if (user && user.email) {
            identifier = sessionId 
              ? `user:${user.email}:${sessionId}` 
              : `user:${user.email}`;
          }
        }

        if (request.method === 'GET') {
          const history = await getChatHistory(env.DB, identifier);
          return new Response(JSON.stringify(history), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        if (request.method === 'DELETE') {
          await env.DB.prepare('DELETE FROM chat_history WHERE identifier = ?').bind(identifier).run();
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
      }

      // 6. Logout
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        if (token) {
          await logoutSession(env.DB, token);
        }
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }



      // 8. Feedback submission
      if (url.pathname === '/api/feedback' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(env.DB, token) : null;
        let email;

        if (user) {
          email = user.email;
        } else {
          const guestId = request.headers.get('x-guest-id');
          if (!guestId) {
            return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          email = 'guest:' + guestId;
        }

        const { feedback } = await request.json();
        if (!feedback || !feedback.trim()) {
          return new Response(JSON.stringify({ error: 'Feedback message cannot be empty.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
        const safeFeedback = feedback
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');

        const alertText = `📝 <b>New Feedback Received!</b>\n\n` +
                          `<b>User:</b> <code>${email}</code>\n` +
                          `<b>IP:</b> <code>${ip}</code>\n\n` +
                          `<b>Feedback:</b>\n<blockquote>${safeFeedback}</blockquote>`;

        ctx.waitUntil(sendTelegramNotification(env, alertText));

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 8b. Support message submission
      if (url.pathname === '/api/support' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(env.DB, token) : null;
        
        let userEmailStr = '';
        let userNameStr = '';
        let isRegistered = false;

        if (user) {
          userEmailStr = user.email;
          userNameStr = user.name || 'N/A';
          isRegistered = true;
        }

        const { message: supportMsg, name: guestName, email: guestEmail } = await request.json();
        
        if (!supportMsg || !supportMsg.trim()) {
          return new Response(JSON.stringify({ error: 'Message cannot be empty.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // If guest, use optional guestName/guestEmail
        if (!isRegistered) {
          userEmailStr = guestEmail ? guestEmail.trim() : 'Guest (No Email)';
          userNameStr = guestName ? guestName.trim() : 'Guest (No Name)';
        }

        const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
        const safeMsg = supportMsg
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        const safeName = userNameStr
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        const safeEmail = userEmailStr
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');

        const alertText = `🎫 <b>New Support Request!</b>\n\n` +
                          `<b>User Type:</b> <code>${isRegistered ? 'Registered User' : 'Guest'}</code>\n` +
                          `<b>Name:</b> <code>${safeName}</code>\n` +
                          `<b>Email:</b> <code>${safeEmail}</code>\n` +
                          `<b>IP:</b> <code>${ip}</code>\n\n` +
                          `<b>Message:</b>\n<blockquote>${safeMsg}</blockquote>`;

        ctx.waitUntil(sendTelegramSupportNotification(env, alertText));

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 10. User preferences endpoint (stub)
      if (url.pathname === '/api/user/preferences' && request.method === 'PATCH') {
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }


      // Fallback 404 for unknown API calls
      return new Response(JSON.stringify({ error: 'API route not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (err) {
      console.error('[Worker] Global fetch handler error:', err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
};
