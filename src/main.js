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
  CO2_EXT: { name: 'CO2 (extracellular)', ecocyc: 'CARBON-DIOXIDE', bigg: 'co2_e', kegg: 'C00011', chebi: '16526', hmdb: 'HMDB0001967' },

  // Automatically added iJO1366 map cross-references
  'NO2_P': { name: 'Nitrite', ecocyc: '-', bigg: 'no2_p', kegg: '-', chebi: '-', hmdb: '-' },
  'H_P': { name: 'H+', ecocyc: '-', bigg: 'h_p', kegg: '-', chebi: '-', hmdb: '-' },
  'H2O_P': { name: 'H2O', ecocyc: '-', bigg: 'h2o_p', kegg: '-', chebi: '-', hmdb: '-' },
  'NH4_P': { name: 'Ammonium', ecocyc: '-', bigg: 'nh4_p', kegg: '-', chebi: '-', hmdb: '-' },
  '2DMMQ8_C': { name: '2-Demethylmenaquinone 8', ecocyc: '-', bigg: '2dmmq8_c', kegg: '-', chebi: '-', hmdb: '-' },
  '2DMMQL8_C': { name: '2-Demethylmenaquinol 8', ecocyc: '-', bigg: '2dmmql8_c', kegg: '-', chebi: '-', hmdb: '-' },
  'MQN8_C': { name: 'Menaquinone 8', ecocyc: '-', bigg: 'mqn8_c', kegg: '-', chebi: '-', hmdb: '-' },
  'MQL8_C': { name: 'Menaquinol 8', ecocyc: '-', bigg: 'mql8_c', kegg: '-', chebi: '-', hmdb: '-' },
  'MAL__L_P': { name: 'L-Malate', ecocyc: '-', bigg: 'mal__L_p', kegg: '-', chebi: '-', hmdb: '-' },
  'LAC__D_P': { name: 'D-Lactate', ecocyc: '-', bigg: 'lac__D_p', kegg: '-', chebi: '-', hmdb: '-' },
  'G1P_P': { name: 'D-Glucose 1-phosphate', ecocyc: '-', bigg: 'g1p_p', kegg: '-', chebi: '-', hmdb: '-' },
  'PI_P': { name: 'Phosphate', ecocyc: '-', bigg: 'pi_p', kegg: '-', chebi: '-', hmdb: '-' },
  'GLC__D_P': { name: 'D-Glucose', ecocyc: '-', bigg: 'glc__D_p', kegg: '-', chebi: '-', hmdb: '-' },
  'ACON_T_C': { name: 'Trans-Aconitate', ecocyc: '-', bigg: 'acon_T_c', kegg: '-', chebi: '-', hmdb: '-' },
  'AMET_C': { name: 'S-Adenosyl-L-methionine', ecocyc: '-', bigg: 'amet_c', kegg: '-', chebi: '-', hmdb: '-' },
  'AHCYS_C': { name: 'S-Adenosyl-L-homocysteine', ecocyc: '-', bigg: 'ahcys_c', kegg: '-', chebi: '-', hmdb: '-' },
  'ACONM_C': { name: 'E-3-carboxy-2-pentenedioate 6-methyl ester', ecocyc: '-', bigg: 'aconm_c', kegg: '-', chebi: '-', hmdb: '-' },
  'ACALD_P': { name: 'Acetaldehyde', ecocyc: '-', bigg: 'acald_p', kegg: '-', chebi: '-', hmdb: '-' },
  'GLYCLT_C': { name: 'Glycolate', ecocyc: '-', bigg: 'glyclt_c', kegg: '-', chebi: '-', hmdb: '-' },
  'F6P_E': { name: 'D-Fructose 6-phosphate', ecocyc: '-', bigg: 'f6p_e', kegg: '-', chebi: '-', hmdb: '-' },
  'F6P_P': { name: 'D-Fructose 6-phosphate', ecocyc: '-', bigg: 'f6p_p', kegg: '-', chebi: '-', hmdb: '-' },
  'H2_C': { name: 'H2', ecocyc: '-', bigg: 'h2_c', kegg: '-', chebi: '-', hmdb: '-' },
  'S17BP_C': { name: 'Sedoheptulose 1,7-bisphosphate', ecocyc: '-', bigg: 's17bp_c', kegg: '-', chebi: '-', hmdb: '-' },
  'ETOH_P': { name: 'Ethanol', ecocyc: '-', bigg: 'etoh_p', kegg: '-', chebi: '-', hmdb: '-' },
  'FUM_P': { name: 'Fumarate', ecocyc: '-', bigg: 'fum_p', kegg: '-', chebi: '-', hmdb: '-' },
  'GLYCOGEN_C': { name: 'Glycogen', ecocyc: '-', bigg: 'glycogen_c', kegg: '-', chebi: '-', hmdb: '-' },
  'G1P_C': { name: 'D-Glucose 1-phosphate', ecocyc: '-', bigg: 'g1p_c', kegg: '-', chebi: '-', hmdb: '-' },
  'NO3_P': { name: 'Nitrate', ecocyc: '-', bigg: 'no3_p', kegg: '-', chebi: '-', hmdb: '-' },
  'DSBARD_P': { name: 'Periplasmic protein disulfide isomerase I (reduced)', ecocyc: '-', bigg: 'dsbard_p', kegg: '-', chebi: '-', hmdb: '-' },
  'DSBAOX_P': { name: 'Periplasmic protein disulfide isomerase I (oxidized)', ecocyc: '-', bigg: 'dsbaox_p', kegg: '-', chebi: '-', hmdb: '-' },
  'TMAO_P': { name: 'Trimethylamine N-oxide', ecocyc: '-', bigg: 'tmao_p', kegg: '-', chebi: '-', hmdb: '-' },
  'TMA_P': { name: 'Trimethylamine', ecocyc: '-', bigg: 'tma_p', kegg: '-', chebi: '-', hmdb: '-' },
  'PPI_C': { name: 'Diphosphate', ecocyc: '-', bigg: 'ppi_c', kegg: '-', chebi: '-', hmdb: '-' },
  'ADPGLC_C': { name: 'ADPglucose', ecocyc: '-', bigg: 'adpglc_c', kegg: '-', chebi: '-', hmdb: '-' },
  'GLYC_C': { name: 'Glycerol', ecocyc: '-', bigg: 'glyc_c', kegg: '-', chebi: '-', hmdb: '-' },
  'GLYC_P': { name: 'Glycerol', ecocyc: '-', bigg: 'glyc_p', kegg: '-', chebi: '-', hmdb: '-' },
  'GLYC_E': { name: 'Glycerol', ecocyc: '-', bigg: 'glyc_e', kegg: '-', chebi: '-', hmdb: '-' },
  'O2S_C': { name: 'Superoxide anion', ecocyc: '-', bigg: 'o2s_c', kegg: '-', chebi: '-', hmdb: '-' },
  'LGT__S_C': { name: '(R)-S-Lactoylglutathione', ecocyc: '-', bigg: 'lgt__S_c', kegg: '-', chebi: '-', hmdb: '-' },
  'GTHRD_C': { name: 'Reduced glutathione', ecocyc: '-', bigg: 'gthrd_c', kegg: '-', chebi: '-', hmdb: '-' },
  'H2O2_C': { name: 'Hydrogen peroxide', ecocyc: '-', bigg: 'h2o2_c', kegg: '-', chebi: '-', hmdb: '-' },
  'H2_P': { name: 'H2', ecocyc: '-', bigg: 'h2_p', kegg: '-', chebi: '-', hmdb: '-' },
  'O2S_P': { name: 'Superoxide anion', ecocyc: '-', bigg: 'o2s_p', kegg: '-', chebi: '-', hmdb: '-' },
  'H2O2_P': { name: 'Hydrogen peroxide', ecocyc: '-', bigg: 'h2o2_p', kegg: '-', chebi: '-', hmdb: '-' },
  'O2_P': { name: 'O2', ecocyc: '-', bigg: 'o2_p', kegg: '-', chebi: '-', hmdb: '-' },
  'GLYC3P_C': { name: 'Glycerol 3-phosphate', ecocyc: '-', bigg: 'glyc3p_c', kegg: '-', chebi: '-', hmdb: '-' },
  'AKG_P': { name: '2-Oxoglutarate', ecocyc: '-', bigg: 'akg_p', kegg: '-', chebi: '-', hmdb: '-' },
  '12PPD__R_P': { name: '(R)-Propane-1,2-diol', ecocyc: '-', bigg: '12ppd__R_p', kegg: '-', chebi: '-', hmdb: '-' },
  '12PPD__R_C': { name: '(R)-Propane-1,2-diol', ecocyc: '-', bigg: '12ppd__R_c', kegg: '-', chebi: '-', hmdb: '-' },
  'DMSO_P': { name: 'Dimethyl sulfoxide', ecocyc: '-', bigg: 'dmso_p', kegg: '-', chebi: '-', hmdb: '-' },
  'DMSO_C': { name: 'Dimethyl sulfoxide', ecocyc: '-', bigg: 'dmso_c', kegg: '-', chebi: '-', hmdb: '-' },
  'BGLYCOGEN_C': { name: 'Branching glycogen', ecocyc: '-', bigg: 'bglycogen_c', kegg: '-', chebi: '-', hmdb: '-' },
  'XYL__D_P': { name: 'D-Xylose', ecocyc: '-', bigg: 'xyl__D_p', kegg: '-', chebi: '-', hmdb: '-' },
  'XYL__D_C': { name: 'D-Xylose', ecocyc: '-', bigg: 'xyl__D_c', kegg: '-', chebi: '-', hmdb: '-' },
  'G1P_E': { name: 'D-Glucose 1-phosphate', ecocyc: '-', bigg: 'g1p_e', kegg: '-', chebi: '-', hmdb: '-' },
  'DMS_P': { name: 'Dimethyl sulfide', ecocyc: '-', bigg: 'dms_p', kegg: '-', chebi: '-', hmdb: '-' },
  'FRU_P': { name: 'D-Fructose', ecocyc: '-', bigg: 'fru_p', kegg: '-', chebi: '-', hmdb: '-' },
  'F1P_C': { name: 'D-Fructose 1-phosphate', ecocyc: '-', bigg: 'f1p_c', kegg: '-', chebi: '-', hmdb: '-' },
  'PPPI_C': { name: 'Inorganic triphosphate', ecocyc: '-', bigg: 'pppi_c', kegg: '-', chebi: '-', hmdb: '-' },
  'LAC__L_C': { name: 'L-Lactate', ecocyc: '-', bigg: 'lac__L_c', kegg: '-', chebi: '-', hmdb: '-' },
  'LAC__L_P': { name: 'L-Lactate', ecocyc: '-', bigg: 'lac__L_p', kegg: '-', chebi: '-', hmdb: '-' },
  'DHA_C': { name: 'Dihydroxyacetone', ecocyc: '-', bigg: 'dha_c', kegg: '-', chebi: '-', hmdb: '-' },
  'CO2_P': { name: 'CO2', ecocyc: '-', bigg: 'co2_p', kegg: '-', chebi: '-', hmdb: '-' },
  'GLYC3P_P': { name: 'Glycerol 3-phosphate', ecocyc: '-', bigg: 'glyc3p_p', kegg: '-', chebi: '-', hmdb: '-' },
  'LAC__L_E': { name: 'L-Lactate', ecocyc: '-', bigg: 'lac__L_e', kegg: '-', chebi: '-', hmdb: '-' },
  'AC_P': { name: 'Acetate', ecocyc: '-', bigg: 'ac_p', kegg: '-', chebi: '-', hmdb: '-' },
  'CIT_E': { name: 'Citrate', ecocyc: '-', bigg: 'cit_e', kegg: '-', chebi: '-', hmdb: '-' },
  'CIT_P': { name: 'Citrate', ecocyc: '-', bigg: 'cit_p', kegg: '-', chebi: '-', hmdb: '-' },
  'RIB__D_P': { name: 'D-Ribose', ecocyc: '-', bigg: 'rib__D_p', kegg: '-', chebi: '-', hmdb: '-' },
  'RIB__D_C': { name: 'D-Ribose', ecocyc: '-', bigg: 'rib__D_c', kegg: '-', chebi: '-', hmdb: '-' },
  '2DDG6P_C': { name: '2-Dehydro-3-deoxy-D-gluconate 6-phosphate', ecocyc: '-', bigg: '2ddg6p_c', kegg: '-', chebi: '-', hmdb: '-' },
  'NO3_C': { name: 'Nitrate', ecocyc: '-', bigg: 'no3_c', kegg: '-', chebi: '-', hmdb: '-' },
  'NO2_C': { name: 'Nitrite', ecocyc: '-', bigg: 'no2_c', kegg: '-', chebi: '-', hmdb: '-' },
  'LALD__D_C': { name: 'D-Lactaldehyde', ecocyc: '-', bigg: 'lald__D_c', kegg: '-', chebi: '-', hmdb: '-' },
  'GLYC3P_E': { name: 'Glycerol 3-phosphate', ecocyc: '-', bigg: 'glyc3p_e', kegg: '-', chebi: '-', hmdb: '-' },
  'TMAO_C': { name: 'Trimethylamine N-oxide', ecocyc: '-', bigg: 'tmao_c', kegg: '-', chebi: '-', hmdb: '-' },
  'TMA_C': { name: 'Trimethylamine', ecocyc: '-', bigg: 'tma_c', kegg: '-', chebi: '-', hmdb: '-' },
  'FOR_P': { name: 'Formate', ecocyc: '-', bigg: 'for_p', kegg: '-', chebi: '-', hmdb: '-' },
  'SUCC_P': { name: 'Succinate', ecocyc: '-', bigg: 'succ_p', kegg: '-', chebi: '-', hmdb: '-' },
  '12PPD__R_E': { name: '(R)-Propane-1,2-diol', ecocyc: '-', bigg: '12ppd__R_e', kegg: '-', chebi: '-', hmdb: '-' },
  'GLCN_P': { name: 'D-Gluconate', ecocyc: '-', bigg: 'glcn_p', kegg: '-', chebi: '-', hmdb: '-' },
  'H2_E': { name: 'H2', ecocyc: '-', bigg: 'h2_e', kegg: '-', chebi: '-', hmdb: '-' },
  'MTHGXL_C': { name: 'Methylglyoxal', ecocyc: '-', bigg: 'mthgxl_c', kegg: '-', chebi: '-', hmdb: '-' },
  'PYR_P': { name: 'Pyruvate', ecocyc: '-', bigg: 'pyr_p', kegg: '-', chebi: '-', hmdb: '-' },
  'DMS_C': { name: 'Dimethyl sulfide', ecocyc: '-', bigg: 'dms_c', kegg: '-', chebi: '-', hmdb: '-' },
  'XYLU__D_C': { name: 'D-Xylulose', ecocyc: '-', bigg: 'xylu__D_c', kegg: '-', chebi: '-', hmdb: '-' },
  'XYL__D_E': { name: 'D-Xylose', ecocyc: '-', bigg: 'xyl__D_e', kegg: '-', chebi: '-', hmdb: '-' },
  'G6P_P': { name: 'D-Glucose 6-phosphate', ecocyc: '-', bigg: 'g6p_p', kegg: '-', chebi: '-', hmdb: '-' },
  'RIB__D_E': { name: 'D-Ribose', ecocyc: '-', bigg: 'rib__D_e', kegg: '-', chebi: '-', hmdb: '-' },
  'HCO3_C': { name: 'Bicarbonate', ecocyc: '-', bigg: 'hco3_c', kegg: '-', chebi: '-', hmdb: '-' },
  'G6P_E': { name: 'D-Glucose 6-phosphate', ecocyc: '-', bigg: 'g6p_e', kegg: '-', chebi: '-', hmdb: '-' },
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
let isDead = false;
let speedMultiplier = 1.0;
let animationFrameCount = 0;

let lastBoundsFetchTime = 0;
let activeRepressions = {};

