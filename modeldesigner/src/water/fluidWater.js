/**
 * 水体模拟系统（FluidWater）：移植自 D:\Proj\test\pilo.js 的 Cesium GPU 浅水模拟，
 * 按本项目现有 three.js 地形渲染方式适配。
 *
 * 关键设计：
 *   - 模拟域**自动覆盖整个地形**（heightField.sizeMeters），高程直接取现有
 *     heightField.texture（与地形顶点着色器同一份 R16F 数据），没有“取高度图”步骤，
 *     也不需要手动设模拟范围。
 *   - 4 个 ping-pong 渲染目标 + 全屏 quad 计算，逐子步推进（A→B→C→D），
 *     与原实现的缓冲区读写顺序一致。
 *   - 支持最多 8 个水源（点选地形直接放置），每个水源可独立半径 / 每次注水量 / 目标水位。
 *   - 水面用一张覆盖全域的网格渲染：顶点按模拟水位位移，片元用模拟水位求几何法线，
 *     再叠加程序化波纹、菲涅尔天空反射、太阳高光、深度吸收、岸边/急流泡沫与地形同款薄雾。
 *
 * 单位：外部全部用「米」；纹理内部用归一化高程/水深（1.0 = reliefMeters），
 *       世界 y 换算与地形顶点着色器一致：y = hNorm * reliefMeters * uExaggeration。
 */
import * as THREE from 'three';
import { halfToFloat } from '../terrain/heightfield.js';
import {
  DEFAULT_WATER_RESOLUTION,
  MAX_WATER_SOURCES,
  WATER_DEFAULTS,
  WATER_RESOLUTIONS,
  normalizeWaterState,
  waterSourceId,
} from './waterState.js';
import {
  simVertex,
  simFragmentA,
  simFragmentB,
  simFragmentC,
  simFragmentD,
  simFragmentDisplay,
  waterSurfaceVertex,
  waterSurfaceFragment,
} from './waterShaders.js';
import { createWaterNormalTexture, createFoamNoiseTexture } from './waterTextures.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 新水源默认目标水位 = 点选处地面 + 10 m（显式传 null 才表示不限制） */
const DEFAULT_SOURCE_RISE = 10;

/** 模拟参数的固定部分（与原实现一致）：衰减 / 强度 / 最小流量 / 注水间隔（子步） */
const FLUID_PARAM = { attenuation: 0.995, strength: 0.25, minFlow: 0.0001, injectInterval: 2 };

const STATS_SIZE = 64;

export class FluidWater {
  constructor({
    renderer,
    heightField,
    env,
    skyColors = {},
    maxAnisotropy = 8,
    resolution = DEFAULT_WATER_RESOLUTION,
    meshSegments = 512,
  }) {
    if (!renderer || !heightField || !env) {
      throw new Error('FluidWater 需要 renderer / heightField / env');
    }
    this.renderer = renderer;
    this.hf = heightField;
    this.env = env;
    this.sizeMeters = heightField.sizeMeters;
    this.relief = Math.max(1, heightField.reliefMeters);
    this.minElevation = heightField.elevation.minMeters;

    this.state = normalizeWaterState(WATER_DEFAULTS);
    this.state.sim.resolution = this._pickResolution(resolution);
    this.selectedId = null;
    this.onChange = null;

    this._step = 0; // 已执行子步数（integer）
    this._playStep = 0; // 用于注水节拍的浮点步计数
    this._acc = 0;

    this.stats = { steps: 0, wetCells: null, maxDepthMeters: null, sourceCount: 0, paused: false };

    this._normalMap = createWaterNormalTexture(256, maxAnisotropy);
    this._foamMap = createFoamNoiseTexture(256);

    this.group = new THREE.Group();
    this.group.name = 'water-fluid';

    this._buildSurfaceMesh(skyColors, meshSegments);
    this._buildSim();

    this._syncStateUniforms();
    this._resetSim();
    this.group.visible = this.state.enabled;
  }

  // ── 坐标 / 高程 ────────────────────────────────────────────────────────────
  metersToWorldY(meters) {
    return (meters - this.minElevation) * this.env.uExaggeration.value;
  }

  worldYToMeters(y) {
    return this.minElevation + y / Math.max(1e-6, this.env.uExaggeration.value);
  }

