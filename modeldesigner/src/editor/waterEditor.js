/**
 * 水源选点放置 / 场景标记 / 拖动。
 *
 * 与旧「画水面区域 + 流动水」不同，这里只做一件事：在地形上点选**水源**，
 * 交给 FluidWater 后由 GPU 浅水模拟自己扩散成水面。交互约定：
 *
 *   - `startPlacement()`：进入放置模式（关闭模型拾取），在地形上连续点击即可连续放水源；
 *     左键拖动（位移 > 6px）仍算转视角，不会误放点。`Esc` / `cancel()` 退出。
 *   - 每个水源在场景里有一个青色小球（地面之上）+ 一个半径圆环（贴地）+ CSS2D 名称序号。
 *     小球可以按住水平拖动，松开时 `water.updateSource(id, { x, z })` 提交
 *     （地面高程由 FluidWater 按新位置自动跟随）。
 *   - 点击小球选中（`water.selectSource(id)`），选中标记变白/黄。
 *
 * 坐标约定：外部一律用「米」/世界坐标；标记的 y 由 `water.groundMetersAt()` 换算出世界 y。
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const SPHERE_RADIUS = 13; // 小球半径（世界单位）
const SPHERE_LIFT = 26; // 小球离地高度（世界单位）
const RING_LIFT = 2.0; // 圆环离地高度，避免与地形 z-fighting
const LABEL_LIFT = 30; // CSS2D 名称在球心之上
const CLICK_SLOP = 6; // 位移超过这个像素算拖拽视角，不算点击

const COLOR_SOURCE = 0x7fe6d4; // 青色：普通水源
const COLOR_SELECTED = 0xffd166; // 黄色：选中水源的地面圆环
const COLOR_SELECTED_CORE = 0xf2fbff; // 白：选中水源的小球

export class WaterEditor {
  /**
   * @param {{
   *   water: import('../water/fluidWater.js').FluidWater,
   *   editor: import('./editor.js').Editor,
   *   camera: THREE.PerspectiveCamera,
   *   domElement: HTMLElement,
   *   scene: THREE.Scene,
   *   cameraControls: import('../viewer/controls.js').TerrainControls,
   *   onStatus?: (text: string | null) => void,
   *   onDraftChange?: (editor: WaterEditor) => void,
   * }} opts
   */
  constructor({ water, editor, camera, domElement, scene, cameraControls, onStatus, onDraftChange }) {
    this.water = water;
    this.editor = editor;
    this.camera = camera;
    this.dom = domElement;
    this.cameraControls = cameraControls ?? null;
    this.onStatus = onStatus;
    this.onDraftChange = onDraftChange;

    this.placement = false; // 放置模式
    this.visible = false; // 只在「水体编辑」模式下显示标记
    this.tourHidden = false; // 游览模式（无 UI）下临时隐藏标记，避免截图里出现小球/圆环
    this._down = null; // 放置模式的按下点（区分点击 / 拖视角）
    this._drag = null; // 拖动水源小球时的状态
    this._hoverId = null;

    // 场景标记（与水面网格分开，由本类全权管理）
    this.group = new THREE.Group();
    this.group.name = 'water-source-markers';
    this.group.visible = false;
    scene?.add(this.group);

    // 共享几何 / 材质：小球与圆环都复用，只有圆环用 scale 表示半径
    this.sphereGeometry = new THREE.SphereGeometry(SPHERE_RADIUS, 18, 12);
    this.ringGeometry = new THREE.RingGeometry(0.994, 1, 96);
    this.ringGeometry.rotateX(-Math.PI / 2);

    this.sphereMaterial = new THREE.MeshBasicMaterial({
      color: COLOR_SOURCE,
      transparent: true,
      opacity: 0.92,
      depthTest: false,
      depthWrite: false,
    });
    this.sphereMaterialSelected = new THREE.MeshBasicMaterial({
      color: COLOR_SELECTED_CORE,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
    });
    this.ringMaterial = new THREE.MeshBasicMaterial({
      color: COLOR_SOURCE,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.ringMaterialSelected = new THREE.MeshBasicMaterial({
      color: COLOR_SELECTED,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.raycaster = new THREE.Raycaster();
    /** @type {Map<string, { id: string, source: object, index: number, sphere: THREE.Mesh, ring: THREE.Mesh, label: CSS2DObject }>} */
    this.nodes = new Map();

    this._bind();
  }

  /** 是否处于放置模式（UI / main 用它切右面板与 Esc 行为） */
  get active() {
    return this.placement;
  }

  /** 只在「水体编辑」模式下显示场景标记 */
  setVisible(on) {
    this.visible = Boolean(on);
    if (!this.visible) {
      this.dom.style.cursor = '';
      if (this.placement) this.cancel();
    }
    this._applyVisibility();
  }

  /** 游览模式（无 UI）下隐藏标记；退出游览后按模式恢复 */
  setTourHidden(on) {
    this.tourHidden = Boolean(on);
    this._applyVisibility();
  }

  _applyVisibility() {
    this.group.visible = this.visible && !this.tourHidden;
    if (!this.group.visible && this.dom) this.dom.style.cursor = '';
  }

  // ── 放置模式 ──────────────────────────────────────────────────────────────
  startPlacement() {
    if (this.placement) return;
    this.placement = true;
    this._down = null;
    this._drag = null;
    this.editor?.setPickingEnabled?.(false); // 放置时点击不再选模型
    document.body?.classList.add('water-placing');
    this.onStatus?.('在地形上点选放置水源（可连续放置）· Esc 结束');
    this.onDraftChange?.(this);
  }

  cancel() {
    if (!this.placement) return;
    this.placement = false;
    this._down = null;
    this.editor?.setPickingEnabled?.(true);
    document.body?.classList.remove('water-placing');
    this.dom.style.cursor = '';
    this.onStatus?.(null);
    this.onDraftChange?.(this);
  }

  // ── 场景标记 ──────────────────────────────────────────────────────────────
  /** 按 `water.state.sources` 重建/同步标记；选中高亮跟着 `water.selectedId` */
  syncNodes() {
    const sources = this.water?.state?.sources ?? [];
    const selectedId = this.water?.selectedId ?? null;

    const alive = new Set(sources.map((source) => source.id));
    for (const node of [...this.nodes.values()]) {
      if (!alive.has(node.id)) this._disposeNode(node);
    }

    sources.forEach((source, index) => {
      let node = this.nodes.get(source.id);
      if (!node) {
        node = this._createNode(source);
        this.nodes.set(source.id, node);
      }
      node.source = source;
      node.index = index;
      this._positionNode(node);
      this._styleNode(node, source.id === selectedId);
    });

    this._applyVisibility();
  }

  _createNode(source) {
    const sphere = new THREE.Mesh(this.sphereGeometry, this.sphereMaterial);
    sphere.renderOrder = 40;
    sphere.userData = { sourceId: source.id };

    const ring = new THREE.Mesh(this.ringGeometry, this.ringMaterial);
    ring.renderOrder = 30;

    const element = document.createElement('div');
    element.className = 'water-source-label';
    const label = new CSS2DObject(element);
    label.position.set(0, LABEL_LIFT, 0);
    sphere.add(label);

    this.group.add(sphere);
    this.group.add(ring);
    return { id: source.id, source, index: 0, sphere, ring, label, element };
  }

  _disposeNode(node) {
    this.group.remove(node.sphere);
    this.group.remove(node.ring);
    node.element?.remove?.();
    this.nodes.delete(node.id);
  }

  _styleNode(node, selected) {
    node.sphere.material = selected ? this.sphereMaterialSelected : this.sphereMaterial;
    node.ring.material = selected ? this.ringMaterialSelected : this.ringMaterial;
    node.element?.classList.toggle('active', Boolean(selected));
  }

  /** 世界坐标换算：地表绝对高程（米）→ 世界 y，再加标记高度偏移 */
  _groundWorldY(x, z, lift = 0) {
    const meters = this.water?.groundMetersAt?.(x, z);
    if (!Number.isFinite(meters)) {
      const fallback = this.editor?.groundY?.(x, z);
      return Number.isFinite(fallback) ? fallback + lift : lift;
    }
    const heightField = this.editor?.heightField;
    const minMeters = heightField?.elevation?.minMeters ?? 0;
    const exaggeration = this.editor?.env?.uExaggeration?.value ?? 1;
    return (meters - minMeters) * exaggeration + lift;
  }

  _positionNode(node) {
    const source = node.source;
    const groundY = this._groundWorldY(source.x, source.z);
    const radius = Math.max(1, Number(source.radius) || 250);
    node.sphere.position.set(source.x, groundY + SPHERE_LIFT, source.z);
    node.ring.position.set(source.x, groundY + RING_LIFT, source.z);
    node.ring.scale.set(radius, 1, radius);
    if (node.element) {
      node.element.textContent = `${node.index + 1} · ${source.name || '水源'}`;
    }
  }

  // ── 交互 ──────────────────────────────────────────────────────────────────
  _bind() {
    this._handlePointerDown = this._handlePointerDown.bind(this);
    this._handlePointerMove = this._handlePointerMove.bind(this);
    this._handlePointerUp = this._handlePointerUp.bind(this);
    this._handleKeyDown = this._handleKeyDown.bind(this);

    this.dom.addEventListener('pointerdown', this._handlePointerDown);
    this.dom.addEventListener('pointermove', this._handlePointerMove);
    this.dom.addEventListener('pointerup', this._handlePointerUp);
    window.addEventListener('keydown', this._handleKeyDown);
  }

  _handlePointerDown(event) {
    if (event.button !== 0) return;

    // 放置模式：只记录按下点，松手时若没怎么拖动才落点
    if (this.placement) {
      this._down = { x: event.clientX, y: event.clientY };
      return;
    }

    if (!this.visible || this.tourHidden) return;
    const hit = this._pickSource(event.clientX, event.clientY);
    // 小球上的 userData 只有 sourceId（水源对象每次 sync 会换新引用），这里按 id 查当前水源
    const sourceId = hit?.object?.userData?.sourceId ?? null;
    const source = sourceId ? this.nodes.get(sourceId)?.source : null;
    if (!source) return;

    // 开始拖动某个水源：选中它、关掉相机、记下起点
    this.water?.selectSource?.(source.id);
    this._drag = {
      id: source.id,
      startX: event.clientX,
      startY: event.clientY,
      nextX: null,
      nextZ: null,
    };
    this.cameraControls?.setEnabled?.(false);
    this.editor?.setPickingEnabled?.(false);
    try {
      this.dom.setPointerCapture?.(event.pointerId);
    } catch {
      /* 某些浏览器不支持 pointer capture，忽略 */
    }
    this.onStatus?.('拖动水源修改位置（水平移动）· 松开提交');
    this.onDraftChange?.(this);
  }

  _handlePointerMove(event) {
    // 拖动中：实时把节点挪到地形上（数据在松开时才写回 water）
    if (this._drag) {
      const hit = this.cameraControls?.pick?.(event.clientX, event.clientY);
      if (!hit) return;
      const drag = this._drag;
      drag.nextX = hit.x;
      drag.nextZ = hit.z;
      const node = this.nodes.get(drag.id);
      if (node) {
        node.source = { ...node.source, x: hit.x, z: hit.z };
        this._positionNode(node);
      }
      return;
    }

    if (this.placement || !this.visible || this.tourHidden) {
      if (this.dom.style.cursor === 'grab') this.dom.style.cursor = '';
      return;
    }

    // 悬停在标记上时给出可拖动的手型光标
    const hit = this._pickSource(event.clientX, event.clientY);
    const id = hit?.object?.userData?.sourceId ?? null;
    if (id !== this._hoverId) {
      this._hoverId = id;
      this.dom.style.cursor = id ? 'grab' : '';
    }
  }

  _handlePointerUp(event) {
    if (event.button !== 0) return;

    // ① 拖动结束：提交位置
    if (this._drag) {
      const drag = this._drag;
      this._drag = null;
      this.cameraControls?.setEnabled?.(true);
      this.editor?.setPickingEnabled?.(true);
      try {
        this.dom.releasePointerCapture?.(event.pointerId);
      } catch {
        /* ignore */
      }
      this.onStatus?.(null);
      if (Number.isFinite(drag.nextX) && Number.isFinite(drag.nextZ)) {
        this.water?.updateSource?.(drag.id, { x: drag.nextX, z: drag.nextZ });
      } else {
        this.syncNodes();
      }
      this.onDraftChange?.(this);
      return;
    }

    // ② 放置模式：区分「点击放点」与「拖视角」
    if (!this.placement || !this._down) return;
    const dx = event.clientX - this._down.x;
    const dy = event.clientY - this._down.y;
    this._down = null;
    if (Math.hypot(dx, dy) > CLICK_SLOP) return; // 拖拽视角，不算点击

    const hit = this.cameraControls?.pick?.(event.clientX, event.clientY);
    if (!hit) {
      this.onStatus?.('没点在地形上：请在地形范围内点击');
      return;
    }
    const before = this.water?.state?.sources?.length ?? 0;
    const source = this.water?.addSource?.({ x: hit.x, z: hit.z });
    const after = this.water?.state?.sources?.length ?? 0;
    if (source) {
      this.onStatus?.(
        after > before
          ? `已放置水源「${source.name}」· 继续点击可连续放置，Esc 结束`
          : `水源数量已达上限（${after} 个）· Esc 结束`,
      );
    } else {
      this.onStatus?.('水源创建失败（可能已达水源数量上限）');
    }
    this.onDraftChange?.(this);
  }

  _handleKeyDown(event) {
    if (!this.placement || event.key !== 'Escape') return;
    const typing =
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement;
    if (typing) return;
    event.preventDefault();
    this.cancel();
  }

  /** 拾取场景里的水源小球（只用球体，不用圆环，避免沿地面误选） */
  _pickSource(clientX, clientY) {
    if (!this.nodes.size) return null;
    // 游览模式 / 非水体模式下标记是隐藏的：不能 raycast 到（否则会误拖隐藏的水源）
    if (!this.group.visible) return null;
    const rect = this.dom.getBoundingClientRect();
    this.raycaster.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -(((clientY - rect.top) / rect.height) * 2 - 1),
      ),
      this.camera,
    );
    const spheres = [...this.nodes.values()].map((node) => node.sphere);
    const hits = this.raycaster.intersectObjects(spheres, false);
    return hits[0] ?? null;
  }
}
