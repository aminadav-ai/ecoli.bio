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
  ACCOA: { name: 'Acetyl-CoA', ecocyc: 'ACETYL-COA', bigg: 'accoa_c', kegg: 'C00024', chebi: '15379', hmdb: 'HMDB0001206' },
  OXALO: { name: 'Oxaloacetate', ecocyc: 'OXALOACETATE', bigg: 'oaa_c', kegg: 'C00036', chebi: '16452', hmdb: 'HMDB0000223' },
  CITRATE: { name: 'Citrate', ecocyc: 'CITRATE', bigg: 'cit_c', kegg: 'C00158', chebi: '16947', hmdb: 'HMDB0000094' },
  ISOCIT: { name: 'Isocitrate', ecocyc: 'ISOCITRATE', bigg: 'icit_c', kegg: 'C00311', chebi: '16088', hmdb: 'HMDB0000193' },
  AKG: { name: 'Alpha-ketoglutarate', ecocyc: '2-KETOGLUTARATE', bigg: 'akg_c', kegg: 'C00026', chebi: '16810', hmdb: 'HMDB0000208' },
  SUCCOA: { name: 'Succinyl-CoA', ecocyc: 'SUCCINYL-COA', bigg: 'succoa_c', kegg: 'C00091', chebi: '15380', hmdb: 'HMDB0001150' },
  SUCC: { name: 'Succinate', ecocyc: 'SUCCINATE', bigg: 'succ_c', kegg: 'C00042', chebi: '15741', hmdb: 'HMDB0000254' },
  FUMAR: { name: 'Fumarate', ecocyc: 'FUMARATE', bigg: 'fum_c', kegg: 'C00122', chebi: '18012', hmdb: 'HMDB0000134' },
  MALATE: { name: 'L-Malate', ecocyc: 'MALATE', bigg: 'mal__L_c', kegg: 'C00149', chebi: '15589', hmdb: 'HMDB0000156' },
  '6PGL': { name: '6-Phosphoglucono-d-lactone', ecocyc: 'D-GLUCONO-15-LACTONE-6-P', bigg: '6pgl_c', kegg: 'C01236', chebi: '16075', hmdb: 'HMDB0001149' },
  '6PGC': { name: '6-Phosphogluconate', ecocyc: 'D-GLUCONATE-6-P', bigg: '6pgc_c', kegg: 'C00345', chebi: '17960', hmdb: 'HMDB0001314' },
  RL5P: { name: 'Ribulose 5-phosphate', ecocyc: 'RIBULOSE-5P', bigg: 'ru5p__D_c', kegg: 'C00199', chebi: '16712', hmdb: 'HMDB0001188' },
  R5P: { name: 'Ribose 5-phosphate', ecocyc: 'RIBOSE-5P', bigg: 'r5p_c', kegg: 'C00117', chebi: '17797', hmdb: 'HMDB0000283' },
  X5P: { name: 'Xylulose 5-phosphate', ecocyc: 'D-XYLULOSE-5-P', bigg: 'xu5p__D_c', kegg: 'C00231', chebi: '16332', hmdb: 'HMDB0001287' },
  S7P: { name: 'Sedoheptulose 7-phosphate', ecocyc: 'SEDOHEPTULOSE-7P', bigg: 's7p_c', kegg: 'C05382', chebi: '15714', hmdb: 'HMDB0001072' },
  E4P: { name: 'Erythrose 4-phosphate', ecocyc: 'ERYTHROSE-4P', bigg: 'e4p_c', kegg: 'C00279', chebi: '16897', hmdb: 'HMDB0001479' }
};

// Map BiGG ID to Database keys
function getDatabaseKey(biggId) {
  const normId = biggId.toLowerCase();
  for (const [key, db] of Object.entries(NAMESPACE_DATABASE)) {
    if (db.bigg === normId) return key;
  }
  return null;
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

// Timesteps tracking
let accumulatedTime = 0.0;
const simTickRate = 50.0; // 50ms (20Hz)

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
  await renderer.init(mapData);

  // 4. Setup rolling chart canvas references
  chartCanvas = document.getElementById('rolling-chart');

  // 5. Wire up DOM UI Listeners
  setupUIListeners();

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

  // Camera focuses
  document.querySelectorAll('.btn-pathway').forEach(btn => {
    btn.addEventListener('click', () => {
      const pathway = btn.getAttribute('data-pathway');
      if (pathway === 'fit') {
        renderer.fitMapToScreen();
      } else {
        const ids = PATHWAY_FOCUS_IDS[pathway];
        if (ids) {
          renderer.focusOnPathway(ids);
        }
      }
    });
  });

  // Strain selector
  const strainSelect = document.getElementById('strain-select');
  const strainDesc = document.getElementById('strain-description');
  const metricGrowth = document.getElementById('metric-growth');
  const metricAtp = document.getElementById('metric-atp');

  strainSelect.addEventListener('change', (e) => {
    const strainId = e.target.value;
    simulation.selectStrain(strainId);
    chartHistory = [];

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
