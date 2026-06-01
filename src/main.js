/**
 * src/main.js
 * 
 * Application controller for e-coli3.
 * Manages UI interactions, charts, focus controls, and bridges the simulation
 * engine with the PixiJS visual renderer.
 */

import { Simulation } from './simulation.js';
import { PixiRenderer } from './renderer.js';

// Database cross-reference IDs mapped to BiGG IDs
const NAMESPACE_DATABASE = {
  // Glycolysis / Gluconeogenesis & Pentose Phosphate Pathway intermediates
  GLC_EXT: { name: 'D-Glucose (extracellular)', ecocyc: 'D-GLUCOSE', bigg: 'glc__D_e', kegg: 'C00267', chebi: '17634', hmdb: 'HMDB0000122' },
  GLC_INT: { name: 'D-Glucose (intracellular)', ecocyc: 'D-GLUCOSE', bigg: 'glc__D_c', kegg: 'C00267', chebi: '17634', hmdb: 'HMDB0000122' },
  G6P: { name: 'Glucose 6-phosphate', ecocyc: 'GLUCOSE-6-P', bigg: 'g6p_c', kegg: 'C00092', chebi: '14314', hmdb: 'HMDB0001401' },
  F6P: { name: 'Fructose 6-phosphate', ecocyc: 'FRUCTOSE-6P', bigg: 'f6p_c', kegg: 'C00085', chebi: '20979', hmdb: 'HMDB0000124' },
  FDP: { name: 'Fructose 1,6-bisphosphate', ecocyc: 'FRUCTOSE-16-DIPHOSPHATE', bigg: 'fdp_c', kegg: 'C00354', chebi: '16905', hmdb: 'HMDB0001058' },
  DHAP: { name: 'Dihydroxyacetone phosphate', ecocyc: 'DIHYDROXY-ACETONE-PHOSPHATE', bigg: 'dhap_c', kegg: 'C00111', chebi: '16108', hmdb: 'HMDB0001473' },
  GAP: { name: 'Glyceraldehyde 3-phosphate', ecocyc: 'GAP', bigg: 'g3p_c', kegg: 'C00118', chebi: '17138', hmdb: 'HMDB0001112' },
  BPG: { name: '1,3-Bisphosphoglycerate', ecocyc: '1-3-DIPHOSPHOGLYCERATE', bigg: '13dpg_c', kegg: 'C00236', chebi: '16001', hmdb: 'HMDB0001430' },
  PEP: { name: 'Phosphoenolpyruvate', ecocyc: 'PHOSPHO-ENOL-PYRUVATE', bigg: 'pep_c', kegg: 'C00074', chebi: '18021', hmdb: 'HMDB0000263' },
  PYRU: { name: 'Pyruvate', ecocyc: 'PYRUVATE', bigg: 'pyr_c', kegg: 'C00022', chebi: '15361', hmdb: 'HMDB0000243' },
  PYRU_EXT: { name: 'Pyruvate (extracellular)', ecocyc: 'PYRUVATE', bigg: 'pyr_e', kegg: 'C00022', chebi: '15361', hmdb: 'HMDB0000243' },
  '3PG': { name: '3-Phospho-D-glycerate', ecocyc: '3-P-GLYCERATE', bigg: '3pg_c', kegg: 'C00197', chebi: '17794', hmdb: 'HMDB0000807' },
  '2PG': { name: '2-Phospho-D-glycerate', ecocyc: '2-PG', bigg: '2pg_c', kegg: 'C00631', chebi: '17835', hmdb: 'HMDB0000007' },
  
  // TCA Cycle & Glyoxylate Bypass intermediates
  ACCOA: { name: 'Acetyl-CoA', ecocyc: 'ACETYL-COA', bigg: 'accoa_c', kegg: 'C00024', chebi: '15379', hmdb: 'HMDB0001206' },
  OXALO: { name: 'Oxaloacetate', ecocyc: 'OXALOACETATE', bigg: 'oaa_c', kegg: 'C00036', chebi: '16452', hmdb: 'HMDB0000223' },
  CITRATE: { name: 'Citrate', ecocyc: 'CITRATE', bigg: 'cit_c', kegg: 'C00158', chebi: '16947', hmdb: 'HMDB0000094' },
  ISOCIT: { name: 'Isocitrate', ecocyc: 'ISOCITRATE', bigg: 'icit_c', kegg: 'C00311', chebi: '16088', hmdb: 'HMDB0000193' },
  AKG: { name: 'Alpha-ketoglutarate', ecocyc: '2-KETOGLUTARATE', bigg: 'akg_c', kegg: 'C00026', chebi: '16810', hmdb: 'HMDB0000208' },
  AKG_EXT: { name: 'Alpha-ketoglutarate (extracellular)', ecocyc: '2-KETOGLUTARATE', bigg: 'akg_e', kegg: 'C00026', chebi: '16810', hmdb: 'HMDB0000208' },
  SUCCOA: { name: 'Succinyl-CoA', ecocyc: 'SUCCINYL-COA', bigg: 'succoa_c', kegg: 'C00091', chebi: '15380', hmdb: 'HMDB0001150' },
  SUCC: { name: 'Succinate', ecocyc: 'SUCCINATE', bigg: 'succ_c', kegg: 'C00042', chebi: '15741', hmdb: 'HMDB0000254' },
  SUCC_EXT: { name: 'Succinate (extracellular)', ecocyc: 'SUCCINATE', bigg: 'succ_e', kegg: 'C00042', chebi: '15741', hmdb: 'HMDB0000254' },
  FUMAR: { name: 'Fumarate', ecocyc: 'FUMARATE', bigg: 'fum_c', kegg: 'C00122', chebi: '18012', hmdb: 'HMDB0000134' },
  FUMAR_EXT: { name: 'Fumarate (extracellular)', ecocyc: 'FUMARATE', bigg: 'fum_e', kegg: 'C00122', chebi: '18012', hmdb: 'HMDB0000134' },
  MALATE: { name: 'L-Malate', ecocyc: 'MALATE', bigg: 'mal__L_c', kegg: 'C00149', chebi: '15589', hmdb: 'HMDB0000156' },
  MALATE_EXT: { name: 'L-Malate (extracellular)', ecocyc: 'MALATE', bigg: 'mal__L_e', kegg: 'C00149', chebi: '15589', hmdb: 'HMDB0000156' },
  GLX: { name: 'Glyoxylate', ecocyc: 'GLYOXYLATE', bigg: 'glx_c', kegg: 'C00048', chebi: '16842', hmdb: 'HMDB0000119' },
  ACON_C: { name: 'cis-Aconitate', ecocyc: 'CIS-ACONITATE', bigg: 'acon_C_c', kegg: 'C00417', chebi: '16405', hmdb: 'HMDB0000072' },

  // Pentose Phosphate Pathway (PPP)
  '6PGL': { name: '6-Phosphoglucono-d-lactone', ecocyc: 'D-GLUCONO-15-LACTONE-6-P', bigg: '6pgl_c', kegg: 'C01236', chebi: '16075', hmdb: 'HMDB0001149' },
  '6PGC': { name: '6-Phosphogluconate', ecocyc: 'D-GLUCONATE-6-P', bigg: '6pgc_c', kegg: 'C00345', chebi: '17960', hmdb: 'HMDB0001314' },
  RL5P: { name: 'Ribulose 5-phosphate', ecocyc: 'RIBULOSE-5P', bigg: 'ru5p__D_c', kegg: 'C00199', chebi: '16712', hmdb: 'HMDB0001188' },
  R5P: { name: 'Ribose 5-phosphate', ecocyc: 'RIBOSE-5P', bigg: 'r5p_c', kegg: 'C00117', chebi: '17797', hmdb: 'HMDB0000283' },
  X5P: { name: 'Xylulose 5-phosphate', ecocyc: 'D-XYLULOSE-5-P', bigg: 'xu5p__D_c', kegg: 'C00231', chebi: '16332', hmdb: 'HMDB0001287' },
  S7P: { name: 'Sedoheptulose 7-phosphate', ecocyc: 'SEDOHEPTULOSE-7P', bigg: 's7p_c', kegg: 'C05382', chebi: '15714', hmdb: 'HMDB0001072' },
  E4P: { name: 'Erythrose 4-phosphate', ecocyc: 'ERYTHROSE-4P', bigg: 'e4p_c', kegg: 'C00279', chebi: '16897', hmdb: 'HMDB0001479' },

  // Fermentation & Transport metabolites
  AC: { name: 'Acetate', ecocyc: 'ACETATE', bigg: 'ac_c', kegg: 'C00033', chebi: '30089', hmdb: 'HMDB0000042' },
  AC_EXT: { name: 'Acetate (extracellular)', ecocyc: 'ACETATE', bigg: 'ac_e', kegg: 'C00033', chebi: '30089', hmdb: 'HMDB0000042' },
  ACALD: { name: 'Acetaldehyde', ecocyc: 'ACETALDEHYDE', bigg: 'acald_c', kegg: 'C00084', chebi: '15343', hmdb: 'HMDB0000087' },
  ACALD_EXT: { name: 'Acetaldehyde (extracellular)', ecocyc: 'ACETALDEHYDE', bigg: 'acald_e', kegg: 'C00084', chebi: '15343', hmdb: 'HMDB0000087' },
  ACTP: { name: 'Acetyl phosphate', ecocyc: 'ACETYL-P', bigg: 'actp_c', kegg: 'C00227', chebi: '15370', hmdb: 'HMDB0001487' },
  ETOH: { name: 'Ethanol', ecocyc: 'ETHANOL', bigg: 'etoh_c', kegg: 'C00469', chebi: '16236', hmdb: 'HMDB0000108' },
  ETOH_EXT: { name: 'Ethanol (extracellular)', ecocyc: 'ETHANOL', bigg: 'etoh_e', kegg: 'C00469', chebi: '16236', hmdb: 'HMDB0000108' },
  FOR: { name: 'Formate', ecocyc: 'FORMATE', bigg: 'for_c', kegg: 'C00058', chebi: '15740', hmdb: 'HMDB0000135' },
  FOR_EXT: { name: 'Formate (extracellular)', ecocyc: 'FORMATE', bigg: 'for_e', kegg: 'C00058', chebi: '15740', hmdb: 'HMDB0000135' },
  FRU_EXT: { name: 'D-Fructose (extracellular)', ecocyc: 'FRUCTOSE', bigg: 'fru_e', kegg: 'C00095', chebi: '15824', hmdb: 'HMDB0000122' },
  LAC: { name: 'D-Lactate', ecocyc: 'D-LACTATE', bigg: 'lac__D_c', kegg: 'C00256', chebi: '16021', hmdb: 'HMDB0001311' },
  LAC_EXT: { name: 'D-Lactate (extracellular)', ecocyc: 'D-LACTATE', bigg: 'lac__D_e', kegg: 'C00256', chebi: '16021', hmdb: 'HMDB0001311' },

  // Energy & Electron Carriers / Cofactors
  ATP: { name: 'ATP', ecocyc: 'ATP', bigg: 'atp_c', kegg: 'C00002', chebi: '15422', hmdb: 'HMDB0000538' },
  ADP: { name: 'ADP', ecocyc: 'ADP', bigg: 'adp_c', kegg: 'C00008', chebi: '16761', hmdb: 'HMDB0000077' },
  AMP: { name: 'AMP', ecocyc: 'AMP', bigg: 'amp_c', kegg: 'C00020', chebi: '16027', hmdb: 'HMDB0000045' },
  NAD: { name: 'NAD+', ecocyc: 'NAD', bigg: 'nad_c', kegg: 'C00003', chebi: '15846', hmdb: 'HMDB0000902' },
  NADH: { name: 'NADH', ecocyc: 'NADH', bigg: 'nadh_c', kegg: 'C00004', chebi: '16908', hmdb: 'HMDB0001482' },
  NADP: { name: 'NADP+', ecocyc: 'NADP', bigg: 'nadp_c', kegg: 'C00006', chebi: '25523', hmdb: 'HMDB0000217' },
  NADPH: { name: 'NADPH', ecocyc: 'NADPH', bigg: 'nadph_c', kegg: 'C00005', chebi: '16474', hmdb: 'HMDB0000221' },
  COA: { name: 'CoA', ecocyc: 'CO-A', bigg: 'coa_c', kegg: 'C00010', chebi: '15346', hmdb: 'HMDB0001435' },
  Q8: { name: 'Ubiquinone-8', ecocyc: 'UBIQUINONE-8', bigg: 'q8_c', kegg: 'C05842', chebi: '46245', hmdb: 'HMDB0060370' },
  Q8H2: { name: 'Ubiquinol-8', ecocyc: 'UBIQUINOL-8', bigg: 'q8h2_c', kegg: 'C11346', chebi: '17996', hmdb: 'HMDB0060370' },

  // Amino Acids
  GLN: { name: 'L-Glutamine', ecocyc: 'GLN', bigg: 'gln__L_c', kegg: 'C00064', chebi: '18050', hmdb: 'HMDB0000641' },
  GLN_EXT: { name: 'L-Glutamine (extracellular)', ecocyc: 'GLN', bigg: 'gln__L_e', kegg: 'C00064', chebi: '18050', hmdb: 'HMDB0000641' },
  GLU: { name: 'L-Glutamate', ecocyc: 'GLU', bigg: 'glu__L_c', kegg: 'C00025', chebi: '16015', hmdb: 'HMDB0000148' },
  GLU_EXT: { name: 'L-Glutamate (extracellular)', ecocyc: 'GLU', bigg: 'glu__L_e', kegg: 'C00025', chebi: '16015', hmdb: 'HMDB0000148' },

  // Inorganic compounds & Small Buffer molecules
  H2O: { name: 'Water', ecocyc: 'WATER', bigg: 'h2o_c', kegg: 'C00001', chebi: '15377', hmdb: 'HMDB0002111' },
  H2O_EXT: { name: 'Water (extracellular)', ecocyc: 'WATER', bigg: 'h2o_e', kegg: 'C00001', chebi: '15377', hmdb: 'HMDB0002111' },
  H: { name: 'H+', ecocyc: 'PROTON', bigg: 'h_c', kegg: 'C00080', chebi: '15378', hmdb: 'HMDB0059597' },
  H_EXT: { name: 'H+ (extracellular)', ecocyc: 'PROTON', bigg: 'h_e', kegg: 'C00080', chebi: '15378', hmdb: 'HMDB0059597' },
  NH4: { name: 'Ammonium', ecocyc: 'AMMONIUM', bigg: 'nh4_c', kegg: 'C01342', chebi: '28938', hmdb: 'HMDB0000051' },
  NH4_EXT: { name: 'Ammonium (extracellular)', ecocyc: 'AMMONIUM', bigg: 'nh4_e', kegg: 'C01342', chebi: '28938', hmdb: 'HMDB0000051' },
  PI: { name: 'Phosphate', ecocyc: 'INORGANIC-PHOSPHATE', bigg: 'pi_c', kegg: 'C00009', chebi: '43474', hmdb: 'HMDB0001429' },
  PI_EXT: { name: 'Phosphate (extracellular)', ecocyc: 'INORGANIC-PHOSPHATE', bigg: 'pi_e', kegg: 'C00009', chebi: '43474', hmdb: 'HMDB0001429' },
  O2: { name: 'Oxygen', ecocyc: 'OXYGEN', bigg: 'o2_c', kegg: 'C00007', chebi: '15379', hmdb: 'HMDB0001377' },
  O2_EXT: { name: 'Oxygen (extracellular)', ecocyc: 'OXYGEN', bigg: 'o2_e', kegg: 'C00007', chebi: '15379', hmdb: 'HMDB0001377' },
  CO2: { name: 'CO2', ecocyc: 'CARBON-DIOXIDE', bigg: 'co2_c', kegg: 'C00011', chebi: '16526', hmdb: 'HMDB0001967' },
  CO2_EXT: { name: 'CO2 (extracellular)', ecocyc: 'CARBON-DIOXIDE', bigg: 'co2_e', kegg: 'C00011', chebi: '16526', hmdb: 'HMDB0001967' }
};

