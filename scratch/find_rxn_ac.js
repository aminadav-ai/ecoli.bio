import fs from 'fs';
const mapData = JSON.parse(fs.readFileSync('public/iJO1366.Central metabolism.json', 'utf8'));
const reactions = mapData[1].reactions;

console.log('=== Reactions containing "ac" or "ace" ===');
for (const [id, r] of Object.entries(reactions)) {
  const bigg = r.bigg_id ? r.bigg_id.toLowerCase() : '';
  if (bigg.includes('ac') || bigg.includes('ace')) {
    console.log(`id: ${id} | bigg_id: ${r.bigg_id} | name: ${r.name}`);
  }
}
