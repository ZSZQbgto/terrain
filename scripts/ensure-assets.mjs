/**
 * 地形瓦片资产自检 / 自动补齐（dev、build、postbuild 与 CLI 共用）。
 *
 * 背景：`public/data/`（height.f16 + terrain.json + sat/*.jpg）与 `dist/data/` 都是
 * `npm run assets`（scripts/prepare-assets.mjs）生成的派生产物，且被 .gitignore 忽略。
 * 干净检出、或换了卫星源图之后，缺瓦片时页面只能降级成高程分层 —— 而用户往往
 * 并不知道要先跑一次资产管线。这里把「检测 + 缺失就自动 npm run assets」做成一处：
 *
 *   - `node scripts/ensure-assets.mjs`         检查 public/data，缺什么自动跑全量资产管线
 *   - `node scripts/ensure-assets.mjs --dist`  检查 dist/data（构建产物），缺则先补 public/data
 *                                              再同步进 dist（`npm run build` 的 postbuild 调用它）
 *
 * 判定内容：
 *   - `public/data/height.f16` 存在且非空
 *   - `public/data/terrain.json` 可解析且 width/height 有效
 *   - 当 `resourses/`（或仓库根）里存在卫星源图时，`sat/` 下必须齐 8×8×3 = 192 张瓦片；
 *     没有卫星源图时只要求高度场（卫星影像是可选功能，页面会自动降级）。
 *
 * 自动生成失败（缺源图、缺 sharp、超时）不抛异常：只打印可操作的中文提示，
 * 由调用方决定继续启动（页面会按实际资产降级，不会白屏）。
 */
