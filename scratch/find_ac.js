import fs from 'fs';
const mapData = JSON.parse(fs.readFileSync('public/iJO1366.Central metabolism.json', 'utf8'));
const nodes = mapData[1].nodes;

console.log('=== Nodes containing "ac" or similar ===');
for (const [id, n] of Object.entries(nodes)) {
  if (n.node_type === 'metabolite') {
    const bigg = n.bigg_id.toLowerCase();
    if (bigg.includes('ac') || bigg.includes('ace')) {
      console.log(`id: ${id} | bigg_id: ${n.bigg_id} | name: ${n.name}`);
    }
  }
}
