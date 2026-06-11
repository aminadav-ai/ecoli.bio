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
  checkLimitAndIncrement, 
  verifyGoogleTokenAndLogin, 
  getUserStatus, 
  logoutSession, 
  simulatePremiumPayment, 
  saveChatMessage, 
  getChatHistory, 
  bulkIncrementUserStats,
  incrementUserVisits,
  incrementUserQuestions,
  recordGuestVisit,
  getSimulationSessions,
  getSimulationSession,
  upsertSimulationSession,
  deleteSimulationSession,
  getExperimentCount
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
    this.renameTimeout = null;
    this.isSolving = false;

    // In-memory buffering state
    this.bufferedTicks = 0;
    this.lastFlushTime = 0;
    this.userEmail = null;
    this.totalSolverTicks = undefined;
    this.alarmScheduled = false;

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
        this.simulation = initializeNewSimulation();
        if (savedState && this.simulation) {
          deserializeSimulation(this.simulation, savedState);
          console.log('[DO] Restored active simulation state from storage.');
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
    if (this.isSolving) return;
    this.isSolving = true;
    
    // Broadcast WORK state to all clients
    this.broadcast({ type: "STATUS", status: "WORK" });
    
    try {
      let stabilized = false;
      let ticksRun = 0;
      
      while (!stabilized && ticksRun < 100 && this.isSolving) {
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
        ticksRun++;
        
        // Save state to DO storage
        const stateToSave = serializeSimulation(this.simulation);
        await this.state.storage.put('sim_state', stateToSave);
        
        // Increment solver ticks
        const newTicks = this.simulation.solverTicksBuffer || 0;
        if (newTicks > 0 && this.userEmail) {
          this.simulation.solverTicksBuffer = 0;
          this.bufferedTicks += newTicks;
          if (this.totalSolverTicks !== undefined) {
            this.totalSolverTicks += newTicks;
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
          solverTicks: this.totalSolverTicks || 0
        });
        
        stabilized = result.stabilized;
        
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
    
    if (this.renameTimeout) {
      clearTimeout(this.renameTimeout);
    }
    
    this.renameTimeout = setTimeout(() => {
      this.state.waitUntil(this.performAiRename());
    }, 5000); // 5 seconds debounce
  }

  async performAiRename() {
    try {
      const modifiedList = [];
      for (const [rId, rxn] of Object.entries(this.simulation.reactions)) {
        if (rxn.vMax !== rxn.defaultVmax || rxn.km !== rxn.defaultKm) {
          modifiedList.push(`Reaction ${rxn.name || rId}: vMax=${rxn.vMax}, km=${rxn.km}`);
        }
      }
      const o2 = this.simulation.metabolites['o2_e'].concentration;
      const glc = this.simulation.metabolites['glc__D_e'].concentration;
      if (o2 !== 2.0) modifiedList.push(`Oxygen Concentration o2_e: ${o2}`);
      if (glc !== 2.0) modifiedList.push(`Glucose Concentration glc__D_e: ${glc}`);
      
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
    }
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'INIT') {
        const { userEmail, dbTicks } = data;
        this.userEmail = userEmail || null;
        if (dbTicks !== undefined && this.totalSolverTicks === undefined) {
          this.totalSolverTicks = dbTicks;
        }
        
        const dbSession = await getSimulationSession(this.env.DB, this.sessionId);
        if (dbSession) {
          this.baseName = dbSession.base_name;
          this.name = dbSession.name;
          if (dbSession.state) {
            try {
              const stateObj = JSON.parse(dbSession.state);
              deserializeSimulation(this.simulation, stateObj);
            } catch (e) {
              console.error("[DO] Failed to parse saved session state:", e);
            }
          }
        } else {
          this.baseName = "Experiment";
          this.name = this.name || "Experiment";
        }
        
        ws.send(JSON.stringify({
          type: "INIT_STATE",
          state: serializeSimulation(this.simulation),
          base_name: this.baseName,
          name: this.name,
          solverTicks: this.totalSolverTicks || 0,
          isSolving: !!this.isSolving
        }));
        
        return;
      }
      
      if (data.type === 'UPDATE_PARAMETER') {
        const { id, param, value, concentrations, parameters } = data;
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
        this.triggerAiRename();
        return;
      }
      
      if (data.type === 'RESET_SIMULATION') {
        this.simulation.reset();
        this.state.waitUntil(this.startSolveLoop());
        this.triggerAiRename();
        return;
      }
      
      if (data.type === 'APPLY_SCENARIO') {
        const { scenarioId } = data;
        this.simulation.applyScenario(scenarioId);
        this.state.waitUntil(this.startSolveLoop());
        this.triggerAiRename();
        return;
      }
      
      if (data.type === 'RENAME_PROJECT') {
        const { name } = data;
        this.baseName = name;
        this.name = name;
        if (this.userEmail) {
          await upsertSimulationSession(
            this.env.DB,
            this.sessionId,
            this.userEmail,
            this.baseName,
            this.name,
            JSON.stringify(serializeSimulation(this.simulation))
          );
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
      
      const stateToSave = serializeSimulation(this.simulation);
      this.state.storage.put('sim_state', stateToSave);

      if (this.totalSolverTicks === undefined && data.dbTicks !== undefined) {
        this.totalSolverTicks = data.dbTicks;
      }

      const newTicks = this.simulation.solverTicksBuffer || 0;
      if (newTicks > 0 && data.userEmail) {
        this.simulation.solverTicksBuffer = 0;
        this.bufferedTicks += newTicks;
        this.userEmail = data.userEmail;
        if (this.totalSolverTicks !== undefined) {
          this.totalSolverTicks += newTicks;
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

      result.solverTicks = this.totalSolverTicks !== undefined ? this.totalSolverTicks : (data.dbTicks || 0);

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

// ==========================================
// 2. Default Worker Fetch Handler
// ==========================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Serve static assets if not an API route
    if (!url.pathname.startsWith('/api/')) {
      return await env.ASSETS.fetch(request);
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
            dbTicks: user.solver_ticks || 0
          })
        });

        const doRes = await doStub.fetch(solveRequest);
        if (!doRes.ok) {
          return new Response(doRes.body, { status: doRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const result = await doRes.json();
        
        result.solverTicks = result.solverTicks !== undefined ? result.solverTicks : (user.solver_ticks || 0);
        result.lastTimestamp = Date.now();

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
        await deleteSimulationSession(env.DB, id);

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 2. Chat AI endpoint
      if (url.pathname === '/api/chat' && request.method === 'POST') {
        const body = await request.json();
        const { message, history, context } = body;
        const apiKey = env.GOOGLE_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ error: 'GOOGLE_API_KEY is not configured.' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const guestId = request.headers.get('x-guest-id');
        const ip = request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip') || 'unknown';
        const timeZone = request.headers.get('x-timezone');
        const sessionId = request.headers.get('x-session-id');

        const limitCheck = await checkLimitAndIncrement(env.DB, ip, guestId, token, timeZone);
        if (!limitCheck.user) {
          return new Response(JSON.stringify({ error: 'Authentication required. Please sign in.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        if (!limitCheck.allowed) {
          return new Response(JSON.stringify({ error: 'Limit Reached' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // Increment questions count asynchronously
        ctx.waitUntil(incrementUserQuestions(env.DB, limitCheck.user.email));

        const identifier = sessionId 
          ? `user:${limitCheck.user.email}:${sessionId}` 
          : `user:${limitCheck.user.email}`;
        ctx.waitUntil(saveChatMessage(env.DB, identifier, 'user', message, context));

        const systemPrompt = `You are a helpful and expert AI Metabolic Assistant for a student using the E. coli Metabolic Live Atlas.
Your goal is to guide the student, explain how pathways work, answer their questions about E. coli metabolism, and help them with the interactive learning scenarios.

IMPORTANT: Respond in the same language as the user's query. Keep your answer concise, scientifically accurate, and encouraging.

CRITICAL WARNING: The user interacts with a live simulation, meaning that fluxes, growth rates, and concentrations change in real time with every user action. Always look up all values, rates, and statuses from the CURRENT simulation state context below. DO NOT reuse numbers, fluxes (e.g. CYTBO3_4pp, growth rate, etc.) or parameter values from previous messages in the chat history, as they are now stale and incorrect.

NOTE: The active model and map are based on the genome-scale E. coli iJO1366 reconstruction (specifically its central carbon metabolism map), NOT the simplified e_coli_core model. The primary growth rate / biomass reaction is BIOMASS_Ec_iJO1366_core_53p95M. Keep this in mind when discussing pathways, connections, and reactions on the screen.

Here is the current state of the metabolic simulation on the student's screen:
${JSON.stringify(context, null, 2)}
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
        
        ctx.waitUntil(saveChatMessage(env.DB, identifier, 'model', reply));

        return new Response(JSON.stringify({ reply, remaining: limitCheck.remaining }), {
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

        let status = await getUserStatus(env.DB, token, ip, guestId, timeZone);
        if (visit) {
          if (status.loggedIn && status.user) {
            await incrementUserVisits(env.DB, status.user.email);
            status = await getUserStatus(env.DB, token, ip, guestId, timeZone);
          } else {
            const sessionId = request.headers.get('x-session-id') || guestId || ip || 'unknown';
            const dateStr = new Date().toISOString().slice(0, 10);
            ctx.waitUntil(recordGuestVisit(env.DB, sessionId, dateStr));
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

      // 7. Simulate payment
      if (url.pathname === '/api/payments/simulate' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        if (!token) {
          return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        const { tier, autoRenew } = await request.json();
        const result = await simulatePremiumPayment(env.DB, token, tier, autoRenew);
        return new Response(JSON.stringify(result), {
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