// Inspection Selection State
let selectedMetaboliteId = null;
let selectedReactionId = null;

// Pinned Reactions state
let pinnedReactions = [];
try {
  const saved = localStorage.getItem('pinnedReactions');
  if (saved) {
    pinnedReactions = JSON.parse(saved);
  }
} catch (e) {
  console.error('[App] Failed to load pinnedReactions: ', e);
}

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
    const res = await fetch('/iJO1366.Central metabolism.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mapData = await res.json();
  } catch (error) {
    console.error('[App] Failed to load iJO1366.Central metabolism.json local asset:', error);
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

  // Load and display initial cache stats
  updateStatsUI();

  // 6. Populate Overview list initially
  populateOverviewList();
  renderPinnedReactions();

  // Restore saved GEO dataset/analysis state from localStorage
  restoreGeoStateFromLocalStorage();

  // Initialize Scenarios and AI Chat
  setupScenariosAndChat();

  // 7. Start the main game-loop
  requestAnimationFrame(gameLoop);
  console.log('[App] Metabolic Simulator bootstrapped.');
}

/**
 * High-precision Game Loop matching 60fps rendering with a semi-fixed 20Hz simulation step.
 */
let isFetchingBounds = false;
async function updateFbaBounds(currentTime) {
  if (isFetchingBounds || !simulation) return;
  isFetchingBounds = true;

  try {
    // Collect current concentrations
    const concentrations = {};
    for (const [mId, metab] of Object.entries(simulation.metabolites)) {
      concentrations[mId] = metab.concentration;
    }

    // Collect customized reaction parameters (Vmax/Km)
    const parameters = {};
    for (const [rId, rxn] of Object.entries(simulation.reactions)) {
      if (rxn.vMax !== rxn.defaultVmax || rxn.km !== rxn.defaultKm) {
        parameters[rId] = {
          vMax: rxn.vMax,
          km: rxn.km
        };
      }
    }

    const res = await fetch('/api/solve-fba', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ concentrations, parameters })
    });

    if (res.ok) {
      const data = await res.json();
      activeRepressions = data.repressed || {};
      if (data.fluxes) {
        simulation.updateFluxes(data.fluxes, data.biomass_flux);
        isDead = data.is_dead || false;
        
        // Show/hide death overlay directly
        const overlay = document.getElementById('death-overlay');
        if (overlay) {
          if (isDead) {
            overlay.classList.remove('hidden');
          } else {
            overlay.classList.add('hidden');
          }
        }
      }
    }
  } catch (err) {
    console.error('[App] Failed to solve FBA on server:', err);
  } finally {
    isFetchingBounds = false;
  }
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
  if (accumulatedTime > simTickRate * 5) {
    accumulatedTime = simTickRate * 5;
  }
  while (accumulatedTime >= simTickRate) {
    if (!isPaused && !isDead) {
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
      const biomassFlux = simulation.reactions['BIOMASS_Ecoli_core_w_GAM']?.flux || 0;
      const currentGrowth = Math.max(0.0, biomassFlux);
      growthHistory.push(currentGrowth);
      if (growthHistory.length > maxGrowthPoints) {
        growthHistory.shift();
      }
    }
    accumulatedTime -= simTickRate;
  }

  // Trigger server bounds update and FBA solve every 250ms (or 5 sim ticks)
  if (!isPaused && !isDead) {
    if (currentTime - lastBoundsFetchTime >= 250) {
      lastBoundsFetchTime = currentTime;
      updateFbaBounds(currentTime);
    }
  }

  // Render Visual Updates (radii pulsation, moving particles, highlighted states)
  renderer.renderUpdate(
    simulation.metabolites,
    simulation.reactions,
    animationFrameCount,
    isDead
  );

  // Update UI panel values (concentrations in lists, sliders, labels, active chart)
  updateUIPanelValues();

  // Check active scenario objectives
  checkScenarioObjectives();

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

  // Reset/Restart handler
  const resetHandler = () => {
    simulation.reset();
    chartHistory = [];
    isDead = false;
    const overlay = document.getElementById('death-overlay');
    if (overlay) overlay.classList.add('hidden');
    console.log('[App] Simulation state reset.');

    // Recalculate fluxes immediately on reset
    updateFbaBounds(performance.now());

    // Refresh UI parameters and inputs to default values
    renderPinnedReactions();
    if (selectedReactionId && simulation.reactions[selectedReactionId]) {
      handleReactionSelect({
        biggId: selectedReactionId,
        name: simulation.reactions[selectedReactionId].name
      });
    }
  };

  document.getElementById('reset-btn').addEventListener('click', resetHandler);
  
  const deathResetBtn = document.getElementById('death-reset-btn');
  if (deathResetBtn) {
    deathResetBtn.addEventListener('click', resetHandler);
  }

  // Mobile popup close button
  const mobileCloseBtn = document.getElementById('mobile-metab-popup-close');
  if (mobileCloseBtn) {
    mobileCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideInspector();
      if (renderer) {
        renderer.clearSelection();
      }
    });
  }

  // Speed slider
  const speedSlider = document.getElementById('speed-slider');
  const speedVal = document.getElementById('speed-val');
  speedSlider.addEventListener('input', (e) => {
    speedMultiplier = parseFloat(e.target.value);
    speedVal.textContent = `${speedMultiplier.toFixed(1)}x`;
  });

  // Global Oxygen slider
  const globalO2Slider = document.getElementById('global-o2-slider');
  const globalO2Val = document.getElementById('global-o2-val');
  if (globalO2Slider && globalO2Val) {
    globalO2Slider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      globalO2Val.textContent = val.toFixed(1);
      if (simulation && simulation.metabolites['o2_e']) {
        simulation.metabolites['o2_e'].concentration = val;
        simulation.metabolites['o2_e'].targetConcentration = val;
        updateFbaBounds(performance.now());
      }
    });
  }

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

  // Strain selector (Removed from UI, keeping placeholder metrics variables if needed)
  console.log('[App] Active model is fixed to iJO1366 server simulation.');

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
      simulation.deplete(selectedMetaboliteId);
      console.log(`[App] Depleted ${selectedMetaboliteId} to 0.1 mM`);
    }
  });

  // Copy to clipboard helper
  function setupCopyButton(btnId, spanId) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    
    const originalHTML = btn.innerHTML;
    const checkmarkHTML = `
      <svg class="copy-icon success-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;
    
    btn.addEventListener('click', async () => {
      const textToCopy = document.getElementById(spanId).textContent;
      if (!textToCopy) return;
      
      let success = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(textToCopy);
          success = true;
        } catch (err) {
          console.error('Failed to copy via navigator.clipboard: ', err);
        }
      }
      
      if (!success) {
        try {
          const textArea = document.createElement('textarea');
          textArea.value = textToCopy;
          textArea.style.position = 'fixed';
          textArea.style.opacity = '0';
          document.body.appendChild(textArea);
          textArea.select();
          const successful = document.execCommand('copy');
          document.body.removeChild(textArea);
          if (successful) {
            success = true;
          }
        } catch (err) {
          console.error('Fallback copy failed: ', err);
        }
      }
      
      if (success) {
        btn.classList.add('copied');
        btn.innerHTML = checkmarkHTML;
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = originalHTML;
        }, 1500);
      }
    });
  }

  setupCopyButton('copy-metab-bigg-btn', 'metab-bigg-id');
  setupCopyButton('copy-rxn-bigg-btn', 'rxn-bigg-id');

  // Copy Vmax button listener
  const copyVmaxBtn = document.getElementById('copy-vmax-btn');
  if (copyVmaxBtn) {
    const originalHTML = copyVmaxBtn.innerHTML;
    const checkmarkHTML = `
      <svg class="copy-icon success-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;
    copyVmaxBtn.addEventListener('click', async () => {
      if (!selectedReactionId) return;
      const vmaxTextVal = document.getElementById('vmax-val').textContent;
      const textToCopy = `${selectedReactionId} Vmax = ${vmaxTextVal}`;
      
      let success = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(textToCopy);
          success = true;
        } catch (err) {
          console.error('Failed to copy Vmax: ', err);
        }
      }
      
      if (!success) {
        try {
          const textArea = document.createElement('textarea');
          textArea.value = textToCopy;
          textArea.style.position = 'fixed';
          textArea.style.opacity = '0';
          document.body.appendChild(textArea);
          textArea.select();
          const successful = document.execCommand('copy');
          document.body.removeChild(textArea);
          if (successful) {
            success = true;
          }
        } catch (err) {
          console.error('Fallback copy failed for Vmax: ', err);
        }
      }
      
      if (success) {
        copyVmaxBtn.classList.add('copied');
        copyVmaxBtn.innerHTML = checkmarkHTML;
        setTimeout(() => {
          copyVmaxBtn.classList.remove('copied');
          copyVmaxBtn.innerHTML = originalHTML;
        }, 1500);
      }
    });
  }

  // Pin Reaction button click
  const pinBtn = document.getElementById('pin-rxn-btn');
  if (pinBtn) {
    pinBtn.addEventListener('click', () => {
      if (!selectedReactionId) return;
      
      const idx = pinnedReactions.indexOf(selectedReactionId);
      if (idx > -1) {
        pinnedReactions.splice(idx, 1);
        pinBtn.classList.remove('pinned');
        pinBtn.title = 'Pin reaction to sidebar';
      } else {
        pinnedReactions.push(selectedReactionId);
        pinBtn.classList.add('pinned');
        pinBtn.title = 'Unpin reaction';
      }
      
      localStorage.setItem('pinnedReactions', JSON.stringify(pinnedReactions));
      renderPinnedReactions();
    });
  }

  // Reaction Parameter Tweaks
  const vmaxSlider = document.getElementById('vmax-slider');
  const vmaxVal = document.getElementById('vmax-val');
  vmaxSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    vmaxVal.textContent = val.toFixed(1);
    if (selectedReactionId) {
      simulation.updateParameter(selectedReactionId, 'vMax', val);
      
      // Update pinned reaction slider if it exists
      const pinnedSlider = document.querySelector(`.pinned-vmax-slider[data-id="${selectedReactionId}"]`);
      const pinnedLabel = document.getElementById(`pinned-vmax-val-${selectedReactionId}`);
      if (pinnedSlider) pinnedSlider.value = val;
      if (pinnedLabel) pinnedLabel.textContent = val.toFixed(1);
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

  // Handle hover tooltips for GEO metabolites list items
  const geoTooltip = document.getElementById('geo-tooltip');
  const geoTooltipTitle = document.getElementById('geo-tooltip-title');
  const geoTooltipContent = document.getElementById('geo-tooltip-content');
  const geoStateDetailsPanel = document.getElementById('geo-state-details-panel');

  if (geoStateDetailsPanel && geoTooltip) {
    geoStateDetailsPanel.addEventListener('mouseover', (e) => {
      const item = e.target.closest('.geo-details-item.metabolite-item');
      if (!item) return;

      const titleName = item.getAttribute('data-tooltip-title');
      const titleText = item.getAttribute('data-tooltip-text');

      if (titleName && titleText) {
        geoTooltipTitle.textContent = titleName;
        geoTooltipContent.innerHTML = titleText.replace(/\n/g, '<br>');
        geoTooltip.classList.remove('hidden');
        geoTooltip.style.opacity = '1';
      }
    });

    geoStateDetailsPanel.addEventListener('mouseout', (e) => {
      const item = e.target.closest('.geo-details-item.metabolite-item');
      if (!item) return;
      geoTooltip.classList.add('hidden');
      geoTooltip.style.opacity = '0';
    });

    window.addEventListener('pointermove', (e) => {
      if (!geoTooltip.classList.contains('hidden')) {
        const padding = 15;
        let tx = e.clientX + padding;
        let ty = e.clientY + padding;

        if (tx + geoTooltip.offsetWidth > window.innerWidth) {
          tx = e.clientX - geoTooltip.offsetWidth - padding;
        }
        if (ty + geoTooltip.offsetHeight > window.innerHeight) {
          ty = e.clientY - geoTooltip.offsetHeight - padding;
        }

        geoTooltip.style.left = `${tx}px`;
        geoTooltip.style.top = `${ty}px`;
      }
    });
  }

  // Delegated click listener for the contributing fluxes list inside the metabolite inspector
  const metabFluxesList = document.getElementById('metab-fluxes-list');
  if (metabFluxesList) {
    metabFluxesList.addEventListener('click', (e) => {
      const row = e.target.closest('.flux-row');
      if (!row) return;
      
      const rxnId = row.getAttribute('data-rxn-id');
      if (rxnId) {
        const rxn = renderer.reactions.find(r => r.biggId === rxnId);
        if (rxn) {
          renderer.selectReaction(rxn.id);
          handleReactionSelect(rxn);
          renderer.focusOnCoordinates(rxn.labelX, rxn.labelY, 0.85);
        }
      }
    });
  }

  // Map settings dropdown toggle
  const settingsToggleBtn = document.getElementById('settings-toggle-btn');
  const settingsCloseBtn = document.getElementById('settings-close-btn');
  const settingsDropdown = document.getElementById('settings-dropdown');
  if (settingsToggleBtn && settingsDropdown) {
    settingsToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      settingsDropdown.classList.toggle('hidden');
    });
  }
  if (settingsCloseBtn && settingsDropdown) {
    settingsCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      settingsDropdown.classList.add('hidden');
    });
  }
  document.addEventListener('click', (e) => {
    if (settingsDropdown && !e.target.closest('.settings-container')) {
      settingsDropdown.classList.add('hidden');
    }
    const userDropdown = document.getElementById('user-profile-dropdown');
    if (userDropdown && !e.target.closest('.user-profile-container')) {
      userDropdown.classList.add('hidden');
      const badge = document.getElementById('user-profile-badge');
      if (badge) {
        const chevron = badge.querySelector('.chevron-icon');
        if (chevron) chevron.style.transform = 'rotate(0deg)';
      }
    }
    const reportsDropdown = document.getElementById('reports-dropdown');
    if (reportsDropdown && !e.target.closest('.reports-container')) {
      reportsDropdown.classList.add('hidden');
      const btn = document.getElementById('reports-dropdown-btn');
      if (btn) {
        const chevron = btn.querySelector('.chevron-icon');
        if (chevron) chevron.style.transform = 'rotate(0deg)';
      }
    }
  });


}

/**
 * Records hit or miss for NCBI / AI cache, saves in localStorage, and updates UI.
 */
function recordStat(category, status) {
  if (status !== 'hit' && status !== 'miss') return;
  const storageKey = `${category}_${status === 'hit' ? 'hits' : 'misses'}`;
  const currentVal = parseInt(localStorage.getItem(storageKey) || '0', 10);
  localStorage.setItem(storageKey, currentVal + 1);
  updateStatsUI();
}

/**
 * Updates UI with current cache hits/misses from localStorage.
 */
function updateStatsUI() {
  const ncbiHits = localStorage.getItem('ncbi_hits') || '0';
  const ncbiMisses = localStorage.getItem('ncbi_misses') || '0';
  const aiHits = localStorage.getItem('ai_hits') || '0';
  const aiMisses = localStorage.getItem('ai_misses') || '0';

  const docNcbiHits = document.getElementById('stat-ncbi-hits');
  const docNcbiMisses = document.getElementById('stat-ncbi-misses');
  const docAiHits = document.getElementById('stat-ai-hits');
  const docAiMisses = document.getElementById('stat-ai-misses');

  if (docNcbiHits) docNcbiHits.textContent = ncbiHits;
  if (docNcbiMisses) docNcbiMisses.textContent = ncbiMisses;
  if (docAiHits) docAiHits.textContent = aiHits;
  if (docAiMisses) docAiMisses.textContent = aiMisses;
}

/**
 * Resets all cache statistics counters.
 */
