import fs from 'fs';
import highsLoader from 'highs';

async function test() {
  const highs = await highsLoader();
  const lpHeader = fs.readFileSync('./public/static_lp_header.txt', 'utf8');
  const lpString = lpHeader + '\nEnd';
  
  const start = Date.now();
  const iterations = 50;
  for (let i = 0; i < iterations; i++) {
    highs.solve(lpString, { "log_to_console": false, "output_flag": false });
  }
  const diff = Date.now() - start;
  console.log(`${iterations} solves took ${diff} ms (avg ${(diff/iterations).toFixed(2)} ms per solve)`);
}
test();
