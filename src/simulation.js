/**
 * src/simulation.js
 * 
 * Client-side kinetic simulation engine for E. coli central metabolism.
 * Parses network stoichiometry from Escher map JSON, runs a 20Hz ODE solver
 * using Euler integration, and supports real-time parameter tweaking.
 */

export class Simulation {
  constructor(escherMapData) {
    this.mapData = escherMapData;
    this.metabolites = {}; // bigg_id -> { name, concentration, isBuffered, type }
    this.reactions = {};    // bigg_id -> { name, reversibility, substrates, products, stoichiometry, vMax, km, flux }
    
    this.activeModel = 'e_coli_core';
    this.fluxMultiplier = 1.0;
    this.kmMultiplier = 1.0;

    // Define cofactors and inorganic molecules to buffer (hold at constant physiological concentrations)
    this.bufferedIds = new Set([
      'atp_c', 'adp_c', 'amp_c',
      'nad_c', 'nadh_c',
      'nadp_c', 'nadph_c',
      'pi_c', 'pi_e',
      'coa_c',
      'q8_c', 'q8h2_c',
      'nh4_c', 'nh4_e',
      'co2_c', 'co2_e',
      'o2_c', 'o2_e',
      'h_c', 'h_e',
      'h2o_c', 'h2o_e',
      'for_e', 'for_c', // formate transport can accumulate, but buffer to keep stable
    ]);

    // Initial physiological concentrations (mM)
    this.initialConcentrations = {
      // Primary carbon sources
      'glc__D_e': 10.0, // Extracellular glucose starts abundant
      'glc__D_c': 2.0,
      
      // Glycolysis / Gluconeogenesis intermediates
      'g6p_c': 1.0,
      'f6p_c': 0.8,
      'fdp_c': 0.5,
      'dhap_c': 0.4,
      'g3p_c': 0.3,
      '13dpg_c': 0.1,
      '3pg_c': 0.5,
      '2pg_c': 0.2,
      'pep_c': 0.8,
      'pyr_c': 1.5,
      
      // TCA cycle intermediates
      'accoa_c': 0.5,
      'oaa_c': 0.2,
      'cit_c': 1.2,
      'icit_c': 0.3,
      'akg_c': 1.0,
      'succoa_c': 0.4,
      'succ_c': 0.8,
      'fum_c': 0.5,
      'mal__L_c': 0.8,
      
      // Pentose Phosphate Pathway (PPP)
      '6pgl_c': 0.2,
      '6pgc_c': 0.4,
      'ru5p__D_c': 0.3,
      'r5p_c': 0.5,
      'xu5p__D_c': 0.4,
      's7p_c': 0.6,
      'e4p_c': 0.3,
      
      // Fermentation products
      'ac_c': 1.0,
      'ac_e': 0.2,
      'etoh_c': 0.5,
      'etoh_e': 0.1,
      'lac__D_c': 0.5,
      'lac__D_e': 0.1,

      // Buffered cofactors / small molecules
      'atp_c': 4.0,
      'adp_c': 1.0,
      'amp_c': 0.2,
      'nad_c': 2.6,
      'nadh_c': 0.1,
      'nadp_c': 0.1,
      'nadph_c': 0.4,
      'pi_c': 10.0,
      'pi_e': 10.0,
      'coa_c': 1.0,
      'q8_c': 2.0,
      'q8h2_c': 1.0,
      'nh4_c': 10.0,
      'nh4_e': 10.0,
      'co2_c': 1.0,
      'co2_e': 1.0,
      'o2_c': 0.2,
      'o2_e': 0.2,
      'h_c': 1.0,
      'h_e': 1.0,
      'h2o_c': 55000.0,
      'h2o_e': 55000.0,
      'for_c': 0.1,
      'for_e': 0.1,
    };

    // Predefined strain multipliers
    this.strains = {
      e_coli_core: {
        name: 'Wild-Type Core (e_coli_core)',
        description: 'Standard wild-type core metabolic model. Balanced and stable.',
        fluxMultiplier: 1.0,
        kmMultiplier: 1.0
      },
      iJO1366: {
        name: 'Aerobic Growth Strain (iJO1366)',
        description: 'Accelerated glycolysis and oxygen uptake model.',
        fluxMultiplier: 1.25,
        kmMultiplier: 0.9
      },
      iML1515: {
        name: 'Optimized Mutant (iML1515)',
        description: 'Highly active metabolic network, optimized for growth rate.',
        fluxMultiplier: 1.5,
        kmMultiplier: 0.8
      },
      iAF1260: {
        name: 'Classic Strain (iAF1260)',
        description: 'Classic genome-scale reconstruction with moderate kinetics.',
        fluxMultiplier: 0.9,
        kmMultiplier: 1.0
      },
      iJR904: {
        name: 'Slow Fermenter (iJR904)',
        description: 'Slower substrate uptake and higher Km binding thresholds.',
        fluxMultiplier: 0.8,
        kmMultiplier: 1.3
      }
    };

    this.initialize();
  }

