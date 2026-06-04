# scratch/print_fluxes.py
import json
from simulation import Simulation

with open("public/iJO1366.Central metabolism.json", "r", encoding="utf-8") as f:
    map_data = json.load(f)
    
sim = Simulation(map_data)
sim.tick(1.0)
sim.solve_fba()

print("Non-zero fluxes in simulation.reactions:")
has_nonzero = False
for r_id, r in sim.reactions.items():
    if abs(r['flux']) > 1e-4:
        print(f"Reaction {r_id}: {r['flux']:.4f} ({r['name']})")
        has_nonzero = True

if not has_nonzero:
    print("All reaction fluxes in sim.reactions are zero!")

print("\nModel objective reaction:", sim.model.objective)
print("Model objective value:", sim.model.optimize().objective_value)
