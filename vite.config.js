import { defineConfig } from 'vite';
import obfuscator from 'vite-plugin-javascript-obfuscator';

export default defineConfig({
  plugins: [
    obfuscator({
      options: {
        // High level of protection but keeping performance acceptable
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.75,
        numbersToExpressions: true,
        simplify: true,
        stringArrayShuffle: true,
        splitStrings: true,
        stringArrayThreshold: 0.75
      }
    })
  ],
  build: {
    chunkSizeWarningLimit: 1000
  }
});

