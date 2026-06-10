// src/worker.js
// Cloudflare Worker + Durable Objects entry point

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
  getAllUsersFromDb, 
  deleteUserFromDb, 
  saveChatMessage, 
  getChatHistory, 
  bulkIncrementUserStats,
  incrementUserVisits,
  incrementUserQuestions
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

    // Block DO concurrency until WASM solver is loaded and state is restored
    this.state.blockConcurrencyWhile(async () => {
      try {
        console.log('[DO] Loading HiGHS solver WebAssembly...');
        this.highs = await highsLoader({
          instantiateWasm(imports, successCallback) {
            WebAssembly.instantiate(highsWasm, imports).then(result => {
              successCallback(result.instance, result.module);
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
      } catch (err) {
        console.error('[DO] Failed DO initialization:', err);
      }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/solve') {
      return new Response('Not found', { status: 404 });
    }

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

      // Solve FBA inside the Durable Object
      const result = solveFba(this.highs, staticLpHeader, concentrations, parameters, this.simulation, options);
      
      // Save state to DO storage (asynchronously)
      const stateToSave = serializeSimulation(this.simulation);
      this.state.storage.put('sim_state', stateToSave);

      // Asynchronously flush solver ticks to D1
      const ticks = this.simulation.solverTicksBuffer || 0;
      if (ticks > 0 && data.userEmail) {
        this.simulation.solverTicksBuffer = 0;
        this.state.waitUntil(
          bulkIncrementUserStats(this.env.DB, [{ email: data.userEmail, ticks }]).catch(err => {
            console.error('[DO] Failed to increment user solver ticks:', err);
          })
        );
      }

      // Sync solver ticks count to return the actual count to the user
      // Note: we can read the ticks from the user profile, but returning it is handled in the main worker
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
      // 1. solve-fba endpoint
      if (url.pathname === '/api/solve-fba' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const user = token ? await getUserByToken(env.DB, token) : null;

        if (!user) {
          return new Response(JSON.stringify({ error: 'Пожалуйста, авторизуйтесь для работы с симулятором.' }), {
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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            concentrations: body.concentrations,
            parameters: body.parameters,
            reset: body.reset,
            scenario: body.scenario,
            userEmail: user.email
          })
        });

        const doRes = await doStub.fetch(solveRequest);
        if (!doRes.ok) {
          return new Response(doRes.body, { status: doRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const result = await doRes.json();
        
        // Append user ticks and timestamp
        const updatedUser = await getUserByToken(env.DB, token);
        result.solverTicks = updatedUser ? (updatedUser.solver_ticks || 0) : 0;
        result.lastTimestamp = Date.now();

        return new Response(JSON.stringify(result), {
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

        const identifier = `user:${limitCheck.user.email}`;
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
        if (visit && status.loggedIn && status.user) {
          await incrementUserVisits(env.DB, status.user.email);
          status = await getUserStatus(env.DB, token, ip, guestId, timeZone);
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

        let identifier = `guest:${guestId || ip || 'unknown'}`;
        if (token) {
          const user = await getUserByToken(env.DB, token);
          if (user && user.email) {
            identifier = `user:${user.email}`;
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

      // 8. Admin Reports
      if (url.pathname === '/api/admin/reports/users' && request.method === 'GET') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        if (!token) {
          return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        const user = await getUserByToken(env.DB, token);
        if (!user || user.email !== 'fbhcdbhf@gmail.com') {
          return new Response(JSON.stringify({ error: 'Forbidden.' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        const users = await getAllUsersFromDb(env.DB);
        return new Response(JSON.stringify(users), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 9. Admin delete user
      if (url.pathname.startsWith('/api/admin/users/') && request.method === 'DELETE') {
        const authHeader = request.headers.get('authorization');
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        if (!token) {
          return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        const user = await getUserByToken(env.DB, token);
        if (!user || user.email !== 'fbhcdbhf@gmail.com') {
          return new Response(JSON.stringify({ error: 'Forbidden.' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        
        const targetEmail = decodeURIComponent(url.pathname.substring('/api/admin/users/'.length));
        if (!targetEmail) {
          return new Response(JSON.stringify({ error: 'Email parameter is required.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        
        await deleteUserFromDb(env.DB, targetEmail);
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
