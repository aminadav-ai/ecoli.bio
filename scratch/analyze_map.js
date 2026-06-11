import fs from 'fs';
const mapData = JSON.parse(fs.readFileSync('public/iJO1366.Central metabolism.json', 'utf8'));
const mapReactions = mapData[1].reactions;

console.log('=== Reactions in Map ===');
const reactions = [];
for (const [id, r] of Object.entries(mapReactions)) {
  reactions.push({ id: id, bigg_id: r.bigg_id, name: r.name });
}

// Print some examples
console.log(JSON.stringify(reactions.slice(0, 30), null, 2));

// Find reactions where the ID in the map or bigg_id ends with pp, t, abcpp, etc.
console.log('\n=== Reactions ending with compartment/transport suffixes ===');
reactions.forEach(r => {
  const bigg = r.bigg_id;
  if (bigg) {
    if (bigg.endsWith('pp') || bigg.endsWith('tex') || bigg.endsWith('abcpp') || bigg.endsWith('t2r') || bigg.endsWith('t3pp') || bigg.endsWith('t2rpp')) {
      console.log(`bigg_id: ${bigg} | name: ${r.name}`);
    }
  }
});