function resetStats() {
  localStorage.setItem('ncbi_hits', '0');
  localStorage.setItem('ncbi_misses', '0');
  localStorage.setItem('ai_hits', '0');
  localStorage.setItem('ai_misses', '0');
  updateStatsUI();
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
  closeChatDrawer();

  selectedMetaboliteId = node.biggId;
  selectedReactionId = null;
  chartHistory = []; // Reset history for new chart plotting

  // Swap inspector states
  document.getElementById('inspector-empty').classList.add('hidden');
  document.getElementById('inspector-reaction').classList.add('hidden');
  document.getElementById('inspector-metabolite').classList.remove('hidden');
  document.getElementById('inspector-panel').classList.remove('hidden-panel');

  // Show/Hide mobile popup depending on viewport width
  const isMobile = window.innerWidth <= 768;
  const mobilePopup = document.getElementById('mobile-metabolite-popup');
  if (mobilePopup) {
    if (isMobile) {
      mobilePopup.classList.remove('hidden');
      const mobileBiggEl = document.getElementById('mobile-metab-bigg-id-val');
      if (mobileBiggEl) {
        mobileBiggEl.textContent = node.biggId;
      }
      setTimeout(updateMobilePopupPosition, 0);
    } else {
      mobilePopup.classList.add('hidden');
    }
  }

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

  // Render fluxes list immediately on select
  populateConnectedFluxes(node.biggId);

  // Sync rows in left panel list
  updateOverviewListHighlight();
}

/**
 * Event handler triggered when a user clicks on a reaction badge in Pixi canvas.
 */
function handleReactionSelect(rxn) {
  closeChatDrawer();
  selectedReactionId = rxn.biggId;
  selectedMetaboliteId = null;
  chartHistory = [];

  // Hide mobile popup if visible
  const mobilePopup = document.getElementById('mobile-metabolite-popup');
  if (mobilePopup) {
    mobilePopup.classList.add('hidden');
  }

  // Swap inspector states
  document.getElementById('inspector-empty').classList.add('hidden');
  document.getElementById('inspector-metabolite').classList.add('hidden');
  document.getElementById('inspector-reaction').classList.remove('hidden');
  document.getElementById('inspector-panel').classList.remove('hidden-panel');

  // Fill in static metadata
  document.getElementById('rxn-name').textContent = rxn.name;
  document.getElementById('rxn-bigg-id').textContent = rxn.biggId;

  // Update pin button state
  const pinBtn = document.getElementById('pin-rxn-btn');
  if (pinBtn) {
    if (pinnedReactions.includes(rxn.biggId)) {
      pinBtn.classList.add('pinned');
      pinBtn.title = 'Unpin reaction';
    } else {
      pinBtn.classList.remove('pinned');
      pinBtn.title = 'Pin reaction to sidebar';
    }
  }

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
    const vmaxLabel = document.querySelector('label[for="vmax-slider"]');

    const repression = activeRepressions[rxn.biggId];
    const isRepressed = repression && repression.repressed;
    const lockMessage = isRepressed ? repression.reason : '';

    if (vmaxSlider && vmaxVal) {
      if (isRepressed) {
        vmaxSlider.disabled = true;
        vmaxSlider.value = 0.0;
        vmaxVal.textContent = "0.0 (Repressed)";
        if (vmaxLabel) {
          vmaxLabel.innerHTML = `Maximum Velocity (Vmax) <span style="color: #f87171; font-size: 0.85em; font-weight: 500;">${lockMessage}</span>`;
        }
      } else {
        vmaxSlider.disabled = false;
        vmaxSlider.value = simRxn.vMax;
        vmaxVal.textContent = simRxn.vMax.toFixed(1);
        if (vmaxLabel) {
          vmaxLabel.textContent = 'Maximum Velocity (Vmax)';
        }
      }
    }

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
  
  // Hide mobile popup if visible
  const mobilePopup = document.getElementById('mobile-metabolite-popup');
  if (mobilePopup) {
    mobilePopup.classList.add('hidden');
  }

  updateOverviewListHighlight();
}

function openChatDrawer() {
  const chatDrawer = document.getElementById('ai-chat-drawer');
  const chatTrigger = document.getElementById('ai-chat-trigger');
  if (chatDrawer) {
    chatDrawer.classList.remove('hidden');
    // Hide the reaction/metabolite inspector panel
    hideInspector();
  }
  if (chatTrigger) {
    chatTrigger.classList.remove('animate-bounce');
  }
  // Scroll to bottom or last scroll position
  const chatMessages = document.getElementById('ai-chat-messages');
  if (chatMessages) {
    if (lastChatScrollTop !== null) {
      chatMessages.scrollTop = lastChatScrollTop;
    } else {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }
}

function closeChatDrawer() {
  const chatDrawer = document.getElementById('ai-chat-drawer');
  if (chatDrawer && !chatDrawer.classList.contains('hidden')) {
    const chatMessages = document.getElementById('ai-chat-messages');
    if (chatMessages) {
      lastChatScrollTop = chatMessages.scrollTop;
    }
    chatDrawer.classList.add('hidden');
  }
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
  if (!container) return;
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
 * Renders the list of pinned reactions in the left sidebar.
 */
function renderPinnedReactions() {
  const container = document.getElementById('pinned-reactions-container');
  if (!container) return;
  
  if (pinnedReactions.length === 0) {
    container.innerHTML = `
      <div class="pinned-placeholder">
        No pinned reactions. Click the 📌 icon in the reaction inspector to pin.
      </div>
    `;
    return;
  }
  
  container.innerHTML = '';
  
  pinnedReactions.forEach(rxnId => {
    const rxn = simulation.reactions[rxnId];
    if (!rxn) return;
    
    const row = document.createElement('div');
    row.className = 'pinned-row';
    row.id = `pinned-row-${rxnId}`;
    
    const repression = activeRepressions[rxnId];
    const isRepressed = repression && repression.repressed;

    const vmaxVal = isRepressed ? 0.0 : (rxn.vMax !== undefined ? rxn.vMax : 15.0);
    const fluxVal = rxn.flux !== undefined ? rxn.flux.toFixed(2) : '0.00';
    const disabledAttr = isRepressed ? 'disabled' : '';
    const labelText = isRepressed ? '0.0 (Repressed)' : vmaxVal.toFixed(1);
    
    row.innerHTML = `
      <div class="pinned-row-header">
        <div class="pinned-row-title-container">
          <span class="pinned-rxn-name" title="${rxn.name}">${rxn.name}</span>
          <span class="pinned-rxn-id code-font">${rxnId}</span>
        </div>
        <div class="pinned-row-actions">
          <button class="btn-focus-pinned" data-id="${rxnId}" title="Focus on map">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
          </button>
          <button class="btn-unpin-pinned" data-id="${rxnId}" title="Unpin reaction">✕</button>
        </div>
      </div>
      <div class="pinned-row-body">
        <div class="pinned-flux-container">
          <span class="pinned-flux-label">Flux:</span>
          <span class="pinned-flux-val code-font" id="pinned-flux-${rxnId}">${fluxVal} mM/s</span>
        </div>
        <div class="pinned-slider-container">
          <span class="pinned-slider-label">
            <span>Vmax:</span>
            <span id="pinned-vmax-val-${rxnId}" class="code-font">${labelText}</span>
          </span>
          <input type="range" class="pinned-vmax-slider" data-id="${rxnId}" min="0.0" max="100.0" step="0.5" value="${vmaxVal}" ${disabledAttr} />
        </div>
      </div>
    `;
    
    // Setup focus button event
    row.querySelector('.btn-focus-pinned').addEventListener('click', (e) => {
      e.stopPropagation();
      const id = rxnId;
      const rBadge = renderer.rxnBadges[id];
      if (rBadge) {
        const fakeRxn = { biggId: id, name: rxn.name };
        handleReactionSelect(fakeRxn);
        if (renderer.focusOnCoordinates) {
          renderer.focusOnCoordinates(rBadge.x, rBadge.y);
        }
      }
    });
    
    // Setup unpin button event
    row.querySelector('.btn-unpin-pinned').addEventListener('click', (e) => {
      e.stopPropagation();
      const id = rxnId;
      const idx = pinnedReactions.indexOf(id);
      if (idx > -1) {
        pinnedReactions.splice(idx, 1);
        localStorage.setItem('pinnedReactions', JSON.stringify(pinnedReactions));
        renderPinnedReactions();
        
        if (selectedReactionId === id) {
          const mainPinBtn = document.getElementById('pin-rxn-btn');
          if (mainPinBtn) {
            mainPinBtn.classList.remove('pinned');
            mainPinBtn.title = 'Pin reaction to sidebar';
          }
        }
      }
    });
    
    // Setup Vmax slider event
    const slider = row.querySelector('.pinned-vmax-slider');
    const label = row.querySelector(`#pinned-vmax-val-${rxnId}`);
    slider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      label.textContent = val.toFixed(1);
      simulation.updateParameter(rxnId, 'vMax', val);
      
      if (selectedReactionId === rxnId) {
        const vmaxSlider = document.getElementById('vmax-slider');
        const vmaxValText = document.getElementById('vmax-val');
        if (vmaxSlider) vmaxSlider.value = val;
        if (vmaxValText) vmaxValText.textContent = val.toFixed(1);
      }
    });
    
    container.appendChild(row);
  });
}

/**
 * Per-frame update of UI texts, progress bars, charts, and inspector dials.
 */