// Map BiGG ID to Database keys
function getDatabaseKey(biggId) {
  const normId = biggId.toLowerCase();
  for (const [key, db] of Object.entries(NAMESPACE_DATABASE)) {
    if (db.bigg === normId) return key;
  }
  return null;
}

// Get label text for a node given a namespace
function getLabelTextForNamespace(biggId, namespace) {
  if (namespace === 'common') {
    const metab = simulation.metabolites[biggId];
    return metab ? metab.name : biggId;
  }
  const ns = namespace.toLowerCase().replace(' id', '').replace(' ', ''); // e.g. "BiGG ID" -> "bigg"
  if (ns === 'bigg') return biggId;
  const dbKey = getDatabaseKey(biggId);
  if (!dbKey) return biggId;
  const db = NAMESPACE_DATABASE[dbKey];
  if (!db) return biggId;
  
  const val = db[ns];
  return (val && val !== '-') ? val : biggId;
}

// Pathway metabolite groups for camera focus centering
const PATHWAY_FOCUS_IDS = {
  glycolysis: new Set(['glc__D_e', 'glc__D_c', 'g6p_c', 'f6p_c', 'fdp_c', 'dhap_c', 'g3p_c', '13dpg_c', '3pg_c', '2pg_c', 'pep_c', 'pyr_c']),
  tca: new Set(['accoa_c', 'oaa_c', 'cit_c', 'icit_c', 'akg_c', 'succoa_c', 'succ_c', 'fum_c', 'mal__L_c']),
  ppp: new Set(['g6p_c', '6pgl_c', '6pgc_c', 'ru5p__D_c', 'r5p_c', 'xu5p__D_c', 's7p_c', 'e4p_c', 'g3p_c', 'f6p_c'])
};

