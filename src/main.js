import * as THREE from 'three';
import { loadHeightField } from './terrain/heightfield.js';
import { buildLookupTexture } from './terrain/gpuLookup.js';
import { createPaletteTexture } from './terrain/palette.js';
import { Terrain, createEnvUniforms } from './terrain/terrain.js';
import { SatelliteLOD, probeSatelliteTiles } from './terrain/satelliteLOD.js';
import { createSky, Water } from './terrain/environment.js';
import { TerrainControls } from './viewer/controls.js';
import { FrameBudget } from './viewer/framebudget.js';
import { FxaaPass } from './viewer/fxaa.js';
import { probeWebglDevices, pickBestDevice, shortGpuName, probeWebGpuDevices } from './viewer/gpuProbe.js';
import { Hud } from './viewer/hud.js';

const DATA = `${import.meta.env.BASE_URL}data/`;
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

// 让出主线程：优先等下一帧，页面在后台时用定时器兜底（避免加载流程被 rAF 节流卡死）
const nextFrame = () =>
  new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 120);
  });

async function main() {
  setLoading('读取高程数据…');
  const heightField = await loadHeightField(DATA);
  await nextFrame();

  // ── 渲染上下文（可重建：切换核显/独显必须换一个新的 WebGL 上下文）─────────
  const container = document.getElementById('app');
  let renderer = null;
  let fxaa = null;
  let lookupTexture = null;

  /** 读当前上下文实际绑定的 GPU 名称 */
  const gpuName = (r) => {
    const gl = r.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return shortGpuName(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  };

  /**
   * 建立渲染上下文，并重建“属于该上下文”的 GPU 资源（离屏查询纹理、FXAA 的 render target）。
   * WebGL 没有运行时切换 GPU 的 API —— 只能在创建上下文时用 powerPreference 提出请求，
   * 实际由浏览器/驱动决定，所以“切设备”= 销毁上下文 → 换偏好重建 → 重跑离屏预计算。
   * 几何、材质、卫星纹理都是上下文无关的数据对象，three 会在新上下文里自动重新上传。
   */
  let terrain = null;
  let hud = null;

  /** 重建离屏查询纹理（首次创建与上下文恢复都走这条路径） */
  const rebuildLookup = () => {
    const previous = lookupTexture;
    lookupTexture = buildLookupTexture(renderer, heightField.texture, {
      width: heightField.width,
      height: heightField.height,
      reliefMeters: heightField.reliefMeters,
      pxMeters: heightField.pxMeters,
      aoStrength: 1,
      exagRef: 4,
    });
    terrain?.setLookupTexture(lookupTexture);
    previous?.dispose();
  };

  const createGpu = (powerPreference) => {
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference, alpha: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // 着色器内自行做 linear→sRGB
    renderer.setClearColor(0x0a0f14, 1);
    container.appendChild(renderer.domElement);

    // 核显上 MSAA 4x 会让地形着色成本近乎翻倍，改用 FXAA 后处理补回抗锯齿
    fxaa = new FxaaPass(renderer);

    setLoading('计算高程梯度与遮蔽（GPU）…');
    const t = performance.now();
    rebuildLookup();
    console.info(`[terrain] ${gpuName(renderer)} | 梯度/AO 纹理（GPU 离屏）${(performance.now() - t).toFixed(1)}ms`);

    // 浏览器可能出于省电（标签页不可见、切换电源方案）把上下文换回集显并丢弃它。
    // 不 preventDefault 上下文就不会恢复；恢复后离屏预计算的 GPU 资源已被清空，必须重跑。
    renderer.domElement.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      console.warn('[gpu] WebGL 上下文丢失（系统/浏览器可能切换了显卡）');
      setLoading('渲染上下文丢失，等待恢复…');
    });
    renderer.domElement.addEventListener('webglcontextrestored', () => {
      console.info('[gpu] 上下文已恢复，重建离屏预计算');
      rebuildLookup();
      hud?.setGpuName(gpuName(renderer));
      setLoading(null);
    });
  };

  // ── 硬件探测：只用于挑出最合适的 powerPreference，不在运行时切换设备 ──────
  // WebGL 没有运行时换 GPU 的 API；powerPreference 是创建上下文时给浏览器/驱动的建议。
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
  createGpu(autoPower);

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const maxTexture = renderer.capabilities.maxTextureSize; // 供瓦片尺寸校验使用

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 80000);
  camera.position.set(3400, 4200, 5600);

  const env = createEnvUniforms(heightField.sizeMeters);
  const palette = createPaletteTexture();

  terrain = new Terrain({
    heightField,
    lookupTexture,
    paletteTexture: palette,
    satelliteTexture: null,
    env,
  });

  setLoading('构建地形分块 LOD…');
  await nextFrame();
  const t1 = performance.now();
  await terrain.prebuild();
  console.info(`[terrain] LOD 几何预构建 ${(performance.now() - t1).toFixed(0)}ms`);
  scene.add(terrain.group);

  const sky = createSky(env, {
    zenith: new THREE.Color(0x2f5f9e),
    horizon: new THREE.Color(0xb9cfe0),
  });
  scene.add(sky);

  const water = new Water(env, heightField.sizeMeters);
  water.mesh.visible = true; // 默认开启，水位由面板调节
  scene.add(water.mesh);

  const relief = heightField.reliefMeters;
  let waterNormalized = 0.06;
  const syncWater = () => {
    water.setLevel(waterNormalized * relief * env.uExaggeration.value);
  };
  syncWater();

  // ── 控制 ──────────────────────────────────────────────────────────────────
  const controls = new TerrainControls(camera, renderer.domElement, heightField, {
    getExaggeration: () => env.uExaggeration.value,
  });
  controls.setTarget(0, relief * env.uExaggeration.value * 0.25, 0);

  // ── 卫星影像（可选）：分块 LOD（每块三档，按块到相机的距离实时切换）──────
  // 近景档 2048²/块 ≈ 0.49 m/px，比源图 0.55 m/px 还细，等于用回原始像素。
  // 离线管线在缺源图时会跳过卫星产物，这里先探测瓦片是否存在；
  // 没有卫星影像时不创建调度器，页面固定展示高程分层地形。
  const chunkCount = heightField.chunkCount ?? 8;
  const satURL = `${DATA}sat/`;
  setLoading('检测卫星影像…');
  await nextFrame();
  const hasSatellite = await probeSatelliteTiles(satURL);
  let satellite = null;
  if (hasSatellite) {
    satellite = new SatelliteLOD({
      terrain,
      baseURL: satURL,
      chunkCount,
      maxAnisotropy: maxAniso,
      hiResBudget: 3,
    });
    satellite.setEnabled(true);
    // 显卡不支持 2048² 纹理时退回中景档，避免上传失败
    if (maxTexture < 2048) satellite.setHiResBudget(0);
  } else {
    console.info('[satellite] 未找到卫星瓦片（npm run assets 未生成），仅展示地形');
  }

  // ── 帧率自适应 ────────────────────────────────────────────────────────────
  const budget = new FrameBudget(renderer, {
    targetFps: 60,
    onDegrade: (level) => console.info(`[perf] 渲染分辨率降档 → ${budget.scale}`),
  });

  // 加载结束：收起遮罩并清空帧统计窗口，避免加载长任务把分辨率误降到低画质
  const finishLoading = () => {
    setLoading(null);
    budget.reset();
  };

  hud = new Hud({
    hasSatellite: Boolean(satellite),
    onMode: (mode) => {
      terrain.setMode(mode);
    },
    onExaggeration: (v) => {
      terrain.setExaggeration(v);
      syncWater();
    },
    onBands: (v) => {
      terrain.hypsoMaterial.uniforms.uBands.value = v;
    },
    onContour: (v) => {
      terrain.hypsoMaterial.uniforms.uContour.value = v;
    },
    onHiResBudget: (n) => {
      satellite?.setHiResBudget(n);
    },
    onWaterToggle: (on) => {
      water.mesh.visible = on;
    },
    onWaterLevel: (v) => {
      waterNormalized = v;
      syncWater();
      hud.setWaterLevelLabel(v, heightField.elevation.minMeters + v * relief);
    },
  });
  hud.setWaterLevelLabel(waterNormalized, heightField.elevation.minMeters + waterNormalized * relief);
  // 设备名只作信息展示：渲染设备由浏览器按 powerPreference 自动分配，运行时不切换
  hud.setGpuName(gpuName(renderer));

  // 标签页重新可见时复核一次实际设备：浏览器可能因省电换过显卡
  // （真正换卡会触发 webglcontextlost / restored，上面已处理；这里只是刷新显示）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    hud?.setGpuName(gpuName(renderer));
  });

  // 先把远景档铺满（64 张小图，几百 KB），保证任何角度都有影像；近景档按需补
  if (satellite) {
    satellite
      .preloadCoarse()
      .catch((err) => console.warn('[satellite] 远景预载失败', err))
      .finally(finishLoading);
  } else {
    finishLoading();
  }

  // ── 交互：双击聚焦 / 悬停高程 ─────────────────────────────────────────────
  renderer.domElement.addEventListener('dblclick', (e) => {
    const hit = controls.pick(e.clientX, e.clientY);
    if (hit) controls.focusAt(hit, Math.max(400, hit.y * 0.8 + 500));
  });

  let lastPick = 0;
  renderer.domElement.addEventListener('pointermove', (e) => {
    const now = performance.now();
    if (now - lastPick < 80) return;
    lastPick = now;
    const hit = controls.pick(e.clientX, e.clientY);
    hud.setElevation(hit ? heightField.elevation.minMeters + hit.normalized * relief : null);
  });

  const resize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize);

  // ── 渲染循环 ──────────────────────────────────────────────────────────────
  const clock = new THREE.Clock();
  let hudTimer = 0;
  let frameHandle = 0;
  let fallbackTimer = 0;

  const loop = () => {
    const dt = Math.min(clock.getDelta(), 0.25);

    controls.update(dt);
    water.update(clock.elapsedTime);
    sky.position.copy(camera.position);
    terrain.updateLOD(camera, window.innerHeight);
    satellite?.update(camera);

    fxaa.render(scene, camera);

    budget.tick(dt);
    hudTimer += dt;
    if (hudTimer > 0.25) {
      hudTimer = 0;
      const size = renderer.getSize(new THREE.Vector2());
      hud.update({
        fps: budget.fps,
        frameMs: budget.frameMs,
        triangles: terrain.triangles,
        pixelRatio: renderer.getPixelRatio(),
        width: Math.round(size.x),
        height: Math.round(size.y),
      });
    }

    startLoop();
  };

  const startLoop = () => {
    frameHandle = requestAnimationFrame(loop);
    // 标签页在后台时 rAF 会停摆，用定时器兜底保证状态继续推进
    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      if (frameHandle) cancelAnimationFrame(frameHandle);
      frameHandle = 0;
      loop();
    }, 200);
  };

  startLoop();

  window.__terrain = { scene, camera, renderer, terrain, controls, heightField, env, water, budget, satellite, fxaa };
}

main().catch((err) => {
  console.error(err);
  setLoading(`加载失败：${err.message}`);
});
