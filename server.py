# server.py
import asyncio
import websockets
import json
import gzip
import traceback
from simulation import Simulation

async def handler(websocket):
    print("[Server] New client connected.")
    try:
        # Load map JSON
        with open("public/iJO1366.Central metabolism.json", "r", encoding="utf-8") as f:
            map_data = json.load(f)
            
        sim = Simulation(map_data)
        
    except Exception as e:
        print(f"[Server] Failed to initialize simulation: {e}")
        traceback.print_exc()
        return

    # Task to periodically push simulation state updates to the client
    async def send_updates():
        try:
            while True:
                # If not paused, advance the simulation
                if not sim.is_paused:
                    sim.tick(sim.speed_multiplier)
                
                # Fetch biomass flux (growth rate) from the model objective
                try:
                    biomass_flux = float(sim.model.reactions.get_by_id(sim.biomass_id).flux)
                except Exception:
                    biomass_flux = 0.0
                
                # Build state package
                state = {
                    'metabolites': {
                        m_id: {
                            'concentration': float(m['concentration'])
                        } for m_id, m in sim.metabolites.items()
                    },
                    'reactions': {
                        r_id: {
                            'flux': float(r['flux'])
                        } for r_id, r in sim.reactions.items()
                    },
                    'biomass_flux': float(max(0.0, biomass_flux))
                }
                
                # Serialize to JSON and compress using Gzip
                payload = json.dumps(state).encode('utf-8')
                compressed_payload = gzip.compress(payload)
                
                # Send as binary frame
                await websocket.send(compressed_payload)
                
                # Sleep to maintain 20Hz (50ms interval)
                await asyncio.sleep(0.05)
                
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"[Server] Error in update loop: {e}")
            traceback.print_exc()

    # Start the background update task
    updater_task = asyncio.create_task(send_updates())
    
    # Receive client commands
    try:
        async for message in websocket:
            try:
                data = json.loads(message)
                msg_type = data.get('type')
                
                if msg_type == 'update_parameter':
                    rxn_id = data.get('rxn_id')
                    param = data.get('param')
                    val = data.get('value')
                    print(f"[Server] Parameter update: {rxn_id} {param} = {val}")
                    sim.update_parameter(rxn_id, param, val)
                    
                elif msg_type == 'bulk_update_parameters':
                    updates = data.get('updates', [])
                    print(f"[Server] Bulk parameter update for {len(updates)} reactions")
                    for u in updates:
                        sim.update_parameter(u.get('rxn_id'), u.get('param'), u.get('value'))
                        
                elif msg_type == 'inject':
                    metab_id = data.get('metab_id')
                    amount = data.get('amount', 0.0)
                    print(f"[Server] Spiking metabolite: {metab_id} +{amount} mM")
                    sim.inject(metab_id, amount)
                    
                elif msg_type == 'deplete':
                    metab_id = data.get('metab_id')
                    print(f"[Server] Depleting metabolite: {metab_id}")
                    sim.deplete(metab_id)
                    
                elif msg_type == 'reset':
                    print("[Server] Resetting simulation state")
                    sim.reset()
                    
                elif msg_type == 'pause':
                    val = data.get('value', False)
                    print(f"[Server] Setting paused state = {val}")
                    sim.is_paused = val
                    
                elif msg_type == 'speed':
                    val = data.get('value', 1.0)
                    print(f"[Server] Setting speed multiplier = {val}x")
                    sim.speed_multiplier = val
                    
            except Exception as e:
                print(f"[Server] Error handling client message: {e}")
                traceback.print_exc()
                
    except websockets.exceptions.ConnectionClosed:
        print("[Server] Client disconnected.")
    finally:
        updater_task.cancel()

async def main():
    print("[Server] Starting WebSocket server on port 8000...")
    async with websockets.serve(handler, "0.0.0.0", 8000):
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    asyncio.run(main())
