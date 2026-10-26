/**
 * 地形对象：分块 LOD 网格 + 两套材质（高程分层 / 卫星影像）。
 *
 * 为什么要分块 LOD：8km 地形若用单张 1024² 网格，就是 210 万三角面，
 * 在核显上光栅化只有个位数帧率。这里把地形切成 CHUNKS×CHUNKS 块，
 * 每块按屏幕尺寸选择细分级别（16/32/64/128），远处块只花几百个三角形。
 * 块边缘加一圈垂直裙边遮住 LOD 接缝，避免可见裂缝。
 */
import * as THREE from 'three';
import { terrainVertex, buildTerrainFragment } from './shaders.js';

const CHUNKS = 8;
const LEVELS = [16, 32, 64, 128];
const SKIRT = 90; // 裙边下探深度（夸张前，会被顶点着色器的夸张系数放大）
const MAX_EXAGGERATION = 8;
const BICUBIC_MIN_LEVEL = 64; // 该细分级别及以上的块才用双三次顶点采样，其余走硬件双线性
const PIXELS_PER_CELL = 5.0; // LOD 选择：每个格子在屏幕上约占多少像素

/**
 * 生成一块地形网格：平面网格 + 四周裙边。
 * 几何本身不含高程 —— 高度由顶点着色器从查询纹理解析（见 shaders.js），
 * 所以这里只是纯线性插值，构建耗时与 LOD 级别成线性，主线程几乎无感。
 */
function buildChunkGeometry(hf, cx, cz, level) {
  const size = hf.sizeMeters;
  const half = size / 2;
  const relief = hf.reliefMeters;
  const N = level + 1;

  const u0 = cx / CHUNKS;
  const u1 = (cx + 1) / CHUNKS;
  const v0 = cz / CHUNKS;
  const v1 = (cz + 1) / CHUNKS;

  const skirtVerts = 4 * N;
  const total = N * N + skirtVerts;

  const positions = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);

  let p = 0;
  let q = 0;
  for (let j = 0; j < N; j++) {
    const v = v0 + (v1 - v0) * (j / level);
    const z = -half + v * size;
    for (let i = 0; i < N; i++) {
      const u = u0 + (u1 - u0) * (i / level);
      positions[p++] = -half + u * size;
      positions[p++] = 0; // 高程由 GPU 从纹理解析
      positions[p++] = z;
      uvs[q++] = u;
      uvs[q++] = v;
    }
  }

  // 裙边：四条边各 N 个顶点，沿 y 负方向下探，用于遮住 LOD 接缝
  const edgeIndex = (side, k) => {
    if (side === 0) return k; // j = 0
    if (side === 1) return level * N + k;
    if (side === 2) return k * N; // i = 0
    return k * N + level;
  };
  let sp = N * N;
  for (let side = 0; side < 4; side++) {
    for (let k = 0; k < N; k++) {
      const src = edgeIndex(side, k);
      positions[sp * 3] = positions[src * 3];
      positions[sp * 3 + 1] = -SKIRT;
      positions[sp * 3 + 2] = positions[src * 3 + 2];
      uvs[sp * 2] = uvs[src * 2];
      uvs[sp * 2 + 1] = uvs[src * 2 + 1];
      sp++;
    }
  }

  const quads = level * level;
  const skirtQuads = 4 * level;
  const indices = new Uint32Array((quads + skirtQuads) * 6);
  let k = 0;
  for (let j = 0; j < level; j++) {
    const rowA = j * N;
    const rowB = rowA + N;
    for (let i = 0; i < level; i++) {
      const a = rowA + i;
      const b = a + 1;
      const c = rowB + i;
      const d = c + 1;
      indices[k++] = a; indices[k++] = c; indices[k++] = b;
      indices[k++] = b; indices[k++] = c; indices[k++] = d;
    }
  }
  // 裙边四边形（双面材质，绕序不重要）
  for (let side = 0; side < 4; side++) {
    const base = N * N + side * N;
    for (let i = 0; i < level; i++) {
      const a = edgeIndex(side, i);
      const b = edgeIndex(side, i + 1);
      const sa = base + i;
      const sb = base + i + 1;
      indices[k++] = a; indices[k++] = sa; indices[k++] = b;
      indices[k++] = b; indices[k++] = sa; indices[k++] = sb;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));

  const cxMin = -half + u0 * size;
  const czMin = -half + v0 * size;
  const cxMax = -half + u1 * size;
  const czMax = -half + v1 * size;
  geo.boundingBox = new THREE.Box3(
    new THREE.Vector3(cxMin, -SKIRT * MAX_EXAGGERATION, czMin),
    new THREE.Vector3(cxMax, relief * MAX_EXAGGERATION, czMax),
  );
  geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
  return geo;
}

