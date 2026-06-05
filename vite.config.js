import { defineConfig, loadEnv } from 'vite';
import { XMLParser } from 'fast-xml-parser';
import zlib from 'zlib';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Load static bounds once on startup
const staticBoundsPath = path.resolve('src/static_bounds.json');
let staticBounds = {};
if (fs.existsSync(staticBoundsPath)) {
  staticBounds = JSON.parse(fs.readFileSync(staticBoundsPath, 'utf8'));
}

function calculateBounds(concentrations, parameters) {
  const bounds = {};
  
  // Define default blocked bypasses
  const defaultBlocked = ['PFK_3', 'FBA3', 'F6PA', 'GLCDpp', 'XYLI2', 'GLCabcpp'];
  
  // Define coupled checkpoints
  const coupledCheckpoints = new Set(['GLCptspp', 'PFK', 'PYK', 'CS', 'ICDHyr', 'SUCDi']);
  
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

  // We only calculate bounds for reactions that are blocked, coupled, or modified
  const reactionsToProcess = new Set([
    ...defaultBlocked,
    ...coupledCheckpoints,
    ...Object.keys(parameters)
  ]);

  for (const rxnId of reactionsToProcess) {
    const orig = staticBounds[rxnId];
    if (!orig) continue;

    // Apply default blocked bypasses
    if (defaultBlocked.includes(rxnId)) {
      bounds[rxnId] = { lowerBound: 0.0, upperBound: 0.0 };
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
    const vMax = param.vMax !== undefined ? param.vMax : defaultVmax;
    const km = param.km !== undefined ? param.km : defaultKm;

    // Check reversibility
    const isReversible = (orig.lb < -1e-5);

    if (isReversible) {
      let ubForward = vMax;
      let ubBackward = vMax;

      if (coupledCheckpoints.has(rxnId)) {
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
      }

      const lb = -ubBackward;
      const ub = ubForward;
      bounds[rxnId] = { lowerBound: lb, upperBound: ub };
    } else {
      let ubForward = vMax;
      if (coupledCheckpoints.has(rxnId)) {
        const subs = reactionSubstrates[rxnId] || [];
        for (const sId of subs) {
          const conc = concentrations[sId] !== undefined ? concentrations[sId] : 1.0;
          ubForward = Math.min(ubForward, vMax * (conc / (km + conc)));
        }
      }

      const lb = 0.0;
      const ub = ubForward;
      bounds[rxnId] = { lowerBound: lb, upperBound: ub };
    }
  }

  return bounds;
}

export default defineConfig(({ mode }) => {
  // Load env variables from .env files
  const env = loadEnv(mode, process.cwd(), '');

  const supabaseUrl = env.SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_KEY || process.env.SUPABASE_KEY;

  async function getCache(key) {
    if (!supabaseUrl || !supabaseKey) return null;
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/api_cache?cache_key=eq.${encodeURIComponent(key)}`, {
        method: 'GET',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        return data[0] || null;
      }
    } catch (err) {
      console.error(`[Supabase Cache Get Error] Key: ${key}`, err);
    }
    return null;
  }

  async function setCache(key, type, value) {
    if (!supabaseUrl || !supabaseKey) return;
    try {
      const row = {
        cache_key: key,
        cache_type: type,
        cache_value: value,
        updated_at: new Date().toISOString()
      };
      await fetch(`${supabaseUrl}/rest/v1/api_cache`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify(row)
      });
    } catch (err) {
      console.error(`[Supabase Cache Set Error] Key: ${key}`, err);
    }
  }

  function isCacheExpired(cacheEntry) {
    if (!cacheEntry || !cacheEntry.updated_at) return true;
    const updatedAt = new Date(cacheEntry.updated_at).getTime();
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    return (now - updatedAt) > oneDayMs;
  }

  const getPostBody = (req) => {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({});
        }
      });
      req.on('error', err => reject(err));
    });
  };

  const handleSearch = async (req, res, next) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/geo-search') {
      try {
        const userQuery = url.searchParams.get('query') || '';
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        
        // Clean query: remove double quotes to preserve syntax
        const sanitizedQuery = userQuery.replace(/"/g, '');
        
        const cacheKey = `search:${sanitizedQuery.toLowerCase()}:${page}`;
        const cached = await getCache(cacheKey);
        if (cached && !isCacheExpired(cached)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...cached.cache_value, cacheStatus: 'hit' }));
          return;
        }

        const organism = '("Escherichia coli"[Organism])';
        const finalQuery = `("${sanitizedQuery}"[All Fields] AND ${organism})`;
        
        // Set up pagination start (0-indexed)
        const retstart = (page - 1) * 20;
        
        // Build NCBI Esearch query parameters
        const searchParams = new URLSearchParams({
          db: 'gds',
          term: finalQuery,
          retstart: retstart.toString(),
          retmax: '20',
          usehistory: 'y',
          retmode: 'xml'
        });
        
        const apiKey = env.NCBI_API_KEY || process.env.NCBI_API_KEY;
        if (apiKey) {
          searchParams.append('api_key', apiKey);
        }
        
        const esearchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${searchParams.toString()}`;
        
        const esearchResponse = await fetch(esearchUrl, {
          headers: {
            'User-Agent': 'E-Coli3-App/1.0 (aminadav.biotech@gmail.com)'
          }
        });
        
        if (!esearchResponse.ok) {
          throw new Error(`NCBI esearch failed with status ${esearchResponse.status}`);
        }
        
        const esearchXml = await esearchResponse.text();
        const parser = new XMLParser({
          ignoreAttributes: false,
          attributeNamePrefix: ''
        });
        
        const esearchJson = parser.parse(esearchXml);
        const eSearchResult = esearchJson.eSearchResult || {};
        const totalCount = parseInt(eSearchResult.Count || '0', 10);
        
        let ids = [];
        if (eSearchResult.IdList?.Id) {
          ids = Array.isArray(eSearchResult.IdList.Id)
            ? eSearchResult.IdList.Id.map(String)
            : [String(eSearchResult.IdList.Id)];
        }
        
        let results = [];
        if (ids.length > 0) {
          // Build summary URL
          const summaryParams = new URLSearchParams({
            db: 'gds',
            id: ids.join(','),
            retmode: 'xml'
          });
          if (apiKey) {
            summaryParams.append('api_key', apiKey);
          }
          
          const esummaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${summaryParams.toString()}`;
          const esummaryResponse = await fetch(esummaryUrl, {
            headers: {
              'User-Agent': 'E-Coli3-App/1.0 (aminadav.biotech@gmail.com)'
            }
          });
          
          if (!esummaryResponse.ok) {
            throw new Error(`NCBI esummary failed with status ${esummaryResponse.status}`);
          }
          
          const esummaryXml = await esummaryResponse.text();
          const esummaryJson = parser.parse(esummaryXml);
          
          let docSums = [];
          if (esummaryJson.eSummaryResult?.DocSum) {
            docSums = Array.isArray(esummaryJson.eSummaryResult.DocSum)
              ? esummaryJson.eSummaryResult.DocSum
              : [esummaryJson.eSummaryResult.DocSum];
          }
          
          results = docSums.map(docSum => {
            const resData = {
              id: String(docSum.Id || ''),
              accession: '',
              title: '',
              summary: '',
              gdsType: '',
              taxon: '',
              n_samples: 0,
              pdat: '',
              ftpLink: ''
            };
            
            const items = Array.isArray(docSum.Item) 
              ? docSum.Item 
              : (docSum.Item ? [docSum.Item] : []);
              
            for (const item of items) {
              const name = item.Name || '';
              let val = '';
              if (item && typeof item === 'object') {
                val = item['#text'] !== undefined ? item['#text'] : '';
              } else {
                val = item || '';
              }
              
              val = String(val).trim();
              
              if (name === 'Accession') resData.accession = val;
              else if (name === 'title') resData.title = val;
              else if (name === 'summary') resData.summary = val;
              else if (name === 'gdsType') resData.gdsType = val;
              else if (name === 'taxon') resData.taxon = val;
              else if (name === 'n_samples') resData.n_samples = parseInt(val, 10) || 0;
              else if (name === 'PDAT') resData.pdat = val;
              else if (name === 'FTPLink') resData.ftpLink = val;
            }
            return resData;
          });
        }
        
        const output = { totalCount, results };
        await setCache(cacheKey, 'search', output);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...output, cacheStatus: 'miss' }));
      } catch (err) {
        console.error('Error in geo-search API:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (url.pathname === '/api/analyze-dataset/init' && req.method === 'POST') {
      try {
        const body = await getPostBody(req);
        const accession = body.accession || '';
        if (!accession) {
          throw new Error('Accession ID is required');
        }

        const cacheKey = `metadata:${accession}`;
        const cached = await getCache(cacheKey);
        if (cached && !isCacheExpired(cached)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...cached.cache_value, cacheStatus: 'hit' }));
          return;
        }

        let overallDesign = '';
        let supplementaryUrls = [];
        const gseTextResponse = await fetch(`https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${accession}&targ=self&form=text&view=quick`);
        if (gseTextResponse.ok) {
          const gseText = await gseTextResponse.text();
          const lines = gseText.split('\n');
          for (const line of lines) {
            if (line.startsWith('!Series_overall_design =')) {
              overallDesign = line.split('=').slice(1).join('=').trim();
            } else if (line.startsWith('!Series_supplementary_file =')) {
              const sUrl = line.split('=').slice(1).join('=').trim();
              if (sUrl) supplementaryUrls.push(sUrl);
            }
          }
        } else {
          throw new Error(`NCBI series lookup failed with status ${gseTextResponse.status}`);
        }

        const output = { overallDesign, supplementaryUrls };
        await setCache(cacheKey, 'metadata', output);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...output, cacheStatus: 'miss' }));
      } catch (err) {
        console.error('Error in analyze-dataset/init:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (url.pathname === '/api/analyze-dataset/snippet' && req.method === 'POST') {
      try {
        const body = await getPostBody(req);
        const supplementaryUrls = body.supplementaryUrls || [];
        
        let fileSnippet = '';
        let fileName = '';

        if (supplementaryUrls.length > 0) {
          const firstUrl = supplementaryUrls[0];
          const ftpUrlHash = crypto.createHash('md5').update(firstUrl).digest('hex');
          const cacheKey = `snippet:${ftpUrlHash}`;
          
          const cached = await getCache(cacheKey);
          if (cached && !isCacheExpired(cached)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ...cached.cache_value, cacheStatus: 'hit' }));
            return;
          }

          if (firstUrl.endsWith('.csv.gz') || firstUrl.endsWith('.tsv.gz') || firstUrl.endsWith('.txt.gz') ||
              firstUrl.endsWith('.csv') || firstUrl.endsWith('.tsv') || firstUrl.endsWith('.txt')) {
            try {
              const httpsUrl = firstUrl.replace('ftp://ftp.ncbi.nlm.nih.gov', 'https://ftp.ncbi.nlm.nih.gov');
              fileName = httpsUrl.split('/').pop() || '';

              // Perform HEAD request to check size
              const headResponse = await fetch(httpsUrl, { method: 'HEAD' });
              const contentLength = parseInt(headResponse.headers.get('content-length') || '0', 10);

              // 5MB limit
              if (contentLength < 5 * 1024 * 1024) {
                const fileResponse = await fetch(httpsUrl);
                if (fileResponse.ok) {
                  const arrayBuffer = await fileResponse.arrayBuffer();
                  let decompressedBuffer;
                  if (httpsUrl.endsWith('.gz')) {
                    decompressedBuffer = zlib.gunzipSync(Buffer.from(arrayBuffer));
                  } else {
                    decompressedBuffer = Buffer.from(arrayBuffer);
                  }
                  const textContent = decompressedBuffer.toString('utf-8');
                  
                  // Filter lines to keep only E. coli central metabolism genes
                  const rawLines = textContent.split('\n');
                  if (rawLines.length > 0) {
                    const filteredLines = [];
                    // Keep header row
                    filteredLines.push(rawLines[0]);

                    // E. coli central metabolic genes regex (matches symbols and b-numbers)
                    const targetGenesRegex = /\b(pgi|pfk[ab]|fba[ab]|tpiA|gapA|pgk|gpm[am]|eno|pyk[af]|ldhA|pflB|adhE|pta|ackA|ace[efb]|lpd|gltA|acn[ab]|icd|suc[abcd]|sdh[abcd]|fum[abc]|mdh|ppc|pts[ghis]|crr|b4025|b3916|b1723|b2929|b2097|b3919|b1779|b2926|b0755|b3612|b2779|b1676|b1854|b1380|b0903|b1241|b2296|b2297|b0114|b0115|b0116|b0720|b1276|b0118|b1136|b0726|b0727|b0728|b0729|b0721|b0722|b0723|b0724|b1612|b4122|b1611|b3236|b3956|b4000|b4001|b1101|b2417|b2416|b2415)\b/i;

                    for (let i = 1; i < rawLines.length; i++) {
                      const line = rawLines[i];
                      if (targetGenesRegex.test(line)) {
                        filteredLines.push(line);
                      }
                      if (filteredLines.length >= 100) {
                        break; // Clamp to maximum 100 relevant gene lines to keep payload small
                      }
                    }
                    fileSnippet = filteredLines.join('\n');
                  }
                }
              }
            } catch (err) {
              console.warn('Failed to fetch supplementary file snippet:', err);
            }
          }
          
          const output = { fileName, fileSnippet };
          await setCache(cacheKey, 'snippet', output);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...output, cacheStatus: 'miss' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ fileName, fileSnippet, cacheStatus: 'miss' }));
      } catch (err) {
        console.error('Error in analyze-dataset/snippet:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (url.pathname === '/api/analyze-dataset/gemini' && req.method === 'POST') {
      try {
        const body = await getPostBody(req);
        const accession = body.accession || '';
        const title = body.title || '';
        const summary = body.summary || '';
        const overallDesign = body.overallDesign || '';
        const fileName = body.fileName || '';
        const fileSnippet = body.fileSnippet || '';

        const cacheKey = `gemini:${accession}`;
        const cached = await getCache(cacheKey);
        if (cached) {
          const cachedVal = cached.cache_value || {};
          const cachedResponseData = cachedVal.responseData || cachedVal;
          const cachedOverallDesign = cachedVal.overallDesign;
          const cachedFileSnippet = cachedVal.fileSnippet;

          if (!isCacheExpired(cached)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ...cachedResponseData, cacheStatus: 'hit' }));
            return;
          } else if (cachedOverallDesign === overallDesign && cachedFileSnippet === fileSnippet) {
            // Reuse cached response and refresh updated_at
            await setCache(cacheKey, 'gemini', cachedVal);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ...cachedResponseData, cacheStatus: 'hit' }));
            return;
          }
        }

        // Request Gemini API for structured mapping
        const googleApiKey = env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY;
        if (!googleApiKey) {
          throw new Error('GOOGLE_API_KEY is not defined in the environment (.env)');
        }

        const promptText = `You are a bioinformatics assistant. Your job is to analyze the E. coli Gene Expression Omnibus (GEO) dataset metadata and its supplementary data snippet, and map the metabolic conditions described in it to the parameters of our E. coli core metabolic map/simulation.

Here is the dataset metadata:
Accession: ${accession}
Title: ${title}
Summary (from GEO): ${summary}
Overall Design: ${overallDesign || 'N/A'}

${fileSnippet ? `Here is a filtered snippet of the supplementary data file (${fileName}) containing expression counts for central metabolic genes:\n${fileSnippet}` : 'No supplementary data files were available or readable.'}

Identify:
1. Whether this dataset contains information that can be mapped to E. coli central metabolism. Set "canMap" to true if yes, false if no.
2. Under "states", identify up to 3 major metabolic states (conditions) compared in this study.
   For each state, you MUST populate both the "metabolites" and "reactions" parameter adjustment objects. DO NOT leave them empty.

   For each state, provide:
   - "name": A short name (e.g. "WT - Glucose", "pgi Knockout", "Anaerobic growth").
   - "description": A brief biological explanation (1-2 sentences) of what occurs in this metabolic condition.
   - "focusMetaboliteIds": An array of E. coli core metabolite BiGG IDs that are critical to this condition, which we should highlight and focus on the map. Choose from:
     glc__D_c, g6p_c, f6p_c, fdp_c, dhap_c, g3p_c, 3pg_c, 2pg_c, pep_c, pyr_c, accoa_c, oaa_c, cit_c, icit_c, akg_c, succoa_c, succ_c, fum_c, mal__L_c, pyr_e, ac_c, ac_e, etoh_c, etoh_e, lac__D_c, lac__D_e
   - "data": An object mapping metabolic data to simulation variables. It MUST contain BOTH "metabolites" and "reactions" keys populated with actual values (do not leave them as empty objects {}):
     - "metabolites": A key-value map of metabolite BiGG IDs to their estimated/measured concentrations in mM (must be numbers between 0.1 and 25.0 mM). You must adjust at least 3-6 metabolites from their standard physiological baselines to reflect accumulation or depletion in this state:
       Baselines: glc__D_c: 2.0, g6p_c: 1.0, f6p_c: 0.8, fdp_c: 0.5, dhap_c: 0.4, g3p_c: 0.3, pep_c: 0.8, pyr_c: 1.5, accoa_c: 0.5, oaa_c: 0.2, cit_c: 1.2, akg_c: 1.0, succ_c: 0.8, mal__L_c: 0.8, ac_c: 1.0, lac__D_c: 0.5
       If extracellular concentrations are affected, adjust: glc__D_e (baseline 10.0), ac_e (baseline 0.2), lac__D_e (baseline 0.1), pyr_e (baseline 0.1).
     - "reactions": A key-value map of reaction IDs to a single number representing its adjusted vMax (must be between 0.0 and 40.0). DO NOT use nested objects; just output a single number representing the vMax. Reaction IDs must be from:
       GLCpts, PGI, PFK, FBA, TPI, GAPD, PGK, PGM, ENO, PYK, LDH_D, PFL, ALCD2x, ACALD, PTAr, ACKr, PDH, CS, ACONTa, ACONTb, ICDHyr, AKGDH, SUCOAS, SUCDi, FUM, MDH, PPC, ICL, MALS
       Value: The number must be between 0.0 and 40.0.

   MAPPING RULES (CRITICAL):
   - If a gene knockout, deletion, mutant, or null allele is mentioned, set vMax to 0.0 for its corresponding reaction(s):
     * pgi -> PGI
     * pfkA, pfkB -> PFK
     * fbaA -> FBA
     * tpiA -> TPI
     * gapA -> GAPD
     * pgk -> PGK
     * gpmA, gpmM -> PGM
     * eno -> ENO
     * pykA, pykF -> PYK
     * ldhA -> LDH_D
     * pflB -> PFL
     * adhE -> ALCD2x, ACALD
     * pta -> PTAr
     * ackA -> ACKr
     * aceE, aceF, lpd -> PDH
     * gltA -> CS
     * acnA, acnB -> ACONTa, ACONTb
     * icd -> ICDHyr
     * sucA, sucB -> AKGDH
     * sucC, sucD -> SUCOAS
     * sdhA, sdhB, sdhC, sdhD -> SUCDi
     * fumA, fumB, fumC -> FUM
     * mdh -> MDH
     * ppc -> PPC
     * aceA -> ICL
     * aceB -> MALS
     * ptsG, ptsI, ptsH, crr -> GLCpts
   - For anaerobic growth, downregulate respiration/TCA (reduce vMax of SUCDi, AKGDH, PDH to 1.0-3.0) and upregulate fermentation (increase vMax of LDH_D, PFL, ACKr to 15.0-30.0, increase concentrations of ac_c, ac_e, lac__D_c, lac__D_e).
   - For acetate overflow, increase GLCpts vMax (to 30.0) and decrease/saturate citric acid cycle (CS vMax to 5.0), and increase acetate excretion (ACKr and PTAr vMax to 25.0, ac_e concentration to 5.0+).
   - If glucose is limited or starved, set glc__D_e to 0.1 and glc__D_c to 0.1, and reduce GLCpts vMax. If another carbon source is used (e.g. acetate or lactate), increase its extracellular concentration (e.g., set ac_e or lac__D_e to 15.0).
   - IMPORTANT: DO NOT output floating point numbers with excessive decimal precision. Standard integers or simple decimals are required (e.g. 2, 2.5, 15).

Ensure your response is valid JSON matching the schema requested. The metabolites and reactions objects under data MUST NOT be empty.`;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${googleApiKey}`;
        const geminiResponse = await fetch(geminiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: promptText }
                ]
              }
            ],
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: 'OBJECT',
                properties: {
                  canMap: { type: 'BOOLEAN' },
                  states: {
                    type: 'ARRAY',
                    items: {
                      type: 'OBJECT',
                      properties: {
                        name: { type: 'STRING' },
                        description: { type: 'STRING' },
                        focusMetaboliteIds: {
                          type: 'ARRAY',
                          items: { type: 'STRING' }
                        },
                        data: {
                          type: 'OBJECT',
                          properties: {
                            metabolites: {
                              type: 'OBJECT',
                              properties: {
                                glc__D_c: { type: 'NUMBER' },
                                g6p_c: { type: 'NUMBER' },
                                f6p_c: { type: 'NUMBER' },
                                fdp_c: { type: 'NUMBER' },
                                dhap_c: { type: 'NUMBER' },
                                g3p_c: { type: 'NUMBER' },
                                '3pg_c': { type: 'NUMBER' },
                                '2pg_c': { type: 'NUMBER' },
                                pep_c: { type: 'NUMBER' },
                                pyr_c: { type: 'NUMBER' },
                                accoa_c: { type: 'NUMBER' },
                                oaa_c: { type: 'NUMBER' },
                                cit_c: { type: 'NUMBER' },
                                icit_c: { type: 'NUMBER' },
                                akg_c: { type: 'NUMBER' },
                                succoa_c: { type: 'NUMBER' },
                                succ_c: { type: 'NUMBER' },
                                fum_c: { type: 'NUMBER' },
                                mal__L_c: { type: 'NUMBER' },
                                pyr_e: { type: 'NUMBER' },
                                ac_c: { type: 'NUMBER' },
                                ac_e: { type: 'NUMBER' },
                                etoh_c: { type: 'NUMBER' },
                                etoh_e: { type: 'NUMBER' },
                                lac__D_c: { type: 'NUMBER' },
                                lac__D_e: { type: 'NUMBER' },
                                glc__D_e: { type: 'NUMBER' }
                              }
                            },
                            reactions: {
                              type: 'OBJECT',
                              properties: {
                                GLCpts: { type: 'NUMBER' },
                                PGI: { type: 'NUMBER' },
                                PFK: { type: 'NUMBER' },
                                FBA: { type: 'NUMBER' },
                                TPI: { type: 'NUMBER' },
                                GAPD: { type: 'NUMBER' },
                                PGK: { type: 'NUMBER' },
                                PGM: { type: 'NUMBER' },
                                ENO: { type: 'NUMBER' },
                                PYK: { type: 'NUMBER' },
                                LDH_D: { type: 'NUMBER' },
                                PFL: { type: 'NUMBER' },
                                ALCD2x: { type: 'NUMBER' },
                                ACALD: { type: 'NUMBER' },
                                PTAr: { type: 'NUMBER' },
                                ACKr: { type: 'NUMBER' },
                                PDH: { type: 'NUMBER' },
                                CS: { type: 'NUMBER' },
                                ACONTa: { type: 'NUMBER' },
                                ACONTb: { type: 'NUMBER' },
                                ICDHyr: { type: 'NUMBER' },
                                AKGDH: { type: 'NUMBER' },
                                SUCOAS: { type: 'NUMBER' },
                                SUCDi: { type: 'NUMBER' },
                                FUM: { type: 'NUMBER' },
                                MDH: { type: 'NUMBER' },
                                PPC: { type: 'NUMBER' },
                                ICL: { type: 'NUMBER' },
                                MALS: { type: 'NUMBER' }
                              }
                            }
                          },
                          required: ['metabolites', 'reactions']
                        }
                      },
                      required: ['name', 'description', 'focusMetaboliteIds', 'data']
                    }
                  }
                },
                required: ['canMap', 'states']
              }
            }
          })
        });

        if (!geminiResponse.ok) {
          const errorText = await geminiResponse.text();
          throw new Error(`Gemini API returned status ${geminiResponse.status}: ${errorText}`);
        }

        const geminiJson = await geminiResponse.json();
        const geminiOutputText = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        
        let responseData = {};
        try {
          responseData = JSON.parse(geminiOutputText);
        } catch (e) {
          responseData = { canMap: false, states: [] };
        }

        // Add usage metadata
        responseData.usage = {
          sentCharacters: promptText.length,
          receivedCharacters: geminiOutputText.length,
          promptTokens: geminiJson.usageMetadata?.promptTokenCount || 0,
          completionTokens: geminiJson.usageMetadata?.candidatesTokenCount || 0,
          totalTokens: geminiJson.usageMetadata?.totalTokenCount || 0
        };
        
        // Store to cache
        await setCache(cacheKey, 'gemini', {
          responseData,
          overallDesign,
          fileSnippet
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...responseData, cacheStatus: 'miss' }));
      } catch (err) {
        console.error('Error in analyze-dataset/gemini:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (url.pathname === '/api/get-bounds' && req.method === 'POST') {
      try {
        const body = await getPostBody(req);
        const concentrations = body.concentrations || {};
        const parameters = body.parameters || {};

        const bounds = calculateBounds(concentrations, parameters);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ bounds }));
      } catch (err) {
        console.error('Error in get-bounds API:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      next();
    }
  };

  return {
    build: {
      chunkSizeWarningLimit: 1000
    },
    preview: {
      port: parseInt(process.env.PORT || '8080', 10),
      host: '0.0.0.0',
      allowedHosts: true
    },
    plugins: [
      {
        name: 'ncbi-api-middleware',
        configureServer(server) {
          server.middlewares.use(handleSearch);
        },
        configurePreviewServer(server) {
          server.middlewares.use(handleSearch);
        }
      }
    ]
  };
});
