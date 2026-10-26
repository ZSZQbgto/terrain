/**
 * 装配：地形渲染（复用 terrain 模块） + 模型沙盘编辑器。
 *
 * 渲染分层：
 *   WebGL 场景（地形 / 天空 / 水面 / 模型）→ FXAA 后处理 → canvas
 *   CSS2D 标签层（独立 DOM，叠加在 canvas 上）→ #labels
 */
import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import './styles.css';

import { loadHeightField } from './terrain/heightfield.js';
import { buildLookupTexture } from './terrain/gpuLookup.js';
import { createPaletteTexture } from './terrain/palette.js';
import { Terrain, createEnvUniforms } from './terrain/terrain.js';
import { SatelliteLOD, probeSatelliteTiles } from './terrain/satelliteLOD.js';
import { createSky } from './terrain/environment.js';
import { TerrainControls } from './viewer/controls.js';
import { FrameBudget } from './viewer/framebudget.js';
import { FxaaPass } from './viewer/fxaa.js';

import { AssetLibrary } from './editor/assetLibrary.js';
import { TagLayer } from './editor/labels.js';
import { Gizmo } from './editor/gizmo.js';
import { Editor } from './editor/editor.js';
import { Ui } from './editor/ui.js';
import { WaterSystem } from './editor/waterSystem.js';
import { WaterEditor } from './editor/waterEditor.js';

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

async function main() {
  const container = document.getElementById('app');

  // ── 地形数据 ──────────────────────────────────────────────────────────────
  setLoading('读取高程数据…');
  const heightField = await loadHeightField(DATA);
  await nextFrame();

  // ── 渲染上下文 ────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // 着色器内自行做 linear→sRGB
  renderer.setClearColor(0x0a0f14, 1);
  container.appendChild(renderer.domElement);

  const fxaa = new FxaaPass(renderer);

  setLoading('计算高程梯度与遮蔽（GPU）…');
  const lookupTexture = buildLookupTexture(renderer, heightField.texture, {
    width: heightField.width,
    height: heightField.height,
    reliefMeters: heightField.reliefMeters,
    pxMeters: heightField.pxMeters,
    aoStrength: 1,
    exagRef: 4,
  });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 80000);
  camera.position.set(3400, 4200, 5600);

  const env = createEnvUniforms(heightField.sizeMeters);
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
  const satellite = hasSatellite
    ? new SatelliteLOD({
        terrain,
        baseURL: satURL,
        chunkCount: heightField.chunkCount ?? 8,
        maxAnisotropy: maxAniso,
        hiResBudget: 3,
      })
    : null;
  if (satellite) {
    // 显卡不支持 2048² 纹理时退回中景档
    if (renderer.capabilities.maxTextureSize < 2048) satellite.setHiResBudget(0);
    satellite.preloadCoarse().catch((err) => console.warn('[satellite] 远景瓦片预载失败', err));
  } else {
    console.info('[satellite] 未找到 public/data/sat 瓦片 → 地形贴图不可用（放卫星源图后执行 npm run assets）');
  }

  const sky = createSky(env, {
    zenith: new THREE.Color(0x2f5f9e),
    horizon: new THREE.Color(0xb9cfe0),
  });
  scene.add(sky);

  const relief = heightField.reliefMeters;
  // 水面：只保留圈定区域与流动水，不再有覆盖全图的统一水面
  const DEFAULT_WATER_LEVEL = 69; // 新建区域时的默认水面高程（米）
  let getModelTargets = () => [];
  const waterSystem = new WaterSystem({
    scene,
    heightField,
    env,
    // 流动水带贴表面用：模型 content 列表（地形靠 CPU 高度采样兜底）
    getSurfaceTargets: () => getModelTargets(),
  });
  waterSystem.setDefaultLevel(DEFAULT_WATER_LEVEL);

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

  // ── 视图设置（贴图开关 / 相机碰撞），存 localStorage，不属于工程 JSON ────
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
    waterSystem.setEnabled(waterOn);
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

  // 水面系统与编辑器打通：选中互斥 + 数据变化自动落盘/刷新面板
  getModelTargets = () => editor.models.map((m) => m.content); // 水带贴表面用
  editor.attachWater(waterSystem);
  waterSystem.onChange = () => {
    editor.scheduleSave();
    ui?.refreshWaterPanel();
  };

  const waterEditor = new WaterEditor({
    system: waterSystem,
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

  ui = new Ui({
    editor,
    library,
    gizmo,
    waterSystem,
    waterEditor,
    onImportFiles: () => fileInput.click(),
    onImportProject: () => projectInput.click(),
    onExportProject: () => exportProject(),
    onToggleTextures: () => applyTextures(!texturesOn),
    onToggleCollision: () => applyCollision(!collisionOn),
    onToggleWater: () => applyWater(!waterOn),
    onDrawArea: () => waterEditor.start('area'),
    onDrawFlow: () => waterEditor.start('flow'),
    onMode: (mode) => patchSettings({ uiMode: mode }),
    onFogChange: (scale) => applyFog(scale),
    onWaterUndoPoint: () => waterEditor.undoPoint(),
    onWaterFinish: () => waterEditor.finish(),
    onWaterCancel: () => waterEditor.cancel(),
    onWaterRedraw: () => {
      const sel = waterSystem.selected;
      if (!sel) {
        ui?.toast('请先从水体列表选中一个对象');
        return;
      }
      waterEditor.redraw(sel.kind, sel.id);
    },
    onWaterSave: () => {
      editor.saveNow();
      ui?.toast('水体编辑已保存到本地工程');
    },
    onReset: async () => {
      await editor.resetAll();
      ui.renderAll();
    },
  });

  applyTextures(texturesOn); // 先确定开关状态，restore 出来的模型会按它应用贴图
  applyCollision(collisionOn); // 相机碰撞开关
  applyWater(waterOn); // 水面总开关
  applyFog(initialSettings.fog ?? 1); // 薄雾强度（地形 + 水面 + 模型）
  // 恢复上次的界面模式（模型编辑 / 水体编辑），并渲染对应面板
  ui.setMode(initialSettings.uiMode === 'water' ? 'water' : 'models');

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
    waterSystem.update(clock.elapsedTime); // 流动水贴图滚动
    sky.position.copy(camera.position);
    terrain.updateLOD(camera, window.innerHeight);
    satellite?.update(camera); // 地形贴图：按块到相机距离切换三档瓦片
    tagLayer.update(); // 部件标签跟随 gizmo / 数值编辑移动

    fxaa.render(scene, camera);
    css2d.render(scene, camera);

    budget.tick(dt);
    statsTimer += dt;
    if (statsTimer > 0.25) {
      statsTimer = 0;
      ui.setFps(budget.fps);
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
    waterSystem,
    waterEditor,
    editor,
    ui,
    library,
    gizmo,
    tagLayer,
    budget,
    cameraControls,
    satellite,
    applyTextures,
    isTexturesOn: () => texturesOn,
  };
}

main().catch((err) => {
  console.error(err);
  setLoading(`加载失败：${err?.message ?? err}`);
});