function updateUIPanelValues() {
  // Sync global oxygen slider value
  const globalO2Slider = document.getElementById('global-o2-slider');
  const globalO2Val = document.getElementById('global-o2-val');
  if (globalO2Slider && globalO2Val && simulation && simulation.metabolites['o2_e']) {
    const currentO2 = simulation.metabolites['o2_e'].concentration;
    if (document.activeElement !== globalO2Slider) {
      globalO2Slider.value = currentO2;
      globalO2Val.textContent = currentO2.toFixed(1);
    }
  }

  // Update live fluxes of pinned reactions
  pinnedReactions.forEach(rxnId => {
    const rxn = simulation.reactions[rxnId];
    const fluxEl = document.getElementById(`pinned-flux-${rxnId}`);
    if (rxn && fluxEl) {
      fluxEl.textContent = `${rxn.flux.toFixed(2)} mM/s`;
    }

    // Dynamic slider locking/repression state for pinned reactions
    if (rxn) {
      const repression = activeRepressions[rxnId];
      const isRepressed = repression && repression.repressed;

      const pinnedSlider = document.querySelector(`.pinned-vmax-slider[data-id="${rxnId}"]`);
      const pinnedLabel = document.getElementById(`pinned-vmax-val-${rxnId}`);
      if (pinnedSlider && pinnedLabel) {
        if (isRepressed) {
          pinnedSlider.disabled = true;
          pinnedSlider.value = 0.0;
          pinnedLabel.textContent = "0.0 (Repressed)";
        } else {
          pinnedSlider.disabled = false;
          if (document.activeElement !== pinnedSlider) {
            pinnedSlider.value = rxn.vMax;
            pinnedLabel.textContent = rxn.vMax.toFixed(1);
          }
        }
      }
    }
  });

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

      // Update mobile popup values/chart if popup is visible
      const isMobile = window.innerWidth <= 768;
      if (isMobile) {
        const mobilePopup = document.getElementById('mobile-metabolite-popup');
        if (mobilePopup && !mobilePopup.classList.contains('hidden')) {
          updateMobilePopupPosition();
          
          const mobileValEl = document.getElementById('mobile-metab-conc-val');
          if (mobileValEl) {
            mobileValEl.textContent = info.concentration.toFixed(2);
          }
          
          drawMobileChart();
        }
      }

      // Render fluxes contributors list every 10 frames to prevent DOM thrashing and preserve click responsiveness
      if (animationFrameCount % 10 === 0) {
        populateConnectedFluxes(selectedMetaboliteId);
      }
    }
  } else if (selectedReactionId) {
    const rxn = simulation.reactions[selectedReactionId];
    if (rxn) {
      const absFlux = Math.abs(rxn.flux);
      document.getElementById('rxn-flux-val').textContent = `${rxn.flux.toFixed(2)} mM/s`;

      // Update slider state dynamically (e.g. MALS/ICL/PFL/PDH repression)
      const repression = activeRepressions[selectedReactionId];
      const isRepressed = repression && repression.repressed;
      const lockMessage = isRepressed ? repression.reason : '';
      
      const vmaxSlider = document.getElementById('vmax-slider');
      const vmaxVal = document.getElementById('vmax-val');
      const vmaxLabel = document.querySelector('label[for="vmax-slider"]');

      if (vmaxSlider && vmaxVal) {
        if (isRepressed) {
          vmaxSlider.disabled = true;
          vmaxSlider.value = 0.0;
          vmaxVal.textContent = "0.0 (Repressed)";
          if (vmaxLabel) {
            vmaxLabel.innerHTML = `Maximum Velocity (Vmax) <span style="color: #f87171; font-size: 0.85em; font-weight: 500;">${lockMessage}</span>`;
          }
        } else {
          vmaxSlider.disabled = false;
          if (document.activeElement !== vmaxSlider) {
            vmaxSlider.value = rxn.vMax;
            vmaxVal.textContent = rxn.vMax.toFixed(1);
          }
          if (vmaxLabel) {
            vmaxLabel.textContent = 'Maximum Velocity (Vmax)';
          }
        }
      }

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
  const biomassFlux = simulation.reactions['BIOMASS_Ecoli_core_w_GAM']?.flux || 0;
  const currentGrowth = Math.max(0.0, biomassFlux);
  document.getElementById('metric-growth').textContent = `${currentGrowth.toFixed(2)} hr⁻¹`;

  // Update ATP yield dynamically based on active ATP synthesis rate (ATPS4r flux)
  const atpsFlux = Math.max(0.0, Math.abs(simulation.reactions['ATPS4r']?.flux || 0));
  const currentAtpYield = atpsFlux;
  document.getElementById('metric-atp').textContent = `${currentAtpYield.toFixed(1)} mM/s`;

  // Draw growth rate trend line
  drawGrowthSparkline();

  // Update scenario expected concentrations list if displayed
  document.querySelectorAll('.geo-details-item.metabolite-item').forEach(el => {
    const id = el.getAttribute('data-bigg-id');
    const simMetab = simulation.metabolites[id];
    if (simMetab) {
      const valEl = el.querySelector('.geo-details-value');
      const nameEl = el.querySelector('.geo-details-name');
      
      if (valEl) {
        let expectedConc = el.getAttribute('data-expected-conc');
        if (!expectedConc) {
          expectedConc = valEl.textContent.replace(' mM', '').trim();
          el.setAttribute('data-expected-conc', expectedConc);
        }
        const exp = Number(expectedConc);
        const cur = simMetab.concentration;
        const diffRatio = Math.abs(cur - exp) / Math.max(0.1, exp);

        const isMismatch = diffRatio > 0.15;
        const curColor = isMismatch ? '#f87171' : '#34d399'; // red vs green
        const nameColor = isMismatch ? '#f87171' : '';

        if (nameEl) {
          nameEl.style.color = nameColor;
        }

        // Generate dynamic educational advice
        const displayName = simMetab.name || id;
        let tooltipText = '';
        if (!isMismatch) {
          tooltipText = `Model matches experimental target (deviation: ${(diffRatio * 100).toFixed(0)}%).`;
        } else {
          // Find consuming and producing reactions
          const contributors = [];
          for (const rxn of Object.values(simulation.reactions)) {
            const coeff = rxn.stoichiometry ? rxn.stoichiometry[id] : undefined;
            if (coeff) {
              contributors.push({ id: rxn.id, name: rxn.name, coeff: coeff });
            }
          }
          
          const producers = contributors.filter(c => c.coeff > 0).map(c => `${c.name || c.id} (${c.id})`);
          const consumers = contributors.filter(c => c.coeff < 0).map(c => `${c.name || c.id} (${c.id})`);

          if (cur > exp) {
            const consStr = consumers.slice(0, 2).join(', ') || 'consuming pathways';
            tooltipText = `Model predicts accumulation of ${displayName}.\nCheck the activity of consuming enzymes like: ${consStr}.`;
          } else {
            const prodStr = producers.slice(0, 2).join(', ') || 'producing pathways';
            tooltipText = `Model predicts deficit of ${displayName}.\nCheck the activity of producing enzymes like: ${prodStr}.`;
          }
        }

        // Set tooltip data attributes and remove native title
        el.setAttribute('data-tooltip-title', displayName);
        el.setAttribute('data-tooltip-text', tooltipText);
        el.removeAttribute('title');

        valEl.innerHTML = `Cur: <span style="font-weight: 600; color: ${curColor};">${cur.toFixed(2)}</span> <span style="color: #94a3b8; font-size: 0.85em;">/ Exp: ${expectedConc} mM</span>`;
      }
    }
  });
}

/**
 * Draws connected producing and consuming reactions inside inspector.
 */
function populateConnectedFluxes(metabId) {
  const container = document.getElementById('metab-fluxes-list');
  container.innerHTML = '';

  const contributors = [];

  for (const rxn of Object.values(simulation.reactions)) {
    const coeff = rxn.stoichiometry ? rxn.stoichiometry[metabId] : undefined;
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
    row.setAttribute('data-rxn-id', item.id);
    
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

/**
 * Dynamically positions the mobile metabolite popup next to the selected metabolite.
 */
function updateMobilePopupPosition() {
  if (!selectedMetaboliteId || !renderer) return;

  const node = renderer.metabNodes.find(n => n.biggId === selectedMetaboliteId);
  if (!node) return;

  const mobilePopup = document.getElementById('mobile-metabolite-popup');
  if (!mobilePopup) return;

  const canvas = renderer.canvas;
  const rect = canvas.getBoundingClientRect();

  // Convert metabolite's world coordinates to screen/canvas coordinates
  const screenX = node.x * renderer.zoom + renderer.viewport.x;
  const screenY = node.y * renderer.zoom + renderer.viewport.y;

  // Absolute positioning relative to document body/viewport wrapper
  const tx = screenX + rect.left;
  const ty = screenY + rect.top;

  const popupW = 170;
  const popupH = 100; // estimated height
  const padding = 8;

  let left = tx - popupW / 2;
  let top = ty - popupH - 25; // 25px above metabolite center

  // Clamp horizontal coordinate to stay within screen boundaries
  if (left < padding) left = padding;
  if (left + popupW > window.innerWidth - padding) {
    left = window.innerWidth - popupW - padding;
  }

  // Vertical position check: flip below metabolite if it goes above top screen edge
  if (top < padding) {
    top = ty + 25; // position below
  }
  
  // Check if it goes off bottom screen edge
  if (top + popupH > window.innerHeight - padding) {
    top = window.innerHeight - popupH - padding;
  }

  mobilePopup.style.left = `${left}px`;
  mobilePopup.style.top = `${top}px`;
}

/**
 * Renders a compact concentration history line chart in the mobile popup.
 */
function drawMobileChart() {
  const canvas = document.getElementById('mobile-metab-chart');
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  
  // Skip drawing if container is hidden/has 0 width
  if (rect.width === 0) return;

  canvas.width = rect.width * dpr;
  canvas.height = 60 * dpr; // hardcoded canvas height

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = 60;

  ctx.clearRect(0, 0, w, h);

  if (chartHistory.length < 2) {
    ctx.fillStyle = '#64748b';
    ctx.font = '10px "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Loading history...', w / 2, h / 2);
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
  maxVal = Math.max(1.0, maxVal);

  const paddingY = 8;
  const plotH = h - paddingY * 2;
  const plotW = w - 6;

  // 1. Draw grid background lines (2 horizontal lines)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 2; i++) {
    const yGrid = paddingY + (plotH / 2) * i;
    ctx.moveTo(0, yGrid);
    ctx.lineTo(w, yGrid);
  }
  ctx.stroke();

  // 2. Plot concentration curve line
  ctx.strokeStyle = '#34d399'; // Minty green
  ctx.lineWidth = 2;
  ctx.beginPath();

  chartHistory.forEach((val, i) => {
    const x = (i / (maxChartPoints - 1)) * plotW;
    const y = paddingY + plotH - ((val - minVal) / (maxVal - minVal)) * plotH;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  // 3. Draw gradient filled area under the line
  const lastIdx = chartHistory.length - 1;
  const grad = ctx.createLinearGradient(0, paddingY, 0, h - paddingY);
  grad.addColorStop(0, 'rgba(52, 211, 153, 0.15)');
  grad.addColorStop(1, 'rgba(52, 211, 153, 0.0)');

  ctx.fillStyle = grad;
  ctx.lineTo((lastIdx / (maxChartPoints - 1)) * plotW, h - paddingY);
  ctx.lineTo(0, h - paddingY);
  ctx.closePath();
  ctx.fill();

  // 4. Draw glowing current value dot at the tip
  const lastVal = chartHistory[lastIdx];
  const lastX = (lastIdx / (maxChartPoints - 1)) * plotW;
  const lastY = paddingY + plotH - ((lastVal - minVal) / (maxVal - minVal)) * plotH;

  ctx.fillStyle = '#ffffff';
  ctx.shadowBlur = 6;
  ctx.shadowColor = '#34d399';
  ctx.beginPath();
  ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
  ctx.fill();

  // Reset shadow
  ctx.shadowBlur = 0;
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

  const leftMargin = 32;
  const rightMargin = 4;
  const topPad = 6;
  const bottomPad = 6;

  const plotH = h - (topPad + bottomPad);
  const plotW = w - (leftMargin + rightMargin);

  // Draw dashed baseline guides
  growthCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  growthCtx.lineWidth = 1;
  growthCtx.setLineDash([2, 2]);

  // Top guide
  growthCtx.beginPath();
  growthCtx.moveTo(leftMargin, topPad);
  growthCtx.lineTo(w - rightMargin, topPad);
  growthCtx.stroke();

  // Bottom guide
  growthCtx.beginPath();
  growthCtx.moveTo(leftMargin, h - bottomPad);
  growthCtx.lineTo(w - rightMargin, h - bottomPad);
  growthCtx.stroke();

  // Clear line dash for drawing the curve
  growthCtx.setLineDash([]);

  // Draw Y-axis labels on the left
  growthCtx.fillStyle = '#64748b';
  growthCtx.font = '8px "JetBrains Mono", monospace';
  growthCtx.textBaseline = 'middle';
  growthCtx.textAlign = 'right';
  growthCtx.fillText(maxVal.toFixed(2), leftMargin - 4, topPad);
  growthCtx.fillText(minVal.toFixed(2), leftMargin - 4, h - bottomPad);

  // Draw the trend sparkline curve
  growthCtx.strokeStyle = '#34d399';
  growthCtx.lineWidth = 1.5;
  growthCtx.beginPath();

  growthHistory.forEach((val, i) => {
    const x = leftMargin + (i / (maxGrowthPoints - 1)) * plotW;
    const y = topPad + (1 - (val - minVal) / (maxVal - minVal)) * plotH;

    if (i === 0) {
      growthCtx.moveTo(x, y);
    } else {
      growthCtx.lineTo(x, y);
    }
  });
  growthCtx.stroke();

  // Fill gradient area below the curve
  const lastIdx = growthHistory.length - 1;
  const grad = growthCtx.createLinearGradient(0, topPad, 0, h - bottomPad);
  grad.addColorStop(0, 'rgba(52, 211, 153, 0.12)');
  grad.addColorStop(1, 'rgba(52, 211, 153, 0.0)');

  growthCtx.fillStyle = grad;
  growthCtx.lineTo(leftMargin + (lastIdx / (maxGrowthPoints - 1)) * plotW, h - bottomPad);
  growthCtx.lineTo(leftMargin, h - bottomPad);
  growthCtx.closePath();
  growthCtx.fill();

  // Draw the last value point marker
  const lastVal = growthHistory[lastIdx];
  const lastX = leftMargin + (lastIdx / (maxGrowthPoints - 1)) * plotW;
  const lastY = topPad + (1 - (lastVal - minVal) / (maxVal - minVal)) * plotH;

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

  // Setup selected dataset AI analysis actions
  const geoAnalyzeBtn = document.getElementById('geo-analyze-btn');
  const geoStateSelect = document.getElementById('geo-state-select');
  const geoStateDesc = document.getElementById('geo-state-desc');

  if (geoAnalyzeBtn) {
    geoAnalyzeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      performGeoAnalysis();
    });
  }

  const geoStateDetailsBtn = document.getElementById('geo-state-details-btn');
  const geoStateDetailsPanel = document.getElementById('geo-state-details-panel');

  if (geoStateDetailsBtn && geoStateDetailsPanel) {
    geoStateDetailsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = geoStateDetailsPanel.classList.contains('hidden');
      if (isHidden) {
        geoStateDetailsPanel.classList.remove('hidden');
        geoStateDetailsBtn.textContent = 'Hide Details';
      } else {
        geoStateDetailsPanel.classList.add('hidden');
        geoStateDetailsBtn.textContent = 'Show Details';
      }
      saveGeoStateToLocalStorage();
    });

    geoStateDetailsPanel.addEventListener('click', (e) => {
      const item = e.target.closest('.geo-details-item.interactive');
      if (!item) return;

      const biggId = item.dataset.biggId;
      const type = item.dataset.type;

      if (type === 'metabolite') {
        const node = renderer.metabNodes.find(n => n.biggId === biggId);
        if (node) {
          renderer.selectMetabolite(node.id);
          handleMetaboliteSelect(node);
          renderer.focusOnCoordinates(node.x, node.y, 0.85);
        }
      } else if (type === 'reaction') {
        const rxn = renderer.reactions.find(r => r.biggId === biggId);
        if (rxn) {
          renderer.selectReaction(rxn.id);
          handleReactionSelect(rxn);
          renderer.focusOnCoordinates(rxn.labelX, rxn.labelY, 0.85);
        }
      }
    });
  }

  if (geoStateSelect) {
    geoStateSelect.addEventListener('change', (e) => {
      const selectedIndex = e.target.value;
      if (geoSelectedDataset && geoSelectedDataset.analysisStates && geoSelectedDataset.analysisStates[selectedIndex]) {
        const state = geoSelectedDataset.analysisStates[selectedIndex];
        if (geoStateDesc) geoStateDesc.textContent = state.description || '';
        applyMetabolicState(state);
        renderStateDetails(state);
        saveGeoStateToLocalStorage();
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

    if (data.cacheStatus) {
      recordStat('ncbi', data.cacheStatus);
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
 * Saves current GEO dataset and condition state to localStorage.
 */
function saveGeoStateToLocalStorage() {
  try {
    if (!geoSelectedDataset) {
      localStorage.removeItem('activeGeoState');
      return;
    }

    const geoStateSelect = document.getElementById('geo-state-select');
    const geoStateDetailsPanel = document.getElementById('geo-state-details-panel');

    const stateToSave = {
      dataset: {
        accession: geoSelectedDataset.accession,
        title: geoSelectedDataset.title,
        summary: geoSelectedDataset.summary,
        analysisStates: geoSelectedDataset.analysisStates || null
      },
      selectedStateIndex: geoStateSelect ? parseInt(geoStateSelect.value, 10) : 0,
      showDetails: geoStateDetailsPanel ? !geoStateDetailsPanel.classList.contains('hidden') : false
    };

    localStorage.setItem('activeGeoState', JSON.stringify(stateToSave));
    console.log('[GEO] Saved active state to localStorage.');
  } catch (e) {
    console.error('[GEO] Failed to save state to localStorage:', e);
  }
}

/**
 * Restores GEO dataset and condition state from localStorage on startup.
 */
function restoreGeoStateFromLocalStorage() {
  try {
    const savedStr = localStorage.getItem('activeGeoState');
    if (!savedStr) return;

    const saved = JSON.parse(savedStr);
    if (!saved || !saved.dataset) return;

    console.log('[GEO] Restoring saved dataset state:', saved.dataset.accession);

    // 1. Select the dataset
    geoSelectedDataset = saved.dataset;
    const geoSelectedPanel = document.getElementById('geo-selected-dataset');
    const geoSelectedAccession = document.getElementById('geo-selected-accession');
    const geoSelectedTitle = document.getElementById('geo-selected-title');
    const geoSelectedSummary = document.getElementById('geo-selected-summary');
    const geoSelectedReadMore = document.getElementById('geo-selected-read-more');

    if (geoSelectedPanel) {
      geoSelectedAccession.textContent = saved.dataset.accession || 'N/A';
      geoSelectedTitle.textContent = saved.dataset.title || 'Untitled Dataset';
      geoSelectedSummary.textContent = saved.dataset.summary || 'No description available.';
      
      geoSelectedSummary.classList.add('collapsed');
      if (geoSelectedReadMore) {
        geoSelectedReadMore.textContent = 'Read Description';
        if (!saved.dataset.summary || saved.dataset.summary.length < 120) {
          geoSelectedReadMore.style.display = 'none';
          geoSelectedSummary.classList.remove('collapsed');
        } else {
          geoSelectedReadMore.style.display = 'block';
        }
      }

      // Hide analyze button and show results if already analyzed
      const geoAnalyzeBtn = document.getElementById('geo-analyze-btn');
      const geoAnalysisLoading = document.getElementById('geo-analysis-loading');
      const geoAnalysisResults = document.getElementById('geo-analysis-results');
      const geoStateSelect = document.getElementById('geo-state-select');
      const geoStateDesc = document.getElementById('geo-state-desc');
      const geoStateDetailsPanel = document.getElementById('geo-state-details-panel');
      const geoStateDetailsBtn = document.getElementById('geo-state-details-btn');

      if (saved.dataset.analysisStates && saved.dataset.analysisStates.length > 0) {
        if (geoAnalyzeBtn) geoAnalyzeBtn.classList.add('hidden');
        if (geoAnalysisLoading) geoAnalysisLoading.classList.add('hidden');
        if (geoAnalysisResults) geoAnalysisResults.classList.remove('hidden');

        // Populate dropdown
        if (geoStateSelect) {
          geoStateSelect.innerHTML = '';
          saved.dataset.analysisStates.forEach((state, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = state.name;
            geoStateSelect.appendChild(option);
          });

          const indexToSelect = Math.min(saved.selectedStateIndex || 0, saved.dataset.analysisStates.length - 1);
          geoStateSelect.value = indexToSelect;

          const state = saved.dataset.analysisStates[indexToSelect];
          if (state) {
            if (geoStateDesc) geoStateDesc.textContent = state.description || '';
            applyMetabolicState(state);
            renderStateDetails(state);
          }
        }

        // Restore details panel visibility
        if (saved.showDetails && geoStateDetailsPanel && geoStateDetailsBtn) {
          geoStateDetailsPanel.classList.remove('hidden');
          geoStateDetailsBtn.textContent = 'Hide Details';
        }
      } else {
        if (geoAnalyzeBtn) geoAnalyzeBtn.classList.remove('hidden');
        if (geoAnalysisLoading) geoAnalysisLoading.classList.add('hidden');
        if (geoAnalysisResults) geoAnalysisResults.classList.add('hidden');
        resetStateDetails();
      }

      geoSelectedPanel.classList.remove('hidden');
    }
  } catch (e) {
    console.error('[GEO] Failed to restore saved state from localStorage:', e);
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

  // Reset AI analysis panel elements
  const geoAnalyzeBtn = document.getElementById('geo-analyze-btn');
  const geoAnalysisLoading = document.getElementById('geo-analysis-loading');
  const geoAnalysisResults = document.getElementById('geo-analysis-results');
  if (geoAnalyzeBtn) geoAnalyzeBtn.classList.remove('hidden');
  if (geoAnalysisLoading) geoAnalysisLoading.classList.add('hidden');
  if (geoAnalysisResults) geoAnalysisResults.classList.add('hidden');
  resetStateDetails();

  geoSelectedPanel.classList.remove('hidden');
  console.log(`[GEO] Selected active dataset: ${dataset.accession}`);
  saveGeoStateToLocalStorage();
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

  // Reset AI analysis panel elements
  const geoAnalyzeBtn = document.getElementById('geo-analyze-btn');
  const geoAnalysisLoading = document.getElementById('geo-analysis-loading');
  const geoAnalysisResults = document.getElementById('geo-analysis-results');
  if (geoAnalyzeBtn) geoAnalyzeBtn.classList.remove('hidden');
  if (geoAnalysisLoading) geoAnalysisLoading.classList.add('hidden');
  if (geoAnalysisResults) geoAnalysisResults.classList.add('hidden');
  resetStateDetails();

  console.log('[GEO] Deselected active dataset.');
  saveGeoStateToLocalStorage();
}

/**
 * Sends a POST request to analyze the active GEO dataset with Gemini.
 * Parses metabolic states, populates the dropdown select menu, and applies simulation overrides.
 */
async function performGeoAnalysis() {
  if (!geoSelectedDataset) return;

  const geoAnalyzeBtn = document.getElementById('geo-analyze-btn');
  const geoAnalysisLoading = document.getElementById('geo-analysis-loading');
  const geoAnalysisResults = document.getElementById('geo-analysis-results');
  const geoStateSelect = document.getElementById('geo-state-select');
  const geoStateDesc = document.getElementById('geo-state-desc');
  const geoStatusText = document.getElementById('geo-analysis-status');

  if (geoAnalyzeBtn) geoAnalyzeBtn.classList.add('hidden');
  if (geoAnalysisLoading) geoAnalysisLoading.classList.remove('hidden');
  if (geoAnalysisResults) geoAnalysisResults.classList.add('hidden');

  try {
    // Step 1/3: Fetch metadata & designs from NCBI GEO
    if (geoStatusText) geoStatusText.textContent = "Step 1/3: Fetching series design from NCBI...";
    const initResponse = await fetch('/api/analyze-dataset/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        accession: geoSelectedDataset.accession
      })
    });

    if (!initResponse.ok) {
      let errMsg = initResponse.statusText;
      try {
        const errData = await initResponse.json();
        if (errData && errData.error) errMsg = errData.error;
      } catch (e) {}
      throw new Error(`NCBI metadata query failed: ${errMsg}`);
    }

    const initData = await initResponse.json();
    if (initData.error) {
      throw new Error(initData.error);
    }

    if (initData.cacheStatus) {
      recordStat('ncbi', initData.cacheStatus);
    }

    const overallDesign = initData.overallDesign || '';
    const supplementaryUrls = initData.supplementaryUrls || [];

    // Step 2/3: Download and filter expression files
    if (geoStatusText) geoStatusText.textContent = "Step 2/3: Downloading & filtering supplementary file...";
    let fileName = '';
    let fileSnippet = '';

    if (supplementaryUrls.length > 0) {
      const snippetResponse = await fetch('/api/analyze-dataset/snippet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          supplementaryUrls
        })
      });

      if (snippetResponse.ok) {
        const snippetData = await snippetResponse.json();
        if (!snippetData.error) {
          fileName = snippetData.fileName || '';
          fileSnippet = snippetData.fileSnippet || '';
          if (snippetData.cacheStatus) {
            recordStat('ncbi', snippetData.cacheStatus);
          }
        }
      }
    }

    // Step 3/3: Run Dataset Analysis
    if (geoStatusText) geoStatusText.textContent = "Step 3/3: Identifying metabolic states...";
    const geminiResponse = await fetch('/api/analyze-dataset/gemini', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        accession: geoSelectedDataset.accession,
        title: geoSelectedDataset.title,
        summary: geoSelectedDataset.summary,
        overallDesign,
        fileName,
        fileSnippet
      })
    });

    if (!geminiResponse.ok) {
      let errMsg = geminiResponse.statusText;
      try {
        const errData = await geminiResponse.json();
        if (errData && errData.error) errMsg = errData.error;
      } catch (e) {}
      throw new Error(`AI model query failed: ${errMsg}`);
    }

    const geminiData = await geminiResponse.json();
    if (geminiData.cacheStatus) {
      recordStat('ai', geminiData.cacheStatus);
    }
    if (geminiData.error) {
      throw new Error(geminiData.error);
    }

    if (geoAnalysisLoading) geoAnalysisLoading.classList.add('hidden');

    if (!geminiData.canMap || !geminiData.states || geminiData.states.length === 0) {
      alert('Analysis concluded that these conditions cannot be mapped to the core metabolic model (or no relevant data points were extracted).');
      if (geoAnalyzeBtn) geoAnalyzeBtn.classList.remove('hidden');
      return;
    }

    // Store analysis states in active dataset
    geoSelectedDataset.analysisStates = geminiData.states;

    // Populate dropdown options
    if (geoStateSelect) {
      geoStateSelect.innerHTML = '';
      geminiData.states.forEach((state, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = state.name;
        geoStateSelect.appendChild(option);
      });

      // Display first state and apply it
      if (geminiData.states.length > 0) {
        if (geoStateDesc) geoStateDesc.textContent = geminiData.states[0].description || '';
        applyMetabolicState(geminiData.states[0]);
        renderStateDetails(geminiData.states[0]);
      }
    }

    // Display usage statistics
    if (geminiData.usage) {
      const usageEl = document.getElementById('geo-analysis-usage');
      if (usageEl) {
        const u = geminiData.usage;
        let usageText = `Sent: ${(u.sentCharacters / 1024).toFixed(1)} KB`;
        if (u.promptTokens) usageText += ` (${u.promptTokens} tokens)`;
        usageText += ` | Received: ${(u.receivedCharacters / 1024).toFixed(1)} KB`;
        if (u.completionTokens) usageText += ` (${u.completionTokens} tokens)`;
        usageEl.textContent = usageText;
        usageEl.classList.remove('hidden');
      }
    }

    if (geoAnalysisResults) geoAnalysisResults.classList.remove('hidden');
    console.log('[GEO] Analysis completed successfully.');
    saveGeoStateToLocalStorage();

  } catch (err) {
    console.error('[GEO Analysis Error] ', err);
    if (geoAnalysisLoading) geoAnalysisLoading.classList.add('hidden');
    if (geoAnalyzeBtn) geoAnalyzeBtn.classList.remove('hidden');
    alert(`Analysis failed: ${err.message || 'Unknown network error'}`);
  }
}