// Global State
let simulation = null;
let renderer = null;
let isPaused = false;
let speedMultiplier = 1.0;
let animationFrameCount = 0;

// Inspection Selection State
let selectedMetaboliteId = null;
let selectedReactionId = null;

// Concentration chart variables
const maxChartPoints = 120;
let chartHistory = [];
let chartCanvas = null;
let chartCtx = null;

// Growth rate chart variables
const maxGrowthPoints = 120;
let growthHistory = [];
let growthCanvas = null;
let growthCtx = null;

// Timesteps tracking
let accumulatedTime = 0.0;
const simTickRate = 50.0; // 50ms (20Hz)

/**
 * Populates and wires up event listeners for the map loading warnings badge.
 */
function initializeWarningsUI() {
  const warnings = renderer ? renderer.mapWarnings : [];
  const container = document.getElementById('map-warnings-container');
  const countEl = document.getElementById('warnings-count');
  const listEl = document.getElementById('warnings-list');
  const toggleBtn = document.getElementById('warnings-toggle-btn');
  const closeBtn = document.getElementById('warnings-close-btn');
  const dropdown = document.getElementById('warnings-dropdown');

  if (!container || warnings.length === 0) {
    if (container) container.classList.add('hidden');
    return;
  }

  // Show container and update badge count
  container.classList.remove('hidden');
  countEl.textContent = `${warnings.length} warning${warnings.length > 1 ? 's' : ''}`;

  // Populate list
  listEl.innerHTML = '';
  warnings.forEach(warn => {
    const li = document.createElement('li');
    li.className = 'warning-item';

    if (warn.type === 'missing') {
      li.innerHTML = `⚠️ <strong>${warn.biggId}</strong>: missing coordinates.`;
    } else if (warn.type === 'far') {
      li.innerHTML = `⚠️ <strong>${warn.biggId}</strong>: label offset is <span class="dist">${warn.distance.toFixed(1)}px</span> (threshold: 100px).`;
    } else {
      li.innerHTML = warn.message;
    }

    // Click on warning item selects and centers the corresponding metabolite node
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      if (renderer && renderer.metabNodes) {
        const node = renderer.metabNodes.find(n => n.id === warn.id || n.biggId === warn.biggId);
        if (node) {
          renderer.selectMetabolite(node.id);
          handleMetaboliteSelect(node);
          renderer.focusOnCoordinates(node.x, node.y, 0.85);
          dropdown.classList.add('hidden');
        }
      }
    });

    listEl.appendChild(li);
  });

  // Wire up toggling dropdown
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('hidden');
  });

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.add('hidden');
  });

  // Close dropdown on click outside
  document.addEventListener('click', () => {
    dropdown.classList.add('hidden');
  });

  dropdown.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}

/**
 * Bootstraps the application, loading assets and launching the loops.
 */
async function bootstrap() {
  // 1. Fetch official Escher JSON map local asset
  let mapData;
  try {
    const res = await fetch('/escher_core.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mapData = await res.json();
  } catch (error) {
    console.error('[App] Failed to load escher_core.json local asset:', error);
    alert('Failed to load local metabolic map asset.');
    return;
  }

  // 2. Initialize simulation engine
  simulation = new Simulation(mapData);

  // 3. Initialize visual renderer
  const canvasElement = document.getElementById('pixi-canvas');
  renderer = new PixiRenderer(
    canvasElement,
    handleMetaboliteSelect,
    handleReactionSelect
  );
  renderer.getLabelText = getLabelTextForNamespace;
  await renderer.init(mapData);

  // Check if any map metabolites are missing from our namespace database
  checkMetaboliteDatabaseCompleteness();

  // Initialize warnings UI if there are any map loading warnings
  initializeWarningsUI();

  // 4. Setup rolling chart canvas references
  chartCanvas = document.getElementById('rolling-chart');
  growthCanvas = document.getElementById('growth-sparkline');
  initializeGrowthHistory();

  // 5. Wire up DOM UI Listeners
  setupUIListeners();

  // Setup Map Search Bar
  setupSearch();

  // Setup GEO Search
  setupGeoSearch();

  // 6. Populate Overview list initially
  populateOverviewList();

  // 7. Start the main game-loop
  requestAnimationFrame(gameLoop);
  console.log('[App] Metabolic Simulator bootstrapped.');
}

/**
 * High-precision Game Loop matching 60fps rendering with a semi-fixed 20Hz simulation step.
 */
let lastTime = performance.now();
function gameLoop(currentTime) {
  const dt = currentTime - lastTime;
  lastTime = currentTime;

  animationFrameCount++;

  // Accumulate time for simulation step (fixed timestep)
  accumulatedTime += dt;
  while (accumulatedTime >= simTickRate) {
    if (!isPaused) {
      simulation.tick(speedMultiplier);
      
      // Update historical data for concentration chart if inspecting a metabolite
      if (selectedMetaboliteId) {
        const info = simulation.getMetaboliteInfo(selectedMetaboliteId);
        if (info) {
          chartHistory.push(info.concentration);
          if (chartHistory.length > maxChartPoints) {
            chartHistory.shift();
          }
        }
      }

      // Update growth rate history dynamically
      const baseGrowth = getBaseGrowthRate(simulation.activeModel);
      const biomassFlux = simulation.reactions['BIOMASS_Ecoli_core_w_GAM']?.flux || 0;
      const currentGrowth = Math.max(0.0, (biomassFlux / 9.4335e-8) * baseGrowth);
      growthHistory.push(currentGrowth);
      if (growthHistory.length > maxGrowthPoints) {
        growthHistory.shift();
      }
    }
    accumulatedTime -= simTickRate;
  }

  // Render Visual Updates (radii pulsation, moving particles, highlighted states)
  renderer.renderUpdate(
    simulation.metabolites,
    simulation.reactions,
    animationFrameCount
  );

  // Update UI panel values (concentrations in lists, sliders, labels, active chart)
  updateUIPanelValues();

  requestAnimationFrame(gameLoop);
}

/**
 * Configures event listeners for left panel controls and right panel details.
 */
function setupUIListeners() {
  const canvasElement = document.getElementById('pixi-canvas');
  // Play/Pause button
  const playPauseBtn = document.getElementById('play-pause-btn');
  playPauseBtn.addEventListener('click', () => {
    isPaused = !isPaused;
    playPauseBtn.textContent = isPaused ? '▶ Play' : '⏸ Pause';
    playPauseBtn.className = isPaused ? 'btn btn-secondary' : 'btn btn-primary';
  });

  // Reset button
  document.getElementById('reset-btn').addEventListener('click', () => {
    simulation.reset();
    chartHistory = [];
    console.log('[App] Simulation state reset.');
  });

  // Speed slider
  const speedSlider = document.getElementById('speed-slider');
  const speedVal = document.getElementById('speed-val');
  speedSlider.addEventListener('input', (e) => {
    speedMultiplier = parseFloat(e.target.value);
    speedVal.textContent = `${speedMultiplier.toFixed(1)}x`;
  });

  // Label font size slider
  const fontSizeSlider = document.getElementById('font-size-slider');
  const fontSizeVal = document.getElementById('font-size-val');
  fontSizeSlider.addEventListener('input', (e) => {
    const size = parseInt(e.target.value, 10);
    fontSizeVal.textContent = `${size}px`;
    if (renderer) {
      renderer.updateLabelFontSize(size);
    }
  });

  // Namespace select listener
  const namespaceSelect = document.getElementById('namespace-select');
  const namespaceDesc = document.getElementById('namespace-desc');
  const NAMESPACE_DESCRIPTIONS = {
    common: 'Standard readable chemical nomenclature for central metabolism.',
    ecocyc: 'Escherichia coli encyclopedia of genes and metabolic pathways.',
    bigg: 'Standard for genome-scale metabolic models (E. coli K-12).',
    kegg: 'Kyoto Encyclopedia of Genes and Genomes pathways database.',
    chebi: 'Chemical Entities of Biological Interest ontology and dictionary.',
    hmdb: 'Chemical cross-reference database (Universal reference).'
  };

  namespaceSelect.addEventListener('change', (e) => {
    const val = e.target.value;
    namespaceDesc.textContent = NAMESPACE_DESCRIPTIONS[val] || '';
    if (renderer) {
      renderer.updateLabelNamespace(val);
    }
  });

  // Map zoom controls
  const btnZoomIn = document.getElementById('btn-zoom-in');
  const btnZoomOut = document.getElementById('btn-zoom-out');
  const btnZoomCanvas = document.getElementById('btn-zoom-canvas');

  if (btnZoomIn && btnZoomOut && btnZoomCanvas) {
    btnZoomIn.addEventListener('click', () => {
      if (renderer) renderer.zoomIn();
    });
    btnZoomOut.addEventListener('click', () => {
      if (renderer) renderer.zoomOut();
    });
    btnZoomCanvas.addEventListener('click', () => {
      if (renderer) renderer.zoomToCanvas();
    });
  }

  // Strain selector
  const strainSelect = document.getElementById('strain-select');
  const strainDesc = document.getElementById('strain-description');
  const metricGrowth = document.getElementById('metric-growth');
  const metricAtp = document.getElementById('metric-atp');

  strainSelect.addEventListener('change', (e) => {
    const strainId = e.target.value;
    simulation.selectStrain(strainId);
    chartHistory = [];
    initializeGrowthHistory();

    // Update strain metadata texts and placeholder yields
    const metadata = simulation.strains[strainId];
    if (metadata) {
      strainDesc.textContent = metadata.description;
      
      // Predefined illustrative metrics reflecting model behaviors
      if (strainId === 'iJO1366') {
        metricGrowth.textContent = '0.41 hr⁻¹';
        metricAtp.textContent = '15.6 mM/s';
      } else if (strainId === 'iML1515') {
        metricGrowth.textContent = '0.48 hr⁻¹';
        metricAtp.textContent = '18.2 mM/s';
      } else if (strainId === 'iAF1260') {
        metricGrowth.textContent = '0.28 hr⁻¹';
        metricAtp.textContent = '11.0 mM/s';
      } else if (strainId === 'iJR904') {
        metricGrowth.textContent = '0.22 hr⁻¹';
        metricAtp.textContent = '8.9 mM/s';
      } else {
        metricGrowth.textContent = '0.32 hr⁻¹';
        metricAtp.textContent = '12.5 mM/s';
      }
    }
  });

  // Close inspector panels
  document.querySelectorAll('.close-inspector-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      hideInspector();
      renderer.clearSelection();
    });
  });

  // Injections Spikes
  document.querySelectorAll('.btn-inject').forEach(btn => {
    btn.addEventListener('click', () => {
      if (selectedMetaboliteId) {
        const amount = parseFloat(btn.getAttribute('data-amount'));
        simulation.inject(selectedMetaboliteId, amount);
        console.log(`[App] Spiked ${selectedMetaboliteId} by +${amount} mM`);
      }
    });
  });

  // Deplete metabolite
  document.getElementById('btn-deplete').addEventListener('click', () => {
    if (selectedMetaboliteId && simulation.metabolites[selectedMetaboliteId]) {
      simulation.metabolites[selectedMetaboliteId].concentration = 0.1;
      console.log(`[App] Depleted ${selectedMetaboliteId} to 0.1 mM`);
    }
  });

  // Reaction Parameter Tweaks
  const vmaxSlider = document.getElementById('vmax-slider');
  const vmaxVal = document.getElementById('vmax-val');
  vmaxSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    vmaxVal.textContent = val.toFixed(1);
    if (selectedReactionId) {
      simulation.updateParameter(selectedReactionId, 'vMax', val);
    }
  });

  const kmSlider = document.getElementById('km-slider');
  const kmVal = document.getElementById('km-val');
  kmSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    kmVal.textContent = val.toFixed(2);
    if (selectedReactionId) {
      simulation.updateParameter(selectedReactionId, 'km', val);
    }
  });

  // Handle hover tooltips custom event from Pixi Canvas
  const tooltip = document.getElementById('tooltip');
  const tooltipTitle = document.getElementById('tooltip-title');
  const tooltipConc = document.getElementById('tooltip-conc');
  const tooltipFlux = document.getElementById('tooltip-flux');

  canvasElement.addEventListener('metabolite-hover', (e) => {
    const node = e.detail;
    if (node) {
      const info = simulation.getMetaboliteInfo(node.biggId);
      if (info) {
        tooltipTitle.textContent = info.name;
        tooltipConc.textContent = `${info.concentration.toFixed(2)} mM`;
        
        const sign = info.netFlux >= 0.005 ? '+' : '';
        tooltipFlux.textContent = `${sign}${info.netFlux.toFixed(2)} mM/s`;
        tooltipFlux.className = info.netFlux >= 0.005 ? 'value text-emerald' : 
                                 info.netFlux <= -0.005 ? 'value text-danger' : 'value text-neutral';

        // Position tooltip relative to cursor inside canvas bounding box
        tooltip.classList.remove('hidden');
        tooltip.style.opacity = '1';
        
        const tooltipW = tooltip.offsetWidth;
        const tooltipH = tooltip.offsetHeight;
        let tx = renderer.dragStart.x + 15; // default mouse position, wait.
        
        // Actually track mouse position from hover node rendering
        // Use renderer's pointer coords relative to window
        // (We fetch it from standard pointer tracking)
      }
    } else {
      tooltip.classList.add('hidden');
      tooltip.style.opacity = '0';
    }
  });

  // Setup actual mouse tracking for tooltip window position
  window.addEventListener('pointermove', (e) => {
    if (!tooltip.classList.contains('hidden')) {
      const padding = 15;
      let tx = e.clientX + padding;
      let ty = e.clientY + padding;

      if (tx + tooltip.offsetWidth > window.innerWidth) {
        tx = e.clientX - tooltip.offsetWidth - padding;
      }
      if (ty + tooltip.offsetHeight > window.innerHeight) {
        ty = e.clientY - tooltip.offsetHeight - padding;
      }

      tooltip.style.left = `${tx}px`;
      tooltip.style.top = `${ty}px`;
    }
  });
}

