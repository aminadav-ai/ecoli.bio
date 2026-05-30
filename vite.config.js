import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 1000 // Increase chunk size warning limit to 1000 kB to avoid warnings for large library dependencies (like PixiJS)
  }
});