/**
 * Overwrites metabolite concentrations and reaction parameters in the simulation,
 * and zooms/centers camera focus on the target pathways.
 */
function applyMetabolicState(state) {
  if (!simulation || !state || !state.data) return;

  // 1. Apply metabolite concentrations (Skipped: concentrations evolve dynamically based on reaction parameters)
  if (state.data.metabolites) {
    for (const [id, conc] of Object.entries(state.data.metabolites)) {
      console.log(`[GEO AI] Expected scenario concentration of ${id} is ${conc} mM (calculating dynamically)`);
    }
  }

  // 2. Apply reaction parameters (vMax, km)
  if (state.data.reactions) {
    for (const [id, params] of Object.entries(state.data.reactions)) {
      if (simulation.reactions[id]) {
        if (typeof params === 'object') {
          if (params.vMax !== undefined) {
            simulation.updateParameter(id, 'vMax', Number(params.vMax));
            console.log(`[GEO AI] Set vMax of ${id} to ${params.vMax}`);
          }
          if (params.km !== undefined) {
            simulation.updateParameter(id, 'km', Number(params.km));
            console.log(`[GEO AI] Set km of ${id} to ${params.km}`);
          }
        } else {
          simulation.updateParameter(id, 'vMax', Number(params));
          console.log(`[GEO AI] Set vMax of ${id} to ${params}`);
        }
      }
    }
  }

  // 3. Zoom/Center and highlight relevant metabolites (Disabled as per user request to prevent camera jumping)
  /*
  if (renderer && state.focusMetaboliteIds && state.focusMetaboliteIds.length > 0) {
    const focusSet = new Set(state.focusMetaboliteIds);
    
    // Zoom/Center camera on pathway
    renderer.focusOnPathway(focusSet);

    // Auto-select the first highlighted metabolite in the inspector sidebar
    if (renderer.metabNodes) {
      const matchedNode = renderer.metabNodes.find(n => focusSet.has(n.biggId));
      if (matchedNode) {
        renderer.selectMetabolite(matchedNode.id);
        handleMetaboliteSelect(matchedNode);
      }
    }
  }
   */
}

/**
 * Renders a structured text checklist of reaction parameters and metabolite concentration modifications
 * applied by the selected metabolic condition state.
 */
function renderStateDetails(state) {
  const panel = document.getElementById('geo-state-details-panel');
  if (!panel) return;

  if (!state || !state.data) {
    panel.innerHTML = '<div style="text-align: center; color: #64748b; padding: 4px 0;">No conditions mapping details available.</div>';
    return;
  }

  let html = '';

  // 1. Render reactions modifications
  if (state.data.reactions && Object.keys(state.data.reactions).length > 0) {
    html += '<div class="geo-details-section-title">Reactions (Enzymatic Rates)</div>';
    html += '<ul class="geo-details-list">';
    for (const [id, params] of Object.entries(state.data.reactions)) {
      const simRxn = simulation ? simulation.reactions[id] : null;
      const displayName = simRxn ? `${simRxn.name} (${id})` : id;
      
      let valStr = '';
      if (typeof params === 'object') {
        const parts = [];
        if (params.vMax !== undefined) parts.push(`Vmax: ${params.vMax}`);
        if (params.km !== undefined) parts.push(`Km: ${params.km}`);
        valStr = parts.join(', ');
      } else {
        valStr = `Vmax: ${params}`;
      }
      
      html += `
        <li class="geo-details-item reaction-item interactive" data-bigg-id="${id}" data-type="reaction" title="Click to view on map: ${displayName}">
          <span class="geo-details-name">${displayName}</span>
          <span class="geo-details-value">${valStr}</span>
        </li>
      `;
    }
    html += '</ul>';
  }

  // 2. Render metabolites modifications
  if (state.data.metabolites && Object.keys(state.data.metabolites).length > 0) {
    html += '<div class="geo-details-section-title">Metabolites (Concentrations)</div>';
    html += '<ul class="geo-details-list">';
    for (const [id, conc] of Object.entries(state.data.metabolites)) {
      const simMetab = simulation ? simulation.metabolites[id] : null;
      const displayName = simMetab ? `${simMetab.name} (${id})` : id;
      
      html += `
        <li class="geo-details-item metabolite-item interactive" data-bigg-id="${id}" data-type="metabolite">
          <span class="geo-details-name">${displayName}</span>
          <span class="geo-details-value metabolite-val">${conc} mM</span>
        </li>
      `;
    }
    html += '</ul>';
  }

  if (!html) {
    html = '<div style="text-align: center; color: #64748b; padding: 4px 0;">No reactions or metabolites changes specified.</div>';
  }

  panel.innerHTML = html;
}

/**
 * Resets the state details panel and toggle button to initial state.
 */
function resetStateDetails() {
  const geoStateDetailsBtn = document.getElementById('geo-state-details-btn');
  const geoStateDetailsPanel = document.getElementById('geo-state-details-panel');
  const geoAnalysisUsage = document.getElementById('geo-analysis-usage');
  if (geoStateDetailsBtn) geoStateDetailsBtn.textContent = 'Show Details';
  if (geoStateDetailsPanel) {
    geoStateDetailsPanel.innerHTML = '';
    geoStateDetailsPanel.classList.add('hidden');
  }
  if (geoAnalysisUsage) {
    geoAnalysisUsage.textContent = '';
    geoAnalysisUsage.classList.add('hidden');
  }
}

// ============================================================================
// SCENARIOS & AI CHAT INTEGRATION
// ============================================================================

// Active scenario state variables
let activeScenarioId = null;
let scenarioObjectivesStatus = {}; // objectiveId -> completed (bool)

const SCENARIOS = {
  oxygen_switch: {
    id: 'oxygen_switch',
    title: '1. Oxygen Switch',
    desc: 'Goal: Show that the cell switches metabolic pathways based on oxygen availability. Aerobic respiration via PDH is thermodynamically much more efficient than anaerobic fermentation via PFL.',
    objectives: [
      { id: 'set_o2_0', text: 'Set oxygen (o2_e) to 0 (anaerobic conditions)', check: () => simulation.metabolites['o2_e'] && simulation.metabolites['o2_e'].concentration < 0.01 },
      { id: 'observe_pfl', text: 'Ensure there is flux through PFL (flux > 2.0)', check: () => simulation.reactions['PFL'] && Math.abs(simulation.reactions['PFL'].flux) > 2.0 },
      { id: 'increase_o2', text: 'Gradually increase oxygen supply (o2_e >= 0.5)', check: () => simulation.metabolites['o2_e'] && simulation.metabolites['o2_e'].concentration >= 0.49 },
      { id: 'observe_pdh', text: 'Observe PDH turning on (> 2.0) and PFL shutting down (< 0.5)', check: () => {
        const pdhVal = simulation.reactions['PDH'] ? Math.abs(simulation.reactions['PDH'].flux) : 0;
        const pflVal = simulation.reactions['PFL'] ? Math.abs(simulation.reactions['PFL'].flux) : 999;
        return pdhVal > 2.0 && pflVal < 0.5;
      }}
    ],
    reflection: 'Why does the atp_c level (or ATP yield) increase when oxygen is supplied, even if the incoming glucose rate remains unchanged?',
    controls: [
      { id: 'o2_e', name: 'Oxygen Supply (o2_e)', min: 0.0, max: 1.0, step: 0.05, value: 0.8 }
    ]
  },
  metabolic_jam: {
    id: 'metabolic_jam',
    title: '2. Metabolic Jam',
    desc: 'Goal: Show pathway capacity limitation (Vmax). If enzymes (e.g., PDH) are running at their limit, the influx of excess glucose leads to a critical accumulation of intermediate products (pyruvate).',
    objectives: [
      { id: 'increase_glc', text: 'Increase glucose concentration (glc__D_e >= 20.0)', check: () => simulation.metabolites['glc__D_e'] && simulation.metabolites['glc__D_e'].concentration >= 19.9 },
      { id: 'reduce_pdh_vmax', text: 'Reduce Vmax of PDH enzyme to 2.0 or below', check: () => simulation.reactions['PDH'] && simulation.reactions['PDH'].vMax <= 2.01 },
      { id: 'observe_pyr_accum', text: 'Observe accumulation of pyruvate (pyr_c > 8.0 mM)', check: () => simulation.metabolites['pyr_c'] && simulation.metabolites['pyr_c'].concentration > 8.0 }
    ],
    reflection: 'Why does the growth rate (biomass_flux) stop increasing and hit a limit when there is an excess of glucose?',
    controls: [
      { id: 'glc__D_e', name: 'Glucose Concentration (glc__D_e)', min: 1.0, max: 30.0, step: 1.0, value: 2.0 }
    ]
  },
  warburg_effect: {
    id: 'warburg_effect',
    title: '3. Warburg Effect',
    desc: 'Goal: Demonstrate overflow metabolism (similar to the Warburg effect in cancer cells). When the rate of glycolysis exceeds the capacity of respiration, excess carbon is excreted as lactate, even in the presence of oxygen.',
    objectives: [
      { id: 'reduce_resp', text: 'Limit Vmax of respiration (CYTBO3_4pp) to 5.0 or below', check: () => simulation.reactions['CYTBO3_4pp'] && simulation.reactions['CYTBO3_4pp'].vMax <= 5.01 },
      { id: 'increase_glc', text: 'Increase glucose concentration (glc__D_e >= 20.0)', check: () => simulation.metabolites['glc__D_e'] && simulation.metabolites['glc__D_e'].concentration >= 19.9 },
      { id: 'observe_lac_flux', text: 'Observe excretion of lactate into the medium (EX_lac__D_e flux > 1.0)', check: () => simulation.reactions['EX_lac__D_e'] && simulation.reactions['EX_lac__D_e'].flux > 1.0 }
    ],
    reflection: 'Why do cancer cells switch to lactic acid fermentation even under aerobic conditions? What is the advantage of this adaptation for rapid division?',
    controls: [
      { id: 'glc__D_e', name: 'Glucose Concentration (glc__D_e)', min: 1.0, max: 30.0, step: 1.0, value: 10.0 }
    ]
  }
};