/**
 * Helper to check if a metabolite is in the main list of transportable carbon sources
 * that E. coli can effectively import from the medium (D-Glucose, Acetate, Glycerol, Succinate, Lactate).
 */
function isMetaboliteTransportable(biggId) {
  if (!biggId) return false;

  const allowedBases = new Set([
    'glc__D', // D-Glucose
    'ac',     // Acetate
    'glyc',   // Glycerol
    'succ',   // Succinate
    'lac__D'  // Lactate
  ]);

  let base = biggId;
  if (biggId.endsWith('_c') || biggId.endsWith('_e')) {
    base = biggId.slice(0, -2);
  }

  return allowedBases.has(base);
}

/**
 * Event handler triggered when a user clicks on a metabolite circle in Pixi canvas.
 */
function handleMetaboliteSelect(node) {
  if (!node) {
    hideInspector();
    return;
  }

  selectedMetaboliteId = node.biggId;
  selectedReactionId = null;
  chartHistory = []; // Reset history for new chart plotting

  // Swap inspector states
  document.getElementById('inspector-empty').classList.add('hidden');
  document.getElementById('inspector-reaction').classList.add('hidden');
  document.getElementById('inspector-metabolite').classList.remove('hidden');
  document.getElementById('inspector-panel').classList.remove('hidden-panel');

  // Fill in static metadata
  document.getElementById('metab-name').textContent = node.name;
  document.getElementById('metab-bigg-id').textContent = node.biggId;

  // Show/Hide injection buttons based on transportable status
  const isTransportable = isMetaboliteTransportable(node.biggId);
  const descEl = document.getElementById('injection-desc');
  const warningEl = document.getElementById('injection-warning');
  const buttonsEl = document.getElementById('injection-buttons');

  if (isTransportable) {
    descEl.classList.remove('hidden');
    buttonsEl.classList.remove('hidden');
    warningEl.classList.add('hidden');
  } else {
    descEl.classList.add('hidden');
    buttonsEl.classList.add('hidden');
    warningEl.classList.remove('hidden');
    if (node.biggId === 'h2o_c' || node.biggId === 'h2o_e') {
      warningEl.textContent = '⚠️ In silico injection is disabled. Water is in excess and physiologically buffered.';
    } else {
      warningEl.textContent = '⚠️ In silico injection is disabled. This metabolite is not transported across the cell membrane.';
    }
  }

  // Render cross references
  populateCrossReferences(node.biggId);

  // Sync rows in left panel list
  updateOverviewListHighlight();
}

/**
 * Event handler triggered when a user clicks on a reaction badge in Pixi canvas.
 */
