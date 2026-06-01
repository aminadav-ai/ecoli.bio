import { defineConfig, loadEnv } from 'vite';
import { XMLParser } from 'fast-xml-parser';

export default defineConfig(({ mode }) => {
  // Load env variables from .env files
  const env = loadEnv(mode, process.cwd(), '');

  const handleSearch = async (req, res, next) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/geo-search') {
      try {
        const userQuery = url.searchParams.get('query') || '';
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        
        // Clean query: remove double quotes to preserve syntax
        const sanitizedQuery = userQuery.replace(/"/g, '');
        
        const organism = '("Escherichia coli"[Organism])';
        const metabolicKeywords = '("central metabolism" OR "glycolysis" OR "TCA cycle" OR "phosphotransferase system")';
        const dataTypes = '("counts"[All Fields] OR "TPM"[All Fields])';
        
        const finalQuery = `("${sanitizedQuery}"[All Fields] AND ${organism} AND ${metabolicKeywords} AND ${dataTypes})`;
        
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