let aiChatHistory = [];
let lastChatScrollTop = null;

// Auth & Rate-limiting State
let guestId = localStorage.getItem('chatGuestId');
if (!guestId) {
  guestId = 'guest_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  localStorage.setItem('chatGuestId', guestId);
}

let userToken = localStorage.getItem('userToken');
let googleClientId = null;
let currentLimit = { max: 5, count: 0, remaining: 5 };
let userProfile = null;
let googleAuthInitialized = false;

async function loadChatHistory() {
  const token = localStorage.getItem('userToken');
  try {
    const headers = { 
      'x-guest-id': guestId,
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch('/api/chat/history', { headers });
    if (res.ok) {
      const historyData = await res.json();
      
      const chatMessages = document.getElementById('ai-chat-messages');
      if (chatMessages) {
        // Reset container to default greeting message
        chatMessages.innerHTML = `
          <div class="message message-model">
            Hello! I am your AI assistant for E. coli metabolism. Feel free to ask me any questions about the map, reactions, metabolic pathways, or the current learning scenarios.
          </div>
        `;
        
        aiChatHistory = [];
        
        // Populate messages from database history
        for (const item of historyData) {
          if (item.role === 'user') {
            appendUserMessage(item.message);
            aiChatHistory.push({ role: 'user', text: item.message });
          } else {
            appendModelMessage(item.message);
            aiChatHistory.push({ role: 'model', text: item.message });
          }
        }
      }
    }
  } catch (err) {
    console.error('Failed to load chat history:', err);
  }
}

async function checkAuthStatus(isVisit = false) {
  const token = localStorage.getItem('userToken');
  try {
    const headers = { 
      'x-guest-id': guestId,
      'x-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const url = isVisit ? '/api/auth/status?visit=true' : '/api/auth/status';
    const res = await fetch(url, { headers });
    if (res.ok) {
      const data = await res.json();
      userProfile = data.user;
      currentLimit = data.limit;
      googleClientId = data.googleClientId;
      
      updateUserStatusUI();
      
      if (googleClientId && !googleAuthInitialized) {
        initGoogleAuth(googleClientId);
      }

      // Load chat history from Supabase
      await loadChatHistory();
    }
  } catch (err) {
    console.error('Failed to check auth status:', err);
  }
}

function initGoogleAuth(clientId) {
  if (typeof google === 'undefined') {
    setTimeout(() => initGoogleAuth(clientId), 500);
    return;
  }
  googleAuthInitialized = true;
  
  google.accounts.id.initialize({
    client_id: clientId,
    callback: handleGoogleCredentialResponse
  });
  
  renderGoogleButton();
}

function renderGoogleButton() {
  const container = document.getElementById('global-google-signin-btn-container');
  if (container && typeof google !== 'undefined') {
    container.innerHTML = '';
    const btnDiv = document.createElement('div');
    btnDiv.id = 'global-google-signin-btn';
    container.appendChild(btnDiv);
    google.accounts.id.renderButton(
      document.getElementById('global-google-signin-btn'),
      { theme: 'outline', size: 'large', type: 'standard', text: 'signin_with' }
    );
  }
}

async function handleGoogleCredentialResponse(response) {
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });
    if (res.ok) {
      const data = await res.json();
      localStorage.setItem('userToken', data.token);
      userToken = data.token;
      await checkAuthStatus(true);
      closeAuthModal();
    } else {
      const err = await res.json();
      alert(`Google Auth failed: ${err.error}`);
    }
  } catch (err) {
    console.error('Google credential validation error:', err);
  }
}

async function handleLogout() {
  const token = localStorage.getItem('userToken');
  if (token) {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch (e) {
      console.error('Logout request error:', e);
    }
  }
  localStorage.removeItem('userToken');
  userToken = null;
  userProfile = null;
  await checkAuthStatus();
}

function openAuthModal() {
  const authModal = document.getElementById('global-auth-modal');
  if (authModal) {
    authModal.classList.remove('hidden');
    renderGoogleButton();
  }
}

function closeAuthModal() {
  const authModal = document.getElementById('global-auth-modal');
  if (authModal) {
    authModal.classList.add('hidden');
  }
}

function showLockOverlay(mode) {
  const lockOverlay = document.getElementById('ai-chat-lock-overlay');
  const lockTitle = document.getElementById('lock-title');
  const lockMessage = document.getElementById('lock-message');
  const lockIcon = document.getElementById('lock-icon');
  const btnUpgrade = document.getElementById('btn-upgrade-premium');
  const btnLockSignin = document.getElementById('btn-lock-signin');
  const inputContainer = document.querySelector('.chat-input-container');

  if (!lockOverlay) return;

  lockOverlay.classList.remove('hidden');
  if (inputContainer) inputContainer.classList.add('hidden');

  if (mode === 'auth_required') {
    if (lockIcon) lockIcon.textContent = '🔒';
    if (lockTitle) lockTitle.textContent = 'Sign In to Use Chat';
    if (lockMessage) lockMessage.textContent = 'The AI Metabolic Assistant is available only to registered users. Please sign in to continue.';
    if (btnUpgrade) btnUpgrade.classList.add('hidden');
    if (btnLockSignin) btnLockSignin.classList.remove('hidden');
  } else if (mode === 'limit_guest') {
    if (lockIcon) lockIcon.textContent = '🔒';
    if (lockTitle) lockTitle.textContent = 'Daily Limit Reached';
    if (lockMessage) lockMessage.textContent = 'Guests are limited to 2 queries per day. Sign in to continue, or upgrade your plan.';
    if (btnUpgrade) btnUpgrade.classList.add('hidden');
    if (btnLockSignin) btnLockSignin.classList.remove('hidden');
  } else if (mode === 'limit_user') {
    if (lockIcon) lockIcon.textContent = '🔒';
    if (lockTitle) lockTitle.textContent = 'Daily Limit Reached';
    if (lockMessage) lockMessage.textContent = 'Daily query limit reached. Upgrade to Premium Basic ($5.00) or Premium Pro ($15.00) to get more queries.';
    if (btnUpgrade) {
      btnUpgrade.classList.remove('hidden');
      btnUpgrade.textContent = 'Upgrade Plan';
    }
    if (btnLockSignin) btnLockSignin.classList.add('hidden');
  }
}

function updateUserStatusUI() {
  const statusBar = document.getElementById('ai-chat-status-bar');
  const lockOverlay = document.getElementById('ai-chat-lock-overlay');
  const inputContainer = document.querySelector('.chat-input-container');

  // Identify user in Microsoft Clarity for session replay matching
  if (userProfile && typeof clarity === 'function') {
    clarity("identify", userProfile.email, userProfile.name);
  }

  // Update User Tier Badge in Top Header
  const userTierContainer = document.getElementById('user-tier-container');
  if (userTierContainer) {
    if (userProfile) {
      const tierName = userProfile.isPremium 
        ? (userProfile.premiumTier === 2 ? 'Pro' : 'Basic') 
        : 'Free';
      const showUpgrade = !userProfile.isPremium || userProfile.premiumTier !== 2;
      
      userTierContainer.innerHTML = `
        <span>${tierName}: ${currentLimit.remaining} left</span>
        ${showUpgrade ? `<button id="header-tier-upgrade-btn" class="chat-upgrade-btn">Upgrade</button>` : ''}
      `;
      userTierContainer.className = `user-tier-container tier-${userProfile.isPremium ? (userProfile.premiumTier === 2 ? 'pro' : 'basic') : 'free'}`;
      
      if (!userTierContainer.dataset.hasListener) {
        userTierContainer.dataset.hasListener = "true";
        userTierContainer.addEventListener('click', (e) => {
          e.stopPropagation();
          openMockCheckout();
        });
      }
    } else {
      userTierContainer.className = 'user-tier-container hidden';
      userTierContainer.innerHTML = '';
    }
  }

  // Update Reports Button Visibility
  const adminReportsContainer = document.getElementById('admin-reports-container');
  if (adminReportsContainer) {
    if (userProfile && userProfile.isAdmin) {
      adminReportsContainer.classList.remove('hidden');
    } else {
      adminReportsContainer.classList.add('hidden');
      const reportsDropdown = document.getElementById('reports-dropdown');
      if (reportsDropdown) reportsDropdown.classList.add('hidden');
    }
  }
  
  // 1. Update AI Chat Status Bar (if it exists)
  if (statusBar) {
    if (userProfile) {
      const isPremium = userProfile.isPremium;
      if (isPremium) {
        const tierName = userProfile.premiumTier === 2 ? '⚡ Premium Pro' : '💎 Premium Basic';
        if (userProfile.premiumTier === 2) {
          statusBar.innerHTML = `
            <span>${tierName}: ${currentLimit.remaining} / ${currentLimit.max} left today</span>
          `;
        } else {
          statusBar.innerHTML = `
            <span>${tierName}: ${currentLimit.remaining} / ${currentLimit.max} left today <button id="btn-status-upgrade" class="chat-upgrade-btn">Upgrade</button></span>
          `;
        }
      } else {
        statusBar.innerHTML = `
          <span>Free: ${currentLimit.remaining} / ${currentLimit.max} left today <button id="btn-status-upgrade" class="chat-upgrade-btn">Upgrade</button></span>
        `;
      }
    } else {
      statusBar.innerHTML = `
        <span>Sign in to use the AI Metabolic Assistant</span>
        <button id="btn-status-login" class="chat-status-login-btn">Sign in</button>
      `;
    }
    
    const btnStatusLogin = document.getElementById('btn-status-login');
    if (btnStatusLogin) {
      btnStatusLogin.addEventListener('click', () => {
        openAuthModal();
      });
    }

    const btnStatusUpgrade = document.getElementById('btn-status-upgrade');
    if (btnStatusUpgrade) {
      btnStatusUpgrade.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!userProfile) {
          alert('Please sign in with Google first to purchase Premium!');
          openAuthModal();
          return;
        }
        openMockCheckout();
      });
    }
  }
  
  // 2. Update Top Header User Profile Badge / Dropdown
  const headerProfileContainer = document.getElementById('user-profile-header-container');
  if (headerProfileContainer) {
    if (userProfile) {
      const initial = userProfile.name ? userProfile.name.charAt(0).toUpperCase() : 'U';
      const tierText = userProfile.isPremium ? (userProfile.premiumTier === 2 ? '⚡ Premium Pro' : '💎 Premium Basic') : 'Free Plan';
      const showUpgrade = !userProfile.isPremium || userProfile.premiumTier !== 2;
      headerProfileContainer.innerHTML = `
        <div class="user-badge" id="user-profile-badge">
          <div class="user-avatar">${initial}</div>
          <span class="user-name">${userProfile.name}</span>
          <span class="chevron-icon">▼</span>
        </div>
        <div id="user-profile-dropdown" class="user-dropdown glass hidden">
          <div class="user-dropdown-info">
            <div class="user-dropdown-name">${userProfile.name}</div>
            <div class="user-dropdown-email">${userProfile.email || ''}</div>
            <div class="user-dropdown-tier" style="display: flex; align-items: center; gap: 6px;">
              <span>${tierText}</span>
              ${showUpgrade ? `<button id="dropdown-upgrade-btn" class="chat-upgrade-btn">Upgrade</button>` : ''}
            </div>
            <div class="user-dropdown-limits">Queries remaining: ${currentLimit.remaining} / ${currentLimit.max}</div>
          </div>
          <hr class="dropdown-divider" />
          <button id="header-logout-btn" class="btn btn-secondary logout-dropdown-btn">Log out</button>
        </div>
      `;
      
      const badge = document.getElementById('user-profile-badge');
      const dropdown = document.getElementById('user-profile-dropdown');
      const logoutBtn = document.getElementById('header-logout-btn');
      const dropdownUpgradeBtn = document.getElementById('dropdown-upgrade-btn');
      
      if (badge && dropdown) {
        badge.addEventListener('click', (e) => {
          e.stopPropagation();
          dropdown.classList.toggle('hidden');
          const isOpening = !dropdown.classList.contains('hidden');
          if (isOpening) {
            closeChatDrawer();
            hideInspector();
          }
          const chevron = badge.querySelector('.chevron-icon');
          if (chevron) {
            const isHidden = dropdown.classList.contains('hidden');
            chevron.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(180deg)';
          }
        });
      }
      
      if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          handleLogout();
        });
      }

      if (dropdownUpgradeBtn) {
        dropdownUpgradeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openMockCheckout();
        });
      }
    } else {
      headerProfileContainer.innerHTML = `
        <button id="header-login-btn" class="btn btn-secondary header-btn login-header-btn">Sign in</button>
      `;
      const loginBtn = document.getElementById('header-login-btn');
      if (loginBtn) {
        loginBtn.addEventListener('click', () => {
          openAuthModal();
        });
      }
    }
  }
  
  if (!userProfile) {
    showLockOverlay('auth_required');
  } else {
    const limitsExceeded = currentLimit.remaining <= 0;
    if (limitsExceeded) {
      showLockOverlay('limit_user');
    } else {
      if (lockOverlay) lockOverlay.classList.add('hidden');
      if (inputContainer) inputContainer.classList.remove('hidden');
    }
  }
}

