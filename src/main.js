/**
 * 装配：地形渲染（复用 terrain 模块） + 地形模型编辑。
 *
 * 渲染分层：
 *   WebGL 场景（地形 / 天空 / 水面 / 模型）→ FXAA 后处理 → canvas
 *   CSS2D 标签层（独立 DOM，叠加在 canvas 上）→ #labels
 */
import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import './styles.css';

import { loadHeightField } from './terrain/heightfield.js';
import { createLookupUpdater } from './terrain/gpuLookup.js';
import { createPaletteTexture } from './terrain/palette.js';
import { Terrain, createEnvUniforms } from './terrain/terrain.js';
import { SatelliteLOD, probeSatelliteTiles } from './terrain/satelliteLOD.js';
import { createSky } from './terrain/environment.js';
import { TerrainControls } from './viewer/controls.js';
import { FrameBudget } from './viewer/framebudget.js';
import { FxaaPass } from './viewer/fxaa.js';
import { probeWebglDevices, pickBestDevice, shortGpuName, probeWebGpuDevices } from './viewer/gpuProbe.js';

import { AssetLibrary } from './editor/assetLibrary.js';
import { TagLayer } from './editor/labels.js';
import { Gizmo } from './editor/gizmo.js';
import { Editor } from './editor/editor.js';
import { Ui } from './editor/ui.js';
import { FluidWater } from './water/fluidWater.js';
import { WaterEditor } from './editor/waterEditor.js';
import { TerrainEditor, restoreSavedTerrainEdits } from './editor/terrainEditor.js';

const DATA = `${import.meta.env.BASE_URL}data/`;
const HINT =
  '拖入 .glb 或点「导入模型」 · 左键选择模型 · 1/2/3 切换移动/旋转/缩放 · Esc 取消选择 · Delete 删除 · Ctrl+D 复制';

const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');

const setLoading = (text) => {
  if (!text) {
    loadingEl.classList.add('hidden');
    return;
  }
  loadingText.textContent = text;
  loadingEl.classList.remove('hidden');
};

const nextFrame = () =>
  new Promise((resolve) => {
    requestAnimationFrame(resolve);
    setTimeout(resolve, 120);
  });

/** 数值设置读取：非法/越界时回落到默认值（localStorage 里可能残留旧版本数据） */
const clampSetting = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

// ── 视图 / 渲染设置（localStorage，与工程 JSON 分开）────────────────────────
// 贴图、相机碰撞、水面、薄雾强度、垂直夸张、分层数、等高线、近景高清块数都存这里。
const SETTINGS_KEY = 'modeldesigner.settings.v1';
const readSettings = () => {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    return {};
  }
};
const patchSettings = (patch) => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readSettings(), ...patch }));
  } catch {
    /* 隐私模式/配额异常时忽略 */
  }
};
const initialSettings = readSettings();

