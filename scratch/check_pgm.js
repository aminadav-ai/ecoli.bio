import fs from 'fs';
const data = JSON.parse(fs.readFileSync('/home/aminadav/Projects/e-coli3/public/iJO1366.Central metabolism.json', 'utf8'));
const mapData = data[1];
const pgmRxns = [];
for (const [id, rxn] of Object.entries(mapData.reactions)) {
  if (rxn.bigg_id.includes('PGM') || rxn.name.includes('Phosphoglycerate') || rxn.name.includes('phosphoglycerate')) {
    pgmRxns.push({ id, ...rxn });
  }
}
console.log(JSON.stringify(pgmRxns, null, 2));
