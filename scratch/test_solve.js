import fs from 'fs';
import highsLoader from 'highs';

async function test() {
  console.log('Loading HiGHS WASM...');
  const highs = await highsLoader();
  console.log('HiGHS loaded.');

  const modelData = JSON.parse(fs.readFileSync('./public/iJO1366.json', 'utf8'));
  const mapData = JSON.parse(fs.readFileSync('./public/iJO1366.Central metabolism.json', 'utf8'));

  const bufferedIds = new Set([
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

  const initialConcentrations = {
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

  const metabolites = {};
  const reactions = {};
  const reactionMapping = {
    'PPKr': 'PPK',
    'PPK2r': 'PPK2',
  };

  // Initialize
  const mapReactions = mapData[1].reactions;
  const mapNodes = mapData[1].nodes;

  for (const node of Object.values(mapNodes)) {
    if (node.node_type === 'metabolite') {
      const mId = node.bigg_id;
      if (!metabolites[mId]) {
        metabolites[mId] = {
          id: mId,
          name: node.name,
          concentration: initialConcentrations[mId] !== undefined ? initialConcentrations[mId] : 1.0,
          isBuffered: bufferedIds.has(mId)
        };
      }
    }
  }

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
      if (coeff < 0) substrates.push(mId);
      else products.push(mId);

      if (!metabolites[mId]) {
        metabolites[mId] = {
          id: mId,
          name: mId,
          concentration: initialConcentrations[mId] !== undefined ? initialConcentrations[mId] : 1.0,
          isBuffered: bufferedIds.has(mId)
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

    reactions[biggId] = {
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

  // Build static LP header
  const lines = [];
  lines.push('Maximize');
  const objTerms = [];
  for (const rxn of modelData.reactions) {
    const objCoeff = parseFloat(rxn.objective_coefficient || 0);
    if (objCoeff !== 0) {
      objTerms.push(`${objCoeff} R_${rxn.id}`);
    }
  }
  if (objTerms.length === 0) {
    objTerms.push('1 R_BIOMASS_Ec_iJO1366_core_53p95M');
  }
  lines.push(`  obj: ${objTerms.join(' + ')}`);
  lines.push('Subject To');

  const stoichiometryMap = {};
  for (const rxn of modelData.reactions) {
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

  for (const met of modelData.metabolites) {
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
  const staticLpHeader = lines.join('\n') + '\n';

  // Solve FBA function logic
  const originalBounds = {};
  for (const rxn of modelData.reactions) {
    originalBounds[rxn.id] = [rxn.lower_bound, rxn.upper_bound];
  }

  const bounds = {};
  for (const rxn of modelData.reactions) {
    const orig = originalBounds[rxn.id];
    bounds[rxn.id] = {
      lowerBound: orig[0],
      upperBound: orig[1]
    };
  }

  // Block bypasses
  const defaultBlocked = ['PFK_3', 'FBA3', 'F6PA'];
  for (const bId of defaultBlocked) {
    if (bounds[bId]) {
      bounds[bId] = { lowerBound: 0.0, upperBound: 0.0 };
    }
  }

  const coupledCheckpoints = new Set(['GLCptspp', 'PFK', 'PYK', 'CS', 'ICDHyr', 'SUCDi']);

  for (const [coreRxnId, coreRxn] of Object.entries(reactions)) {
    const modelRxnId = reactionMapping[coreRxnId] || coreRxnId;
    const modelRxn = modelData.reactions.find(r => r.id === modelRxnId);
    if (!modelRxn) continue;

    const vMax = coreRxn.vMax;
    const km = coreRxn.km;
    const orig = originalBounds[modelRxnId];

    const hasExtracellularSubstrate = coreRxn.substrates.some(sId => sId.endsWith('_e'));

    if (coreRxn.reversibility) {
      let ubForward = vMax;
      let ubBackward = vMax;

      if (coupledCheckpoints.has(modelRxnId) || hasExtracellularSubstrate) {
        for (const sId of coreRxn.substrates) {
          if (metabolites[sId] && !metabolites[sId].isBuffered) {
            const conc = metabolites[sId].concentration;
            ubForward = Math.min(ubForward, vMax * (conc / (km + conc)));
          }
        }
        for (const pId of coreRxn.products) {
          if (metabolites[pId] && !metabolites[pId].isBuffered) {
            const conc = metabolites[pId].concentration;
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
          if (metabolites[sId] && !metabolites[sId].isBuffered) {
            const conc = metabolites[sId].concentration;
            ubForward = Math.min(ubForward, vMax * (conc / (km + conc)));
          }
        }
      }

      const lb = 0.0;
      const ub = (orig[1] > 1e-5) ? ubForward : 0.0;

      bounds[modelRxnId] = { lowerBound: lb, upperBound: ub };
    }
  }

  const boundsLines = [];
  for (const rxn of modelData.reactions) {
    const rxnId = rxn.id;
    const b = bounds[rxnId];
    const formatBound = (val, isUpper) => {
      if (val === null || val === undefined) return isUpper ? 'inf' : '-inf';
      if (val === Infinity || val >= 999999) return 'inf';
      if (val === -Infinity || val <= -999999) return '-inf';
      return val.toString();
    };
    const lbStr = formatBound(b.lowerBound, false);
    const ubStr = formatBound(b.upperBound, true);
    boundsLines.push(`  ${lbStr} <= R_${rxnId} <= ${ubStr}`);
  }

  const lpString = staticLpHeader + boundsLines.join('\n') + '\nEnd';

  try {
    const sol = highs.solve(lpString, {
      "log_to_console": false,
      "output_flag": false
    });

    console.log('Solver Status:', sol.Status);
    if (sol.Status === 'Optimal') {
      const columns = sol.Columns;
      console.log('Biomass flux:', columns['R_BIOMASS_Ec_iJO1366_core_53p95M']?.Primal);
      console.log('PFK flux:', columns['R_PFK']?.Primal);
      console.log('GLCptspp flux:', columns['R_GLCptspp']?.Primal);
      console.log('PGI flux:', columns['R_PGI']?.Primal);
      console.log('FBA flux:', columns['R_FBA']?.Primal);
      console.log('Active map fluxes:');
      for (const [rId, r] of Object.entries(reactions)) {
        const modelRxnId = reactionMapping[rId] || rId;
        const val = columns['R_' + modelRxnId]?.Primal || 0.0;
        if (Math.abs(val) > 0.01) {
          console.log(`  ${rId}: ${val}`);
        }
      }
    } else {
      console.log('Solve failed with solution:', sol);
    }
  } catch (err) {
    console.error('Solve error:', err);
  }
}

test();