async function main() {
  const container = document.getElementById('app');

  // ── 地形数据 ──────────────────────────────────────────────────────────────
  setLoading('读取高程数据…');
  const heightField = await loadHeightField(DATA);
  // 恢复上次在地形编辑里保存的高度（必须在构建 GPU 查询纹理之前应用）
  setLoading('恢复地形编辑…');
  const savedTerrain = await restoreSavedTerrainEdits(heightField);
  if (savedTerrain.restored) console.info('[terrain-edit] 已恢复上次编辑的地形高度');
  await nextFrame();

  // ── 硬件探测：只用于挑出最合适的 powerPreference（WebGL 不支持运行时切换设备）──
  // WebGL 既没有枚举显卡的 API，也没有运行时换 GPU 的 API；powerPreference 只是创建
  // 上下文时给浏览器/驱动的建议，最终由系统决定。这里探测只为让独显机器尽量拿到独显。
  setLoading('检测渲染硬件…');
  await nextFrame();
  const gpuDevices = probeWebglDevices();
  const bestDevice = pickBestDevice(gpuDevices);
  const autoPower = bestDevice?.powerPreference ?? 'high-performance';
  console.info(
    '[gpu] 探测到的渲染设备：',
    gpuDevices.map((d) => `${d.kind} | ${d.shortName} | ${d.caps.maxTextureSize}px | pref=${d.prefers.join('/')}`),
    '→ 自动选择',
    autoPower,
  );
  probeWebGpuDevices().then((adapters) => {
    if (!adapters.length) return;
    const distinct = new Set(adapters.map((a) => a.description)).size;
    console.info(
      '[gpu] WebGPU 适配器：',
      adapters.map((a) => `${a.powerPreference} → ${a.description}`),
      distinct > 1 ? '（两块不同设备）' : '（同一设备）',
    );
  });

  await nextFrame();

  // ── 渲染上下文 ────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: autoPower, alpha: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // 着色器内自行做 linear→sRGB
  renderer.setClearColor(0x0a0f14, 1);
  container.appendChild(renderer.domElement);

  /** 读当前上下文实际绑定的 GPU 名称（仅信息展示） */
  const gpuName = () => {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return shortGpuName(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  };

  const fxaa = new FxaaPass(renderer);

  setLoading('计算高程梯度与遮蔽（GPU）…');
  // 可复用的查询纹理更新器：地形编辑时高度图频繁变化，复用同一张 render target 原地重算
  const lookupUpdater = createLookupUpdater(renderer, {
    width: heightField.width,
    height: heightField.height,
    reliefMeters: heightField.reliefMeters,
    pxMeters: heightField.pxMeters,
    aoStrength: 1,
    exagRef: 4,
  });
  lookupUpdater.update(heightField.texture);
  const lookupTexture = lookupUpdater.texture;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 80000);
  camera.position.set(3400, 4200, 5600);

  const env = createEnvUniforms(heightField.sizeMeters);
  // 垂直夸张从上次会话恢复（与「图形选项 → 垂直夸张」滑杆同范围 1–8）
  env.uExaggeration.value = clampSetting(initialSettings.exaggeration, 1, 8, 1.8);
  const palette = createPaletteTexture();
  // 模型走 three 内置雾：与地形自定义距离雾同色同密度，远处同样化入天空
  scene.fog = new THREE.FogExp2(env.uFogColor.value.clone(), env.uFogDensity.value);
  // 薄雾基准密度：「图形选项 → 薄雾强度 1.0×」对应的值，滑块在此基础上乘系数
  const FOG_BASE = env.uFogDensity.value;

  // 模型是 three 内置 PBR 材质，需要真实光源；
  // 方向与颜色都取自地形同一套 env，避免模型与地形各打各的光。
  const sunLight = new THREE.DirectionalLight(env.uSunColor.value.clone(), 1.35);
  sunLight.position.copy(env.uSunDir.value).multiplyScalar(6000);
  scene.add(sunLight);
  scene.add(sunLight.target);
  const hemiLight = new THREE.HemisphereLight(
    env.uSkyColor.value.clone(),
    env.uGroundColor.value.clone(),
    0.9,
  );
  scene.add(hemiLight);

  const terrain = new Terrain({
    heightField,
    lookupTexture,
    paletteTexture: palette,
    satelliteTexture: null,
    env,
  });
  // 高程分层参数从上次会话恢复（与「图形选项」里的分层数 / 等高线滑杆同范围）
  const bandsValue = clampSetting(initialSettings.bands, 6, 48, 48);
  const contourValue = clampSetting(initialSettings.contour, 0, 1, 1);
  terrain.hypsoMaterial.uniforms.uBands.value = bandsValue;
  terrain.hypsoMaterial.uniforms.uContour.value = contourValue;

  /**
   * 重建离屏查询纹理（首次创建、WebGL 上下文恢复、地形编辑后都走这条路径）。
   * 内容原地更新，纹理引用不变，所以只需要调用 update（不需要 terrain.setLookupTexture）。
   */
  const rebuildLookup = () => {
    lookupUpdater.update(heightField.texture);
  };

  setLoading('构建地形分块 LOD…');
  await nextFrame();
  await terrain.prebuild();
  scene.add(terrain.group);

  // ── 地形贴图（可选）：public/data/sat 的分块卫星瓦片 LOD（8×8 块 × 三档）────
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const satURL = `${DATA}sat/`;
  setLoading('检测地形贴图…');
  await nextFrame();
  const hasSatellite = await probeSatelliteTiles(satURL);
  // 近景高清块数（3/6/9）从上次会话恢复；显卡不支持 2048² 纹理时退回中景档
  const satBudget = renderer.capabilities.maxTextureSize < 2048 ? 0 : clampSetting(initialSettings.hiResBudget, 3, 9, 3);
  const satellite = hasSatellite
    ? new SatelliteLOD({
        terrain,
        baseURL: satURL,
        chunkCount: heightField.chunkCount ?? 8,
        maxAnisotropy: maxAniso,
        hiResBudget: satBudget,
      })
    : null;
  if (satellite) {
    satellite.preloadCoarse().catch((err) => console.warn('[satellite] 远景瓦片预载失败', err));
  } else {
    console.info('[satellite] 未找到 public/data/sat 瓦片 → 地形贴图不可用（放卫星源图后执行 npm run assets）');
  }

  // 天空与水面的反射用同一份天色，避免“水面反射的天空”和背景天空不是一个颜色
  const SKY_COLORS = {
    zenith: new THREE.Color(0x2f5f9e),
    horizon: new THREE.Color(0xb9cfe0),
  };
  const sky = createSky(env, SKY_COLORS);
  scene.add(sky);

  const relief = heightField.reliefMeters;

  // ── 水体模拟（GPU 浅水模拟，模拟域自动覆盖整个地形）─────────────────────
  // 无需手动创建高度图 / 设定模拟范围：高度场直接取现有地形数据，
  // 水面网格覆盖整个 8 km 地形，直接在地形上点选放置水源即可开始注水。
  const water = new FluidWater({
    renderer,
    heightField,
    env,
    skyColors: SKY_COLORS,
    // 水面波纹法线用各向异性过滤：斜视角不糊、远处不闪
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    resolution: 768,
  });
  scene.add(water.group);

  const cameraControls = new TerrainControls(camera, renderer.domElement, heightField, {
    getExaggeration: () => env.uExaggeration.value,
  });
  cameraControls.setTarget(0, relief * env.uExaggeration.value * 0.25, 0);

  // ── CSS2D 标签层 ──────────────────────────────────────────────────────────
  const css2d = new CSS2DRenderer({ element: document.getElementById('labels') });
  css2d.setSize(window.innerWidth, window.innerHeight);

  // ── 编辑器装配 ────────────────────────────────────────────────────────────
  const gizmo = new Gizmo(camera, renderer.domElement, {});
  const tagLayer = new TagLayer({ visible: true });
  const library = new AssetLibrary();

  setLoading('扫描 public/models…');
  await library.refresh();
  await nextFrame();

  const editor = new Editor({
    scene,
    camera,
    domElement: renderer.domElement,
    terrain,
    heightField,
    env,
    cameraControls,
    gizmo,
    tagLayer,
    library,
  });

  const fileInput = document.getElementById('file-input');
  const projectInput = document.getElementById('project-input');

  // ── 视图设置（贴图 / 碰撞 / 水面 / 雾 / 地形显示参数），存 localStorage，不属于工程 JSON ──
  let texturesOn = initialSettings.textures !== false;
  let collisionOn = initialSettings.cameraCollision !== false;
  let waterOn = initialSettings.water !== false;
  let ui = null;

  const applyTextures = (on) => {
    texturesOn = Boolean(on);
    editor.setTexturesEnabled(texturesOn); // 模型：摘掉/恢复 glb 自带贴图
    const useSatellite = texturesOn && Boolean(satellite);
    terrain.setMode(useSatellite ? 'satellite' : 'hypsometric'); // 地形：卫星瓦片 or 高程分层
    satellite?.setEnabled(useSatellite);
    ui?.setTextureState(texturesOn, { hasTerrainTexture: Boolean(satellite) });
    patchSettings({ textures: texturesOn });
  };

  const applyCollision = (on) => {
    collisionOn = Boolean(on);
    cameraControls.setCollisionEnabled(collisionOn);
    ui?.setCollisionState(collisionOn);
    patchSettings({ cameraCollision: collisionOn });
  };

  const applyWater = (on) => {
    waterOn = Boolean(on);
    water.setEnabled(waterOn);
    ui?.setWaterState(waterOn);
    patchSettings({ water: waterOn });
  };

  /** 薄雾强度：地形与水面共用 env.uFogDensity，模型走 scene.fog，两边一起调 */
  const applyFog = (scale) => {
    const k = Number.isFinite(scale) ? Math.max(0, Math.min(3, scale)) : 1;
    env.uFogDensity.value = FOG_BASE * k;
    if (scene.fog) scene.fog.density = FOG_BASE * k;
    ui?.setFogState(k);
    patchSettings({ fog: k });
  };

  /** 垂直夸张：只作用于梯度与位移，水面 / 相机碰撞都读同一个 env 值 */
  const applyExaggeration = (value) => {
    const k = clampSetting(value, 1, 8, 1.8);
    terrain.setExaggeration(k);
    ui?.setExaggerationState(k);
    patchSettings({ exaggeration: k });
  };

  /** 高程分层数（6–48）：只影响高程分层材质 */
  const applyBands = (value) => {
    const n = clampSetting(value, 6, 48, 48);
    terrain.hypsoMaterial.uniforms.uBands.value = n;
    ui?.setBandsState(n);
    patchSettings({ bands: n });
  };

  /** 等高线强度（0–1） */
  const applyContour = (value) => {
    const c = clampSetting(value, 0, 1, 1);
    terrain.hypsoMaterial.uniforms.uContour.value = c;
    ui?.setContourState(c);
    patchSettings({ contour: c });
  };

  /** 近景高清块数（3/6/9，0 = 显卡不支持 2048² 时退回中景档） */
  const applyHiResBudget = (value) => {
    if (!satellite) return;
    const n = clampSetting(value, 0, 9, 3);
    satellite.setHiResBudget(n);
    ui?.setHiResBudgetState(n);
    patchSettings({ hiResBudget: n });
  };

  // 水体模拟与编辑器打通：选中互斥 + 数据变化自动落盘/刷新面板
  editor.attachWater(water);
  water.onChange = () => {
    editor.scheduleSave();
    ui?.refreshWaterPanel();
  };

  const waterEditor = new WaterEditor({
    water,
    editor,
    camera,
    domElement: renderer.domElement,
    scene,
    cameraControls,
    onStatus: (text) => {
      if (text) ui?.toast(text);
      else ui?.resetHint?.();
    },
    onDraftChange: () => ui?.refreshWaterPanel(),
  });

  // ── 地形编辑（DEM 笔刷）：高度图实时更新，AO/梯度查询纹理节流重建 ──────────
  // 顶点着色器直接采样高度图（uHeight），所以涂抹时高度位移每帧都在变；
  // 这里只把「着色用的查询纹理」标脏，约 180ms 重建一次（笔画结束立即重建）。
  let lookupDirty = false;
  let lastLookupRebuild = performance.now();
  const LOOKUP_REBUILD_INTERVAL = 180;
  const flushLookup = () => {
    lookupDirty = false;
    lastLookupRebuild = performance.now();
    rebuildLookup();
  };
  const flushLookupIfDue = () => {
    if (!lookupDirty) return;
    if (performance.now() - lastLookupRebuild < LOOKUP_REBUILD_INTERVAL) return;
    flushLookup();
  };

  const terrainEditor = new TerrainEditor({
    heightField,
    camera,
    domElement: renderer.domElement,
    cameraControls,
    editor,
    hasSavedEdits: savedTerrain.restored,
    onEdit: () => {
      lookupDirty = true;
    },
    onStrokeEnd: () => flushLookup(),
    onStateChange: (state) => {
      ui?.setTerrainState?.(state);
      ui?.setTerrainExportInfo?.(terrainEditor.getExportInfo());
    },
    onStatus: (text) => ui?.setTerrainStatus?.(text),
  });

  /** 模式切换：模型编辑 / 水体编辑 / 地形编辑；地形模式激活笔刷、停用模型拾取 */
  const applyMode = (mode) => {
    patchSettings({ uiMode: mode });
    terrainEditor.setActive(mode === 'terrain');
    if (mode === 'terrain') {
      ui?.setTerrainState?.(terrainEditor.getState());
      ui?.setTerrainExportInfo?.(terrainEditor.getExportInfo());
    }
  };

  ui = new Ui({
    editor,
    library,
    gizmo,
    water,
    waterEditor,
    onImportFiles: () => fileInput.click(),
    onImportProject: () => projectInput.click(),
    onExportProject: () => exportProject(),
    onToggleTextures: () => applyTextures(!texturesOn),
    onToggleCollision: () => applyCollision(!collisionOn),
    onToggleWater: () => applyWater(!waterOn),
    onMode: (mode) => applyMode(mode),
    onFogChange: (scale) => applyFog(scale),
    onExaggerationChange: (value) => applyExaggeration(value),
    onBandsChange: (value) => applyBands(value),
    onContourChange: (value) => applyContour(value),
    onHiResBudgetChange: (value) => applyHiResBudget(value),
    onToggleTour: () => applyTour(!tourOn),
    onWaterAddSource: () => waterEditor.startPlacement(),
    onWaterSave: () => {
      editor.saveNow();
      ui?.toast('水体模拟已保存到本地工程');
    },
    onWaterReset: () => {
      water.reset();
      ui?.toast('已重置水体（清空所有积水）');
    },
    onReset: async () => {
      await editor.resetAll();
      ui.renderAll();
    },
    onTerrainTool: (tool) => terrainEditor.setTool(tool),
    onTerrainRadius: (meters) => terrainEditor.setRadius(meters),
    onTerrainStrength: (value) => terrainEditor.setStrength(value),
    onTerrainUndo: () => {
      if (!terrainEditor.undo()) ui?.toast?.('没有可撤销的地形编辑');
    },
    onTerrainReset: () => {
      if (!confirm('恢复原始地形高度？这会丢弃所有地形编辑（建议先导出灰度图备份）。')) return;
      terrainEditor.resetToOriginal();
      ui?.toast?.('已恢复原始地形');
    },
    onTerrainExport: async () => {
      ui?.setTerrainBusy?.(true);
      try {
        const result = await terrainEditor.exportAndDownload();
        ui?.toast?.(`已导出 ${result.filename}（${result.width}×${result.height}，${result.bitDepth} bit 灰度 PNG）`);
      } catch (err) {
        console.error('[terrain-edit] 导出灰度图失败', err);
        ui?.toast?.(`导出灰度图失败：${err?.message ?? err}`);
      } finally {
        ui?.setTerrainBusy?.(false);
      }
    },
  });

  applyTextures(texturesOn); // 先确定开关状态，restore 出来的模型会按它应用贴图
  applyCollision(collisionOn); // 相机碰撞开关
  applyWater(waterOn); // 水面总开关
  applyFog(initialSettings.fog ?? 1); // 薄雾强度（地形 + 水面 + 模型）
  applyExaggeration(env.uExaggeration.value); // 垂直夸张（地形 + 水面 + 相机碰撞）
  applyBands(bandsValue); // 分层数
  applyContour(contourValue); // 等高线
  ui.setHasSatellite(Boolean(satellite)); // 没有卫星瓦片时隐藏「近景高清块数」
  if (satellite) applyHiResBudget(satBudget); // 近景高清块数
  ui.setGpuName(gpuName()); // 图形选项里显示上下文实际绑定的 GPU（仅信息展示）
  ui.setTerrainState?.(terrainEditor.getState()); // 地形编辑：工具 / 笔刷 / 编辑状态
  ui.setTerrainExportInfo?.(terrainEditor.getExportInfo()); // 地形编辑：导出尺寸 / 灰度范围

  // ── WebGL 上下文丢失 / 恢复：浏览器省电（标签页不可见等）可能换显卡并丢弃上下文，
  //    不 preventDefault 就不会恢复；恢复后离屏预计算的 GPU 纹理已被清空，必须重跑、
  //    浅水模拟的 ping-pong 缓冲也要重置。─────────────────────────────────────────
  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    console.warn('[gpu] WebGL 上下文丢失（系统/浏览器可能切换了显卡）');
    setLoading('渲染上下文丢失，等待恢复…');
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    console.info('[gpu] 上下文已恢复，重建离屏预计算');
    flushLookup();
    water.reset();
    ui?.setGpuName(gpuName());
    setLoading(null);
  });

  // 标签页重新可见时复核一次实际设备（真正换卡会触发上面的 lost/restored）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    ui?.setGpuName(gpuName());
  });

  // ── 游览模式：隐藏全部 UI，相机开启惯性缓动 ────────────────────────────
  let tourOn = false;
  const applyTour = (on) => {
    const next = Boolean(on);
    if (next && waterEditor.active) waterEditor.cancel(); // 别把正在画的点带进游览
    tourOn = next;
    ui?.setTourState(tourOn);
    waterEditor.setTourHidden(tourOn); // 游览模式隐藏水源标记（小球 / 圆环）
    cameraControls.setInertia(tourOn);
    if (tourOn) {
      ui?.toast('游览模式：拖动旋转 · 滚轮缩放 · WASD 平移（带惯性）· Esc 退出');
    } else {
      ui?.resetHint?.();
    }
  };

  document.getElementById('tour-exit')?.addEventListener('click', () => applyTour(false));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && tourOn) applyTour(false);
  });

  // 恢复上次的界面模式（模型编辑 / 水体编辑 / 地形编辑），并渲染对应面板
  ui.setMode(
    initialSettings.uiMode === 'water' ? 'water' : initialSettings.uiMode === 'terrain' ? 'terrain' : 'models',
  );

  // ── 恢复上次工程 ──────────────────────────────────────────────────────────
  setLoading('恢复上次工程…');
  try {
    const restored = await editor.restore();
    if (restored.restored) {
      ui.toast(`已恢复 ${restored.restored} 个模型${restored.missing.length ? `，${restored.missing.length} 个资源缺失` : ''}`);
    } else if (restored.missing.length) {
      ui.toast(`${restored.missing.length} 个模型的资源找不到，请把对应 glb 放回 public/models 或重新导入`);
    }
  } catch (err) {
    console.warn('[editor] 恢复工程失败', err);
  }
  applyTextures(texturesOn); // 恢复后再同步一次按钮与材质
  setLoading(null);

  // ── 导入 / 导出 ───────────────────────────────────────────────────────────
  const reportImport = (results) => {
    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);
    if (ok.length) {
      const written = ok.some((r) => r.model?.asset?.source === 'dir');
      ui.toast(
        `已导入 ${ok.length} 个模型${written ? '（已写入 public/models）' : '（暂存在浏览器，可「移入文件夹」）'}` +
          (bad.length ? `；${bad.length} 个失败` : ''),
      );
    } else if (bad.length) {
      ui.toast(`导入失败：${bad.map((b) => `${b.name}（${b.error}）`).join('；')}`);
    }
  };

  fileInput.addEventListener('change', async () => {
    if (!fileInput.files?.length) return;
    const results = await editor.importFiles(fileInput.files);
    fileInput.value = '';
    await library.refresh();
    reportImport(results);
  });

  projectInput.addEventListener('change', async () => {
    const file = projectInput.files?.[0];
    projectInput.value = '';
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      if (!confirm('导入工程会替换当前场景（资源文件夹里的 glb 不受影响），继续？')) return;
      const res = await editor.importProjectJson(json);
      await library.refresh();
      ui.toast(`已导入工程：${res.restored} 个模型${res.missing.length ? `，${res.missing.length} 个资源缺失` : ''}`);
    } catch (err) {
      alert(`导入工程失败：${err?.message ?? err}`);
    }
  });

  async function exportProject() {
    const embed = confirm(
      '导出工程 JSON：\n\n· 确定 = 内嵌 glb（单文件，体积大，可换机器）\n· 取消 = 只导出引用（依赖 public/models 里的同名文件）',
    );
    const project = await editor.exportProject({ embedAssets: embed });
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `沙盘工程-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    ui.toast(`已导出工程${embed ? '（含 glb）' : ''}：${project.models.length} 个模型`);
  }

  // ── 拖拽导入 ──────────────────────────────────────────────────────────────
  let dragDepth = 0;
  const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    dragDepth += 1;
    container.classList.add('drop-target');
  });
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) container.classList.remove('drop-target');
  });
  window.addEventListener('drop', async (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    container.classList.remove('drop-target');
    const results = await editor.importFiles(event.dataTransfer.files);
    await library.refresh();
    reportImport(results);
  });

  // ── 键盘 ──────────────────────────────────────────────────────────────────
  const isTyping = (target) =>
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;

  window.addEventListener('keydown', (event) => {
    if (isTyping(event.target)) return;
    if (event.key === 'Escape') {
      editor.clearSelection();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!editor.selectedId) return;
      event.preventDefault();
      editor.removeSelected();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      editor.duplicateSelected();
      return;
    }
    if (event.key === '1' || event.key === '2' || event.key === '3') {
      gizmo.setMode(event.key === '1' ? 'translate' : event.key === '2' ? 'rotate' : 'scale');
      editor.emitChange();
    }
  });

  // ── 帧率自适应 ────────────────────────────────────────────────────────────
  const budget = new FrameBudget(renderer, {
    targetFps: 60,
    onDegrade: () => console.info(`[perf] 渲染分辨率降档 → ${budget.scale}`),
  });

  const resize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    css2d.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize);

  // ── 渲染循环 ──────────────────────────────────────────────────────────────
  const clock = new THREE.Clock();
  let statsTimer = 0;

  const loop = () => {
    const dt = Math.min(clock.getDelta(), 0.25);
    cameraControls.update(dt);
    water.update(dt); // GPU 浅水模拟：按模拟速度推进子步（水面网格在场景里透明渲染）
    sky.position.copy(camera.position);
    terrain.updateLOD(camera, window.innerHeight);
    satellite?.update(camera); // 地形贴图：按块到相机距离切换三档瓦片
    tagLayer.update(); // 部件标签跟随 gizmo / 数值编辑移动
    flushLookupIfDue(); // 地形编辑后：节流重建 AO / 梯度查询纹理（高度已实时更新）

    fxaa.render(scene, camera);
    css2d.render(scene, camera);

    budget.tick(dt);
    statsTimer += dt;
    if (statsTimer > 0.25) {
      statsTimer = 0;
      const size = renderer.getSize(new THREE.Vector2());
      ui.setPerf({
        fps: budget.fps,
        frameMs: budget.frameMs,
        triangles: terrain.triangles,
        width: Math.round(size.x),
        height: Math.round(size.y),
        pixelRatio: renderer.getPixelRatio(),
      });
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // 调试/自动化入口
  window.__designer = {
    scene,
    camera,
    renderer,
    terrain,
    heightField,
    env,
    water,
    waterEditor,
    editor,
    ui,
    library,
    gizmo,
    tagLayer,
    budget,
    cameraControls,
    satellite,
    gpuDevices,
    terrainEditor,
    lookupUpdater,
    applyTour,
    applyMode,
    applyTextures,
    applyWater,
    applyExaggeration,
    applyBands,
    applyContour,
    applyHiResBudget,
    isTexturesOn: () => texturesOn,
  };
}

main().catch((err) => {
  console.error(err);
  setLoading(`加载失败：${err?.message ?? err}`);
});
