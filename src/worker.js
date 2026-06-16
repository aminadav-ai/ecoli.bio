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
  deductUserCredits
} from './d1_db.js';

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
          this.credits = parseFloat(user.credits) - this.bufferedTicks;
        }
      } catch (err) {
        console.error('[DO LOOP] Failed to reload user credits:', err);
      }
    }
    
    try {
      while (!this.stabilized && this.ticksRun < 100 && this.isSolving) {
        if (this.userEmail && this.credits !== undefined && (this.credits === null || this.credits <= 0)) {
          this.broadcast({
            type: "ERROR",
            error: "insufficient_credits",
            message: "Insufficient credits. Please refill your account."
          });
          break;
        }
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
        const newTicks = this.simulation.solverTicksBuffer || 0;
        console.log(`[DO LOOP] newTicks=${newTicks}, userEmail=${this.userEmail}`);
        if (newTicks > 0 && this.userEmail) {
          this.simulation.solverTicksBuffer = 0;
          this.bufferedTicks += newTicks;
          if (this.credits !== undefined) {
            this.credits = Math.max(0.0, this.credits - newTicks);
          }
          await this.state.storage.put('buffered_state', { ticks: this.bufferedTicks, email: this.userEmail });
          
          if (!this.alarmScheduled) {
            this.alarmScheduled = true;
            this.state.storage.setAlarm(Date.now() + 5000);
          }
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
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
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
        this.userEmail = userEmail || null;
        if (credits !== undefined && credits !== null) {
          this.credits = parseFloat(credits) - this.bufferedTicks;
        }
        
        if (this.userEmail) {
          try {
            const user = await this.env.DB.prepare('SELECT credits FROM users WHERE email = ?').bind(this.userEmail).first();
            if (user && user.credits !== undefined && user.credits !== null) {
              this.credits = parseFloat(user.credits) - this.bufferedTicks;
            } else {
              this.credits = 250.0 - this.bufferedTicks;
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
        
        ws.send(JSON.stringify({
          type: "INIT_STATE",
          state: serializeSimulation(this.simulation),
          base_name: this.baseName,
          name: this.name,
          solverTicks: 0,
          dailySolverTicks: 0,
          isSolving: !!this.isSolving,
          credits: (this.credits !== undefined && this.credits !== null) ? this.credits : 250.0
        }));
        
        if (this.isFreshSession) {
          this.isFreshSession = false;
          this.state.waitUntil(this.startSolveLoop());
        }
        return;
      }
      
      if (data.type === 'UPDATE_PARAMETER' || data.type === 'RESET_SIMULATION' || data.type === 'APPLY_SCENARIO') {
        if (this.userEmail && this.credits !== undefined && (this.credits === null || this.credits <= 0)) {
          ws.send(JSON.stringify({
            type: "ERROR",
            error: "insufficient_credits",
            message: "Insufficient credits. Please refill your account."
          }));
          return;
        }
      }
      
      if (data.type === 'UPDATE_PARAMETER') {
        const { id, param, value, concentrations, parameters, logAction } = data;
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
        if (data.logAction) {
          this.pendingLogAction = data.logAction;
        }
        this.simulation.reset();
        this.state.waitUntil(this.startSolveLoop());
        this.triggerAiRename();
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

    if (url.pathname === '/update-credits') {
      const { credits } = await request.json();
      this.credits = parseFloat(credits) - this.bufferedTicks;

      // Broadcast update to all connected clients
      this.broadcast({
        type: "TICK_UPDATE",
        status: this.isSolving ? "WORK" : "RELAX",
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
      const { message, history, context } = body;
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
            this.credits = parseFloat(user.credits) - this.bufferedTicks;
          }
        }
      }

      if (this.credits !== undefined && this.credits !== null && this.credits <= 0) {
        return new Response(JSON.stringify({ 
          error: 'insufficient_credits', 
          message: 'Insufficient credits. Please refill your account.' 
        }), {
          status: 402,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const identifier = this.sessionId 
        ? `user:${this.userEmail}:${this.sessionId}` 
        : `user:${this.userEmail}`;
      
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
- Experiment Management: Authorized users can create, rename, delete, and switch between multiple saved simulation sessions (experiments) via the header dropdown on desktop or the side drawer on mobile. The custom metabolite concentrations and modified reaction parameters for each experiment are stored dynamically in the cloud (using Durable Objects and D1 database).
- Experiment Report: The "Report" button is located in the center of the bottom dock panel (floating dock on desktop, full-width on mobile), between the Scenarios tab and the AI Chat button. It opens the Experiment Report modal showing a timeline of user actions and biological impacts.
- Chat Context: The chat header features an "👁️ Context" button to view raw JSON simulation context sent to the AI. This button is hidden in production (ecoli.bio / www.ecoli.bio) and only visible in development and staging environments.
- Guest Mode: If the student is not logged in, they see the default wild-type simulation state (aerobic growth rate of 0.98 hr⁻¹ with EX_o2_e = 18.5 and EX_glc__D_e = 10.0) in read-only mode. Their sliders and simulation controls are disabled, and they cannot manage experiments or save their state until they sign in.

Here is the current state of the metabolic simulation on the student's screen:
${JSON.stringify(context, null, 2)}

Instructions:
1. Explain metabolism in simple, clear terms (undergraduate biology level).
2. Use the exact iJO1366 map BiGG IDs (e.g., ATPS4rpp, GLCptspp, ac_e, lac__D_e, PFK, PGI, PDH, PFL, pyr_c) as plain text (without backticks or quotes) in your text when discussing specific reactions or metabolites. Always mention their common names alongside the IDs.
3. If a scenario is active, guide the student through it. If they submit an answer or ask a question about it, evaluate it and explain the biology (e.g. why PDH is more ATP-efficient than PFL, or why Vmax causes metabolic bottlenecks).
4. Do not make up facts. E. coli central metabolism is standard (glycolysis, pentose phosphate pathway, TCA cycle, respiration, fermentation).
`;

      const contents = [];
      if (history && history.length > 0) {
        for (const msg of history) {
          contents.push({
            role: msg.role === 'model' ? 'model' : 'user',
            parts: [{ text: msg.text }]
          });
        }
      }
      contents.push({
        role: 'user',
        parts: [{ text: message }]
      });

      // Request Gemini API
      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: {
            parts: [{ text: systemPrompt }]
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
        creditsCost = (regularTokens * (3 / 11000)) + (cachedTokens * (3 / 44000));
      }

      await deductUserCredits(this.env.DB, this.userEmail, creditsCost);
      const updatedUser = await this.env.DB.prepare('SELECT credits FROM users WHERE email = ?').bind(this.userEmail).first();
      const updatedCredits = updatedUser ? parseFloat(updatedUser.credits) : 0.0;

      // Update in-memory credits
      this.credits = updatedCredits - this.bufferedTicks;

      // Broadcast update to all clients
      this.broadcast({
        type: "TICK_UPDATE",
        status: this.isSolving ? "WORK" : "RELAX",
        solverTicks: 0,
        dailySolverTicks: 0,
        credits: this.credits
      });

      this.state.waitUntil(trackWorkerChatQuery(this.env, request, this.userEmail, message, usageMetadata));

      return new Response(JSON.stringify({ 
        reply, 
        count: 0,
        credits: this.credits
      }), {
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
          this.credits = parseFloat(data.credits) - this.bufferedTicks;
        }
      }

      const newTicks = this.simulation.solverTicksBuffer || 0;
      if (newTicks > 0 && data.userEmail) {
        this.simulation.solverTicksBuffer = 0;
        this.bufferedTicks += newTicks;
        this.userEmail = data.userEmail;
        this.totalSolverTicks += newTicks;
        this.dailySolverTicks += newTicks;
        if (this.credits !== undefined) {
          this.credits = Math.max(0.0, this.credits - newTicks);
        }
        this.state.storage.put('buffered_state', { ticks: this.bufferedTicks, email: this.userEmail });
      }

      if (this.lastFlushTime === 0) {
        this.lastFlushTime = now;
      }
      if (now - this.lastFlushTime >= 5000) {
        this.state.waitUntil(this.flushTicks());
      }

      if (!this.alarmScheduled && this.bufferedTicks > 0) {
        this.alarmScheduled = true;
        this.state.storage.setAlarm(Date.now() + 5000);
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

// Track chat queries in Telegram
async function trackWorkerChatQuery(env, request, email, message, usageMetadata = null) {
  try {
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'Unknown IP';
    const ua = request.headers.get('user-agent') || '';
    const device = parseUserAgent(ua);

    const safeMessage = (message || '')
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

    const text = `💬 <b>AI Chat Request!</b>\n\n` +
                 `<b>User:</b> <code>${email}</code>\n` +
                 `<b>IP:</b> <code>${ip}</code>\n` +
                 `<b>Device:</b> <code>${device}</code>\n\n` +
                 `<b>Prompt:</b>\n<blockquote>${safeMessage}</blockquote>` +
                 tokensInfo;

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

        if (!user) {
          return new Response(JSON.stringify({ error: 'Please sign in to use the simulator.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // Check if user has sufficient credits
        if (user.credits <= 0) {
          return new Response(JSON.stringify({ 
            error: 'insufficient_credits', 
            message: 'Insufficient credits. Please refill your account.' 
          }), {
            status: 402,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

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
            'x-session-id': sessionId
          },
          body: JSON.stringify({
            concentrations: body.concentrations,
            parameters: body.parameters,
            reset: body.reset,
            scenario: body.scenario,
            userEmail: user.email,
            dbTicks: 0,
            dailyTicks: 0,
            credits: user.credits
          })
        });

        const doRes = await doStub.fetch(solveRequest);
        if (!doRes.ok) {
          return new Response(doRes.body, { status: doRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const result = await doRes.json();
        
        result.solverTicks = 0;
        result.dailySolverTicks = 0;
        result.credits = result.credits !== undefined ? result.credits : user.credits;
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

        if (!user) {
          return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const list = await getSimulationSessions(env.DB, user.email);
        return new Response(JSON.stringify(list), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 1c. Create new experiment
      if (url.pathname === '/api/experiments/new' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(env.DB, token) : null;

        if (!user) {
          return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const sessionId = 'session_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        
        // Calculate initial formatted name
        const baseName = "Experiment";
        const dateStr = new Date().toISOString().split('T')[0];
        const count = await getExperimentCount(env.DB, user.email, baseName, dateStr);
        const fullName = `${baseName} (${dateStr} #${count + 1})`;
        
        const defaultState = JSON.stringify({
          metabolites: {},
          parameters: {},
          isDead: false,
          tickCounter: 0,
          lastTimestamp: 0
        });

        await upsertSimulationSession(env.DB, sessionId, user.email, baseName, fullName, defaultState);

        return new Response(JSON.stringify({ id: sessionId, base_name: baseName, name: fullName }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 1d. Delete experiment
      if (url.pathname === '/api/experiments/delete' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(env.DB, token) : null;

        if (!user) {
          return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
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
        await deleteChatHistoryForSession(env.DB, user.email, id);

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
          return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
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

      // 1f. Get experiment logs
      if (url.pathname === '/api/experiments/logs' && request.method === 'GET') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(env.DB, token) : null;

        if (!user) {
          return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) {
          return new Response(JSON.stringify({ error: 'Session ID is required.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }



        const logs = await getExperimentLogs(env.DB, sessionId);

        return new Response(JSON.stringify(logs), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 2. Chat AI endpoint
      if (url.pathname === '/api/chat' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(env.DB, token) : null;
        if (!user) {
          return new Response(JSON.stringify({ error: 'Authentication required. Please sign in.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const sessionId = request.headers.get('x-session-id') || 'default_user';
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

      // 3. OAuth login
      if (url.pathname === '/api/auth/google' && request.method === 'POST') {
        const { credential } = await request.json();
        if (!credential) {
          return new Response(JSON.stringify({ error: 'Missing credential.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        const session = await verifyGoogleTokenAndLogin(env.DB, credential);
        if (session.limitReached) {
          return new Response(JSON.stringify({ error: 'registration_limit_reached' }), {
            status: 403,
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
      if (url.pathname === '/api/chat/history' && request.method === 'GET') {
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

        const history = await getChatHistory(env.DB, identifier);
        return new Response(JSON.stringify(history), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
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

        if (!user) {
          return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
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
                          `<b>User:</b> <code>${user.email}</code>\n` +
                          `<b>IP:</b> <code>${ip}</code>\n\n` +
                          `<b>Feedback:</b>\n<blockquote>${safeFeedback}</blockquote>`;

        ctx.waitUntil(sendTelegramNotification(env, alertText));

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
