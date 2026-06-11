import fs from 'fs';
const mapData = JSON.parse(fs.readFileSync('public/iJO1366.Central metabolism.json', 'utf8'));
const nodes = mapData[1].nodes;

for (const [id, n] of Object.entries(nodes)) {
  if (n.node_type === 'metabolite' && n.bigg_id.toLowerCase().includes('etoh')) {
    console.log(`Node: ${n.bigg_id}`);
  }
}
