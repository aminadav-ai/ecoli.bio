import fs from 'fs';
import path from 'path';

const mapData = JSON.parse(fs.readFileSync('public/iJO1366.Central metabolism.json', 'utf8'));
const map = mapData[1]; // Escher map is usually [ { ...metadata }, { reactions, nodes, text_labels } ]

console.log("--- REACTIONS ---");
for (const [id, rxn] of Object.entries(map.reactions)) {
  if (['GLCptspp', 'PGM', 'PFL', 'PDH', 'MDH', 'PYK', 'PPS', 'ENO'].includes(rxn.bigg_id)) {
    console.log(`${rxn.bigg_id}: x=${rxn.label_x}, y=${rxn.label_y}`);
  }
}

console.log("\n--- METABOLITES ---");
for (const [id, node] of Object.entries(map.nodes)) {
  if (node.node_type === 'metabolite' && ['pep_c', 'pyr_c'].includes(node.bigg_id)) {
    console.log(`${node.bigg_id}: x=${node.x}, y=${node.y}`);
  }
}
