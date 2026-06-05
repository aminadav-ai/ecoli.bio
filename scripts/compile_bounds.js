import fs from 'fs';
import path from 'path';

// Read original model
const modelPath = path.resolve('public/iJO1366.json');
const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));

// 1. Build static LP header
const lines = [];
lines.push('Maximize');
const objTerms = [];
for (const rxn of model.reactions) {
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
for (const rxn of model.reactions) {
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

for (const met of model.metabolites) {
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

// Ensure output directories exist
const headerPath = path.resolve('public/static_lp_header.txt');
fs.writeFileSync(headerPath, lines.join('\n') + '\n', 'utf8');
console.log(`[Compile] Wrote static LP header to ${headerPath}`);

// 2. Extract static default bounds for all reactions
const staticBounds = {};
for (const rxn of model.reactions) {
  staticBounds[rxn.id] = {
    lb: rxn.lower_bound,
    ub: rxn.upper_bound
  };
}

// Save static bounds
const boundsPath = path.resolve('src/static_bounds.json');
fs.writeFileSync(boundsPath, JSON.stringify(staticBounds, null, 2), 'utf8');
console.log(`[Compile] Wrote static bounds for ${model.reactions.length} reactions to ${boundsPath}`);
