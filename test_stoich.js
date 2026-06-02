import fs from 'fs';
import { Simulation } from './src/simulation.js';

const escherMapData = JSON.parse(fs.readFileSync('./public/escher_core.json', 'utf8'));
const sim = new Simulation(escherMapData);

console.log("SUCOAS stoichiometry:");
console.log(sim.reactions['SUCOAS'].stoichiometry);
console.log("Reversibility:", sim.reactions['SUCOAS'].reversibility);

console.log("\nAKGDH stoichiometry:");
console.log(sim.reactions['AKGDH'].stoichiometry);

console.log("\nSUCCt3 stoichiometry:");
console.log(sim.reactions['SUCCt3'].stoichiometry);
