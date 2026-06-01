import { defineConfig, loadEnv } from 'vite';
import { XMLParser } from 'fast-xml-parser';
import zlib from 'zlib';

export default defineConfig(({ mode }) => {
  // Load env variables from .env files
  const env = loadEnv(mode, process.cwd(), '');

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
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalCount, results }));
      } catch (err) {
        console.error('Error in geo-search API:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (url.pathname === '/api/analyze-dataset' && req.method === 'POST') {
      try {
        const body = await getPostBody(req);
        const accession = body.accession || '';
        const title = body.title || '';
        const summary = body.summary || '';

        if (!accession) {
          throw new Error('Accession ID is required');
        }

        // 1. Fetch quick text summary from NCBI to find supplementary files and design
        let overallDesign = '';
        let supplementaryUrls = [];
        try {
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
          }
        } catch (e) {
          console.warn('Failed to fetch GSE text summary:', e);
        }

        // 2. Fetch and decompress the first supplementary file snippet
        let fileSnippet = '';
        let fileName = '';
        if (supplementaryUrls.length > 0) {
          const firstUrl = supplementaryUrls[0];
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
                  fileSnippet = textContent.split('\n').slice(0, 500).join('\n');
                }
              }
            } catch (err) {
              console.warn('Failed to fetch supplementary file snippet:', err);
            }
          }
        }

        // 3. Request Gemini API for structured mapping
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

${fileSnippet ? `Here is a snippet of the first 500 lines of the supplementary data file (${fileName}):\n${fileSnippet}` : 'No supplementary data files were available or readable.'}

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
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(geminiOutputText);
      } catch (err) {
        console.error('Error in analyze-dataset API:', err);
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
