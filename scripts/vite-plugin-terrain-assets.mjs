/**
 * Vite 插件：地形瓦片守卫（terrain-assets-guard）。
 *
 * 背景：`public/data/`（height.f16 + terrain.json + sat/*.jpg）由 `npm run assets`
 * （scripts/prepare-assets.mjs）生成，且被 .gitignore 忽略 —— 干净检出后该目录不存在。
 * 此时 dev server 会把 `GET /data/terrain.json` 回退成 index.html（200 + text/html），
 * 前端 `res.json()` 直接报 `Unexpected token '<'`；卫星瓦片缺失则地形只能降级成高程分层。
 *
 * 本插件让「打开项目即自动检测、缺了自动 npm run assets」成为默认行为：
 *   - dev / build / preview 启动时：configResolved（早于 Vite 7 扫描 publicDir 生成公共
 *     文件清单）里检查 public/data，缺高度场 / terrain.json / 卫星瓦片就同步跑一遍全量
 *     资产管线；configureServer / buildStart 保留为幂等兜底（同一进程只尝试一次）。
 *   - build 结束（closeBundle）：检查 dist/data，缺瓦片时先补 public/data 再同步到 dist
 *     （与 package.json 的 postbuild `node scripts/ensure-assets.mjs --dist` 同一实现）。
 *
 * 失败永远不中断构建：只打印可操作的中文提示（缺源图 / 缺 sharp / 超时），
 * 页面会按实际存在的资产自动降级。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTerrainAssets, ensureDistAssets } from './ensure-assets.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default function terrainAssetsPlugin(options = {}) {
  const state = {
    root: options.root ?? PLUGIN_ROOT,
    logger: null,
    command: 'serve',
    attempted: false,
    distChecked: false,
  };

  const getLogger = () => state.logger ?? console;

  /** 同一进程（dev / build / preview）只做一次资产自检，避免重复生成 */
  const ensurePublic = () => {
    if (state.attempted) return;
    state.attempted = true;
    try {
      ensureTerrainAssets(PLUGIN_ROOT, { logger: getLogger(), timeoutMs: options.timeoutMs });
    } catch (err) {
      getLogger().warn?.(`[terrain-assets] 地形瓦片自检异常（已忽略）：${err?.message ?? err}`);
    }
  };

  return {
    name: 'terrain-assets-guard',
    enforce: 'pre',

    // Vite 7 在创建 server 的最开始就扫描 publicDir 生成公共文件清单；
    // configResolved 比它更早，这里生成的瓦片才能真正被 /data/* 提供。
    configResolved(config) {
      state.root = options.root ?? config.root ?? PLUGIN_ROOT;
      state.logger = config.logger ?? null;
      state.command = config.command;
      ensurePublic();
    },

    // 幂等兜底（`npx vite` / 直接调用 build API 等路径）
    buildStart() {
      ensurePublic();
    },

    configureServer() {
      ensurePublic();
    },

    closeBundle() {
      if (state.command !== 'build' || state.distChecked) return;
      state.distChecked = true;
      try {
        ensureDistAssets(state.root, { logger: getLogger(), timeoutMs: options.timeoutMs, quietWhenComplete: true });
      } catch (err) {
        getLogger().warn?.(`[terrain-assets] dist 瓦片自检异常（已忽略）：${err?.message ?? err}`);
      }
    },
  };
}