  /**
   * Parses the Escher map to extract all metabolites and reactions.
   */
  initialize() {
    const mapData = this.mapData[1];
    
    // 1. Gather all metabolites
    for (const [nodeId, node] of Object.entries(mapData.nodes)) {
      if (node.node_type === 'metabolite') {
        const id = node.bigg_id;
        if (!this.metabolites[id]) {
          const isBuffered = this.bufferedIds.has(id);
          let type = 'metabolite';
          
          if (id === 'glc__D_e' || id === 'glc__D_c') {
            type = 'substrate';
          } else if (id.includes('atp_c') || id.includes('adp_c') || id.includes('nad') || id.includes('nadh') || id.includes('coa')) {
            type = 'cofactor';
          }

          this.metabolites[id] = {
            id: id,
            name: node.name,
            concentration: this.initialConcentrations[id] || 1.0,
            isBuffered: isBuffered,
            type: type
          };
        }
      }
    }

    // 2. Gather reactions and construct stoichiometry
    for (const [rxnId, rxn] of Object.entries(mapData.reactions)) {
      const biggId = rxn.bigg_id;
      const name = rxn.name;
      const reversibility = rxn.reversibility;
      
      const substrates = [];
      const products = [];
      const stoichiometry = {};

      rxn.metabolites.forEach(metab => {
        const id = metab.bigg_id;
        const coeff = metab.coefficient;
        
        stoichiometry[id] = coeff;
        if (coeff < 0) {
          substrates.push(id);
        } else {
          products.push(id);
        }

        // Safety: Ensure metabolite exists in our register
        if (!this.metabolites[id]) {
          this.metabolites[id] = {
            id: id,
            name: id,
            concentration: this.initialConcentrations[id] || 1.0,
            isBuffered: this.bufferedIds.has(id),
            type: 'metabolite'
          };
        }
      });

      // Assign realistic Vmax and Km parameters based on reaction type
      let defaultVmax = 10.0;
      let defaultKm = 0.8;

      // Make primary pathway transport and checkpoints highly active
      if (biggId === 'GLCpts' || biggId === 'EX_glc__D_e') {
        defaultVmax = 18.0;
        defaultKm = 0.5;
      } else if (biggId === 'PFK' || biggId === 'PYK') {
        defaultVmax = 15.0; // Rate-limiting glycolytic checkpoints
        defaultKm = 0.3;
      } else if (biggId === 'CS' || biggId === 'ICDHyr') {
        defaultVmax = 12.0; // TCA entry and checkpoints
        defaultKm = 0.4;
      } else if (biggId === 'BIOMASS_Ecoli_core_w_GAM') {
        defaultVmax = 8.0; // Biomass production rate
        defaultKm = 1.0;
      }

      this.reactions[biggId] = {
        id: biggId,
        name: name,
        reversibility: reversibility,
        substrates: substrates,
        products: products,
        stoichiometry: stoichiometry,
        vMax: defaultVmax,
        km: defaultKm,
        perturbationMultiplier: 1.0,
        flux: 0.0
      };
    }
  }

  /**
   * Reset simulation concentrations and fluxes to initial steady state.
   */
  reset() {
    for (const [id, metab] of Object.entries(this.metabolites)) {
      metab.concentration = this.initialConcentrations[id] || 1.0;
    }
    for (const rxn of Object.values(this.reactions)) {
      rxn.flux = 0.0;
    }
  }

  /**
   * Injects a specified amount of metabolite (mM).
   */
  inject(metabId, amount) {
    if (this.metabolites[metabId]) {
      this.metabolites[metabId].concentration += amount;
      // Clamp to prevent overflow
      if (this.metabolites[metabId].concentration > 150.0) {
        this.metabolites[metabId].concentration = 150.0;
      }
    }
  }

  /**
   * Tweaks Vmax or Km for a specific reaction.
   */
  updateParameter(rxnId, param, value) {
    if (this.reactions[rxnId]) {
      if (param === 'vMax') {
        this.reactions[rxnId].vMax = Math.max(0.0, value);
      } else if (param === 'km') {
        this.reactions[rxnId].km = Math.max(0.05, value);
      }
    }
  }

  /**
   * Applies the strain parameter scaling factors.
   */
  selectStrain(strainId) {
    const strain = this.strains[strainId];
    if (strain) {
      this.activeModel = strainId;
      this.fluxMultiplier = strain.fluxMultiplier;
      this.kmMultiplier = strain.kmMultiplier;
      this.reset();
      console.log(`[Simulation] Switched to strain: ${strain.name}`);
    }
  }