/** 环境/光照 uniform，两套材质共享同一批引用 */
export function createEnvUniforms(sizeMeters = 8000) {
  return {
    uSunDir: { value: new THREE.Vector3(0.45, 0.62, 0.64).normalize() },
    uSunColor: { value: new THREE.Color(0xfff2dc) },
    uSkyColor: { value: new THREE.Color(0x9dbcdf) },
    uGroundColor: { value: new THREE.Color(0x4a4238) },
    uFogColor: { value: new THREE.Color(0xb2c8da) },
    uFogDensity: { value: 0.000058 },
    // 日间薄雾：约 600 m 高度尺度内近地面明显更浓，山脊与高处更通透
    uHazeHeight: { value: 600 },
    // 地形边界迷雾过渡带：距边界 100 m 内完全入雾，200 m 外完全清晰
    uHalfSize: { value: sizeMeters / 2 },
    uEdgeFadeStart: { value: 100 },
    uEdgeFadeEnd: { value: 200 },
    uExaggeration: { value: 1.8 },
  };
}

export class Terrain {
  constructor({ heightField, lookupTexture, paletteTexture, env, detailNormal = 0.5 }) {
    this.heightField = heightField;
    this.env = env;

    const hf = heightField;
    this.sharedUniforms = {
      ...env,
      uTerrain: { value: lookupTexture },
      uTerrainTexel: { value: new THREE.Vector2(1 / hf.width, 1 / hf.height) },
      uPalette: { value: paletteTexture },
      uReliefMeters: { value: hf.reliefMeters },
      uMinElevation: { value: hf.elevation.minMeters },
      uTexelWorld: { value: hf.pxMeters },
      uDetailNormal: { value: detailNormal },
      uVertexDetail: { value: 0 },
      // 0 = 片元一律走硬件双线性。实测核显上分支发散比多采样还贵：
      // 全双线性 13.0 ms、3000 m 阈值 21.6 ms、全双三次 21.8 ms（贴地场景取多轮最小值）。
      // 画质无可见损失：几何顶点仍是双三次位移，法线来自梯度纹理，双线性插值下依然连续。
      uBicubicDistance: { value: 0 },
    };

    this.hypsoMaterial = new THREE.ShaderMaterial({
      uniforms: {
        ...this.sharedUniforms,
        uBands: { value: 48 },
        uQuantize: { value: 0.82 },
        uContour: { value: 1 },
      },
      vertexShader: terrainVertex,
      fragmentShader: buildTerrainFragment({ satellite: false }),
      side: THREE.DoubleSide,
    });

    // 瓦片尚未加载时的 1×1 占位，避免材质绑定 null 采样
    this.placeholderTexture = new THREE.DataTexture(new Uint8Array([38, 46, 38, 255]), 1, 1, THREE.RGBAFormat);
    this.placeholderTexture.needsUpdate = true;
    this.satFragment = buildTerrainFragment({ satellite: true });

    this.mode = 'hypsometric';
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this.chunks = [];
    this.geometryCache = new Map();
    this._buildChunks();
    this.activeTriangles = 0;
  }

  /** 每块一份卫星材质：各自绑定自己的瓦片纹理与块内 uv 原点 */
  _makeSatMaterial(cx, cz) {
    return new THREE.ShaderMaterial({
      uniforms: {
        ...this.sharedUniforms,
        uSat: { value: this.placeholderTexture },
        uSatExposure: { value: 1.18 },
        uChunkOrigin: { value: new THREE.Vector2(cx / CHUNKS, cz / CHUNKS) },
        uChunkCount: { value: CHUNKS },
      },
      vertexShader: terrainVertex,
      fragmentShader: this.satFragment,
      side: THREE.DoubleSide,
    });
  }

