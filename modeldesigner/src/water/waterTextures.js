/**
 * 水体用的程序化纹理（离线生成一次，所有水面共享）：
 *
 *  1. 可平铺的波纹法线贴图：5 层 fbm 高度场 → 中央差分求梯度 → 切线空间法线。
 *     配完整 mipmap + 各向异性过滤：近处是细碎波纹（不是大色块），斜视/远处由
 *     mipmap 平滑，不会闪成噪点。
 *  2. 可平铺的泡沫噪声贴图（单通道）：岸边泡沫与急流白浪的遮罩，两层不同频率
 *     叠加出“破碎/翻涌”的颗粒感。
 *
 * 两者都先对坐标取模再插值，保证纹理四边无缝（RepeatWrapping 下没有接缝）。
 */
import * as THREE from 'three';

/** 整数格点哈希（可平铺：坐标先对 period 取模） */
function hash2(ix, iy, period) {
  const x = ((ix % period) + period) % period;
  const y = ((iy % period) + period) % period;
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** 双线性 + smoothstep 插值的 value noise（period 保证纹理四边无缝） */
function noise2(x, y, period) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, period);
  const b = hash2(xi + 1, yi, period);
  const c = hash2(xi, yi + 1, period);
  const d = hash2(xi + 1, yi + 1, period);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** 5 层 fbm：每层周期翻倍，整体仍可平铺 */
function fbm(nx, ny, basePeriod, octaves = 5) {
  let height = 0;
  let amp = 0.5;
  let period = basePeriod;
  for (let i = 0; i < octaves; i++) {
    height += noise2(nx * period, ny * period, period) * amp;
    amp *= 0.5;
    period *= 2;
  }
  return height;
}

/**
 * 可平铺波纹法线贴图（切线空间，RGBA8）。
 * @param {number} size 纹理边长（2 的幂）
 * @param {number} maxAnisotropy renderer.capabilities.getMaxAnisotropy()
 */
export function createWaterNormalTexture(size = 256, maxAnisotropy = 8) {
  const basePeriod = 4; // 基础频率：一张贴图里 4×4 个大波
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const ny = y / size;
    for (let x = 0; x < size; x++) {
      heights[y * size + x] = fbm(x / size, ny, basePeriod);
    }
  }

  const strength = 9.0; // 高度场 → 法线的坡度增益
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => heights[((y + size) % size) * size + ((x + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx;
      let ny = -dy;
      let nz = 1.0;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * size + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = Math.max(1, Math.min(16, maxAnisotropy));
  texture.colorSpace = THREE.NoColorSpace; // 法线数据，不做 sRGB 解码
  texture.needsUpdate = true;
  return texture;
}

/**
 * 可平铺泡沫噪声（灰度写进 RGBA 四通道，方便任意通道采样）。
 * 低频层给出成片的泡沫区域，高频层给出破碎的颗粒边缘。
 */
export function createFoamNoiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ny = y / size;
    for (let x = 0; x < size; x++) {
      const nx = x / size;
      const low = fbm(nx, ny, 3, 4);
      const high = fbm(nx, ny, 11, 3);
      // 阈值化拉出对比：泡沫是“斑块 + 碎边”，不是均匀噪声
      const v = Math.max(0, low * 1.15 - 0.32) * 0.8 + high * 0.55;
      const c = Math.round(Math.min(1, v) * 255);
      const i = (y * size + x) * 4;
      data[i] = c;
      data[i + 1] = c;
      data[i + 2] = c;
      data[i + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}