  /**
   * Runs the Euler integration tick.
   * Runs at a fixed rate (e.g. 20Hz), sub-stepping dt for integration stability.
   */
  tick(speedMultiplier = 1.0) {
    // 10 sub-steps per frame to prevent numeric divergence in ODEs
    const numSubSteps = 10;
    const dt = 0.005 * speedMultiplier; // Small step size: 5ms * multiplier

    // Initialize flux accumulator to average over sub-steps
    const fluxAccumulator = {};
    for (const rxnId of Object.keys(this.reactions)) {
      fluxAccumulator[rxnId] = 0.0;
    }

    for (let step = 0; step < numSubSteps; step++) {
      // 1. Calculate reaction fluxes
      const currentFluxes = {};
      for (const [rxnId, rxn] of Object.entries(this.reactions)) {
        const vMax = rxn.vMax * this.fluxMultiplier * (rxn.perturbationMultiplier !== undefined ? rxn.perturbationMultiplier : 1.0);
        const km = rxn.km * this.kmMultiplier;

        // Rate = Vmax * Product( [S_i] / (Km + [S_i]) )
        let forwardRate = vMax;
        
        // Handle substrates saturation
        if (rxn.substrates.length > 0) {
          for (const subId of rxn.substrates) {
            const conc = this.metabolites[subId].concentration;
            forwardRate *= conc / (km + conc);
          }
        } else {
          forwardRate = 0.0; // Sinks or exchanges with no inputs don't run forwards
        }

        let flux = forwardRate;

        // If reversible, compute backward rate: Vmax * Product( [P_i] / (Km + [P_i]) )
        if (rxn.reversibility) {
          let backwardRate = vMax;
          if (rxn.products.length > 0) {
            for (const prodId of rxn.products) {
              const conc = this.metabolites[prodId].concentration;
              backwardRate *= conc / (km + conc);
            }
          } else {
            backwardRate = 0.0;
          }
          flux -= backwardRate;
        }

        currentFluxes[rxnId] = flux;
        fluxAccumulator[rxnId] += flux;
      }

      // 2. Compute derivatives (dC/dt) for each metabolite
      const derivatives = {};
      for (const id of Object.keys(this.metabolites)) {
        derivatives[id] = 0.0;
      }

      for (const [rxnId, rxn] of Object.entries(this.reactions)) {
        const flux = currentFluxes[rxnId];
        
        // Stoichiometry adds/subtracts concentrations
        for (const [metabId, coeff] of Object.entries(rxn.stoichiometry)) {
          if (this.metabolites[metabId]) {
            derivatives[metabId] += coeff * flux;
          }
        }
      }

      // 3. Integrate and update concentrations (Euler step)
      for (const [id, metab] of Object.entries(this.metabolites)) {
        if (!metab.isBuffered) {
          // Add integration delta
          let nextConc = metab.concentration + derivatives[id] * dt;
          
          // Apply biological sink/decay to ensure homeostatic stability (simulate dilution/decay)
          const isGlucoseInput = (id === 'glc__D_c');
          const isExitSink = (id === 'pyr_c' || id === 'oaa_c' || id === 'ac_c' || id === 'etoh_c');
          
          if (isGlucoseInput) {
            nextConc *= Math.exp(-0.02 * dt); // Dilution of intracellular glucose
          } else if (isExitSink) {
            nextConc *= Math.exp(-0.06 * dt); // High decay representing secretion/sinks
          } else {
            nextConc *= Math.exp(-0.015 * dt); // Standard pathway dilution
          }

          // Safety clamp: Concentrations must be positive, enforce baseline of 0.1 mM
          metab.concentration = Math.max(0.1, nextConc);
        }
      }
    }

    // 4. Update average fluxes for display
    for (const rxnId of Object.keys(this.reactions)) {
      this.reactions[rxnId].flux = fluxAccumulator[rxnId] / numSubSteps;
    }
  }

  /**
   * Helper to return dynamic details of a metabolite.
   */
  getMetaboliteInfo(id) {
    const metab = this.metabolites[id];
    if (!metab) return null;

    // Calculate dynamic influx and outflux
    let influx = 0;
    let outflux = 0;

    for (const rxn of Object.values(this.reactions)) {
      const coeff = rxn.stoichiometry[id];
      if (coeff) {
        const rate = rxn.flux * coeff;
        if (rate > 0) influx += rate;
        else outflux += Math.abs(rate);
      }
    }

    return {
      ...metab,
      influx: influx,
      outflux: outflux,
      netFlux: influx - outflux
    };
  }
}