  _buildChunks() {
    const hf = this.heightField;
    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        const mesh = new THREE.Mesh(undefined, this.hypsoMaterial);
        mesh.name = `chunk-${cx}-${cz}`;
        mesh.frustumCulled = true;
        mesh.matrixAutoUpdate = false;
        const chunk = {
          cx,
          cz,
          mesh,
          level: 0,
          satTier: 0,
          satMaterial: this._makeSatMaterial(cx, cz),
          centerX: 0,
          centerZ: 0,
        };
        const size = hf.sizeMeters;
        chunk.centerX = -size / 2 + (cx + 0.5) * (size / CHUNKS);
        chunk.centerZ = -size / 2 + (cz + 0.5) * (size / CHUNKS);

        // 绘制前把该块的采样精度写进材质：高细分块用双三次，粗块用硬件双线性
        mesh.onBeforeRender = (renderer, scene, camera, geometry, material) => {
          const u = material.uniforms.uVertexDetail;
          if (u) u.value = chunk.level >= BICUBIC_MIN_LEVEL ? 1 : 0;
        };

        this.group.add(mesh);
        this.chunks.push(chunk);
      }
    }
  }

  _geometry(cx, cz, level) {
    const key = `${cx}:${cz}:${level}`;
    let geo = this.geometryCache.get(key);
    if (!geo) {
      geo = buildChunkGeometry(this.heightField, cx, cz, level);
      this.geometryCache.set(key, geo);
    }
    return geo;
  }

  /** 预构建全部 LOD 几何（放在加载阶段做，避免浏览过程中卡顿） */
  async prebuild(onProgress) {
    const total = this.chunks.length * LEVELS.length;
    let done = 0;
    let sinceYield = 0;
    for (const chunk of this.chunks) {
      for (const level of LEVELS) {
        this._geometry(chunk.cx, chunk.cz, level);
        done++;
      }
      if (onProgress) onProgress(done / total);
      // 每 8 块让出一次主线程（setTimeout(0) 实际有 4ms 下限，太频繁反而拖慢加载）
      if (++sinceYield >= 8) {
        sinceYield = 0;
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  /** 按块在屏幕上的角尺寸选择细分级别 */
  updateLOD(camera, viewportHeight) {
    // 相机没动就整段跳过：静止观察时零开销，移动时仍逐帧更新保证切换平滑
    const pos = camera.position;
    if (this._lodPos && this._lodPos.distanceToSquared(pos) < 4 && this._lodViewportH === viewportHeight) {
      return;
    }
    if (!this._lodPos) this._lodPos = pos.clone();
    else this._lodPos.copy(pos);
    this._lodViewportH = viewportHeight;

    const fovRad = (camera.fov * Math.PI) / 180;
    const chunkSize = this.heightField.sizeMeters / CHUNKS;
    const halfChunk = chunkSize * 0.5;
    let tris = 0;

    for (const chunk of this.chunks) {
      const dx = camera.position.x - chunk.centerX;
      const dz = camera.position.z - chunk.centerZ;
      const dist = Math.max(1, Math.hypot(dx, dz) - halfChunk);

      // 该块在屏幕上横向占多少像素
      const worldPerPixel = (2 * dist * Math.tan(fovRad / 2)) / viewportHeight;
      const pixels = chunkSize / worldPerPixel;
      const target = pixels / PIXELS_PER_CELL; // 每格在屏幕上约 5 像素即可

      let level = LEVELS[0];
      for (const L of LEVELS) if (L <= target) level = L;

      // 滞回：升级要更明显的需求，避免在阈值附近反复切换
      if (level > chunk.level && level > chunk.level * 1.6) chunk.level = level;
      else if (level < chunk.level && level * 1.6 < chunk.level) chunk.level = level;
      else if (chunk.level === 0) chunk.level = level;

      const geo = this._geometry(chunk.cx, chunk.cz, chunk.level);
      if (chunk.mesh.geometry !== geo) {
        chunk.mesh.geometry = geo;
        chunk.mesh.matrixWorldNeedsUpdate = true;
      }
      tris += geo.index.count / 3;
    }
    this.activeTriangles = tris;
  }

  get triangles() {
    const first = this.chunks[0]?.mesh.geometry?.index?.count ?? 0;
    return this.activeTriangles || (first / 3) * this.chunks.length;
  }

  setMode(mode) {
    this.mode = mode;
    for (const chunk of this.chunks) {
      chunk.mesh.material = mode === 'satellite' ? chunk.satMaterial : this.hypsoMaterial;
    }
  }

  /** 给某一块换上指定档位的卫星瓦片 */
  setChunkSatellite(chunk, texture) {
    chunk.satMaterial.uniforms.uSat.value = texture;
  }

  /** 换渲染上下文后重新绑定离屏查询纹理 */
  setLookupTexture(texture) {
    this.sharedUniforms.uTerrain.value = texture;
  }

  setExaggeration(k) {
    this.env.uExaggeration.value = k;
  }

  dispose() {
    for (const geo of this.geometryCache.values()) geo.dispose();
    this.geometryCache.clear();
    for (const chunk of this.chunks) chunk.satMaterial.dispose();
    this.hypsoMaterial.dispose();
    this.placeholderTexture.dispose();
  }
}