function openMockCheckout() {
  const overlay = document.createElement('div');
  overlay.className = 'mock-payment-overlay';
  overlay.id = 'mock-payment-modal';
  
  if (userProfile && userProfile.isPremium && userProfile.premiumTier === 2) {
    overlay.innerHTML = `
      <div class="payment-card glass" style="text-align: center; max-width: 400px; padding: 32px 24px;">
        <button class="btn-close-payment" id="btn-close-payment">✕</button>
        <div style="font-size: 48px; margin-bottom: 16px;">⚡</div>
        <h3 style="margin-bottom: 8px;">Active Premium Pro</h3>
        <p style="font-size: 13.5px; color: #94a3b8; line-height: 1.5; margin: 0 0 24px 0;">You are currently subscribed to the highest tier access plan. Auto-renewal is ${userProfile.autoRenew ? 'enabled' : 'disabled'}. Thank you for your support!</p>
        <button class="btn btn-primary w-100" id="btn-close-payment-ok" style="height: 40px; font-weight: 700;">Ok</button>
      </div>
    `;
    document.body.appendChild(overlay);
    document.getElementById('btn-close-payment').addEventListener('click', () => overlay.remove());
    document.getElementById('btn-close-payment-ok').addEventListener('click', () => overlay.remove());
    return;
  }

  const isBasicActive = userProfile && userProfile.isPremium && userProfile.premiumTier === 1;
  let selectedTier = isBasicActive ? 2 : 1;
  let selectedPrice = isBasicActive ? "15.00" : "5.00";
  
  overlay.innerHTML = `
    <div class="payment-card glass">
      <button class="btn-close-payment" id="btn-close-payment">✕</button>
      <h3>⚡ CellFlux Premium Access</h3>
      <p style="font-size: 12px; color: #94a3b8; margin: 0 0 16px 0;">Upgrade AI Chat & Scenarios</p>
      
      <div class="plan-selector">
        ${isBasicActive ? '' : `
        <div class="plan-card active" id="plan-tier-1" data-tier="1" data-price="5.00">
          <h4>💎 Basic</h4>
          <p>100 queries/day</p>
          <div class="price">$5.00</div>
        </div>
        `}
        <div class="plan-card ${isBasicActive ? 'active' : ''}" id="plan-tier-2" data-tier="2" data-price="15.00">
          <h4>⚡ Pro</h4>
          <p>500 queries/day</p>
          <div class="price">$15.00</div>
        </div>
      </div>
      
      <div class="card-input-group">
        <div>
          <label>Card Number</label>
          <input type="text" placeholder="4000 1234 5678 9010" id="pay-card-num" value="4000 1234 5678 9010" />
        </div>
        <div class="payment-row">
          <div>
            <label>Expiry Date</label>
            <input type="text" placeholder="12/28" id="pay-card-exp" value="12/28" />
          </div>
          <div>
            <label>CVC</label>
            <input type="text" placeholder="123" id="pay-card-cvc" value="123" />
          </div>
        </div>
        <div>
          <label>Cardholder Name</label>
          <input type="text" placeholder="John Doe" id="pay-card-name" value="${userProfile ? userProfile.name : 'John Doe'}" />
        </div>
      </div>

      <!-- Auto-Renew Checkbox -->
      <div class="auto-renew-checkbox-group">
        <input type="checkbox" id="pay-auto-renew" />
        <label for="pay-auto-renew">Auto-renew subscription monthly</label>
      </div>
      
      <button class="btn btn-primary w-100" id="btn-confirm-payment" style="height: 40px; font-weight: 700; margin-top: 16px;">Pay $${selectedPrice}</button>
      <p style="font-size: 10px; color: #64748b; text-align: center; margin: 12px 0 0 0;">🔐 Simulated sandbox payment. No real money will be charged.</p>
    </div>
  `;
  
  document.body.appendChild(overlay);
  
  const card1 = document.getElementById('plan-tier-1');
  const card2 = document.getElementById('plan-tier-2');
  const btnConfirm = document.getElementById('btn-confirm-payment');
  
  if (card1) {
    card1.addEventListener('click', () => {
      card1.classList.add('active');
      if (card2) card2.classList.remove('active');
      selectedTier = 1;
      selectedPrice = "5.00";
      btnConfirm.textContent = `Pay $${selectedPrice}`;
    });
  }
  
  if (card2) {
    card2.addEventListener('click', () => {
      card2.classList.add('active');
      if (card1) card1.classList.remove('active');
      selectedTier = 2;
      selectedPrice = "15.00";
      btnConfirm.textContent = `Pay $${selectedPrice}`;
    });
  }
  
  document.getElementById('btn-close-payment').addEventListener('click', () => {
    overlay.remove();
  });
  
  btnConfirm.addEventListener('click', async () => {
    btnConfirm.disabled = true;
    btnConfirm.textContent = 'Processing transaction...';
    
    const autoRenewCheckbox = document.getElementById('pay-auto-renew');
    const autoRenew = autoRenewCheckbox ? autoRenewCheckbox.checked : false;
    
    const token = localStorage.getItem('userToken');
    try {
      const res = await fetch('/api/payments/simulate', {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ tier: selectedTier, autoRenew })
      });
      if (res.ok) {
        btnConfirm.textContent = '✓ Payment Successful!';
        btnConfirm.style.backgroundColor = '#10b981';
        setTimeout(() => {
          overlay.remove();
          checkAuthStatus();
        }, 1500);
      } else {
        alert('Payment failed. Please try again.');
        btnConfirm.disabled = false;
        btnConfirm.textContent = `Pay $${selectedPrice}`;
      }
    } catch (e) {
      console.error(e);
      alert('Payment request error.');
      btnConfirm.disabled = false;
      btnConfirm.textContent = `Pay $${selectedPrice}`;
    }
  });
}

function setupScenariosAndChat() {
  // 1. Setup Tab Switching in Left Sidebar
  const btnMetrics = document.getElementById('tab-metrics');
  const btnScenarios = document.getElementById('tab-scenarios');
  const contentMetrics = document.getElementById('tab-content-metrics');
  const contentScenarios = document.getElementById('tab-content-scenarios');

  if (btnMetrics && btnScenarios && contentMetrics && contentScenarios) {
    btnMetrics.addEventListener('click', () => {
      btnMetrics.classList.add('active');
      btnScenarios.classList.remove('active');
      contentMetrics.classList.remove('hidden');
      contentScenarios.classList.add('hidden');
    });

    btnScenarios.addEventListener('click', () => {
      btnScenarios.classList.add('active');
      btnMetrics.classList.remove('active');
      contentScenarios.classList.remove('hidden');
      contentMetrics.classList.add('hidden');
    });
  }

  // 2. Setup Scenario Cards Clicks
  const cards = document.querySelectorAll('.scenario-card');
  cards.forEach(card => {
    card.addEventListener('click', () => {
      const scenarioId = card.getAttribute('data-scenario');
      selectScenario(scenarioId);
    });
  });

  // Exit scenario button
  const btnExit = document.getElementById('btn-exit-scenario');
  if (btnExit) {
    btnExit.addEventListener('click', () => {
      exitActiveScenario();
    });
  }

  // Start/Reset scenario button
  const btnStart = document.getElementById('btn-start-scenario');
  if (btnStart) {
    btnStart.addEventListener('click', () => {
      if (activeScenarioId) {
        startScenario(activeScenarioId);
      }
    });
  }

  // Submit reflection answer to AI
  const btnSubmitReflection = document.getElementById('btn-submit-reflection');
  if (btnSubmitReflection) {
    btnSubmitReflection.addEventListener('click', () => {
      submitReflectionAnswer();
    });
  }

  // 3. Setup AI Chatbot Widget Event Listeners
  const chatTrigger = document.getElementById('ai-chat-trigger');
  const chatDrawer = document.getElementById('ai-chat-drawer');
  const chatClose = document.getElementById('ai-chat-close');
  const chatInput = document.getElementById('ai-chat-input');
  const chatSendBtn = document.getElementById('ai-chat-send-btn');
  const contextBtn = document.getElementById('ai-chat-context-btn');
  const contextPanel = document.getElementById('ai-chat-context-panel');

  if (chatTrigger && chatDrawer) {
    chatTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpening = chatDrawer.classList.contains('hidden');
      if (isOpening) {
        openChatDrawer();
      } else {
        closeChatDrawer();
      }
    });

    chatClose.addEventListener('click', (e) => {
      e.stopPropagation();
      closeChatDrawer();
    });

    // Send on button click
    chatSendBtn.addEventListener('click', () => {
      sendChatMessage();
    });

    // Send on enter key
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        sendChatMessage();
      }
    });

    // Prevent click inside drawer from closing it
    chatDrawer.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // Context Panel Toggle
    if (contextBtn && contextPanel) {
      contextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        contextPanel.classList.toggle('hidden');
        if (!contextPanel.classList.contains('hidden')) {
          const jsonDisplay = document.getElementById('ai-chat-context-json');
          if (jsonDisplay) {
            const contextData = getSimulationContext();
            jsonDisplay.textContent = JSON.stringify(contextData, null, 2);
          }
        }
      });
    }
  }

  // Global click outside closes chat
  document.addEventListener('click', () => {
    if (chatDrawer && !chatDrawer.classList.contains('hidden')) {
      const chatMessages = document.getElementById('ai-chat-messages');
      if (chatMessages) {
        lastChatScrollTop = chatMessages.scrollTop;
      }
      chatDrawer.classList.add('hidden');
    }
  });

  // Upgrade to Premium Button
  const btnUpgrade = document.getElementById('btn-upgrade-premium');
  if (btnUpgrade) {
    btnUpgrade.addEventListener('click', () => {
      openMockCheckout();
    });
  }

  // Decoupled Global Auth Modal triggers
  const btnCloseAuth = document.getElementById('btn-close-auth');
  if (btnCloseAuth) {
    btnCloseAuth.addEventListener('click', () => {
      closeAuthModal();
    });
  }

  const btnLockSignin = document.getElementById('btn-lock-signin');
  if (btnLockSignin) {
    btnLockSignin.addEventListener('click', () => {
      openAuthModal();
    });
  }

  // Initial Auth & Limit checks
  checkAuthStatus(true);

  // Admin Reports Dropdown & Modal setup
  const reportsDropdownBtn = document.getElementById('reports-dropdown-btn');
  const reportsDropdownElement = document.getElementById('reports-dropdown');
  const reportUsersOpt = document.getElementById('report-users-opt');
  const reportsModal = document.getElementById('reports-modal');
  const closeReportsModal = document.getElementById('close-reports-modal');
  const reportsTableBody = document.getElementById('reports-table-body');

  if (reportsDropdownBtn && reportsDropdownElement) {
    reportsDropdownBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      reportsDropdownElement.classList.toggle('hidden');
      const chevron = reportsDropdownBtn.querySelector('.chevron-icon');
      if (chevron) {
        const isHidden = reportsDropdownElement.classList.contains('hidden');
        chevron.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(180deg)';
      }
    });
  }

  if (reportUsersOpt && reportsModal && reportsTableBody) {
    reportUsersOpt.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (reportsDropdownElement) reportsDropdownElement.classList.add('hidden');
      const chevron = reportsDropdownBtn ? reportsDropdownBtn.querySelector('.chevron-icon') : null;
      if (chevron) chevron.style.transform = 'rotate(0deg)';

      reportsTableBody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 20px; color: #94a3b8;">Loading report data...</td></tr>';
      reportsModal.classList.remove('hidden');

      try {
        const token = localStorage.getItem('userToken');
        const headers = {};
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        const res = await fetch('/api/admin/reports/users', { headers });
        if (res.ok) {
          const users = await res.json();
          if (users.length === 0) {
            reportsTableBody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 20px; color: #94a3b8;">No registered users found.</td></tr>';
          } else {
            reportsTableBody.innerHTML = users.map(u => {
              const lastVisitStr = u.last_visit ? new Date(u.last_visit).toLocaleString() : 'Never';
              const autoRenewStr = u.auto_renew ? 'Yes' : 'No';
              return `
                <tr>
                  <td>${u.email || ''}</td>
                  <td>${u.name || ''}</td>
                  <td>${u.visits || 0}</td>
                  <td>${lastVisitStr}</td>
                  <td>${u.questions || 0}</td>
                  <td>${u.hours_spent || 0} hrs</td>
                  <td>${autoRenewStr}</td>
                  <td style="text-align: center;">
                    <button class="delete-user-btn" data-email="${u.email}" title="Delete User">🗑️</button>
                  </td>
                </tr>
              `;
            }).join('');

            // Attach event listeners for delete buttons
            const deleteButtons = reportsTableBody.querySelectorAll('.delete-user-btn');
            deleteButtons.forEach(btn => {
              btn.addEventListener('click', async (evt) => {
                evt.stopPropagation();
                const emailToDelete = btn.dataset.email;
                if (!emailToDelete) return;

                if (confirm(`Are you sure you want to delete user ${emailToDelete}? All sessions, statistics, and access status will be permanently erased.`)) {
                  try {
                    const delRes = await fetch(`/api/admin/users/${encodeURIComponent(emailToDelete)}`, {
                      method: 'DELETE',
                      headers: {
                        'Authorization': `Bearer ${token}`
                      }
                    });
                    if (delRes.ok) {
                      // Reload report
                      reportUsersOpt.click();
                    } else {
                      const err = await delRes.json();
                      alert(`Failed to delete user: ${err.error}`);
                    }
                  } catch (err) {
                    console.error('Delete user error:', err);
                    alert('Failed to connect to the server.');
                  }
                }
              });
            });
          }
        } else {
          const err = await res.json();
          reportsTableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 20px; color: #ef4444;">Error: ${err.error || 'Failed to load report data.'}</td></tr>`;
        }
      } catch (err) {
        console.error('Failed to load user reports:', err);
        reportsTableBody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 20px; color: #ef4444;">Error: Failed to fetch data from server.</td></tr>';
      }
    });
  }

  if (closeReportsModal && reportsModal) {
    closeReportsModal.addEventListener('click', () => {
      reportsModal.classList.add('hidden');
    });
  }

  // Heartbeat Loop (every 60 seconds)
  setInterval(async () => {
    const token = localStorage.getItem('userToken');
    if (token && userProfile) {
      try {
        await fetch('/api/auth/heartbeat', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
      } catch (err) {
        console.error('[Heartbeat] Failed to send active heartbeat:', err);
      }
    }
  }, 60000);
}

function selectScenario(scenarioId) {
  const scenario = SCENARIOS[scenarioId];
  if (!scenario) return;

  activeScenarioId = scenarioId;
  scenarioObjectivesStatus = {};
  
  // Update UI headers/desc
  document.getElementById('scenarios-list-container').classList.add('hidden');
  const activeDetail = document.getElementById('active-scenario-detail');
  activeDetail.classList.remove('hidden');
  
  document.getElementById('active-scenario-title').textContent = scenario.title;
  document.getElementById('active-scenario-desc').textContent = scenario.desc;
  document.getElementById('scenario-reflection-question').textContent = scenario.reflection;
  document.getElementById('scenario-reflection-answer').value = '';

  // Setup Objectives checklist markup
  const listEl = document.getElementById('scenario-objectives-list');
  listEl.innerHTML = '';
  scenario.objectives.forEach(obj => {
    const li = document.createElement('li');
    li.id = `objective-${obj.id}`;
    li.textContent = obj.text;
    listEl.appendChild(li);
    scenarioObjectivesStatus[obj.id] = false;
  });

  // Apply scenario simulation parameters
  startScenario(scenarioId);
}

function startScenario(scenarioId) {
  const scenario = SCENARIOS[scenarioId];
  if (!scenario || !simulation) return;

  // Reset objective statuses and UI checkmarks
  scenario.objectives.forEach(obj => {
    scenarioObjectivesStatus[obj.id] = false;
    const li = document.getElementById(`objective-${obj.id}`);
    if (li) {
      li.classList.remove('completed');
    }
  });

  // Clear flashing sets
  if (renderer) {
    if (!renderer.flashingMetaboliteIds) renderer.flashingMetaboliteIds = new Set();
    renderer.flashingMetaboliteIds.clear();
  }

  // 1. Reset and apply scenario constraints on simulation
  simulation.applyScenario(scenarioId);

  // 2. Set up dynamic slider controls
  const controlsContainer = document.getElementById('scenario-controls-container');
  const sliderGroup = document.getElementById('scenario-dynamic-slider-group');
  sliderGroup.innerHTML = '';

  if (scenario.controls && scenario.controls.length > 0) {
    controlsContainer.classList.remove('hidden');
    
    scenario.controls.forEach(ctrl => {
      const wrapper = document.createElement('div');
      wrapper.className = 'param-slider';
      
      const labelRow = document.createElement('div');
      labelRow.className = 'param-label-row';
      
      const label = document.createElement('label');
      label.setAttribute('for', `scenario-slider-${ctrl.id}`);
      label.textContent = ctrl.name;
      
      const valSpan = document.createElement('span');
      valSpan.id = `scenario-slider-val-${ctrl.id}`;
      valSpan.className = 'code-font';
      valSpan.textContent = ctrl.value;
      
      labelRow.appendChild(label);
      labelRow.appendChild(valSpan);
      
      const input = document.createElement('input');
      input.type = 'range';
      input.id = `scenario-slider-${ctrl.id}`;
      input.min = ctrl.min;
      input.max = ctrl.max;
      input.step = ctrl.step;
      input.value = ctrl.value;
      
      // Update simulation concentration on slider change
      input.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        valSpan.textContent = val;
        
        if (simulation.metabolites[ctrl.id]) {
          simulation.metabolites[ctrl.id].concentration = val;
          simulation.metabolites[ctrl.id].targetConcentration = val;
          // Trigger FBA solver bounds immediately
          updateFbaBounds(performance.now());
        }
      });
      
      wrapper.appendChild(labelRow);
      wrapper.appendChild(input);
      sliderGroup.appendChild(wrapper);

      // Force initial value in simulation
      if (simulation.metabolites[ctrl.id]) {
        simulation.metabolites[ctrl.id].concentration = ctrl.value;
        simulation.metabolites[ctrl.id].targetConcentration = ctrl.value;
      }
    });
  } else {
    controlsContainer.classList.add('hidden');
  }

  // 3. Reset checklist checks in UI
  scenario.objectives.forEach(obj => {
    const li = document.getElementById(`objective-${obj.id}`);
    if (li) {
      li.classList.remove('completed');
    }
    scenarioObjectivesStatus[obj.id] = false;
  });

  // Focus map camera on relevant pathway of the scenario
  if (renderer) {
    if (scenarioId === 'oxygen_switch') {
      // Focus closely on the average center of PFL, PTAr and MDH to frame them all on screen
      let sumX = 0, sumY = 0, count = 0;
      const targetIds = ['PFL', 'PTAr', 'MDH'];
      renderer.reactions.forEach(rxn => {
        if (targetIds.includes(rxn.biggId) && rxn.labelX && rxn.labelY) {
          sumX += rxn.labelX;
          sumY += rxn.labelY;
          count++;
        }
      });
      if (count > 0) {
        renderer.focusOnCoordinates(sumX / count, sumY / count, 0.65);
      } else {
        renderer.focusOnCoordinates(2000, 4400, 0.85);
      }
    } else if (scenarioId === 'metabolic_jam') {
      renderer.fitMapToScreen(true);
    } else if (scenarioId === 'warburg_effect') {
      renderer.fitMapToScreen(true);
    }
  }

  // Trigger initial solver run
  updateFbaBounds(performance.now());
}

