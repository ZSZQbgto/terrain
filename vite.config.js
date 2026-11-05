import { defineConfig } from 'vite';
import terrainAssetsPlugin from './scripts/vite-plugin-terrain-assets.mjs';
import modelLibraryPlugin from './scripts/vite-plugin-models.mjs';

export default defineConfig({
  base: './',
  // 地形资产守卫放最前面：dev / build / preview 启动时先检测 public/data 的瓦片，
  // 缺失就自动执行 npm run assets（全量：高度场 + 卫星瓦片），再照常启动。
  plugins: [terrainAssetsPlugin(), modelLibraryPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 3000,
  },
});
