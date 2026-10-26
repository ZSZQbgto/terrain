import { defineConfig } from 'vite';
import modelLibraryPlugin from './scripts/vite-plugin-models.mjs';

export default defineConfig({
  base: './',
  plugins: [modelLibraryPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 3000,
  },
});