function handleReactionSelect(rxn) {
  selectedReactionId = rxn.biggId;
  selectedMetaboliteId = null;
  chartHistory = [];

  // Swap inspector states
  document.getElementById('inspector-empty').classList.add('hidden');
  document.getElementById('inspector-metabolite').classList.add('hidden');
  document.getElementById('inspector-reaction').classList.remove('hidden');
  document.getElementById('inspector-panel').classList.remove('hidden-panel');

  // Fill in static metadata
  document.getElementById('rxn-name').textContent = rxn.name;
  document.getElementById('rxn-bigg-id').textContent = rxn.biggId;

  // Fill equation and set sliders
  const simRxn = simulation.reactions[rxn.biggId];
  if (simRxn) {
    // Reconstruct stoichiometric text equation
    let subs = simRxn.substrates.map(id => id.replace('_c', '').replace('_e', '')).join(' + ');
    let prods = simRxn.products.map(id => id.replace('_c', '').replace('_e', '')).join(' + ');
    const arrow = simRxn.reversibility ? '&harr;' : '&rarr;';
    document.getElementById('rxn-equation').innerHTML = `${subs} ${arrow} ${prods}`;

    // Set slider coordinates
    const vmaxSlider = document.getElementById('vmax-slider');
    const vmaxVal = document.getElementById('vmax-val');
    vmaxSlider.value = simRxn.vMax;
    vmaxVal.textContent = simRxn.vMax.toFixed(1);

    const kmSlider = document.getElementById('km-slider');
    const kmVal = document.getElementById('km-val');
    kmSlider.value = simRxn.km;
    kmVal.textContent = simRxn.km.toFixed(2);
  }

  updateOverviewListHighlight();
}

/**
 * Hides the right inspector sidebar.
 */
function hideInspector() {
  selectedMetaboliteId = null;
  selectedReactionId = null;
  chartHistory = [];
  document.getElementById('inspector-panel').classList.add('hidden-panel');
  updateOverviewListHighlight();
}

/**
 * Populates database cross-reference link grids in the inspector.
 */
function populateCrossReferences(biggId) {
  const container = document.getElementById('metab-cross-refs');
  container.innerHTML = '';

  const dbKey = getDatabaseKey(biggId);
  const db = NAMESPACE_DATABASE[dbKey] || {};

  const databases = [
    { name: 'EcoCyc', val: db.ecocyc, url: `https://ecocyc.org/ECOLI/NEW-IMAGE?type=CHEMICAL&object=${db.ecocyc}` },
    { name: 'BiGG Model', val: biggId, url: `http://bigg.ucsd.edu/universal/metabolites/${biggId.replace('_c','').replace('_e','')}` },
    { name: 'KEGG Cpd', val: db.kegg, url: `https://www.kegg.jp/dbget-bin/www_bget?cpd:${db.kegg}` },
    { name: 'ChEBI ID', val: db.chebi, url: `https://www.ebi.ac.uk/chebi/searchId.do?chebiId=${db.chebi}` },
    { name: 'HMDB ID', val: db.hmdb, url: `https://hmdb.ca/metabolites/${db.hmdb}` }
  ];

  databases.forEach(item => {
    if (!item.val || item.val === '-') return;
    
    const card = document.createElement('div');
    card.className = 'db-card';
    card.innerHTML = `
      <span class="db-name">${item.name}</span>
      <a href="${item.url}" target="_blank" class="db-link" title="Open in database">${item.val}</a>
    `;
    container.appendChild(card);
  });
}

/**
 * Creates static metabolite overview rows in the left sidebar list.
 */
function populateOverviewList() {
  const container = document.getElementById('metabolite-rows-container');
  container.innerHTML = '';

  // Sort metabolites alphabetically for cleaner visual listing, omitting cofactors
  const sorted = Object.values(simulation.metabolites)
    .filter(m => !m.isBuffered)
    .sort((a, b) => a.name.localeCompare(b.name));

  sorted.forEach(m => {
    const row = document.createElement('div');
    row.className = 'metabolite-row';
    row.id = `overview-row-${m.id}`;
    
    let colorClass = 'fill-metabolite';
    if (m.type === 'substrate') colorClass = 'fill-substrate';
    if (m.type === 'cofactor') colorClass = 'fill-cofactor';

    row.innerHTML = `
      <div class="row-meta">
        <span class="metabolite-name">${m.name}</span>
        <span class="metabolite-val" id="row-val-${m.id}">1.0 mM</span>
      </div>
      <div class="progress-bar-bg">
        <div class="progress-bar-fill ${colorClass}" id="row-fill-${m.id}" style="width: 10%;"></div>
      </div>
    `;

    // Click handler to select and center camera focus on this metabolite node
    row.addEventListener('click', () => {
      // Find the corresponding node coordinate in renderer
      const node = renderer.metabNodes.find(n => n.biggId === m.id);
      if (node) {
        renderer.selectMetabolite(node.id);
        handleMetaboliteSelect(node);
        
        // Camera smooth fly-to centering
        const singleNodeSet = new Set([node.biggId]);
        renderer.focusOnPathway(singleNodeSet);
      }
    });

    container.appendChild(row);
  });
}

/**
 * Updates row highlighted border colors in the left overview list.
 */
function updateOverviewListHighlight() {
  document.querySelectorAll('.metabolite-row').forEach(row => {
    row.classList.remove('selected-row');
  });

  if (selectedMetaboliteId) {
    const row = document.getElementById(`overview-row-${selectedMetaboliteId}`);
    if (row) row.classList.add('selected-row');
  }
}

/**
 * Per-frame update of UI texts, progress bars, charts, and inspector dials.
 */
function updateUIPanelValues() {
  // Update left sidebar values and progress bars
  Object.values(simulation.metabolites).forEach(m => {
    if (m.isBuffered) return;

    const rowVal = document.getElementById(`row-val-${m.id}`);
    const rowFill = document.getElementById(`row-fill-${m.id}`);

    if (rowVal && rowFill) {
      rowVal.textContent = `${m.concentration.toFixed(2)} mM`;
      
      // Calculate normalized width (spikes can exceed baseline, clamp display)
      const maxRange = m.type === 'substrate' ? 20.0 : 5.0;
      const pct = Math.max(5, Math.min(100, (m.concentration / maxRange) * 100));
      rowFill.style.width = `${pct}%`;
    }
  });

  // Update right inspector sidebar values
  if (selectedMetaboliteId) {
    const info = simulation.getMetaboliteInfo(selectedMetaboliteId);
    if (info) {
      document.getElementById('metab-conc-val').textContent = info.concentration.toFixed(2);
      
      // Render rolling chart history
      drawConcentrationChart();

      // Render fluxes contributors list
      populateConnectedFluxes(selectedMetaboliteId);
    }
  } else if (selectedReactionId) {
    const rxn = simulation.reactions[selectedReactionId];
    if (rxn) {
      const absFlux = Math.abs(rxn.flux);
      document.getElementById('rxn-flux-val').textContent = `${rxn.flux.toFixed(2)} mM/s`;

      // Draw direction bar filling
      const fillBar = document.getElementById('flux-dir-indicator');
      if (fillBar) {
        // Centered direction filling: left (negative), center (zero), right (positive)
        const percent = Math.min(50, (absFlux / 15.0) * 50); // scale up to 15 mM/s limit
        fillBar.style.width = `${percent}%`;
        if (rxn.flux >= 0) {
          fillBar.style.left = '50%';
          fillBar.style.background = '#34d399'; // green for forward
        } else {
          fillBar.style.left = `${50 - percent}%`;
          fillBar.style.background = '#f472b6'; // pink for backward
        }
      }
    }
  }

  // Update growth rate dynamically
  const baseGrowth = getBaseGrowthRate(simulation.activeModel);
  const biomassFlux = simulation.reactions['BIOMASS_Ecoli_core_w_GAM']?.flux || 0;
  const currentGrowth = Math.max(0.0, (biomassFlux / 9.4335e-8) * baseGrowth);
  document.getElementById('metric-growth').textContent = `${currentGrowth.toFixed(2)} hr⁻¹`;

  // Update ATP yield dynamically based on active ATP synthesis rate (ATPS4r flux)
  const atpsFlux = Math.max(0.0, -1.0 * (simulation.reactions['ATPS4r']?.flux || 0));
  const currentAtpYield = (atpsFlux / 1.7718) * 12.5;
  document.getElementById('metric-atp').textContent = `${currentAtpYield.toFixed(1)} mM/s`;

  // Draw growth rate trend line
  drawGrowthSparkline();
}

/**
 * Draws connected producing and consuming reactions inside inspector.
 */
function populateConnectedFluxes(metabId) {
  const container = document.getElementById('metab-fluxes-list');
  container.innerHTML = '';

  const contributors = [];

  for (const rxn of Object.values(simulation.reactions)) {
    const coeff = rxn.stoichiometry[metabId];
    if (coeff) {
      const rate = rxn.flux * coeff;
      contributors.push({
        id: rxn.id,
        name: rxn.name,
        coeff: coeff,
        rate: rate
      });
    }
  }

  // Sort by net rate impact
  contributors.sort((a, b) => b.rate - a.rate);

  if (contributors.length === 0) {
    container.innerHTML = `<div class="flux-row text-neutral">No active metabolic connections</div>`;
    return;
  }

  contributors.forEach(item => {
    if (Math.abs(item.rate) < 0.001) return; // skip inactive connections

    const row = document.createElement('div');
    row.className = 'flux-row';
    
    let rateClass = 'text-neutral';
    let ratePrefix = '';
    if (item.rate > 0.005) {
      rateClass = 'text-success';
      ratePrefix = '+';
    } else if (item.rate < -0.005) {
      rateClass = 'text-danger';
    }

    row.innerHTML = `
      <span class="flux-row-label">${item.id} (${item.coeff > 0 ? 'Prod' : 'Cons'})</span>
      <span class="flux-row-value ${rateClass}">${ratePrefix}${item.rate.toFixed(2)} mM/s</span>
    `;

    // Click on flux contributor row selects and centers that reaction
    row.addEventListener('click', () => {
      const rxn = renderer.reactions.find(r => r.biggId === item.id);
      if (rxn) {
        renderer.selectReaction(rxn.id);
        handleReactionSelect(rxn);
      }
    });

    container.appendChild(row);
  });
}

