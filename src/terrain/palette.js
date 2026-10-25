/**
 * 高程分层色带（hypsometric tint）。
 * 色标为 sRGB；LUT 纹理设 colorSpace=SRGB，硬件采样时自动解码到线性空间。
 */
import * as THREE from 'three';

/** [归一化高度, sRGB 十六进制] —— 从库底/水面到山巅 */
export const HYPSOMETRIC_STOPS = [
  [0.00, '#0e3346'], // 深水
  [0.045, '#1d5e77'], // 浅水
  [0.085, '#6f8f7d'], // 滩涂湿地
  [0.13, '#5b8a45'], // 低草甸
  [0.24, '#4f7a38'], // 灌木 / 农田
  [0.36, '#6d8b3e'], // 缓坡草地
  [0.48, '#94973f'], // 干草
  [0.60, '#b09a55'], // 黄土
  [0.71, '#a8835b'], // 褐土
  [0.81, '#8d7a6a'], // 岩屑
  [0.90, '#a49a90'], // 裸岩
  [0.96, '#cfc9c1'], // 高山砾石
  [1.00, '#efece6'], // 山巅
];

const LUT_WIDTH = 512;

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** 生成 512x1 的色带查找纹理（sRGB） */
export function createPaletteTexture(stops = HYPSOMETRIC_STOPS) {
  const data = new Uint8Array(LUT_WIDTH * 4);
  let si = 0;
  for (let x = 0; x < LUT_WIDTH; x++) {
    const t = x / (LUT_WIDTH - 1);
    while (si < stops.length - 2 && t > stops[si + 1][0]) si++;
    const [t0, c0] = stops[si];
    const [t1, c1] = stops[si + 1];
    const k = t1 === t0 ? 0 : Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    const a = hexToRgb(c0);
    const b = hexToRgb(c1);
    const o = x * 4;
    data[o] = Math.round(a[0] + (b[0] - a[0]) * k);
    data[o + 1] = Math.round(a[1] + (b[1] - a[1]) * k);
    data[o + 2] = Math.round(a[2] + (b[2] - a[2]) * k);
    data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, LUT_WIDTH, 1, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