function exitActiveScenario() {
  activeScenarioId = null;
  scenarioObjectivesStatus = {};
  
  document.getElementById('scenarios-list-container').classList.remove('hidden');
  document.getElementById('active-scenario-detail').classList.add('hidden');

  if (renderer && renderer.flashingMetaboliteIds) {
    renderer.flashingMetaboliteIds.clear();
  }

  // Keep the current simulation state for continued exploration, just refresh FBA bounds
  if (simulation) {
    updateFbaBounds(performance.now());
  }
}

function checkScenarioObjectives() {
  if (!activeScenarioId || !simulation) return;

  const scenario = SCENARIOS[activeScenarioId];
  if (!scenario) return;

  let allCompletedBefore = Object.values(scenarioObjectivesStatus).every(v => v === true);

  // Check objectives sequentially: a student cannot complete objective N+1 until objective N is met
  let canCheck = true;
  for (let i = 0; i < scenario.objectives.length; i++) {
    const obj = scenario.objectives[i];
    if (!scenarioObjectivesStatus[obj.id]) {
      if (canCheck) {
        const ok = obj.check();
        if (ok) {
          scenarioObjectivesStatus[obj.id] = true;
          const li = document.getElementById(`objective-${obj.id}`);
          if (li) {
            li.classList.add('completed');
          }
        }
      }
      canCheck = false; // block checking of any subsequent incomplete objectives
    }
  }

  // Handle Scenario 2 specific visual effect (pyruvate bottleneck jam)
  if (activeScenarioId === 'metabolic_jam' && renderer) {
    const pyrConc = simulation.metabolites['pyr_c'] ? simulation.metabolites['pyr_c'].concentration : 0;
    if (pyrConc > 8.0) {
      if (!renderer.flashingMetaboliteIds.has('pyr_c')) {
        renderer.flashingMetaboliteIds.add('pyr_c');
      }
    } else {
      if (renderer.flashingMetaboliteIds.has('pyr_c')) {
        renderer.flashingMetaboliteIds.delete('pyr_c');
      }
    }
  }

  let allCompletedAfter = Object.values(scenarioObjectivesStatus).every(v => v === true);

  // If student just finished all objectives, show a small hint & open chat to evaluate answer
  if (!allCompletedBefore && allCompletedAfter) {
    appendModelMessage("🎉 Вы выполнили все практические задачи сценария! Теперь запишите ваш ответ на вопрос рефлексии в текстовое поле слева и нажмите «Проверить ответ с ИИ», чтобы обсудить результат с преподавателем.");
    // Open chat automatically
    const chatDrawer = document.getElementById('ai-chat-drawer');
    const chatTrigger = document.getElementById('ai-chat-trigger');
    if (chatDrawer && chatDrawer.classList.contains('hidden')) {
      chatDrawer.classList.remove('hidden');
      if (chatTrigger) chatTrigger.classList.remove('animate-bounce');
    }
  }
}

function getSimulationContext() {
  if (!simulation) return {};

  const concentrations = {};
  const highConcentrations = {};
  for (const [id, metab] of Object.entries(simulation.metabolites)) {
    if (metab.concentration !== (simulation.initialConcentrations[id] || 1.0)) {
      concentrations[id] = parseFloat(metab.concentration.toFixed(3));
    }
    // Track high accumulation
    if (metab.concentration > 6.0 && !metab.isBuffered) {
      highConcentrations[id] = parseFloat(metab.concentration.toFixed(3));
    }
  }

  const tweaked = {};
  for (const [id, rxn] of Object.entries(simulation.reactions)) {
    if (rxn.vMax !== rxn.defaultVmax || rxn.km !== rxn.defaultKm) {
      tweaked[id] = { vMax: rxn.vMax, km: rxn.km };
    }
  }

  // Key gateway fluxes
  const keyFluxes = {};
  const gatewayRxns = ['GLCptspp', 'PGI', 'PFK', 'PYK', 'PDH', 'PFL', 'G6PDH2r', 'CS', 'AKGDH', 'SUCDi', 'CYTBO3_4pp', 'EX_lac__D_e'];
  gatewayRxns.forEach(rxnId => {
    if (simulation.reactions[rxnId]) {
      keyFluxes[rxnId] = parseFloat(simulation.reactions[rxnId].flux.toFixed(4));
    }
  });

  const objectiveStatus = {};
  if (activeScenarioId) {
    const scenario = SCENARIOS[activeScenarioId];
    if (scenario) {
      scenario.objectives.forEach(obj => {
        objectiveStatus[obj.id] = scenarioObjectivesStatus[obj.id] || false;
      });
    }
  }

  return {
    activeScenario: activeScenarioId,
    scenarioObjectives: objectiveStatus,
    growthRate: simulation.reactions['BIOMASS_Ecoli_core_w_GAM'] ? parseFloat(simulation.reactions['BIOMASS_Ecoli_core_w_GAM'].flux.toFixed(4)) : 0.0,
    atpYield: simulation.reactions['ATPS4r'] ? parseFloat(simulation.reactions['ATPS4r'].flux.toFixed(4)) : 0.0,
    accumulatedMetabolites: highConcentrations,
    tweakedParameters: tweaked,
    keyGatewayFluxes: keyFluxes
  };
}

async function sendChatMessage() {
  const chatInput = document.getElementById('ai-chat-input');
  if (!chatInput) return;
  const message = chatInput.value.trim();
  if (!message) return;

  // Append user message in UI
  appendUserMessage(message);
  chatInput.value = '';

  // Show typing loader
  const chatMessages = document.getElementById('ai-chat-messages');
  const loaderDiv = document.createElement('div');
  loaderDiv.id = 'ai-chat-typing-loader';
  loaderDiv.className = 'message message-model';
  loaderDiv.innerHTML = `
    <div class="typing-loader">
      <span></span>
      <span></span>
      <span></span>
    </div>
  `;
  chatMessages.appendChild(loaderDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    const context = getSimulationContext();
    const history = aiChatHistory.slice(-10); // Keep last 10 messages context to prevent tokens overflow

    const headers = {
      'Content-Type': 'application/json',
      'x-guest-id': guestId,
      'x-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone
    };
    if (userToken) {
      headers['Authorization'] = `Bearer ${userToken}`;
    }

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, history, context })
    });

    // Remove typing loader
    const loader = document.getElementById('ai-chat-typing-loader');
    if (loader) loader.remove();

    if (res.ok) {
      const data = await res.json();
      appendModelMessage(data.reply);
      // Save in history
      aiChatHistory.push({ role: 'user', text: message });
      aiChatHistory.push({ role: 'model', text: data.reply });
      
      // Update remaining limits dynamically
      if (typeof data.remaining !== 'undefined') {
        currentLimit.remaining = data.remaining;
        updateUserStatusUI();
      }
    } else {
      if (res.status === 403) {
        appendModelMessage(`System: Daily query limit reached. Please sign in or upgrade.`);
        await checkAuthStatus();
      } else if (res.status === 401) {
        appendModelMessage(`System: Authentication required. Please sign in.`);
        await checkAuthStatus();
      } else {
        const err = await res.json();
        appendModelMessage(`Error: ${err.error || 'Failed to send query to AI.'}`);
      }
    }
  } catch (err) {
    const loader = document.getElementById('ai-chat-typing-loader');
    if (loader) loader.remove();
    console.error('Failed to chat:', err);
    appendModelMessage('Error: No connection to the chat server.');
  }
}

async function submitReflectionAnswer() {
  const answerInput = document.getElementById('scenario-reflection-answer');
  if (!answerInput) return;
  const answer = answerInput.value.trim();
  if (!answer) {
    alert('Please write an answer to the question before submitting.');
    return;
  }

  const promptMessage = `I am performing the educational scenario "${SCENARIOS[activeScenarioId].title}".
My answer to the reflection question: "${SCENARIOS[activeScenarioId].reflection}"
Answer: "${answer}"
Please evaluate my answer for biological correctness based on the current metabolic map parameters, correct me if I am wrong, and explain the biology in detail.`;

  // Focus on AI chat and open drawer
  openChatDrawer();

  // Clear input
  answerInput.value = '';

  // Append user message in UI
  appendUserMessage(`[Reflection Check]: ${answer}`);

  // Show typing loader
  const chatMessages = document.getElementById('ai-chat-messages');
  const loaderDiv = document.createElement('div');
  loaderDiv.id = 'ai-chat-typing-loader';
  loaderDiv.className = 'message message-model';
  loaderDiv.innerHTML = `
    <div class="typing-loader">
      <span></span>
      <span></span>
      <span></span>
    </div>
  `;
  chatMessages.appendChild(loaderDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    const context = getSimulationContext();
    const history = aiChatHistory.slice(-10);

    const headers = {
      'Content-Type': 'application/json',
      'x-guest-id': guestId,
      'x-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone
    };
    if (userToken) {
      headers['Authorization'] = `Bearer ${userToken}`;
    }

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: promptMessage, history, context })
    });

    const loader = document.getElementById('ai-chat-typing-loader');
    if (loader) loader.remove();

    if (res.ok) {
      const data = await res.json();
      appendModelMessage(data.reply);
      aiChatHistory.push({ role: 'user', text: `[Reflection Check]: ${answer}` });
      aiChatHistory.push({ role: 'model', text: data.reply });
      
      // Update remaining limits dynamically
      if (typeof data.remaining !== 'undefined') {
        currentLimit.remaining = data.remaining;
        updateUserStatusUI();
      }
    } else {
      if (res.status === 403) {
        appendModelMessage(`System: Daily query limit reached. Please sign in or upgrade.`);
        await checkAuthStatus();
      } else if (res.status === 401) {
        appendModelMessage(`System: Authentication required. Please sign in.`);
        await checkAuthStatus();
      } else {
        const err = await res.json();
        appendModelMessage(`Error: ${err.error || 'Failed to submit answer for evaluation.'}`);
      }
    }
  } catch (err) {
    const loader = document.getElementById('ai-chat-typing-loader');
    if (loader) loader.remove();
    console.error('Failed to submit reflection:', err);
    appendModelMessage('Error: No connection to the server for evaluation.');
  }
}

function addCopyButton(messageElement, textToCopy) {
  const copyBtn = document.createElement('button');
  copyBtn.className = 'chat-message-copy-btn';
  copyBtn.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
  `;
  copyBtn.title = 'Copy message';

  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(textToCopy).then(() => {
      copyBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="color: #22c55e;">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      `;
      setTimeout(() => {
        copyBtn.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        `;
      }, 1500);
    }).catch(err => {
      console.error('Failed to copy text:', err);
    });
  });

  messageElement.appendChild(copyBtn);
}

function appendUserMessage(text) {
  const chatMessages = document.getElementById('ai-chat-messages');
  if (!chatMessages) return;

  const div = document.createElement('div');
  div.className = 'message message-user';
  div.setAttribute('dir', 'auto');
  if (/[\u0590-\u05FF]/.test(text)) {
    div.classList.add('hebrew-text');
  }
  div.textContent = text;
  
  // Add copy button
  addCopyButton(div, text);

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function parseMarkdownOnly(text) {
  let escaped = escapeHtml(text);
  // **bold** -> <strong>bold</strong>
  escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // *italic* -> <em>italic</em>
  escaped = escaped.replace(/\*(.*?)\*/g, '<em>$1</em>');
  escaped = escaped.replace(/_(.*?)_/g, '<em>$1</em>');
  return escaped;
}

function makeElementsClickable(container) {
  const idMap = new Map();
  if (renderer) {
    if (renderer.metabNodes) {
      renderer.metabNodes.forEach(n => {
        if (n.biggId) idMap.set(n.biggId.toLowerCase(), { type: 'metabolite', id: n.id, node: n });
        if (n.id) idMap.set(n.id.toLowerCase(), { type: 'metabolite', id: n.id, node: n });
      });
    }
    if (renderer.reactions) {
      renderer.reactions.forEach(r => {
        if (r.biggId) idMap.set(r.biggId.toLowerCase(), { type: 'reaction', id: r.id, rxn: r });
        if (r.id) idMap.set(r.id.toLowerCase(), { type: 'reaction', id: r.id, rxn: r });
      });
    }
  }

  const wordRegex = /\b[A-Za-z0-9_]{3,}\b/g;

  // Walk text nodes
  const walk = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
  let textNode;
  const nodesToReplace = [];

  while (textNode = walk.nextNode()) {
    const text = textNode.nodeValue;
    let hasMatch = false;
    wordRegex.lastIndex = 0;
    let match;
    while ((match = wordRegex.exec(text)) !== null) {
      if (idMap.has(match[0].toLowerCase())) {
        hasMatch = true;
        break;
      }
    }
    if (hasMatch) {
      nodesToReplace.push(textNode);
    }
  }

  nodesToReplace.forEach(node => {
    const text = node.nodeValue;
    wordRegex.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match;

    while ((match = wordRegex.exec(text)) !== null) {
      const matchedText = match[0];
      const lower = matchedText.toLowerCase();

      if (idMap.has(lower)) {
        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
        }

        const info = idMap.get(lower);
        const span = document.createElement('span');
        span.className = 'clickable-map-element';
        span.textContent = matchedText;
        span.dataset.type = info.type;
        span.dataset.id = info.id;

        span.addEventListener('click', () => {
          if (info.type === 'metabolite') {
            renderer.selectMetabolite(info.node.id);
            handleMetaboliteSelect(info.node);
            renderer.focusOnCoordinates(info.node.x, info.node.y, 0.85);
          } else {
            renderer.selectReaction(info.rxn.id);
            handleReactionSelect(info.rxn);
            renderer.focusOnCoordinates(info.rxn.labelX, info.rxn.labelY, 0.85);
          }
        });

        fragment.appendChild(span);
        lastIndex = wordRegex.lastIndex;
      }
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
    }

    node.parentNode.replaceChild(fragment, node);
  });
}

function appendModelMessage(text) {
  const chatMessages = document.getElementById('ai-chat-messages');
  if (!chatMessages) return;

  const div = document.createElement('div');
  div.className = 'message message-model';
  div.style.whiteSpace = 'pre-wrap';
  div.setAttribute('dir', 'auto');
  if (/[\u0590-\u05FF]/.test(text)) {
    div.classList.add('hebrew-text');
  }
  
  // Set parsed HTML (with bold/italic)
  div.innerHTML = parseMarkdownOnly(text);
  
  // Add interactive click handlers to any detected reaction/metabolite IDs
  makeElementsClickable(div);
  
  // Add copy button (copies the raw unparsed markdown response)
  addCopyButton(div, text);
  
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}