/**
 * Custom 2D canvas drawing function for the rolling concentration history chart.
 */
function drawConcentrationChart() {
  if (!chartCanvas) return;
  
  // Set logical dimensions matching container size
  const dpr = window.devicePixelRatio || 1;
  const rect = chartCanvas.getBoundingClientRect();
  chartCanvas.width = rect.width * dpr;
  chartCanvas.height = 120 * dpr; // hardcoded container height

  chartCtx = chartCanvas.getContext('2d');
  chartCtx.scale(dpr, dpr);

  const w = rect.width;
  const h = 120;

  chartCtx.clearRect(0, 0, w, h);

  if (chartHistory.length < 2) {
    chartCtx.fillStyle = '#64748b';
    chartCtx.font = '12px "Inter", sans-serif';
    chartCtx.textAlign = 'center';
    chartCtx.textBaseline = 'middle';
    chartCtx.fillText('Loading kinetic history...', w / 2, h / 2);
    return;
  }

  // Find min/max values in history for fitting
  let maxVal = Math.max(...chartHistory);
  let minVal = Math.min(...chartHistory);

  // Clamp limits to prevent visual flattening on constant lines
  if (maxVal - minVal < 0.2) {
    maxVal = minVal + 1.0;
    minVal = Math.max(0.0, minVal - 0.5);
  }
  maxVal = Math.max(1.0, maxVal); // min vertical scale height of 1.0 mM

  const paddingY = 15;
  const plotH = h - paddingY * 2;
  const plotW = w - 10;

  // 1. Draw grid background lines
  chartCtx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  chartCtx.lineWidth = 1;
  chartCtx.beginPath();
  // 3 horizontal dividers
  for (let i = 0; i <= 3; i++) {
    const yGrid = paddingY + (plotH / 3) * i;
    chartCtx.moveTo(0, yGrid);
    chartCtx.lineTo(w, yGrid);
  }
  chartCtx.stroke();

  // 2. Plot concentration curve line
  chartCtx.strokeStyle = '#34d399'; // Minty green
  chartCtx.lineWidth = 2;
  chartCtx.beginPath();

  chartHistory.forEach((val, i) => {
    // Map point index to X, value to Y
    const x = (i / (maxChartPoints - 1)) * plotW;
    const y = paddingY + plotH - ((val - minVal) / (maxVal - minVal)) * plotH;

    if (i === 0) {
      chartCtx.moveTo(x, y);
    } else {
      chartCtx.lineTo(x, y);
    }
  });
  chartCtx.stroke();

  // 3. Draw gradient filled area under the line
  const lastIdx = chartHistory.length - 1;
  const grad = chartCtx.createLinearGradient(0, paddingY, 0, h - paddingY);
  grad.addColorStop(0, 'rgba(52, 211, 153, 0.18)');
  grad.addColorStop(1, 'rgba(52, 211, 153, 0.0)');

  chartCtx.fillStyle = grad;
  chartCtx.lineTo((lastIdx / (maxChartPoints - 1)) * plotW, h - paddingY);
  chartCtx.lineTo(0, h - paddingY);
  chartCtx.closePath();
  chartCtx.fill();

  // 4. Draw glowing current value dot at the tip
  const lastVal = chartHistory[lastIdx];
  const lastX = (lastIdx / (maxChartPoints - 1)) * plotW;
  const lastY = paddingY + plotH - ((lastVal - minVal) / (maxVal - minVal)) * plotH;

  chartCtx.fillStyle = '#ffffff';
  chartCtx.shadowBlur = 8;
  chartCtx.shadowColor = '#34d399';
  chartCtx.beginPath();
  chartCtx.arc(lastX, lastY, 4, 0, Math.PI * 2);
  chartCtx.fill();

  // Reset shadow for subsequent draws
  chartCtx.shadowBlur = 0;

  // 5. Draw axis scale texts (Max and Min readouts)
  chartCtx.fillStyle = '#64748b';
  chartCtx.font = '9px "JetBrains Mono", monospace';
  chartCtx.textAlign = 'right';
  chartCtx.textBaseline = 'top';
  chartCtx.fillText(`${maxVal.toFixed(1)} mM`, w - 5, paddingY - 10);
  chartCtx.textBaseline = 'bottom';
  chartCtx.fillText(`${minVal.toFixed(1)} mM`, w - 5, h - paddingY + 10);
}

// Boot on window load
window.addEventListener('DOMContentLoaded', bootstrap);

/**
 * Helper to get the baseline growth rate for a given strain model.
 */
function getBaseGrowthRate(strainId) {
  if (strainId === 'iJO1366') return 0.41;
  if (strainId === 'iML1515') return 0.48;
  if (strainId === 'iAF1260') return 0.28;
  if (strainId === 'iJR904') return 0.22;
  return 0.32; // e_coli_core
}

/**
 * Initializes the growth history array as a flat line.
 */
function initializeGrowthHistory() {
  const baseGrowth = getBaseGrowthRate(simulation ? simulation.activeModel : 'e_coli_core');
  growthHistory = Array(maxGrowthPoints).fill(baseGrowth);
}

/**
 * Custom 2D canvas drawing function for the growth rate trend sparkline.
 */
function drawGrowthSparkline() {
  if (!growthCanvas) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = growthCanvas.getBoundingClientRect();
  growthCanvas.width = rect.width * dpr;
  growthCanvas.height = 40 * dpr;

  growthCtx = growthCanvas.getContext('2d');
  growthCtx.scale(dpr, dpr);

  const w = rect.width;
  const h = 40;

  growthCtx.clearRect(0, 0, w, h);

  if (growthHistory.length < 2) return;

  let maxVal = Math.max(...growthHistory);
  let minVal = Math.min(...growthHistory);

  if (maxVal - minVal < 0.05) {
    maxVal = minVal + 0.1;
    minVal = Math.max(0.0, minVal - 0.05);
  }
  maxVal = Math.max(0.2, maxVal);

  const plotH = h - 6;
  const plotW = w - 6;

  growthCtx.strokeStyle = '#34d399';
  growthCtx.lineWidth = 1.5;
  growthCtx.beginPath();

  growthHistory.forEach((val, i) => {
    const x = (i / (maxGrowthPoints - 1)) * plotW + 3;
    const y = h - 3 - ((val - minVal) / (maxVal - minVal)) * plotH;

    if (i === 0) {
      growthCtx.moveTo(x, y);
    } else {
      growthCtx.lineTo(x, y);
    }
  });
  growthCtx.stroke();

  const lastIdx = growthHistory.length - 1;
  const grad = growthCtx.createLinearGradient(0, 3, 0, h - 3);
  grad.addColorStop(0, 'rgba(52, 211, 153, 0.12)');
  grad.addColorStop(1, 'rgba(52, 211, 153, 0.0)');

  growthCtx.fillStyle = grad;
  growthCtx.lineTo((lastIdx / (maxGrowthPoints - 1)) * plotW + 3, h - 3);
  growthCtx.lineTo(3, h - 3);
  growthCtx.closePath();
  growthCtx.fill();

  const lastVal = growthHistory[lastIdx];
  const lastX = (lastIdx / (maxGrowthPoints - 1)) * plotW + 3;
  const lastY = h - 3 - ((lastVal - minVal) / (maxVal - minVal)) * plotH;

  growthCtx.fillStyle = '#34d399';
  growthCtx.beginPath();
  growthCtx.arc(lastX, lastY, 3, 0, Math.PI * 2);
  growthCtx.fill();
}

/**
 * Setup Search UI and event handlers for top search panel.
 */
