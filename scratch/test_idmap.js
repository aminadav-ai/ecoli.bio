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

renderer.reactions.forEach(r => {
  const lowerBigg = r.biggId ? r.biggId.toLowerCase() : '';
  const lowerId = r.id ? r.id.toLowerCase() : '';
  if (r.biggId) idMap.set(lowerBigg, { type: 'reaction', id: r.id, rxn: r });
  if (r.id) idMap.set(lowerId, { type: 'reaction', id: r.id, rxn: r });
  
  if (lowerBigg.endsWith('pp') && lowerBigg.length > 2) {
    const base = lowerBigg.slice(0, -2);
    if (!idMap.has(base)) idMap.set(base, { type: 'reaction', id: r.id, rxn: r });
  }
  if (lowerBigg.endsWith('tex') && lowerBigg.length > 3) {
    const base = lowerBigg.slice(0, -3);
    if (!idMap.has(base)) idMap.set(base, { type: 'reaction', id: r.id, rxn: r });
  }
  if (lowerBigg.endsWith('abcpp') && lowerBigg.length > 5) {
    const base = lowerBigg.slice(0, -5);
    if (!idMap.has(base)) idMap.set(base, { type: 'reaction', id: r.id, rxn: r });
  }
  if (lowerBigg.endsWith('tpp') && lowerBigg.length > 3) {
    const base = lowerBigg.slice(0, -3);
    if (!idMap.has(base)) idMap.set(base, { type: 'reaction', id: r.id, rxn: r });
  }

  if (lowerBigg === 'cytbo3_4pp' || lowerId === 'cytbo3_4pp') {
    idMap.set('cytbo3', { type: 'reaction', id: r.id, rxn: r });
    idMap.set('cytbo3_4', { type: 'reaction', id: r.id, rxn: r });
  }
  if (lowerBigg === 'biomass_ecoli_core_w_gam' || lowerId === 'biomass_ecoli_core_w_gam') {
    idMap.set('biomass', { type: 'reaction', id: r.id, rxn: r });
    idMap.set('biomass_flux', { type: 'reaction', id: r.id, rxn: r });
  }
  if (lowerBigg === 'glcptspp' || lowerId === 'glcptspp') {
    idMap.set('glc_pts', { type: 'reaction', id: r.id, rxn: r });
    idMap.set('glcpts', { type: 'reaction', id: r.id, rxn: r });
  }
  if (lowerBigg === 'atps4rpp' || lowerId === 'atps4rpp') {
    idMap.set('atps4r', { type: 'reaction', id: r.id, rxn: r });
    idMap.set('atps', { type: 'reaction', id: r.id, rxn: r });
  }
});

console.log('=== All idMap keys matching/containing "ace" or "ac" ===');
for (const key of Array.from(idMap.keys()).sort()) {
  if (key.includes('ac') || key.includes('ace')) {
    console.log(`Key: "${key}" -> type: ${idMap.get(key).type}, biggId: ${idMap.get(key).node ? idMap.get(key).node.biggId : idMap.get(key).rxn.biggId}`);
  }
}
