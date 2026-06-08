import fs from 'fs';

async function run() {
  const file = 'public/iJO1366.Central metabolism.json';
  if (!fs.existsSync(file)) {
    console.error('File does not exist:', file);
    return;
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  // The structure of Escher map is usually [ { map: ..., reactions: ... } ] or similar
  const mapData = Array.isArray(data) ? data[1] : data;
  if (!mapData || !mapData.reactions) {
    console.error('No reactions found in map data structure. Keys:', Object.keys(data));
    if (data[0]) {
      console.log('First element keys:', Object.keys(data[0]));
    }
    return;
  }
  const reactions = Object.values(mapData.reactions).map(r => r.bigg_id);
  console.log('Total reactions on map:', reactions.length);
  console.log('Reaction IDs starting with F:', reactions.filter(id => id.toUpperCase().startsWith('F')));
  console.log('Reaction IDs containing FBA:', reactions.filter(id => id.toUpperCase().includes('FBA')));
}

run();
