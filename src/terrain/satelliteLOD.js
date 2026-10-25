/**
 * 卫星影像分块 LOD。
 *
 * 每个地形块（1 km）持有自己的卫星纹理，三档按“块到相机的最近距离”实时切换：
 *   近景 2048² → 0.49 m/px（优于源图 0.55 m/px，等于原像素，不再是压缩后的糊图）
 *   中景  512² → 1.95 m/px
 *   远景  128² → 7.8 m/px
 *
 * 为什么分块粒度与地形块一致（8×8）而不是更细：一个 drawcall 只能绑定一张纹理，
 * 纹理块必须与几何块对齐；而清晰度上限由源图 0.55 m/px 决定，1 km 块用 2048²
 * 已经是 0.49 m/px，再细分不会更清晰，只会成倍增加显存与调度开销。
 *
 * 核显优化：
 *   - 远景档常驻仅 4 MB（64 块 × 128²），全景俯视时几乎不占显存
 *   - 高清档有预算上限（默认 6 块），按距离择优，避免贴地时爆显存
 *   - 每帧最多解码/上传 1 张瓦片，用 ImageBitmap 异步解码，避免主线程卡顿
 *   - 换档只换纹理对象，几何与 drawcall 数量不变
 */
import * as THREE from 'three';

export const SAT_TIERS = [
  { size: 2048, maxDistance: 1400 },
  { size: 512, maxDistance: 3400 },
  { size: 128, maxDistance: Infinity },
];

/** 首块远景瓦片路径：离线管线产出瓦片集时必然存在，可作为“卫星影像是否可用”的探针 */
const PROBE_TILE = `0_0_${SAT_TIERS[SAT_TIERS.length - 1].size}.jpg`;

/**
 * 探测卫星瓦片是否可用（`npm run assets` 在缺源图时会跳过卫星产物，目录整个不存在）。
 * 只解码一张 128² 的远景瓦片，成本可忽略；失败即视为没有卫星影像，页面回落到纯地形。
 * @returns {Promise<boolean>}
 */
export async function probeSatelliteTiles(baseURL) {
  if (!baseURL) return false;
  const loader = new THREE.ImageBitmapLoader();
  try {
    const bitmap = await loader.loadAsync(`${baseURL}${PROBE_TILE}`);
    bitmap.close?.(); // 探针图像不进入缓存，立即释放
    return true;
  } catch {
    return false;
  }
}

