import fs from 'fs';
import path from 'path';
import highsLoader from 'highs';
import { precalculateGuestState, getPrecalculatedGuestState } from '../src/fba_solver_core.js';

async function main() {
  console.log('[Guest State Generator] Initializing HiGHS solver...');
  const highs = await highsLoader();
  
  const lpHeaderPath = path.resolve('public/static_lp_header.txt');
  const staticLpHeader = fs.readFileSync(lpHeaderPath, 'utf8');

  console.log('[Guest State Generator] Running simulation...');
  precalculateGuestState(highs, staticLpHeader);
  
  const guestState = getPrecalculatedGuestState();
  if (guestState) {
    const outputPath = path.resolve('public/guest_state.json');
    fs.writeFileSync(outputPath, JSON.stringify(guestState, null, 2), 'utf8');
    console.log(`[Guest State Generator] Successfully wrote guest state to ${outputPath}`);
  } else {
    console.error('[Guest State Generator] Failed to precalculate guest state.');
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('[Guest State Generator] Error:', err);
  process.exit(1);
});
