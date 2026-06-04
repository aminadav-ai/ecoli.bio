# simulation.py
import cobra
import json

# Pre-load E. coli iJO1366 model globally once on module import
print("[Simulation] Pre-loading E. coli iJO1366 model globally...")
_global_model = cobra.io.load_model("iJO1366")
print("[Simulation] Model loaded successfully.")

class Simulation:
    def __init__(self, map_data):
        self.map_data = map_data
        print("[Simulation] Cloning pre-loaded model...")
        self.model = _global_model.copy()
        print("[Simulation] Model cloned successfully.")
        
        # Set biomass objective explicitly
        self.biomass_id = "BIOMASS_Ec_iJO1366_core_53p95M"
        self.model.objective = self.biomass_id
        
        # Store original bounds to reset them on each FBA solve
        self.original_bounds = {r.id: (r.lower_bound, r.upper_bound) for r in self.model.reactions}
        
        self.metabolites = {}
        self.reactions = {}
        self.is_paused = False
        self.speed_multiplier = 1.0
        self.tick_counter = 0
        
        # Buffered metabolites (constant physiological concentrations)
        self.buffered_ids = {
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
            'for_e', 'for_c',
        }
        
        # Initial concentrations (mM)
        self.initial_concentrations = {
            'glc__D_e': 10.0,
            'glc__D_c': 2.0,
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
            'accoa_c': 0.5,
            'oaa_c': 0.2,
            'cit_c': 1.2,
            'icit_c': 0.3,
            'akg_c': 1.0,
            'succoa_c': 0.4,
            'succ_c': 0.8,
            'fum_c': 0.5,
            'mal__L_c': 0.8,
            '6pgl_c': 0.2,
            '6pgc_c': 0.4,
            'ru5p__D_c': 0.3,
            'r5p_c': 0.5,
            'xu5p__D_c': 0.4,
            's7p_c': 0.6,
            'e4p_c': 0.3,
            'ac_c': 1.0,
            'ac_e': 0.0,
            'etoh_c': 0.5,
            'etoh_e': 0.0,
            'lac__D_c': 0.5,
            'lac__D_e': 0.0,
            'pyr_e': 0.0,
            'succ_e': 0.0,
            'akg_e': 0.0,
            'mal__L_e': 0.0,
            'fum_e': 0.0,
            'glu__L_e': 0.0,
            'gln__L_e': 0.0,
            'fru_e': 0.0,
            'acald_e': 0.0,
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
        }
        
        self.reaction_mapping = {
            'PPKr': 'PPK',
            'PPK2r': 'PPK2',
        }
        
        self.initialize()
        
        # Calculate normal reference fluxes under default conditions
        self.solve_fba()
        self.normal_fluxes = {}
        for m_id in self.metabolites:
            info = self.get_metabolite_info(m_id)
            self.normal_fluxes[m_id] = max(1.5, info['influx']) if info else 1.0

    def initialize(self):
        map_reactions = self.map_data[1]['reactions']
        map_nodes = self.map_data[1]['nodes']
        
        # 1. Gather metabolites in the map
        for node in map_nodes.values():
            if node['node_type'] == 'metabolite':
                m_id = node['bigg_id']
                if m_id not in self.metabolites:
                    is_buffered = m_id in self.buffered_ids
                    self.metabolites[m_id] = {
                        'id': m_id,
                        'name': node['name'],
                        'concentration': self.initial_concentrations.get(m_id, 1.0),
                        'target_concentration': self.initial_concentrations.get(m_id, 1.0),
                        'is_buffered': is_buffered
                    }
                    
        # 2. Gather reactions and construct stoichiometry
        for rxn in map_reactions.values():
            bigg_id = rxn['bigg_id']
            name = rxn['name']
            reversibility = rxn['reversibility']
            
            substrates = []
            products = []
            stoichiometry = {}
            
            for metab in rxn['metabolites']:
                m_id = metab['bigg_id']
                coeff = metab['coefficient']
                stoichiometry[m_id] = coeff
                if coeff < 0:
                    substrates.append(m_id)
                else:
                    products.append(m_id)
                    
            default_vmax = 10.0
            default_km = 0.8
            
            # Apply specific defaults
            if bigg_id in ['GLCpts', 'EX_glc__D_e']:
                default_vmax = 18.0
                default_km = 0.5
            elif bigg_id in ['PFK', 'PYK']:
                default_vmax = 15.0
                default_km = 0.3
            elif bigg_id in ['CS', 'ICDHyr']:
                default_vmax = 12.0
                default_km = 0.4
            elif bigg_id == 'BIOMASS_Ecoli_core_w_GAM':
                default_vmax = 8.0
                default_km = 1.0
                
            self.reactions[bigg_id] = {
                'id': bigg_id,
                'name': name,
                'reversibility': reversibility,
                'substrates': substrates,
                'products': products,
                'stoichiometry': stoichiometry,
                'vMax': default_vmax,
                'km': default_km,
                'default_vmax': default_vmax,
                'default_km': default_km,
                'flux': 0.0
            }

    def reset(self):
        self.tick_counter = 0
        for m_id, metab in self.metabolites.items():
            metab['concentration'] = self.initial_concentrations.get(m_id, 1.0)
            metab['target_concentration'] = self.initial_concentrations.get(m_id, 1.0)
        for rxn in self.reactions.values():
            rxn['flux'] = 0.0
            rxn['vMax'] = rxn['default_vmax']
            rxn['km'] = rxn['default_km']
            
        self.solve_fba()
        self.normal_fluxes = {}
        for m_id in self.metabolites:
            info = self.get_metabolite_info(m_id)
            self.normal_fluxes[m_id] = max(1.5, info['influx']) if info else 1.0

    def inject(self, metab_id, amount):
        if metab_id in self.metabolites:
            self.metabolites[metab_id]['concentration'] += amount
            if self.metabolites[metab_id]['concentration'] > 150.0:
                self.metabolites[metab_id]['concentration'] = 150.0

    def deplete(self, metab_id):
        if metab_id in self.metabolites:
            self.metabolites[metab_id]['concentration'] = 0.1

    def update_parameter(self, rxn_id, param, value):
        if rxn_id in self.reactions:
            if param == 'vMax':
                self.reactions[rxn_id]['vMax'] = max(0.0, value)
            elif param == 'km':
                self.reactions[rxn_id]['km'] = max(0.05, value)

    def solve_fba(self):
        # 1. Restore all original bounds
        for rxn_id, bounds in self.original_bounds.items():
            rxn = self.model.reactions.get_by_id(rxn_id)
            rxn.lower_bound = bounds[0]
            rxn.upper_bound = bounds[1]
            
        # 2. Apply kinetic constraints on checkpoints
        coupled_checkpoints = {'GLCptspp', 'PFK', 'PYK', 'CS', 'ICDHyr', 'SUCDi'}
        
        for core_rxn_id, core_rxn in self.reactions.items():
            model_rxn_id = self.reaction_mapping.get(core_rxn_id, core_rxn_id)
            if not self.model.reactions.has_id(model_rxn_id):
                continue
                
            model_rxn = self.model.reactions.get_by_id(model_rxn_id)
            
            v_max = core_rxn['vMax']
            k_m = core_rxn['km']
            
            has_extracellular_substrate = any(s_id.endswith('_e') for s_id in core_rxn['substrates'])
            
            if core_rxn['reversibility']:
                ub_forward = v_max
                ub_backward = v_max
                
                if model_rxn_id in coupled_checkpoints or has_extracellular_substrate:
                    for s_id in core_rxn['substrates']:
                        if s_id in self.metabolites and not self.metabolites[s_id]['is_buffered']:
                            conc = self.metabolites[s_id]['concentration']
                            ub_forward = min(ub_forward, v_max * (conc / (k_m + conc)))
                    for p_id in core_rxn['products']:
                        if p_id in self.metabolites and not self.metabolites[p_id]['is_buffered']:
                            conc = self.metabolites[p_id]['concentration']
                            ub_backward = min(ub_backward, v_max * (conc / (k_m + conc)))
                            
                lb = -ub_backward if model_rxn.lower_bound < -1e-5 else 0.0
                ub = ub_forward if model_rxn.upper_bound > 1e-5 else 0.0
                
                model_rxn.lower_bound = lb
                model_rxn.upper_bound = ub
            else:
                ub_forward = v_max
                if model_rxn_id in coupled_checkpoints or has_extracellular_substrate:
                    for s_id in core_rxn['substrates']:
                        if s_id in self.metabolites and not self.metabolites[s_id]['is_buffered']:
                            conc = self.metabolites[s_id]['concentration']
                            ub_forward = min(ub_forward, v_max * (conc / (k_m + conc)))
                            
                model_rxn.lower_bound = 0.0
                model_rxn.upper_bound = ub_forward if model_rxn.upper_bound > 1e-5 else 0.0
                
        # 3. Optimize FBA
        try:
            solution = self.model.optimize()
            if solution.status == 'optimal':
                for core_rxn_id, core_rxn in self.reactions.items():
                    model_rxn_id = self.reaction_mapping.get(core_rxn_id, core_rxn_id)
                    if self.model.reactions.has_id(model_rxn_id):
                        core_rxn['flux'] = solution.fluxes[model_rxn_id]
                    else:
                        core_rxn['flux'] = 0.0
            else:
                for core_rxn in self.reactions.values():
                    core_rxn['flux'] = 0.0
        except Exception as e:
            print(f"Error solving FBA: {e}")
            for core_rxn in self.reactions.values():
                core_rxn['flux'] = 0.0

    def tick(self, speed_multiplier=1.0):
        dt = 0.01 * speed_multiplier
        if self.tick_counter % 5 == 0:
            self.solve_fba()
        self.tick_counter = (self.tick_counter + 1) % 5
        
        # Influx/Outflux accumulation
        influxes = {m_id: 0.0 for m_id in self.metabolites}
        outfluxes = {m_id: 0.0 for m_id in self.metabolites}
        
        for rxn in self.reactions.values():
            flux = rxn['flux']
            for m_id, coeff in rxn['stoichiometry'].items():
                if m_id in self.metabolites:
                    rate = coeff * flux
                    if rate > 0:
                        influxes[m_id] += rate
                    else:
                        outfluxes[m_id] += abs(rate)
                        
        # Euler integration
        for m_id, metab in self.metabolites.items():
            if metab['is_buffered']:
                metab['target_concentration'] = metab['concentration']
                continue
                
            if m_id.endswith('_e'):
                if m_id == 'glc__D_e':
                    metab['target_concentration'] = metab['concentration']
                    continue
                next_conc = metab['concentration'] + (influxes[m_id] - outfluxes[m_id]) * dt
                metab['concentration'] = max(0.0, min(next_conc, 150.0))
                metab['target_concentration'] = metab['concentration']
            else:
                J_in = influxes[m_id]
                J_out = outfluxes[m_id]
                J = J_in
                J_normal = self.normal_fluxes.get(m_id, 1.0)
                
                v_max_sum = 0.0
                v_max_default_sum = 0.0
                for rxn in self.reactions.values():
                    coeff = rxn['stoichiometry'].get(m_id, 0.0)
                    if coeff:
                        if coeff < 0 or (coeff > 0 and rxn['reversibility']):
                            v_max_sum += rxn['vMax']
                            v_max_default_sum += rxn['default_vmax']
                            
                activity_ratio = 1.0
                if v_max_sum > 0 and v_max_default_sum > 0:
                    activity_ratio = v_max_sum / v_max_default_sum
                    
                baseline = self.initial_concentrations.get(m_id, 1.0)
                target = baseline * (max(0.01, J) / J_normal) / activity_ratio
                target = max(0.1, min(target, 150.0))
                metab['target_concentration'] = target
                
                dC = J_in - J_out * (metab['concentration'] / target) - 0.02 * metab['concentration']
                next_conc = metab['concentration'] + dC * dt
                metab['concentration'] = max(0.1, min(next_conc, 150.0))

    def get_metabolite_info(self, m_id):
        if m_id not in self.metabolites:
            return None
            
        metab = self.metabolites[m_id]
        influx = 0.0
        outflux = 0.0
        
        for rxn in self.reactions.values():
            coeff = rxn['stoichiometry'].get(m_id, 0.0)
            if coeff:
                rate = rxn['flux'] * coeff
                if rate > 0:
                    influx += rate
                else:
                    outflux += abs(rate)
                    
        return {
            **metab,
            'influx': influx,
            'outflux': outflux,
            'netFlux': influx - outflux
        }