function setupSearch() {
  const searchInput = document.getElementById('map-search-input');
  const searchClearBtn = document.getElementById('search-clear-btn');
  const resultsDropdown = document.getElementById('search-results-dropdown');
  const resultsList = document.getElementById('search-results-list');

  if (!searchInput || !searchClearBtn || !resultsDropdown || !resultsList) return;

  // Perform search on input
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim().toLowerCase();
    if (query.length > 0) {
      searchClearBtn.classList.remove('hidden');
      performSearch(query);
    } else {
      searchClearBtn.classList.add('hidden');
      hideSearchResults();
    }
  });

  // Clear search on button click
  searchClearBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchClearBtn.classList.add('hidden');
    hideSearchResults();
    searchInput.focus();
  });

  // Handle Enter keypress to choose the first result
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const firstItem = resultsList.querySelector('.search-result-item');
      if (firstItem) {
        firstItem.click();
        searchInput.blur();
      }
    }
  });

  // Close search suggestions on click outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-container')) {
      hideSearchResults();
    }
  });
}

// State for GEO Dataset Search
let geoCurrentQuery = '';
let geoCurrentPage = 1;
let geoTotalCount = 0;
let geoSelectedDataset = null;

/**
 * Setup GEO Search UI, dropdown examples, modal and event handlers.
 */
function setupGeoSearch() {
  const geoInput = document.getElementById('geo-search-input');
  const geoClearBtn = document.getElementById('geo-clear-btn');
  const geoDropdownBtn = document.getElementById('geo-dropdown-btn');
  const geoDropdown = document.getElementById('geo-examples-dropdown');
  const geoSubmitBtn = document.getElementById('geo-submit-btn');
  
  const geoModal = document.getElementById('geo-modal-overlay');
  const geoModalCloseBtn = document.getElementById('geo-modal-close-btn');
  const geoModalLoading = document.getElementById('geo-modal-loading');
  const geoModalError = document.getElementById('geo-modal-error');
  const geoErrorMsg = document.getElementById('geo-error-message');
  const geoResultsContainer = document.getElementById('geo-modal-results-container');
  
  const geoPagination = document.getElementById('geo-pagination');
  const geoPrevBtn = document.getElementById('geo-prev-btn');
  const geoNextBtn = document.getElementById('geo-next-btn');
  const geoPageInfo = document.getElementById('geo-page-info');

  if (!geoInput || !geoSubmitBtn || !geoModal) return;

  // Toggle dropdown on button click
  geoDropdownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = geoDropdown.classList.contains('hidden');
    if (isHidden) {
      showGeoDropdown();
    } else {
      hideGeoDropdown();
    }
  });

  // Show dropdown on input focus
  geoInput.addEventListener('focus', () => {
    showGeoDropdown();
  });

  // Input listener for clear button toggle
  geoInput.addEventListener('input', () => {
    if (geoInput.value.trim().length > 0) {
      geoClearBtn.classList.remove('hidden');
    } else {
      geoClearBtn.classList.add('hidden');
    }
  });

  // Clear button click
  geoClearBtn.addEventListener('click', () => {
    geoInput.value = '';
    geoClearBtn.classList.add('hidden');
    geoInput.focus();
  });

  // Close dropdown on click outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.geo-search-container')) {
      hideGeoDropdown();
    }
  });

  // Handle clicking items in the custom examples dropdown
  const exampleItems = document.querySelectorAll('#geo-examples-list li');
  exampleItems.forEach(item => {
    item.addEventListener('click', () => {
      geoInput.value = item.textContent;
      geoClearBtn.classList.remove('hidden');
      hideGeoDropdown();
      triggerSearch();
    });
  });

  // Submit search on button click
  geoSubmitBtn.addEventListener('click', () => {
    triggerSearch();
  });

  // Submit search on Enter keypress
  geoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      triggerSearch();
      geoInput.blur();
    }
  });

  // Close modal button
  geoModalCloseBtn.addEventListener('click', () => {
    geoModal.classList.add('hidden');
  });

  // Close modal on click outside content
  geoModal.addEventListener('click', (e) => {
    if (e.target === geoModal) {
      geoModal.classList.add('hidden');
    }
  });

  // Pagination triggers
  geoPrevBtn.addEventListener('click', () => {
    if (geoCurrentPage > 1) {
      performGeoSearch(geoCurrentQuery, geoCurrentPage - 1);
    }
  });

  // Next page trigger
  geoNextBtn.addEventListener('click', () => {
    if (geoCurrentPage * 20 < geoTotalCount) {
      performGeoSearch(geoCurrentQuery, geoCurrentPage + 1);
    }
  });

  // Setup selected dataset UI actions
  const geoSelectedPanel = document.getElementById('geo-selected-dataset');
  const geoSelectedSummary = document.getElementById('geo-selected-summary');
  const geoSelectedReadMore = document.getElementById('geo-selected-read-more');
  const geoDeselectBtn = document.getElementById('geo-deselect-btn');

  if (geoDeselectBtn) {
    geoDeselectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deselectGeoDataset();
    });
  }

  if (geoSelectedReadMore && geoSelectedSummary) {
    geoSelectedReadMore.addEventListener('click', (e) => {
      e.stopPropagation();
      const isCollapsed = geoSelectedSummary.classList.contains('collapsed');
      if (isCollapsed) {
        geoSelectedSummary.classList.remove('collapsed');
        geoSelectedReadMore.textContent = 'Collapse Description';
      } else {
        geoSelectedSummary.classList.add('collapsed');
        geoSelectedReadMore.textContent = 'Read Description';
      }
    });
  }

  function showGeoDropdown() {
    geoDropdown.classList.remove('hidden');
    geoDropdownBtn.classList.add('active');
  }

  function hideGeoDropdown() {
    geoDropdown.classList.add('hidden');
    geoDropdownBtn.classList.remove('active');
  }

  function triggerSearch() {
    const query = geoInput.value.trim();
    if (query.length === 0) return;
    performGeoSearch(query, 1);
  }
}

/**
 * Executes GEO search fetch call, handles loading/error states, and updates results modal layout.
 */
async function performGeoSearch(query, page) {
  const geoModal = document.getElementById('geo-modal-overlay');
  const geoModalLoading = document.getElementById('geo-modal-loading');
  const geoModalError = document.getElementById('geo-modal-error');
  const geoErrorMsg = document.getElementById('geo-error-message');
  const geoResultsContainer = document.getElementById('geo-modal-results-container');
  
  const geoPagination = document.getElementById('geo-pagination');
  const geoPrevBtn = document.getElementById('geo-prev-btn');
  const geoNextBtn = document.getElementById('geo-next-btn');
  const geoPageInfo = document.getElementById('geo-page-info');

  // Open modal and set active query details
  geoModal.classList.remove('hidden');
  geoCurrentQuery = query;
  geoCurrentPage = page;

  // Show loading spinner
  geoModalLoading.classList.remove('hidden');
  geoModalError.classList.add('hidden');
  geoResultsContainer.innerHTML = '';
  geoPagination.classList.add('hidden');

  try {
    const res = await fetch(`/api/geo-search?query=${encodeURIComponent(query)}&page=${page}`);
    if (!res.ok) {
      throw new Error(`Server returned HTTP ${res.status}`);
    }
    
    const data = await res.json();
    if (data.error) {
      throw new Error(data.error);
    }

    geoTotalCount = data.totalCount || 0;
    const results = data.results || [];

    geoModalLoading.classList.add('hidden');

    if (results.length === 0) {
      geoResultsContainer.innerHTML = `
        <div class="geo-empty-state">
          <span class="geo-empty-icon">❓</span>
          <p>No GEO datasets found matching "<strong>${query}</strong>" and E. coli central metabolism filters.</p>
        </div>
      `;
      return;
    }

    // Populate results cards
    results.forEach(item => {
      const card = document.createElement('div');
      card.className = 'geo-result-card';
      
      const ftpUrl = item.ftpLink || '';
      const ncbiUrl = item.accession ? `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${item.accession}` : '';
      
      // Split date to just show YYYY-MM-DD
      const pubDate = item.pdat ? item.pdat.split(' ')[0] : 'N/A';
      
      card.innerHTML = `
        <div class="geo-card-header">
          <span class="geo-accession-badge">${item.accession || 'N/A'}</span>
          <h3 class="geo-card-title">${item.title || 'Untitled Dataset'}</h3>
        </div>
        <div class="geo-card-metadata">
          <div class="geo-meta-item"><strong>Organism:</strong> ${item.taxon || 'Escherichia coli'}</div>
          <div class="geo-meta-item"><strong>Samples:</strong> ${item.n_samples || 0}</div>
          <div class="geo-meta-item"><strong>Release Date:</strong> ${pubDate}</div>
          <div class="geo-meta-item"><strong>Type:</strong> ${item.gdsType || 'Expression Profiling'}</div>
        </div>
        <p class="geo-card-summary collapsed">${item.summary || 'No description available.'}</p>
        <button class="geo-read-more-btn">Read Description</button>
        <div class="geo-card-actions">
          <button class="btn btn-primary btn-select-dataset" style="height: 30px; font-size: 11px; padding: 0 14px; flex: none;">Select Dataset</button>
          ${ncbiUrl ? `<a href="${ncbiUrl}" target="_blank" class="btn-geo-link">Open in NCBI GEO</a>` : ''}
          ${ftpUrl ? `<a href="${ftpUrl}" target="_blank" class="btn-geo-link">📂 Download Data (FTP)</a>` : ''}
        </div>
      `;

      // Select dataset click handler
      const selectBtn = card.querySelector('.btn-select-dataset');
      if (selectBtn) {
        selectBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          selectGeoDataset(item);
          geoModal.classList.add('hidden');
        });
      }

      // Read More toggle handler
      const summaryEl = card.querySelector('.geo-card-summary');
      const readMoreBtn = card.querySelector('.geo-read-more-btn');
      
      // Hide button if text is short or empty
      if (!item.summary || item.summary.length < 180) {
        readMoreBtn.style.display = 'none';
        summaryEl.classList.remove('collapsed');
      }

      readMoreBtn.addEventListener('click', () => {
        const isCollapsed = summaryEl.classList.contains('collapsed');
        if (isCollapsed) {
          summaryEl.classList.remove('collapsed');
          readMoreBtn.textContent = 'Collapse Description';
        } else {
          summaryEl.classList.add('collapsed');
          readMoreBtn.textContent = 'Read Description';
        }
      });

      geoResultsContainer.appendChild(card);
    });

    // Configure Pagination display
    const totalPages = Math.ceil(geoTotalCount / 20) || 1;
    geoPageInfo.textContent = `Page ${page} of ${totalPages} (Total: ${geoTotalCount})`;
    
    // Enable/disable buttons
    geoPrevBtn.disabled = page <= 1;
    geoNextBtn.disabled = page >= totalPages;

    geoPagination.classList.remove('hidden');

  } catch (err) {
    console.error('[GEO Search Error] ', err);
    geoModalLoading.classList.add('hidden');
    geoErrorMsg.textContent = `Search failed: ${err.message || 'Unknown network error'}`;
    geoModalError.classList.remove('hidden');
  }
}