export class SatelliteLOD {
  /**
   * @param {object} opts
   * @param {import('./terrain.js').Terrain} opts.terrain
   * @param {string} opts.baseURL
   * @param {number} opts.chunkCount
   * @param {number} opts.maxAnisotropy
   * @param {number} opts.hiResBudget 同时驻留的高清块上限
   */
  constructor({ terrain, baseURL, chunkCount, maxAnisotropy = 4, hiResBudget = 6 }) {
    this.terrain = terrain;
    this.baseURL = baseURL;
    this.chunkCount = chunkCount;
    this.maxAnisotropy = maxAnisotropy;
    this.hiResBudget = hiResBudget;

    this.loader = new THREE.ImageBitmapLoader();
    this.loader.setOptions({ imageOrientation: 'none' }); // 与高度纹理同一 UV 约定

    this.cache = new Map(); // `${cx}_${cz}_${size}` -> { texture, lastUsed }
    this.pending = new Set();
    this.queue = [];
    this.enabled = false;
    this.lastCheck = 0;
    this.chunkHalf = terrain.heightField.sizeMeters / chunkCount / 2;
    this.stats = { resident: 0, hiRes: 0, queue: 0 };
    this.onChange = null;
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) this.lastCheck = 0;
  }

  /** 近景高清块的显存预算（同时驻留几块 2048² 瓦片） */
  setHiResBudget(n) {
    this.hiResBudget = Math.max(0, Math.round(n));
    this.lastCheck = 0; // 下一帧重新规划档位
  }

  _key(cx, cz, size) {
    return `${cx}_${cz}_${size}`;
  }

  _acquire(chunk, size) {
    const key = this._key(chunk.cx, chunk.cz, size);
    const hit = this.cache.get(key);
    if (hit) {
      hit.lastUsed = performance.now();
      return hit.texture;
    }
    return null;
  }

  /** 每帧调用；内部节流，真正的换档判断每 120 ms 最多一次 */
  update(camera, now = performance.now()) {
    if (!this.enabled) return;

    if (now - this.lastCheck >= 120) {
      this.lastCheck = now;
      this._replan(camera.position);
    }
    this._pump();
  }

  _replan(camPos) {
    const chunks = this.terrain.chunks;
    const demands = [];
    for (const chunk of chunks) {
      const dx = camPos.x - chunk.centerX;
      const dz = camPos.z - chunk.centerZ;
      const dist = Math.hypot(dx, dz) - this.chunkHalf;
      demands.push({ chunk, dist: Math.max(0, dist) });
    }
    demands.sort((a, b) => a.dist - b.dist);

    let hiRes = 0;
    for (const d of demands) {
      let size = SAT_TIERS[2].size;
      if (d.dist <= SAT_TIERS[0].maxDistance && hiRes < this.hiResBudget) {
        size = SAT_TIERS[0].size;
        hiRes++;
      } else if (d.dist <= SAT_TIERS[1].maxDistance) {
        size = SAT_TIERS[1].size;
      }
      d.size = size;
    }
    this.stats.hiRes = hiRes;

    // 需要换档的块：按距离由近到远排队
    this.queue.length = 0;
    for (const d of demands) {
      const chunk = d.chunk;
      if (chunk.satTier === d.size) continue;
      if (this.pending.has(this._key(chunk.cx, chunk.cz, d.size))) continue;
      const cached = this._acquire(chunk, d.size);
      if (cached) {
        this._apply(chunk, d.size, cached);
        continue;
      }
      this.queue.push({ chunk, size: d.size });
    }
    this.stats.queue = this.queue.length;
  }

  _apply(chunk, size, texture) {
    chunk.satTier = size;
    this.terrain.setChunkSatellite(chunk, texture);
  }

  /** 每帧最多解码一张，避免核显/主线程一次性卡住 */
  _pump() {
    if (!this.queue.length) return;
    const job = this.queue.shift();
    const chunk = job.chunk;
    const size = job.size;
    const key = this._key(chunk.cx, chunk.cz, size);
    if (this.pending.has(key)) return;
    this.pending.add(key);

    const url = `${this.baseURL}${chunk.cx}_${chunk.cz}_${size}.jpg`;
    this.loader
      .loadAsync(url)
      .then((bitmap) => {
        const texture = new THREE.Texture(bitmap);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = true;
        texture.anisotropy = Math.min(this.maxAnisotropy, size >= 1024 ? 8 : 4);
        texture.flipY = false;
        texture.needsUpdate = true;

        const previous = this.cache.get(key);
        this.cache.set(key, { texture, lastUsed: performance.now() });
        if (previous && previous.texture !== texture) previous.texture.dispose();

        // 只有当这块仍然需要该档位时才切换，避免加载竞态导致回退
        if (chunk.satTier !== size) this._apply(chunk, size, texture);
        this._evict();
        this.onChange?.(this.stats);
      })
      .catch((err) => console.warn('[satellite] 瓦片加载失败', url, err))
      .finally(() => {
        this.pending.delete(key);
      });
  }

  /** 简单 LRU：条目过多时释放最久未使用的瓦片 */
  _evict() {
    const limit = 24 + this.hiResBudget * 4;
    if (this.cache.size <= limit) return;
    const entries = [...this.cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const inUse = new Set(this.terrain.chunks.filter((c) => c.satTier).map((c) => this._key(c.cx, c.cz, c.satTier)));
    for (const [key, entry] of entries) {
      if (this.cache.size <= limit) break;
      if (inUse.has(key)) continue;
      entry.texture.dispose();
      this.cache.delete(key);
    }
    this.stats.resident = this.cache.size;
  }

  /** 首屏：先把远景档铺满，保证任何角度都有影像 */
  async preloadCoarse() {
    const jobs = [];
    for (const chunk of this.terrain.chunks) {
      jobs.push(this._loadSize(chunk, SAT_TIERS[2].size));
    }
    await Promise.allSettled(jobs);
  }

  async _loadSize(chunk, size) {
    const key = this._key(chunk.cx, chunk.cz, size);
    const cached = this.cache.get(key);
    if (cached) {
      this._apply(chunk, size, cached.texture);
      return;
    }
    if (this.pending.has(key)) return;
    this.pending.add(key);
    try {
      const bitmap = await this.loader.loadAsync(`${this.baseURL}${chunk.cx}_${chunk.cz}_${size}.jpg`);
      const texture = new THREE.Texture(bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = 4;
      texture.flipY = false;
      texture.needsUpdate = true;
      this.cache.set(key, { texture, lastUsed: performance.now() });
      if (chunk.satTier !== size) this._apply(chunk, size, texture);
    } catch (err) {
      console.warn('[satellite] 远景瓦片加载失败', key, err);
    } finally {
      this.pending.delete(key);
    }
  }

  dispose() {
    for (const entry of this.cache.values()) entry.texture.dispose();
    this.cache.clear();
  }
}