import { existsSync, statSync, readFileSync, readdirSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 与 scripts/prepare-assets.mjs 保持一致：8×8 块 × 近/中/远三档
export const CHUNKS = 8;
export const SAT_TIERS = [2048, 512, 128];
export const SAT_TILE_COUNT = CHUNKS * CHUNKS * SAT_TIERS.length; // 192

export const HEIGHT_FILE = 'height.f16';
export const META_FILE = 'terrain.json';
export const SAT_DIR = 'sat';

/** 卫星源图文件名（prepare-assets.mjs 里同名查找；放 resourses/ 或仓库根目录） */
export const SAT_SOURCE_NAMES = ['尚庄炉水库卫星影像64.png'];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAT_TILE_RE = /^(\d+)_(\d+)_(2048|512|128)\.jpg$/;

/** 卫星源图是否存在（决定要不要要求卫星瓦片） */
export function hasSatelliteSource(root = ROOT) {
  for (const dir of [path.join(root, 'resourses'), root]) {
    for (const name of SAT_SOURCE_NAMES) {
      if (existsSync(path.join(dir, name))) return true;
    }
  }
  return false;
}

/**
 * 检查某个 data 目录（public/data 或 dist/data）的资产是否齐全。
 * @param {string} dataDir
 * @param {{ wantsSatellite?: boolean }} [opts] 不传则按项目根判断是否有卫星源图
 */
export function inspectTerrainAssets(dataDir, opts = {}) {
  const wantsSatellite = opts.wantsSatellite ?? hasSatelliteSource(path.resolve(dataDir, '..', '..'));

  const heightFile = path.join(dataDir, HEIGHT_FILE);
  const metaFile = path.join(dataDir, META_FILE);
  const satDir = path.join(dataDir, SAT_DIR);

  const heightOk = existsSync(heightFile) && statSync(heightFile).size > 0;

  let metaOk = false;
  if (existsSync(metaFile)) {
    try {
      const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
      metaOk = Number.isFinite(meta?.width) && meta.width > 0 && Number.isFinite(meta?.height) && meta.height > 0;
    } catch {
      metaOk = false;
    }
  }

  let satTiles = 0;
  if (existsSync(satDir)) {
    try {
      satTiles = readdirSync(satDir).filter((name) => SAT_TILE_RE.test(name)).length;
    } catch {
      satTiles = 0;
    }
  }
  const satOk = !wantsSatellite || satTiles >= SAT_TILE_COUNT;

  const missing = [];
  if (!heightOk) missing.push(HEIGHT_FILE);
  if (!metaOk) missing.push(META_FILE);
  if (!satOk) missing.push(`${SAT_DIR}/ 瓦片（${satTiles}/${SAT_TILE_COUNT}）`);

  return {
    dataDir,
    wantsSatellite,
    heightOk,
    metaOk,
    satTiles,
    satOk,
    complete: heightOk && metaOk && satOk,
    missing,
  };
}

/** 同步执行全量资产管线（= npm run assets，等价于 node scripts/prepare-assets.mjs） */
export function runAssetPipeline(root = ROOT, { logger = console, timeoutMs = 15 * 60 * 1000 } = {}) {
  const script = path.join(root, 'scripts', 'prepare-assets.mjs');
  if (!existsSync(script)) {
    logger.warn?.(`[terrain-assets] 找不到 ${script}，无法自动生成地形资产（请手动运行 npm run assets）`);
    return false;
  }
  logger.info?.('[terrain-assets] 正在执行资产管线：node scripts/prepare-assets.mjs（高度场 + 卫星瓦片，首次生成卫星瓦片约需数分钟）…');
  const started = Date.now();
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    stdio: 'inherit',
    timeout: timeoutMs,
    windowsHide: true,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) {
    logger.warn?.(`[terrain-assets] 资产管线启动失败：${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    logger.warn?.(
      `[terrain-assets] 资产管线退出码 ${result.status}${result.signal ? `（signal ${result.signal}）` : ''}，用时 ${seconds}s；` +
        '请检查 sharp 是否已安装（npm install）以及 resourses/ 下的源图，或手动运行 npm run assets',
    );
    return false;
  }
  return true;
}

/**
 * 保证 public/data 的瓦片齐全；缺失时自动执行资产管线。
 * 永不抛异常：失败只 warn，返回 ok:false。
 */
export function ensureTerrainAssets(root = ROOT, { logger = console, timeoutMs } = {}) {
  const dataDir = path.join(root, 'public', 'data');
  const wantsSatellite = hasSatelliteSource(root);
  const before = inspectTerrainAssets(dataDir, { wantsSatellite });

  if (before.complete) {
    logger.info?.(
      `[terrain-assets] 地形瓦片完整：${HEIGHT_FILE} + ${META_FILE}` +
        (before.satTiles ? ` + ${before.satTiles} 张卫星瓦片` : '（未配置卫星源图）'),
    );
    return { ok: true, generated: false, inspect: before };
  }

  logger.info?.(`[terrain-assets] 检测到地形瓦片缺失：${before.missing.join('、')}；自动执行 npm run assets 补齐…`);
  let generated = false;
  try {
    generated = runAssetPipeline(root, { logger, timeoutMs });
  } catch (err) {
    logger.warn?.(`[terrain-assets] 自动生成异常（已忽略）：${err?.message ?? err}`);
  }

  const after = inspectTerrainAssets(dataDir, { wantsSatellite });
  if (after.complete) {
    logger.info?.(`[terrain-assets] 自动生成完成，地形瓦片已就绪（卫星瓦片 ${after.satTiles} 张）`);
    return { ok: true, generated, inspect: after };
  }

  logger.warn?.(
    `[terrain-assets] 自动生成后仍缺少：${after.missing.join('、')}。` +
      '请确认 resourses/ 里有 heightmap64.png / 尚庄炉水库卫星影像64.png，并已 npm install（sharp），' +
      '然后手动运行 npm run assets',
  );
  return { ok: false, generated, inspect: after };
}

/**
 * 保证构建产物 dist/data 的瓦片齐全：先补 public/data（必要时自动跑管线），再同步到 dist。
 * `npm run build` 的 postbuild 会调用它；CLI 传 --dist 等价。
 */
export function ensureDistAssets(root = ROOT, { logger = console, timeoutMs, quietWhenComplete = false } = {}) {
  const distDir = path.join(root, 'dist');
  if (!existsSync(distDir)) {
    logger.info?.('[terrain-assets] 尚未构建 dist/，跳过 dist 瓦片自检');
    return { ok: true, skipped: true };
  }

  const wantsSatellite = hasSatelliteSource(root);
  const distData = path.join(distDir, 'data');
  const before = inspectTerrainAssets(distData, { wantsSatellite });

  if (before.complete) {
    if (!quietWhenComplete) {
      logger.info?.(
        `[terrain-assets] dist 地形瓦片完整：${HEIGHT_FILE} + ${META_FILE}` +
          (before.satTiles ? ` + ${before.satTiles} 张卫星瓦片` : '（未配置卫星源图）'),
      );
    }
    return { ok: true, copied: false, inspect: before };
  }

  logger.info?.(`[terrain-assets] dist 地形瓦片缺失：${before.missing.join('、')}；先补齐 public/data 再同步 dist…`);

  const publicData = path.join(root, 'public', 'data');
  let publicResult;
  try {
    publicResult = ensureTerrainAssets(root, { logger, timeoutMs });
  } catch (err) {
    logger.warn?.(`[terrain-assets] 补齐 public/data 异常（已忽略）：${err?.message ?? err}`);
    publicResult = { ok: false, generated: false };
  }

  const publicNow = inspectTerrainAssets(publicData, { wantsSatellite });
  if (!publicNow.complete) {
    logger.warn?.(`[terrain-assets] public/data 仍不完整（缺 ${publicNow.missing.join('、')}），无法同步到 dist/data`);
    return { ok: false, copied: false, publicGenerated: publicResult.generated, inspect: before };
  }

  try {
    cpSync(publicData, distData, { recursive: true });
  } catch (err) {
    logger.warn?.(`[terrain-assets] 同步 public/data → dist/data 失败：${err?.message ?? err}`);
    return { ok: false, copied: false, inspect: before };
  }

  const after = inspectTerrainAssets(distData, { wantsSatellite });
  if (!after.complete) {
    logger.warn?.(`[terrain-assets] dist/data 同步后仍缺少：${after.missing.join('、')}`);
    return { ok: false, copied: true, inspect: after };
  }
  logger.info?.(`[terrain-assets] dist 地形瓦片已补齐（卫星瓦片 ${after.satTiles} 张）`);
  return { ok: true, copied: true, publicGenerated: publicResult.generated, inspect: after };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const wantDist = process.argv.includes('--dist');
  const result = wantDist ? ensureDistAssets(ROOT) : ensureTerrainAssets(ROOT);
  if (!result.ok) process.exitCode = 1;
}
