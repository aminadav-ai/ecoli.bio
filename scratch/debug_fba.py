# scratch/debug_fba.py
import json
from simulation import Simulation

# Load map JSON
with open("public/iJO1366.Central metabolism.json", "r", encoding="utf-8") as f:
    map_data = json.load(f)
    
sim = Simulation(map_data)
print(f"Initial FBA solved.")
try:
    solution = sim.model.optimize()
    print(f"Direct Optimize Status: {solution.status}, Objective: {solution.objective_value}")
except Exception as e:
    print(f"Direct Optimize Exception: {e}")

# Check simulation's reactions fluxes
biomass_flux = sim.reactions.get("BIOMASS_Ecoli_core_w_GAM", {}).get("flux", 0.0)
print(f"Simulation BIOMASS_Ecoli_core_w_GAM flux: {biomass_flux}")

# Let's see if the objective BIOMASS_Ec_iJO1366_core_53p95M has any flux
try:
    bm_rxn = sim.model.reactions.get_by_id("BIOMASS_Ec_iJO1366_core_53p95M")
    print(f"Model Objective Reaction Flux: {bm_rxn.flux}")
    print(f"Model Objective Reaction Bounds: {bm_rxn.lower_bound} to {bm_rxn.upper_bound}")
except Exception as e:
    print(f"Error fetching objective: {e}")
