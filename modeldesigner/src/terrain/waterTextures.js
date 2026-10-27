/**
 * 程序化水体法线贴图。
 *
 * 之前水面用「世界坐标 × 常量频率」直接算噪声当法线，问题有两个：
 *   1. 噪声尺度粗 → 近距离看是大块斑，像低分辨率贴图；
 *   2. 远处高频分量走样 → 闪成一片噪点。
 *
 * 现在改成一张可平铺的法线贴图：valueNoise 的 fbm 高度场 → 有限差分求梯度 →
 * 编码成切线空间法线。配上
 *   - 完整的 mipmap 链（远处自动降采样，不会闪）
 *   - 各向异性过滤（斜视角看水面不会糊成一片）
 *   - shader 里两次不同尺度/速度的采样叠加（近处细节细碎，远处自然平缓）
 *
 * 生成一次约几十毫秒，所有水面/流动水共享同一张。
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

/** 5 层 fbm：每层周期翻倍，保证整体仍可平铺 */
function fbm(nx, ny, basePeriod) {
  let height = 0;
  let amp = 0.5;
  let period = basePeriod;
  for (let i = 0; i < 5; i++) {
    height += noise2(nx * period, ny * period, period) * amp;
    amp *= 0.5;
    period *= 2;
  }
  return height;
}

/**
 * @param {number} size 纹理边长（2 的幂，默认 256）
 * @param {number} maxAnisotropy 取 renderer.capabilities.getMaxAnisotropy()
 * @returns {THREE.DataTexture} 切线空间法线贴图（RGBA8，可平铺）
 */
export function createWaterNormalTexture(size = 256, maxAnisotropy = 8) {
  const basePeriod = 4; // 基础频率：一张贴图里 4×4 个大波
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      heights[y * size + x] = fbm(x / size, y / size, basePeriod);
    }
  }

  const strength = 9.0; // 高度场 → 法线的坡度增益
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => heights[((y + size) % size) * size + ((x + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 中央差分求梯度（wrap 取样 → 四边无缝）
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