  /** 世界 (x,z) 处的地面绝对高程（米） */
  groundMetersAt(x, z) {
    return this.minElevation + this.hf.sampleWorld(x, z) * this.relief;
  }

  _pickResolution(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULT_WATER_RESOLUTION;
    let best = WATER_RESOLUTIONS[0];
    let bestErr = Infinity;
    for (const r of WATER_RESOLUTIONS) {
      const err = Math.abs(r - n);
      if (err < bestErr) {
        bestErr = err;
        best = r;
      }
    }
    return best;
  }

  // ── 模拟资源（GPU 渲染目标 / 计算 pass）───────────────────────────────────
  _buildSim() {
    const renderer = this.renderer;
    const gl = renderer.getContext();
    // WebGL2：浮点颜色缓冲需要扩展；没有就退半浮点（精度略低但可用）
    const hasFloat = Boolean(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('WEBGL_color_buffer_float'));
    const type = hasFloat ? THREE.FloatType : THREE.HalfFloatType;
    this._simType = type;
    this._simHalf = type === THREE.HalfFloatType;

    const R = this.state.sim.resolution;
    this.resolution = R;

    const targetOptions = {
      format: THREE.RGBAFormat,
      type,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };

    this.rtA = new THREE.WebGLRenderTarget(R, R, targetOptions);
    this.rtB = new THREE.WebGLRenderTarget(R, R, targetOptions);
    this.rtC = new THREE.WebGLRenderTarget(R, R, targetOptions);
    this.rtD = new THREE.WebGLRenderTarget(R, R, targetOptions);
    // 渲染用的合成纹理需要双线性：水面网格顶点/片元按世界坐标采样，平滑插值才不出现格子
    this.rtDisplay = new THREE.WebGLRenderTarget(R, R, {
      ...targetOptions,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    for (const rt of [this.rtA, this.rtB, this.rtC, this.rtD, this.rtDisplay]) {
      rt.texture.colorSpace = THREE.NoColorSpace;
      rt.texture.wrapS = THREE.ClampToEdgeWrapping;
      rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    }

    // 统计读回（测试/调试用）：64×64 降采样
    this.rtStats = new THREE.WebGLRenderTarget(STATS_SIZE, STATS_SIZE, targetOptions);
    this.rtStats.texture.colorSpace = THREE.NoColorSpace;
    this._statsBufferFloat = new Float32Array(STATS_SIZE * STATS_SIZE * 4);
    this._statsBufferHalf = new Uint16Array(STATS_SIZE * STATS_SIZE * 4);

    this._simScene = new THREE.Scene();
    this._simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._simGeometry = new THREE.PlaneGeometry(2, 2);
    this._simQuad = new THREE.Mesh(this._simGeometry, null);
    this._simQuad.frustumCulled = false;
    this._simScene.add(this._simQuad);

    this.shared = {
      uHeightMap: { value: this.hf.texture },
      uSimTexel: { value: new THREE.Vector2(1 / R, 1 / R) },
      uSimRes: { value: R },
      uFluidParam: {
        value: new THREE.Vector4(
          FLUID_PARAM.attenuation,
          FLUID_PARAM.strength,
          FLUID_PARAM.minFlow,
          FLUID_PARAM.injectInterval,
        ),
      },
      uFrame: { value: 0 },
      uPlayStep: { value: 0 },
      uSizeMeters: { value: this.sizeMeters },
      uReliefMeters: { value: this.relief },
      uMinElevation: { value: this.minElevation },
      uTargetCap: { value: -1 },
      uWaterAmount: { value: 0.08 },
      uSourceCount: { value: 0 },
      uSources: { value: Array.from({ length: MAX_WATER_SOURCES }, () => new THREE.Vector4()) },
      uTargets: { value: Array.from({ length: MAX_WATER_SOURCES }, () => new THREE.Vector4(-1, 0, 0, 0)) },
    };

    const simMaterial = (fragmentShader, depthTexture, flowTexture) =>
      new THREE.ShaderMaterial({
        uniforms: {
          ...this.shared,
          uDepth: { value: depthTexture },
          uFlow: { value: flowTexture },
        },
        vertexShader: simVertex,
        fragmentShader,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
        transparent: false,
      });

    // 读写顺序与原实现一致：A←(C,D)、B←(A,D)、C←(A,B)、D←(C,B)
    this._matA = simMaterial(simFragmentA, this.rtC.texture, this.rtD.texture);
    this._matB = simMaterial(simFragmentB, this.rtA.texture, this.rtD.texture);
    this._matC = simMaterial(simFragmentC, this.rtA.texture, this.rtB.texture);
    this._matD = simMaterial(simFragmentD, this.rtC.texture, this.rtB.texture);

    this._matDisplay = new THREE.ShaderMaterial({
      uniforms: {
        uDepth: { value: this.rtC.texture },
        uFlow: { value: this.rtD.texture },
      },
      vertexShader: simVertex,
      fragmentShader: simFragmentDisplay,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      transparent: false,
    });

    this._matStats = new THREE.ShaderMaterial({
      uniforms: { uSurface: { value: this.rtDisplay.texture } },
      vertexShader: simVertex,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uSurface;
        varying vec2 vUv;
        void main() { gl_FragColor = texture2D(uSurface, vUv); }
      `,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      transparent: false,
    });

    // 材质/网格 uniform 的模拟分辨率相关项
    if (this.uniforms) {
      this.uniforms.uSimTexel.value.set(1 / R, 1 / R);
      this.uniforms.uCellMeters.value = this.sizeMeters / R;
      this.uniforms.uSurface.value = this.rtDisplay.texture;
    }
  }

  _disposeSim() {
    for (const rt of [this.rtA, this.rtB, this.rtC, this.rtD, this.rtDisplay, this.rtStats]) rt?.dispose();
    for (const mat of [this._matA, this._matB, this._matC, this._matD, this._matDisplay, this._matStats]) {
      mat?.dispose();
    }
    this._simGeometry?.dispose();
  }

  /** 分辨率变化：重建全部模拟缓冲（会重置水体） */
  _rebuildSim() {
    this._disposeSim();
    this._buildSim();
    this._syncStateUniforms();
    this._resetSim();
  }

  _runPass(material, target) {
    this._simQuad.material = material;
    const renderer = this.renderer;
    renderer.setRenderTarget(target);
    renderer.render(this._simScene, this._simCamera);
  }

  _clearTargets() {
    const renderer = this.renderer;
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const rt of [this.rtA, this.rtB, this.rtC, this.rtD, this.rtDisplay]) {
      renderer.setRenderTarget(rt);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(null);
    renderer.setClearColor(prevColor, prevAlpha);
  }

  /** 清空水体：所有缓冲归零，并把 display 纹理初始化成“干地 + 地形高度” */
  _resetSim() {
    this._step = 0;
    this._playStep = 0;
    this._acc = 0;
    this.stats.steps = 0;
    this.stats.wetCells = null;
    this.stats.maxDepthMeters = null;

    const renderer = this.renderer;
    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();
    renderer.autoClear = false;

    this._clearTargets();

    // pass A 的 frame 0：写入地形高度、水深 0（display 需要一份合法数据）
    this.shared.uFrame.value = 0;
    this.shared.uPlayStep.value = 0;
    this._runPass(this._matA, this.rtA);

    // 用 A + 全零流出量生成初始 display
    this._matDisplay.uniforms.uDepth.value = this.rtA.texture;
    this._matDisplay.uniforms.uFlow.value = this.rtD.texture;
    this._runPass(this._matDisplay, this.rtDisplay);
    this._matDisplay.uniforms.uDepth.value = this.rtC.texture;
    this._matDisplay.uniforms.uFlow.value = this.rtD.texture;

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget === undefined ? null : prevTarget);
    this.uniforms.uSurface.value = this.rtDisplay.texture;
  }

  // ── 水面网格 ──────────────────────────────────────────────────────────────
  _buildSurfaceMesh(skyColors, meshSegments) {
    const size = this.sizeMeters;
    const R = this.state.sim.resolution;
    this.uniforms = {
      uSurface: { value: null },
      uSimTexel: { value: new THREE.Vector2(1 / R, 1 / R) },
      uCellMeters: { value: size / R },
      uSizeMeters: { value: size },
      uReliefMeters: { value: this.relief },
      uExaggeration: this.env.uExaggeration, // 共享引用：垂直夸张滑块会同步到水面
      uTime: { value: 0 },
      uShallowColor: { value: new THREE.Color(0x35818f) },
      uDeepColor: { value: new THREE.Color(0x0b2b3a) },
      uSkyZenith: { value: skyColors.zenith ?? new THREE.Color(0x2f5f9e) },
      uSkyHorizon: { value: skyColors.horizon ?? new THREE.Color(0xb9cfe0) },
      uSkyColor: this.env.uSkyColor,
      uSunDir: this.env.uSunDir,
      uSunColor: this.env.uSunColor,
      uFogColor: this.env.uFogColor,
      uFogDensity: this.env.uFogDensity,
      uHazeHeight: this.env.uHazeHeight,
      uHalfSize: this.env.uHalfSize,
      uEdgeFadeStart: this.env.uEdgeFadeStart,
      uEdgeFadeEnd: this.env.uEdgeFadeEnd,
      uShimmer: { value: this.state.visual.shimmer },
      uRipple: { value: this.state.visual.ripple },
      uClarity: { value: this.state.visual.clarity },
      uNormalMap: { value: this._normalMap },
      uFoamMap: { value: this._foamMap },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: waterSurfaceVertex,
      fragmentShader: waterSurfaceFragment,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    const segments = clamp(Math.round(meshSegments), 192, 768);
    const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
    geometry.rotateX(-Math.PI / 2);

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'water-surface';
    this.mesh.renderOrder = 10;
    this.mesh.frustumCulled = false; // 顶点在着色器里位移，包围盒不可靠
    this.group.add(this.mesh);
  }

  // ── 状态 / 参数 ───────────────────────────────────────────────────────────
  get sources() {
    return this.state.sources;
  }

  get selectedSource() {
    if (!this.selectedId) return null;
    return this.state.sources.find((s) => s.id === this.selectedId) ?? null;
  }

  _emit() {
    this.stats.sourceCount = this.state.sources.length;
    this.stats.paused = this.state.sim.paused;
    this.onChange?.(this);
  }

  _syncStateUniforms() {
    if (!this.shared) return;
    this.shared.uWaterAmount.value = Math.max(this.state.sim.waterAmount / this.relief, 1e-6);
    this._updateSourceUniforms();
    if (this.uniforms) {
      this.uniforms.uShimmer.value = this.state.visual.shimmer;
      this.uniforms.uRipple.value = this.state.visual.ripple;
      this.uniforms.uClarity.value = this.state.visual.clarity;
    }
    this.stats.sourceCount = this.state.sources.length;
    this.stats.paused = this.state.sim.paused;
  }

  _updateSourceUniforms() {
    if (!this.shared) return;
    const active = this.state.sources.filter((s) => s.enabled).slice(0, MAX_WATER_SOURCES);
    this.shared.uSourceCount.value = active.length;

    // 全局目标水位 = 所有启用且有目标高程的水源里的最高值；任一水源“不限制”则不设上限。
    // 这个上限在模拟里等价于溢洪道：水面超过它就排掉，避免多水源把全图灌高。
    let targetCap = -1;
    for (const s of active) {
      if (s.targetLevel == null) {
        targetCap = -1;
        break;
      }
      targetCap = Math.max(targetCap, s.targetLevel);
    }
    this.shared.uTargetCap.value = targetCap;

    for (let i = 0; i < MAX_WATER_SOURCES; i++) {
      const s = active[i];
      const pos = this.shared.uSources.value[i];
      const tgt = this.shared.uTargets.value[i];
      if (!s) {
        pos.set(0, 0, 0, 0);
        tgt.set(-1, 0, 0, 0);
        continue;
      }
      const uvx = s.x / this.sizeMeters + 0.5;
      const uvy = s.z / this.sizeMeters + 0.5;
      const ground = this.groundMetersAt(s.x, s.z);
      const amountMeters = Number.isFinite(s.amount) ? s.amount : this.state.sim.waterAmount;
      const targetDepth = s.targetLevel == null ? -1 : Math.max(0, (s.targetLevel - ground) / this.relief);
      pos.set(uvx, uvy, s.radius, Math.max(amountMeters / this.relief, 1e-6));
      tgt.set(targetDepth, s.enabled ? 1 : 0, 0, 0);
    }
  }

  // ── 水源 ──────────────────────────────────────────────────────────────────
  addSource({ x, z, name, radius, targetLevel, amount } = {}) {
    const px = Number(x);
    const pz = Number(z);
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return null;
    if (this.state.sources.length >= MAX_WATER_SOURCES) return null;

    const ground = this.groundMetersAt(px, pz);
    const hasTarget = targetLevel !== undefined;
    const source = {
      id: waterSourceId(),
      name: typeof name === 'string' && name ? name : `水源 ${this.state.sources.length + 1}`,
      x: px,
      z: pz,
      radius: clamp(Number.isFinite(Number(radius)) ? Number(radius) : 150, 20, 3000),
      targetLevel: hasTarget
        ? Number.isFinite(Number(targetLevel))
          ? Number(targetLevel)
          : null
        : Math.round(ground + DEFAULT_SOURCE_RISE),
      amount: Number.isFinite(Number(amount)) ? clamp(Number(amount), 0.5, 300) : null,
      enabled: true,
    };
    this.state.sources.push(source);
    this.selectedId = source.id;
    this._syncStateUniforms();
    this._emit();
    return source;
  }

  updateSource(id, patch = {}) {
    const source = this.state.sources.find((s) => s.id === id);
    if (!source) return null;
    if (patch.name != null) source.name = String(patch.name) || source.name;
    if (patch.radius != null && Number.isFinite(Number(patch.radius))) {
      source.radius = clamp(Number(patch.radius), 20, 3000);
    }
    if (patch.x != null && Number.isFinite(Number(patch.x))) source.x = Number(patch.x);
    if (patch.z != null && Number.isFinite(Number(patch.z))) source.z = Number(patch.z);
    if ('targetLevel' in patch) {
      const v = patch.targetLevel;
      source.targetLevel = v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
    }
    if ('amount' in patch) {
      const v = patch.amount;
      source.amount = v == null || v === '' || !Number.isFinite(Number(v)) ? null : clamp(Number(v), 0.5, 300);
    }
    if (patch.enabled != null) source.enabled = Boolean(patch.enabled);
    this._syncStateUniforms();
    this._emit();
    return source;
  }

  removeSource(id) {
    const before = this.state.sources.length;
    this.state.sources = this.state.sources.filter((s) => s.id !== id);
    if (this.state.sources.length === before) return false;
    if (this.selectedId === id) this.selectedId = null;
    this._syncStateUniforms();
    this._emit();
    return true;
  }

  clearSources() {
    if (!this.state.sources.length) return;
    this.state.sources = [];
    this.selectedId = null;
    this._syncStateUniforms();
    this._emit();
  }

  selectSource(id) {
    const next = id && this.state.sources.some((s) => s.id === id) ? id : null;
    if (next === this.selectedId) return;
    this.selectedId = next;
    this._emit();
  }

  // ── 参数 / 开关 ───────────────────────────────────────────────────────────
  setEnabled(on) {
    const next = Boolean(on);
    if (next === this.state.enabled) return;
    this.state.enabled = next;
    this.group.visible = next;
    this._emit();
  }

  setSimSpeed(speed) {
    if (!Number.isFinite(Number(speed))) return;
    this.state.sim.speed = clamp(Number(speed), 0.1, 4);
    this._emit();
  }

  setWaterAmount(meters) {
    if (!Number.isFinite(Number(meters))) return;
    this.state.sim.waterAmount = clamp(Number(meters), 1, 300);
    this._syncStateUniforms();
    this._emit();
  }

  setPaused(on) {
    this.state.sim.paused = Boolean(on);
    this._emit();
  }

  setResolution(value) {
    const next = this._pickResolution(value);
    if (next === this.state.sim.resolution) return;
    this.state.sim.resolution = next;
    this._rebuildSim();
    this._emit();
  }

  setVisual(patch = {}) {
    if (patch.shimmer != null && Number.isFinite(Number(patch.shimmer))) {
      this.state.visual.shimmer = clamp(Number(patch.shimmer), 0, 3);
    }
    if (patch.ripple != null && Number.isFinite(Number(patch.ripple))) {
      this.state.visual.ripple = clamp(Number(patch.ripple), 0, 2);
    }
    if (patch.clarity != null && Number.isFinite(Number(patch.clarity))) {
      this.state.visual.clarity = clamp(Number(patch.clarity), 0, 1);
    }
    this._syncStateUniforms();
    this._emit();
  }

  reset() {
    this._resetSim();
    this._emit();
  }

  // ── 每帧推进 ──────────────────────────────────────────────────────────────
  /**
   * @param {number} dt 帧间隔（秒）
   * @returns {number} 本帧执行的模拟子步数
   */
  update(dt) {
    const d = Math.min(Math.max(dt, 0), 0.25);
    if (this.uniforms) this.uniforms.uTime.value += d;
    if (!this.state.enabled || this.state.sim.paused) return 0;

    // 速度倍率：1 = 60 Hz 下一个子步；0.2 = 每 5 帧 1 步，4 = 一帧 4 步
    this._acc = Math.min(this._acc + d * 60 * this.state.sim.speed, 8);
    let steps = Math.floor(this._acc);
    this._acc -= steps;
    if (steps > 4) {
      this._acc += steps - 4;
      steps = 4;
    }
    if (steps <= 0) return 0;

    const renderer = this.renderer;
    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();
    renderer.autoClear = false;

    for (let i = 0; i < steps; i++) {
      this.shared.uFrame.value = this._step;
      this.shared.uPlayStep.value = this._playStep;
      this._runPass(this._matA, this.rtA); // A ← C,D
      this._runPass(this._matB, this.rtB); // B ← A,D
      this._runPass(this._matC, this.rtC); // C ← A,B
      this._runPass(this._matD, this.rtD); // D ← C,B
      this._step += 1;
      this._playStep += 1;
    }

    this._runPass(this._matDisplay, this.rtDisplay);
    this.uniforms.uSurface.value = this.rtDisplay.texture;

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget === undefined ? null : prevTarget);

    this.stats.steps = this._step;
    this.stats.wetCells = null;
    this.stats.maxDepthMeters = null;
    return steps;
  }

  // ── 序列化 ────────────────────────────────────────────────────────────────
  toJSON() {
    return JSON.parse(JSON.stringify(this.state));
  }

  load(raw) {
    const next = normalizeWaterState(raw);
    const resolutionChanged = next.sim.resolution !== this.state.sim.resolution;
    this.state = next;
    this.selectedId = null;
    if (resolutionChanged) {
      this._rebuildSim();
    } else {
      this._syncStateUniforms();
      this._resetSim();
    }
    this.group.visible = this.state.enabled;
    this._emit();
  }

  // ── 调试：读回少量像素统计（测试用）───────────────────────────────────────
  /**
   * @returns {{steps:number, wetCells:number, wetRatio:number, maxDepthMeters:number,
   *            meanDepthMeters:number, sourceCount:number, paused:boolean, resolution:number}}
   */
  debugStats() {
    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rtStats);
    this._simQuad.material = this._matStats;
    renderer.render(this._simScene, this._simCamera);

    let wet = 0;
    let maxDepth = 0;
    let sum = 0;
    const count = STATS_SIZE * STATS_SIZE;
    try {
      if (this._simHalf) {
        renderer.readRenderTargetPixels(this.rtStats, 0, 0, STATS_SIZE, STATS_SIZE, this._statsBufferHalf);
        const buf = this._statsBufferHalf;
        for (let i = 0; i < count; i++) {
          const depth = halfToFloat(buf[i * 4 + 1]);
          if (depth > 1e-4) wet += 1;
          if (depth > maxDepth) maxDepth = depth;
          sum += depth;
        }
      } else {
        renderer.readRenderTargetPixels(this.rtStats, 0, 0, STATS_SIZE, STATS_SIZE, this._statsBufferFloat);
        const buf = this._statsBufferFloat;
        for (let i = 0; i < count; i++) {
          const depth = buf[i * 4 + 1];
          if (depth > 1e-4) wet += 1;
          if (depth > maxDepth) maxDepth = depth;
          sum += depth;
        }
      }
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget === undefined ? null : prevTarget);
    }

    const maxDepthMeters = maxDepth * this.relief;
    const meanDepthMeters = (sum / count) * this.relief;
    this.stats.wetCells = wet;
    this.stats.maxDepthMeters = maxDepthMeters;
    return {
      steps: this._step,
      wetCells: wet,
      wetRatio: wet / count,
      maxDepthMeters,
      meanDepthMeters,
      sourceCount: this.state.sources.length,
      paused: this.state.sim.paused,
      resolution: this.resolution,
    };
  }

  dispose() {
    this._disposeSim();
    if (this.uniforms) {
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
    this._normalMap.dispose();
    this._foamMap.dispose();
  }
}
