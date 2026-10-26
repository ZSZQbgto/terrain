// 离线资产管线：把源数据转成运行时可直接使用的二进制/纹理。
//   1) heightmap64.png (16bit 灰度) → public/data/height.f16 (half float 归一化) + terrain.json
//   2) 卫星影像 (14465x14178) → public/data/sat/{cx}_{cz}_{size}.jpg 三档瓦片
//
// 两类源数据都是可选的：找不到就跳过对应产物（不报错），运行时按实际存在的资产降级
// —— 没有卫星瓦片时页面只展示高程分层地形。
//
// 用法：node scripts/prepare-assets.mjs [--height-only]
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { pngHeader, decodePngRows, rowToU16 } from './lib/png.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public', 'data');

// 源数据可以放在根目录，也可以放在 resourses/（用户习惯目录）
const SRC_DIRS = [path.join(ROOT, 'resourses'), ROOT];
/** 找源文件；找不到返回 null（调用方决定跳过还是继续） */
const find = (name) => {
  for (const dir of SRC_DIRS) {
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
};

const HEIGHT_SRC = find('heightmap64.png');
const SAT_SRC = find('尚庄炉水库卫星影像64.png');
const heightOnly = process.argv.includes('--height-only');
const searchHint = `查找于 ${SRC_DIRS.join(' / ')}`;

const fsize = (p) => `${(statSync(p).size / 1048576).toFixed(2)} MiB`;

const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);
/** float32 → float16 位模式（写入 DataTexture(HalfFloatType) 后 GPU 可直接消费） */
function toHalf(value) {
  f32[0] = value;
  const x = i32[0];
  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;
  if (e < 103) return bits;
  if (e > 142) return bits | 0x7c00;
  if (e < 113) {
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;
  return bits;
}

// ── 1. 高度场 ────────────────────────────────────────────────────────────────
async function buildHeight() {
  if (!HEIGHT_SRC) {
    console.warn(`[height] 跳过：找不到 heightmap64.png（${searchHint}）`);
    return false;
  }
  mkdirSync(OUT, { recursive: true });

  const buf = readFileSync(HEIGHT_SRC);
  const hdr = pngHeader(buf);
  const { width: W, height: H } = hdr;
  console.log(`[height] 源 ${W}x${H} ${hdr.bitDepth}bit`);

  const raw = new Uint16Array(W * H);
  let min = 65535, max = 0;
  await decodePngRows(buf, (row, y) => {
    const v = rowToU16(row, W);
    raw.set(v, y * W);
    for (let i = 0; i < v.length; i++) {
      const s = v[i];
      if (s < min) min = s;
      if (s > max) max = s;
    }
  });

  const span = Math.max(1, max - min);

  // half-float 归一化高度：WebGL 侧零转换即可上传成 R16F 纹理
  const half = new Uint16Array(W * H);
  for (let i = 0; i < half.length; i++) half[i] = toHalf((raw[i] - min) / span);
  const binPath = path.join(OUT, 'height.f16');
  writeFileSync(binPath, Buffer.from(half.buffer, 0, half.length * 2));

  // 真实高程区间为估计值（源图不含地理元数据）：平原区 ~55m，最高丘陵 ~310m。
  const meta = {
    width: W,
    height: H,
    sizeMeters: 8000,
    chunkCount: CHUNKS,
    elevation: { minMeters: 55, maxMeters: 310 },
    sourceRange: { min, max, bitDepth: hdr.bitDepth },
  };
  writeFileSync(path.join(OUT, 'terrain.json'), JSON.stringify(meta, null, 2));
  console.log(`[height] → height.f16 ${fsize(binPath)}  (灰度 ${min}..${max} → 归一化 0..1, half float)`);
  return true;
}

// ── 2. 卫星影像瓦片（CHUNKS×CHUNKS 块 × 三档分辨率）─────────────────────────
// 每块单独出图：近景档直接从源图原像素重采样，不做全图降采样，所以不再损失细节。
const CHUNKS = 8;
const SAT_TIERS = [
  { size: 2048, quality: 84, dir: 'sat' },      // 近景：0.49 m/px，优于源图 0.55 m/px
  { size: 512, quality: 82, dir: 'sat' },       // 中景：1.95 m/px
  { size: 128, quality: 80, dir: 'sat' },       // 远景：7.8 m/px
];

async function buildSatellite() {
  if (!SAT_SRC) {
    console.warn(`[sat] 跳过：找不到 尚庄炉水库卫星影像64.png（${searchHint}）——运行时不提供卫星影像`);
    return false;
  }
  mkdirSync(OUT, { recursive: true });

  const meta = await sharp(SAT_SRC, { limitInputPixels: false }).metadata();
  const tileDir = path.join(OUT, 'sat');
  mkdirSync(tileDir, { recursive: true });

  // 源图 365 MB / 2 亿像素：只解码一次，后续按块从 raw 视图提取。
  // （逐块 new sharp(SAT_SRC) 会让 libvips 反复解码整张 PNG，192 张瓦片要跑十几分钟）
  console.log('[sat] 解码源图（一次）…');
  const tDecode = Date.now();
  const raw = await sharp(SAT_SRC, { limitInputPixels: false, unlimited: true })
    .flatten({ background: '#101418' })
    .removeAlpha()
    .raw()
    .toBuffer();
  const RW = meta.width;
  const RH = meta.height;
  const channels = 3;
  console.log(`[sat] raw ${RW}x${RH}x${channels} ${(raw.length / 1048576).toFixed(0)} MiB，用时 ${((Date.now() - tDecode) / 1000).toFixed(1)}s`);

  const total = CHUNKS * CHUNKS * SAT_TIERS.length;
  let done = 0;
  const t0 = Date.now();

  for (let cz = 0; cz < CHUNKS; cz++) {
    for (let cx = 0; cx < CHUNKS; cx++) {
      // 源图不是正方形：按块均分，边角块补齐到边界
      const left = Math.round((cx * RW) / CHUNKS);
      const right = Math.round(((cx + 1) * RW) / CHUNKS);
      const top = Math.round((cz * RH) / CHUNKS);
      const bottom = Math.round(((cz + 1) * RH) / CHUNKS);
      const width = right - left;
      const height = bottom - top;

      for (const tier of SAT_TIERS) {
        const dst = path.join(tileDir, `${cx}_${cz}_${tier.size}.jpg`);
        await sharp(raw, { raw: { width: RW, height: RH, channels } })
          .extract({ left, top, width, height })
          .resize(tier.size, tier.size, { kernel: 'lanczos3', fit: 'fill' })
          .jpeg({ quality: tier.quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
          .toFile(dst);
        done++;
      }
    }
    console.log(`[sat] 第 ${cz + 1}/${CHUNKS} 行完成 (${done}/${total})`);
  }
  console.log(`[sat] ${total} 张瓦片生成完毕，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return true;
}

// ── 3. 汇总 ──────────────────────────────────────────────────────────────────
const built = [];
if (await buildHeight()) built.push('高度场');
if (heightOnly) {
  console.log('[sat] 跳过：--height-only');
} else if (await buildSatellite()) {
  built.push('卫星瓦片');
}

if (built.length) {
  console.log(`[assets] 完成：${built.join(' + ')} → ${path.relative(ROOT, OUT)}`);
} else {
  console.warn('[assets] 未生成任何资产（源数据缺失），请把 heightmap64.png / 尚庄炉水库卫星影像64.png 放进 resourses/ 后重试');
}
