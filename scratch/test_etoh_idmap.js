import fs from 'fs';
const mapData = JSON.parse(fs.readFileSync('public/iJO1366.Central metabolism.json', 'utf8'));

const renderer = {
  metabNodes: Object.entries(mapData[1].nodes)
    .filter(([id, n]) => n.node_type === 'metabolite')
    .map(([id, n]) => ({ ...n, id, biggId: n.bigg_id })),
  reactions: Object.entries(mapData[1].reactions)
    .map(([id, r]) => ({ ...r, id, biggId: r.bigg_id }))
};

const idMap = new Map();

renderer.metabNodes.forEach(n => {
  const lowerBigg = n.biggId ? n.biggId.toLowerCase() : '';
  const lowerId = n.id ? n.id.toLowerCase() : '';
  if (n.biggId) idMap.set(lowerBigg, { type: 'metabolite', id: n.id, node: n });
  if (n.id) idMap.set(lowerId, { type: 'metabolite', id: n.id, node: n });

  if (lowerBigg.endsWith('_c') || lowerBigg.endsWith('_e') || lowerBigg.endsWith('_p')) {
    const stripped = lowerBigg.slice(0, -2);
    if (stripped.length >= 2) {
      if (lowerBigg.endsWith('_c') || !idMap.has(stripped)) {
        idMap.set(stripped, { type: 'metabolite', id: n.id, node: n });
      }
    }
  }

  if (lowerBigg === 'glc__d_c' || lowerBigg === 'glc__d_e') {
    idMap.set('glc', { type: 'metabolite', id: n.id, node: n });
    idMap.set('glucose', { type: 'metabolite', id: n.id, node: n });
  }
});

console.log('Has etoh_e?', idMap.has('etoh_e'));
console.log('Has etoh?', idMap.has('etoh'));
