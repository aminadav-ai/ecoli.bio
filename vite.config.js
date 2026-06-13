import { defineConfig } from 'vite';
import obfuscator from 'vite-plugin-javascript-obfuscator';

export default defineConfig({
  plugins: [
    obfuscator({
      options: {
        // Safe options for high performance in PixiJS and simulation loop
        compact: true,
        controlFlowFlattening: false,
        numbersToExpressions: false,
        simplify: true,
        stringArray: true,
        stringArrayShuffle: true,
        splitStrings: false,
        stringArrayThreshold: 0.75
      }
    })
  ],
  build: {
    chunkSizeWarningLimit: 1000
  }
});

