/**
 * 高度场：DEM 二进制 → GPU 纹理（R16F）+ CPU 侧双三次采样器（仅用于拾取/求交这类轻量查询）。
 *
 * 位移、法线、遮蔽、分层、等高线全部在 GPU 上算：
 *   - height.f16 直接以 HalfFloatType 上传，零 JS 转换、零量化损失
 *   - 梯度 / AO 由一次离屏渲染产出（见 gpuLookup.js），不在主线程做像素循环
 *
 * GPU 查询纹理打包（RGBA16F）：
 *   R = 归一化高度 0..1
 *   G = 天空光遮蔽 AO 0..1
 *   B = 归一化高程梯度 ∂h/∂x（米/米，不含垂直夸张）
 *   A = 归一化高程梯度 ∂h/∂z
 */
import * as THREE from 'three';

/** IEEE754 float16 位模式 → 数值 */
export function halfToFloat(h) {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 5.960464477539063e-8; // 2^-24
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

/** 65536 项查表：一次性建好，CPU 采样时零分支查表（避免逐像素转换整幅 DEM） */
const HALF_TO_FLOAT = new Float32Array(65536);
for (let i = 0; i < 65536; i++) HALF_TO_FLOAT[i] = halfToFloat(i);

const _f32 = new Float32Array(1);
const _i32 = new Int32Array(_f32.buffer);

/** float32 → float16 位模式（写入 R16F 纹理 / half 数组；与 scripts/prepare-assets.mjs 的 toHalf 同算法） */
export function floatToHalf(value) {
  _f32[0] = value;
  const x = _i32[0];
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

/** Catmull-Rom 三次权重（对应 -1 / 0 / 1 / 2 四个样本） */
function crWeights(t, out) {
  const t2 = t * t;
  const t3 = t2 * t;
  out[0] = -0.5 * t3 + t2 - 0.5 * t;
  out[1] = 1.5 * t3 - 2.5 * t2 + 1;
  out[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  out[3] = 0.5 * t3 - 0.5 * t2;
}

export class HeightField {
  constructor(meta, half, texture) {
    this.width = meta.width;
    this.height = meta.height;
    this.half = half; // Uint16Array，half-float 原始位模式（GPU 直接用，CPU 查表采样）
    this.texture = texture; // THREE.DataTexture(R16F)
    this.sizeMeters = meta.sizeMeters;
    this.chunkCount = meta.chunkCount ?? 8;
    this.elevation = meta.elevation;
    this.reliefMeters = meta.elevation.maxMeters - meta.elevation.minMeters;
    this.pxMeters = this.sizeMeters / (this.width - 1);
    this._wx = new Float64Array(4);
    this._wy = new Float64Array(4);

    // ── 地形编辑（sculpt）需要的状态 ────────────────────────────────────────
    // 源灰度信息：导出 16 bit 灰度 PNG 时把归一化高度映射回源灰度值
    this.sourceRange = meta.sourceRange ?? null;
    this.bitDepth = Number.isFinite(meta.sourceRange?.bitDepth) ? meta.sourceRange.bitDepth : 16;
    this.originalHalf = half.slice(); // 原始高度（复位用；2.2 MB）
    this._normalized = null; // 归一化 Float32Array，编辑 / 导出时惰性构建
  }

  /** 归一化高度数组（0..1）Float32Array；编辑与导出共用，首次调用时从 half 转换一次 */
  ensureNormalized() {
    if (!this._normalized) {
      const out = new Float32Array(this.half.length);
      for (let i = 0; i < out.length; i++) out[i] = HALF_TO_FLOAT[this.half[i]];
      this._normalized = out;
    }
    return this._normalized;
  }

  /** 写单个像素高度（归一化 0..1）：同时更新 CPU 数组、half 纹理位与 GPU 纹理 */
  setNormalizedAt(index, value) {
    const v = value < 0 ? 0 : value > 1 ? 1 : value;
    const normalized = this.ensureNormalized();
    normalized[index] = v;
    this.half[index] = floatToHalf(v);
    this.texture.needsUpdate = true;
  }

  /** 整幅替换归一化高度（撤销 / 恢复保存的地形）；长度按调用方保证 */
  applyNormalizedArray(array) {
    const normalized = this.ensureNormalized();
    const len = Math.min(normalized.length, array.length);
    for (let i = 0; i < len; i++) {
      const v = array[i];
      normalized[i] = v;
      this.half[i] = floatToHalf(v);
    }
    this.texture.needsUpdate = true;
  }

  /** 恢复出厂高度（逐字节还原原始 half 位模式） */
  resetToOriginal() {
    if (!this.originalHalf) return false;
    this.half.set(this.originalHalf);
    this._normalized = null;
    this.texture.needsUpdate = true;
    return true;
  }

  /** 与原始高度逐像素比较，返回被修改的像素数（同时返回哪些像素被改，供编辑状态显示） */
  countEditedPixels() {
    if (!this.originalHalf) return 0;
    let count = 0;
    for (let i = 0; i < this.half.length; i++) if (this.half[i] !== this.originalHalf[i]) count++;
    return count;
  }

  /** 双三次采样，u/v ∈ [0,1]（v=0 为影像首行＝北侧）。仅用于拾取/求交等轻量查询。 */
  sample(u, v) {
    const W = this.width;
    const H = this.height;
    const half = this.half;
    const table = HALF_TO_FLOAT;
    const x = u * (W - 1);
    const y = v * (H - 1);
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const wx = this._wx;
    const wy = this._wy;
    crWeights(x - ix, wx);
    crWeights(y - iy, wy);

    let sum = 0;
    for (let ky = 0; ky < 4; ky++) {
      let yy = iy + ky - 1;
      yy = yy < 0 ? 0 : yy > H - 1 ? H - 1 : yy;
      const row = yy * W;
      let rowSum = 0;
      for (let kx = 0; kx < 4; kx++) {
        let xx = ix + kx - 1;
        xx = xx < 0 ? 0 : xx > W - 1 ? W - 1 : xx;
        rowSum += table[half[row + xx]] * wx[kx];
      }
      sum += rowSum * wy[ky];
    }
    return sum;
  }

  /** 世界坐标 (x,z) 处的归一化高度，x/z 以米为单位、原点在地形中心 */
  sampleWorld(x, z) {
    return this.sample(x / this.sizeMeters + 0.5, z / this.sizeMeters + 0.5);
  }

  elevationAt(x, z) {
    return this.elevation.minMeters + this.sampleWorld(x, z) * this.reliefMeters;
  }
}

export async function loadHeightField(baseURL = '/data/') {
  const [meta, buffer] = await Promise.all([
    fetch(`${baseURL}terrain.json`).then((r) => {
      if (!r.ok) throw new Error(`terrain.json ${r.status}`);
      return r.json();
    }),
    fetch(`${baseURL}height.f16`).then((r) => {
      if (!r.ok) throw new Error(`height.f16 ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);

  const half = new Uint16Array(buffer);
  if (half.length !== meta.width * meta.height) {
    throw new Error(`height.f16 尺寸不符：${half.length} != ${meta.width * meta.height}`);
  }

  const texture = new THREE.DataTexture(
    half,
    meta.width,
    meta.height,
    THREE.RedFormat,
    THREE.HalfFloatType,
  );
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.flipY = false; // 数据第 0 行 = 北 = v=0，与卫星图保持一致
  texture.needsUpdate = true;

  return new HeightField(meta, half, texture);
}