/**
 * Filters metabolites and reactions by name or ID, sorting and presenting results.
 */
function performSearch(query) {
  const resultsList = document.getElementById('search-results-list');
  const resultsDropdown = document.getElementById('search-results-dropdown');
  if (!resultsList || !resultsDropdown) return;

  resultsList.innerHTML = '';

  const matches = [];

  // 1. Search Metabolite Nodes present on the map
  if (renderer && renderer.metabNodes) {
    renderer.metabNodes.forEach(node => {
      const commonName = node.name || '';
      const biggId = node.biggId || '';

      const matchesCommon = commonName.toLowerCase().includes(query);
      const matchesBigg = biggId.toLowerCase().includes(query);

      if (matchesCommon || matchesBigg) {
        matches.push({
          type: 'metabolite',
          id: node.id,
          biggId: biggId,
          name: commonName,
          node: node
        });
      }
    });
  }

  // 2. Search Reaction Badges present on the map
  if (renderer && renderer.reactions) {
    renderer.reactions.forEach(rxn => {
      const rxnName = rxn.name || '';
      const biggId = rxn.biggId || '';

      const matchesName = rxnName.toLowerCase().includes(query);
      const matchesBigg = biggId.toLowerCase().includes(query);

      if (matchesName || matchesBigg) {
        matches.push({
          type: 'reaction',
          id: rxn.id,
          biggId: biggId,
          name: rxnName,
          reaction: rxn
        });
      }
    });
  }

  // Sort matches so that exact/prefix matches come first
  matches.sort((a, b) => {
    const aBiggStarts = a.biggId.toLowerCase().startsWith(query);
    const bBiggStarts = b.biggId.toLowerCase().startsWith(query);
    if (aBiggStarts && !bBiggStarts) return -1;
    if (!aBiggStarts && bBiggStarts) return 1;

    const aNameStarts = a.name.toLowerCase().startsWith(query);
    const bNameStarts = b.name.toLowerCase().startsWith(query);
    if (aNameStarts && !bNameStarts) return -1;
    if (!aNameStarts && bNameStarts) return 1;

    return a.name.localeCompare(b.name);
  });

  // Limit suggestions list length
  const maxResults = 10;
  const displayedMatches = matches.slice(0, maxResults);

  if (displayedMatches.length === 0) {
    const li = document.createElement('li');
    li.className = 'search-result-empty';
    li.textContent = 'No results found';
    resultsList.appendChild(li);
  } else {
    displayedMatches.forEach(match => {
      const li = document.createElement('li');
      li.className = 'search-result-item';

      const badgeClass = match.type === 'metabolite' ? 'badge-metabolite' : 'badge-reaction';
      const displayName = match.name || match.biggId;

      li.innerHTML = `
        <div class="search-result-info">
          <span class="search-result-title">${displayName}</span>
          <span class="search-result-subtitle">${match.biggId}</span>
        </div>
        <span class="search-result-badge ${badgeClass}">${match.type}</span>
      `;

      // Select, highlight, center and open inspector for matching element
      li.addEventListener('click', () => {
        if (match.type === 'metabolite') {
          renderer.selectMetabolite(match.node.id);
          handleMetaboliteSelect(match.node);
          renderer.focusOnCoordinates(match.node.x, match.node.y, 0.85);
        } else {
          renderer.selectReaction(match.reaction.id);
          handleReactionSelect(match.reaction);
          renderer.focusOnCoordinates(match.reaction.labelX, match.reaction.labelY, 0.85);
        }
        hideSearchResults();
      });

      resultsList.appendChild(li);
    });
  }

  resultsDropdown.classList.remove('hidden');
}

/**
 * Hides search results dropdown panel.
 */
function hideSearchResults() {
  const resultsDropdown = document.getElementById('search-results-dropdown');
  if (resultsDropdown) {
    resultsDropdown.classList.add('hidden');
  }
}

/**
 * Checks if all metabolite nodes on the map are defined in NAMESPACE_DATABASE.
 * If any are missing, pushes warning objects to renderer.mapWarnings.
 */
function checkMetaboliteDatabaseCompleteness() {
  if (!renderer || !renderer.metabNodes) return;

  const dbMetaboliteBiggs = new Set(
    Object.values(NAMESPACE_DATABASE).map(db => db.bigg.toLowerCase())
  );

  const missingMetabolites = new Map(); // biggId -> nodeName

  renderer.metabNodes.forEach(node => {
    const normId = node.biggId.toLowerCase();
    if (!dbMetaboliteBiggs.has(normId)) {
      missingMetabolites.set(node.biggId, node.name);
    }
  });

  if (missingMetabolites.size > 0) {
    missingMetabolites.forEach((name, biggId) => {
      const warningMsg = `Metabolite "${name}" (${biggId}) is missing from database cross-references (NAMESPACE_DATABASE).`;
      console.warn(`[Database Warning] ${warningMsg}`);
      
      // Push warning object to renderer's warnings list
      renderer.mapWarnings.push({
        id: biggId,
        biggId: biggId,
        name: name,
        type: 'database_missing',
        message: `⚠️ <strong>${biggId}</strong>: missing from database cross-references.`
      });
    });
  }
}

/**
 * Sets the active atlas GEO dataset and updates the display in the left panel.
 */
function selectGeoDataset(dataset) {
  geoSelectedDataset = dataset;
  const geoSelectedPanel = document.getElementById('geo-selected-dataset');
  const geoSelectedAccession = document.getElementById('geo-selected-accession');
  const geoSelectedTitle = document.getElementById('geo-selected-title');
  const geoSelectedSummary = document.getElementById('geo-selected-summary');
  const geoSelectedReadMore = document.getElementById('geo-selected-read-more');

  if (!geoSelectedPanel) return;

  geoSelectedAccession.textContent = dataset.accession || 'N/A';
  geoSelectedTitle.textContent = dataset.title || 'Untitled Dataset';
  geoSelectedSummary.textContent = dataset.summary || 'No description available.';
  
  // Reset collapsed states
  geoSelectedSummary.classList.add('collapsed');
  if (geoSelectedReadMore) {
    geoSelectedReadMore.textContent = 'Read Description';
    
    // Hide toggle button if description is short or empty
    if (!dataset.summary || dataset.summary.length < 120) {
      geoSelectedReadMore.style.display = 'none';
      geoSelectedSummary.classList.remove('collapsed');
    } else {
      geoSelectedReadMore.style.display = 'block';
    }
  }

  geoSelectedPanel.classList.remove('hidden');
  console.log(`[GEO] Selected active dataset: ${dataset.accession}`);
}

/**
 * Clears the active atlas GEO dataset and hides the details card in the left panel.
 */
function deselectGeoDataset() {
  geoSelectedDataset = null;
  const geoSelectedPanel = document.getElementById('geo-selected-dataset');
  if (geoSelectedPanel) {
    geoSelectedPanel.classList.add('hidden');
  }
  console.log('[GEO] Deselected active dataset.');
}


