/**
 * 编辑器核心：模型实例管理、选择、复制、贴地、标签、工程读写。
 *
 * 层级约定：
 *   model.root (Group)   ── 用户编辑的变换（位置/旋转/缩放），进 scene
 *     └─ model.content   ── glb 场景克隆，部件路径 nodePath 相对它
 *          └─ …部件…
 *
 * 复制模型用 SkeletonUtils.clone（骨骼模型也能正确复制），几何/材质共享以省显存。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import {
  LABEL_KINDS,
  createLabel,
  normalizeProject,
  serializeProject,
  uid,
  loadStoredProject,
  saveStoredProject,
  clearStoredProject,
} from './project.js';
import { collectParts, pathToLabel, resolvePath } from './labels.js';
import { patchModelMaterials } from './modelMaterials.js';

const PLACE_DISTANCE = 700; // 新模型放在相机前方多远（米）

export class Editor extends EventTarget {
  constructor({ scene, camera, domElement, terrain, heightField, env, cameraControls, gizmo, tagLayer, library }) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.domElement = domElement;
    this.terrain = terrain;
    this.heightField = heightField;
    this.env = env;
    this.cameraControls = cameraControls;
    this.gizmo = gizmo;
    this.tagLayer = tagLayer;
    this.library = library;

    this.models = [];
    this.selectedId = null;
    this.selectedPartPath = null;
    this.showTags = true;
    this.texturesEnabled = true; // 全局贴图开关（物体侧；地形侧由 main 统一调度）
    this.pickingEnabled = true; // 绘制水面时临时关闭模型拾取
    this.waterSystem = null; // 由 main 注入，用于选中互斥与工程序列化
    this.missingAssets = [];
    this.raycaster = new THREE.Raycaster();
    this._saveTimer = 0;
    this._pointerDown = null;

    scene.add(gizmo.helper);
    gizmo.setMode('translate');
    this._bindPointer();

    gizmo.control.addEventListener('dragging-changed', (event) => {
      const dragging = Boolean(event.value);
      // 拖 gizmo / 改数值时不要让左键拖动带转视角：必须关掉 OrbitControls 本身
      this.cameraControls.setEnabled(!dragging);
      if (!dragging) this._afterTransformCommit();
    });
    gizmo.control.addEventListener('objectChange', () => this._onGizmoChange());
  }

  // ── 基础查询 ──────────────────────────────────────────────────────────────
  get selected() {
    return this.models.find((m) => m.id === this.selectedId) ?? null;
  }

  groundY(x, z) {
    const h = this.heightField.sampleWorld(x, z);
    return h * this.heightField.reliefMeters * this.env.uExaggeration.value;
  }

  modelOf(object) {
    let node = object;
    while (node) {
      const hit = this.models.find((m) => m.root === node);
      if (hit) return hit;
      node = node.parent;
    }
    return null;
  }

  /** 部件相对 content 的索引路径 */
  pathOfPart(model, object) {
    const path = [];
    let node = object;
    while (node && node !== model.content) {
      const parent = node.parent;
      if (!parent) return null;
      const index = parent.children.indexOf(node);
      if (index < 0) return null;
      path.unshift(index);
      node = parent;
    }
    return node === model.content ? path : null;
  }

  parts(model = this.selected) {
    return model ? collectParts(model.content) : [];
  }

  // ── 导入与放置 ────────────────────────────────────────────────────────────
  async parseGltf(buffer, name = '') {
    const loader = new GLTFLoader();
    const isText = /\.gltf$/i.test(name);
    const data = isText ? new TextDecoder().decode(buffer) : buffer;
    const gltf = await loader.parseAsync(data, '');
    if (!gltf?.scene) throw new Error('glb 里没有场景节点');
    return gltf;
  }

  /** 相机前方、带一点环形错开的落点，避免新模型叠在一起 */
  nextPlacement() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const base = this.camera.position.clone().addScaledVector(dir, PLACE_DISTANCE);
    const half = this.heightField.sizeMeters / 2;
    const angle = this.models.length * 0.9;
    const radius = 40 + (this.models.length % 5) * 35;
    const x = THREE.MathUtils.clamp(base.x + Math.cos(angle) * radius, -half * 0.92, half * 0.92);
    const z = THREE.MathUtils.clamp(base.z + Math.sin(angle) * radius, -half * 0.92, half * 0.92);
    return new THREE.Vector3(x, this.groundY(x, z), z);
  }

  /**
   * 从资源库的某个资源生成一个场景实例。
   * @param {{source:'dir'|'local', url?:string, id?:string, name:string}} asset
   */
  async addFromAsset(asset, { position = null, name = null } = {}) {
    const buffer = await this.library.readAsset(asset);
    const gltf = await this.parseGltf(buffer, asset.name);
    const content = gltf.scene;
    content.name = asset.name;
    patchModelMaterials(content); // 与地形一致的 sRGB 输出（否则在 FXAA target 里偏暗）

    const root = new THREE.Group();
    root.name = name ?? suggestName(asset.name, this.models);
    root.add(content);

    const model = {
      id: uid('model'),
      name: root.name,
      asset: { ...asset },
      root,
      content,
      labels: [],
      partTransforms: [],
      partNames: [],
      size: measure(content).size,
    };

    root.position.copy(position ?? this.nextPlacement());
    root.userData.modelId = model.id;
    this.scene.add(root);
    this.models.push(model);
    this.applyTextureFlip(model); // 新模型也遵循当前全局贴图开关

    this.snapToGround(model);
    this.select(model.id);
    this.emitChange();
    this.scheduleSave();
    return model;
  }

  /** 网页选文件 / 拖拽导入：先落盘资源文件夹，再实例化 */
  async importFiles(fileList) {
    const files = [...fileList].filter((f) => /\.(glb|gltf)$/i.test(f.name));
    const skipped = [...fileList].length - files.length;
    const results = [];
    for (const file of files) {
      try {
        const { asset, error } = await this.library.importFile(file);
        if (!asset) {
          results.push({ ok: false, name: file.name, error: error ?? '导入失败' });
          continue;
        }
        const model = await this.addFromAsset(asset);
        results.push({ ok: true, name: file.name, model });
      } catch (err) {
        console.warn('[editor] 导入失败', file.name, err);
        results.push({ ok: false, name: file.name, error: err?.message ?? String(err) });
      }
    }
    if (skipped > 0) results.push({ ok: false, name: `${skipped} 个文件`, error: '不是 .glb/.gltf，已跳过' });
    return results;
  }

  /** 把资源库里已有的模型加到场景（不经过文件选择） */
  async addFromLibrary(asset) {
    return this.addFromAsset(asset);
  }

  // ── 选择 ──────────────────────────────────────────────────────────────────
  select(modelId, partPath = null) {
    const model = this.models.find((m) => m.id === modelId) ?? null;
    this.selectedId = model ? model.id : null;
    this.selectedPartPath = partPath && partPath.length ? [...partPath] : null;
    this.waterSystem?.clearSelection(); // 模型与水体选中互斥
    this.attachGizmo();
    this.emitChange();
  }

  clearSelection() {
    this.selectedId = null;
    this.selectedPartPath = null;
    this.waterSystem?.clearSelection();
    this.gizmo.detach();
    this.emitChange();
  }

  /** 注入水面系统（选中互斥 + 工程序列化） */
  attachWater(system) {
    this.waterSystem = system;
  }

  /** 绘制水面 / 拖 gizmo 时临时关闭模型拾取 */
  setPickingEnabled(on) {
    this.pickingEnabled = Boolean(on);
  }

  /**
   * gizmo 挂到当前选择：选了部件就挂部件，否则挂模型根节点。
   * 选择来源只有两处 —— 部件栏点击，或点场景里的物体（只选整体）。
   */
  attachGizmo() {
    const model = this.selected;
    if (!model) {
      this.gizmo.detach();
      return;
    }
    const node = this.selectedPartPath ? resolvePath(model.content, this.selectedPartPath) : null;
    if (node) {
      if (!this.partTransform(model, this.selectedPartPath)) this.recordPartTransform(model, node, this.selectedPartPath);
      this.gizmo.attach(node);
      return;
    }
    this.gizmo.attach(model.root);
  }

  // ── 变换 ──────────────────────────────────────────────────────────────────
  _onGizmoChange() {
    if (this.selectedPartPath) {
      const model = this.selected;
      const object = this.gizmo.attached;
      if (model && object) this.recordPartTransform(model, object, this.selectedPartPath);
    }
    // 必须走 change(detail.kind='transform')：UI 收到后只刷新数值输入框（不重建 DOM）。
    // 早先直接派发 'transform' 事件，UI 根本没监听，所以拖动时数值不动。
    this.emitChange('transform');
  }

  _afterTransformCommit() {
    this.scheduleSave();
    this.emitChange();
  }

  /** 记录部件级变换，供工程序列化 */
  recordPartTransform(model, object, path) {
    const key = path.join('.');
    let entry = model.partTransforms.find((p) => p.path.join('.') === key);
    if (!entry) {
      entry = { path: [...path], object, transform: null };
      model.partTransforms.push(entry);
    }
    entry.object = object;
    entry.transform = {
      position: object.position.toArray(),
      rotation: object.rotation.toArray(),
      scale: object.scale.toArray(),
    };
    return entry;
  }

  partTransform(model, path) {
    const key = path.join('.');
    const entry = model.partTransforms.find((p) => p.path.join('.') === key);
    if (entry) entry.object = resolvePath(model.content, path) ?? entry.object;
    return entry ?? null;
  }

  resetPartTransform(model, path) {
    const node = resolvePath(model.content, path);
    if (!node) return;
    node.position.set(0, 0, 0);
    node.rotation.set(0, 0, 0);
    node.scale.set(1, 1, 1);
    model.partTransforms = model.partTransforms.filter((p) => p.path.join('.') !== path.join('.'));
    this.attachGizmo();
    this.emitChange();
    this.scheduleSave();
  }

  applyTransformInput(model, field, axis, value) {
    const key = field === 'rotation' ? 'rotation' : field;
    if (key === 'position') model.root.position.setComponent(axis, value);
    else if (key === 'rotation') {
      const euler = model.root.rotation;
      const arr = [euler.x, euler.y, euler.z];
      arr[axis] = (value * Math.PI) / 180;
      model.root.rotation.set(arr[0], arr[1], arr[2]);
    } else model.root.scale.setComponent(axis, Math.max(0.001, value));
    this.emitChange('transform');
    this.scheduleSave();
  }

  /** 把模型底座落到地表；返回位移量，供 UI 给出反馈 */
  snapToGround(model = this.selected) {
    if (!model) return null;
    model.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model.content);
    if (box.isEmpty()) return null;
    const ground = this.groundY(model.root.position.x, model.root.position.z);
    const delta = ground - box.min.y;
    model.root.position.y += delta;
    this.emitChange('transform');
    this.scheduleSave();
    return { ground, delta };
  }

  setVisible(model, visible) {
    model.root.visible = visible;
    this.emitChange();
    this.scheduleSave();
  }

  rename(model, name) {
    model.name = name || model.name;
    model.root.name = model.name;
    this.emitChange();
    this.scheduleSave();
  }

  /**
   * 重命名「当前选择」：整体改模型名，部件改节点名。
   * 部件名写进 partNames（按索引路径持久化），刷新/导入后仍保留。
   */
  renameCurrent(name) {
    const value = String(name ?? '').trim();
    const model = this.selected;
    if (!model || !value) return false;
    if (!this.selectedPartPath) {
      this.rename(model, value);
      return true;
    }
    const node = resolvePath(model.content, this.selectedPartPath);
    if (!node) return false;
    node.name = value;
    const key = this.selectedPartPath.join('.');
    const entry = model.partNames.find((p) => p.path.join('.') === key);
    if (entry) entry.name = value;
    else model.partNames.push({ path: [...this.selectedPartPath], name: value });
    this.emitChange();
    this.scheduleSave();
    return true;
  }

  /** 当前选择的名称（整体=模型名，部件=节点名） */
  currentName() {
    const model = this.selected;
    if (!model) return '';
    if (!this.selectedPartPath) return model.name;
    return resolvePath(model.content, this.selectedPartPath)?.name ?? '';
  }

  /** 当前选择范围下的标签：整体只看模型级，部件只看该部件 */
  labelsFor(model = this.selected, path = this.selectedPartPath) {
    if (!model) return [];
    const key = path ? path.join('.') : null;
    return model.labels.filter((l) => (l.nodePath ? l.nodePath.join('.') : null) === key);
  }

  duplicateSelected() {
    const src = this.selected;
    if (!src) return null;
    const root = new THREE.Group();
    root.name = `${src.name} 副本`;
    const content = cloneSkeleton(src.content);
    root.add(content);
    root.position.copy(src.root.position).add(new THREE.Vector3(60, 0, 60));
    root.rotation.copy(src.root.rotation);
    root.scale.copy(src.root.scale);

    const model = {
      id: uid('model'),
      name: root.name,
      asset: { ...src.asset },
      root,
      content,
      labels: src.labels.map((l) => ({ ...l, id: uid('label') })),
      partTransforms: [],
      partNames: src.partNames.map((p) => ({ path: [...p.path], name: p.name })),
      size: measure(content).size,
    };
    root.userData.modelId = model.id;
    this.scene.add(root);
    this.models.push(model);

    // 部件的局部变换也要复制过去
    for (const entry of src.partTransforms) {
      const node = resolvePath(content, entry.path);
      if (!node) continue;
      const t = entry.transform;
      if (t?.position) node.position.fromArray(t.position);
      if (t?.rotation) node.rotation.fromArray(t.rotation);
      if (t?.scale) node.scale.fromArray(t.scale);
      this.recordPartTransform(model, node, entry.path);
    }

    this.snapToGround(model);
    this.tagLayer.sync(model); // 副本的标签也要立刻出现在场景里
    this.select(model.id);
    this.emitChange();
    this.scheduleSave();
    return model;
  }

  removeSelected() {
    return this.removeModel(this.selectedId);
  }

  removeModel(modelId) {
    const index = this.models.findIndex((m) => m.id === modelId);
    if (index < 0) return false;
    const [model] = this.models.splice(index, 1);
    this.tagLayer.removeModel(model.id);
    this.scene.remove(model.root);
    if (this.selectedId === modelId) {
      this.selectedId = this.models[Math.min(index, this.models.length - 1)]?.id ?? null;
      this.selectedPartPath = null;
      this.attachGizmo();
    }
    this.emitChange();
    this.scheduleSave();
    return true;
  }

  // ── 标签 ──────────────────────────────────────────────────────────────────
  /**
   * 新增标签：只需要名称。
   * 类型留空（未分类），用户在标签卡上再选「动态结构 / 静态标注」。
   * 名称留空时回退成当前部件名（没选部件就是模型名）。
   */
  addLabel({ kind = 'static', title = '', nodePath = null } = {}) {
    const model = this.selected;
    if (!model) return null;
    // 默认挂在当前选中的部件上；没选部件就是整个模型
    const path = nodePath ?? this.selectedPartPath;
    const fallback =
      (path ? pathToLabel(model.content, path).split(' / ').pop() : '') || model.name || '标签';
    const taken = new Set(model.labels.map((l) => l.title));
    let name = String(title).trim() || fallback;
    let i = 2;
    while (taken.has(name)) name = `${fallback} ${i++}`;

    const label = createLabel({ kind, title: name, nodePath: path });
    model.labels.push(label);
    this.tagLayer.sync(model);
    this.emitChange();
    this.scheduleSave();
    return label;
  }

  /** 标签只有「名称」与「类型」可改；其它字段一律忽略 */
  updateLabel(labelId, patch) {
    const model = this.selected;
    if (!model) return;
    const label = model.labels.find((l) => l.id === labelId);
    if (!label) return;
    const kindChanged = patch.kind != null && patch.kind !== label.kind && LABEL_KINDS[patch.kind];
    if (patch.title != null) label.title = String(patch.title);
    if (kindChanged) label.kind = patch.kind;
    this.tagLayer.sync(model);
    // 类型切换会改变卡片上的高亮，整块重建一次
    this.emitChange(kindChanged ? 'all' : 'labels');
    this.scheduleSave();
  }

  removeLabel(labelId) {
    const model = this.selected;
    if (!model) return;
    model.labels = model.labels.filter((l) => l.id !== labelId);
    this.tagLayer.sync(model);
    this.emitChange();
    this.scheduleSave();
  }

  labelPathText(model, label) {
    return pathToLabel(model.content, label.nodePath);
  }

  setShowTags(visible) {
    this.showTags = visible;
    this.tagLayer.setVisible(visible);
    this.emitChange();
  }

  /**
   * 全局贴图开关（物体侧）：关掉时把材质上的贴图摘掉，回退成纯色 PBR；
   * 打开时把原贴图放回去。glb 自带的 map 都会受这一处控制。
   */
  setTexturesEnabled(enabled) {
    this.texturesEnabled = Boolean(enabled);
    for (const model of this.models) this.applyTextureFlip(model);
    this.emitChange();
  }

  /** 把当前开关状态应用到某个模型的全部材质（幂等） */
  applyTextureFlip(model) {
    const enabled = this.texturesEnabled;
    model.content.traverse((object) => {
      if (!object.isMesh && !object.isSkinnedMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        material.userData = material.userData ?? {};
        if (enabled) {
          if (!material.map && material.userData.__origMap) {
            material.map = material.userData.__origMap;
            material.needsUpdate = true;
          }
        } else if (material.map) {
          material.userData.__origMap = material.map;
          material.map = null;
          material.needsUpdate = true;
        }
      }
    });
  }

  // ── 工程序列化 / 恢复 ─────────────────────────────────────────────────────
  serialize() {
    return serializeProject(this.models, this.waterSystem?.toJSON() ?? null);
  }

  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    const ok = saveStoredProject(this.serialize());
    this.dispatchEvent(new CustomEvent('saved', { detail: { ok, at: Date.now() } }));
  }

  async restore() {
    const stored = loadStoredProject();
    if (!stored || !stored.models.length) return { restored: 0, missing: [] };
    return this.applyProject(stored);
  }

  /** 用工程数据重建场景（先清空当前实例） */
  async applyProject(raw, { clear = true } = {}) {
    const project = normalizeProject(raw);
    if (clear) this.clearAll({ keepStorage: true });
    const missing = [];
    let restored = 0;

    for (const entry of project.models) {
      try {
        const buffer = await this.library.readAsset(entry.asset);
        const gltf = await this.parseGltf(buffer, entry.asset.name);
        const root = new THREE.Group();
        root.name = entry.name;
        const content = gltf.scene;
        content.name = entry.asset.name;
        patchModelMaterials(content);
        root.add(content);

        // 局部变换（部件级）先应用，再套模型变换
        const model = {
          id: entry.id,
          name: entry.name,
          asset: { ...entry.asset },
          root,
          content,
          labels: entry.labels.map((l) => ({ ...l })),
          partTransforms: [],
          partNames: [],
          size: measure(content).size,
        };
        for (const pn of entry.partNames ?? []) {
          const node = resolvePath(content, pn.path);
          if (!node) continue;
          node.name = pn.name;
          model.partNames.push({ path: [...pn.path], name: pn.name });
        }
        for (const p of entry.partTransforms) {
          const node = resolvePath(content, p.path);
          if (!node) continue;
          node.position.fromArray(p.transform.position);
          node.rotation.set(
            (p.transform.rotation[0] * Math.PI) / 180,
            (p.transform.rotation[1] * Math.PI) / 180,
            (p.transform.rotation[2] * Math.PI) / 180,
          );
          node.scale.fromArray(p.transform.scale);
          model.partTransforms.push({ path: [...p.path], object: node, transform: null });
        }

        root.position.fromArray(entry.transform.position);
        root.rotation.set(
          (entry.transform.rotation[0] * Math.PI) / 180,
          (entry.transform.rotation[1] * Math.PI) / 180,
          (entry.transform.rotation[2] * Math.PI) / 180,
        );
        root.scale.fromArray(entry.transform.scale);
        root.visible = entry.visible;

        root.userData.modelId = model.id;
        this.scene.add(root);
        this.models.push(model);
        this.applyTextureFlip(model);
        this.tagLayer.sync(model);
        restored += 1;
      } catch (err) {
        console.warn('[editor] 恢复模型失败', entry.name, err);
        missing.push({ name: entry.name, asset: entry.asset, error: err?.message ?? String(err) });
      }
    }

    this.missingAssets = missing;
    this.waterSystem?.load(project.water); // 水面区域 / 流动水一并恢复
    this.attachGizmo();
    this.emitChange();
    this.scheduleSave(); // 导入工程后立即落盘，避免刷新丢失
    return { restored, missing };
  }

  clearAll({ keepStorage = false } = {}) {
    for (const model of this.models) {
      this.tagLayer.removeModel(model.id);
      this.scene.remove(model.root);
    }
    this.models = [];
    this.selectedId = null;
    this.selectedPartPath = null;
    this.gizmo.detach();
    if (!keepStorage) clearStoredProject();
    this.emitChange();
  }

  async resetAll() {
    this.clearAll();
    this.tagLayer.clear();
    this.waterSystem?.load(null);
    clearStoredProject();
    this.emitChange();
  }

  exportProject({ embedAssets = false } = {}) {
    const project = this.serialize();
    if (!embedAssets) return project;
    // 内嵌模式：把 glb 以 base64 放进工程，便于单文件迁移
    const assets = {};
    return (async () => {
      for (const model of this.models) {
        const key = model.asset.source === 'local' ? model.asset.id : model.asset.url;
        if (assets[key]) continue;
        const buffer = await this.library.readAsset(model.asset);
        assets[key] = { name: model.asset.name, base64: bufferToBase64(buffer) };
      }
      return { ...project, embeddedAssets: assets };
    })();
  }

  async importProjectJson(json) {
    const data = json && typeof json === 'object' ? json : null;
    if (!data) throw new Error('工程文件不是合法 JSON 对象');
    // 内嵌资源先写回资源文件夹或 IndexedDB
    if (data.embeddedAssets && typeof data.embeddedAssets === 'object') {
      for (const [key, entry] of Object.entries(data.embeddedAssets)) {
        if (!entry?.base64) continue;
        const buffer = base64ToBuffer(entry.base64);
        const file = new File([buffer], entry.name ?? 'model.glb', { type: 'model/gltf-binary' });
        const result = await this.library.importFile(file);
        if (result.asset) {
          for (const m of data.models ?? []) {
            if (!m.asset) continue;
            const mKey = m.asset.source === 'local' ? m.asset.id : m.asset.url;
            if (mKey === key) m.asset = { ...result.asset };
          }
        }
      }
    }
    return this.applyProject(data);
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────
  emitChange(kind = 'all') {
    this.dispatchEvent(new CustomEvent('change', { detail: { kind } }));
  }

  _bindPointer() {
    const el = this.domElement;
    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this._pointerDown = { x: event.clientX, y: event.clientY };
    });
    el.addEventListener('pointerup', (event) => {
      if (event.button !== 0 || !this._pointerDown) return;
      const dx = event.clientX - this._pointerDown.x;
      const dy = event.clientY - this._pointerDown.y;
      this._pointerDown = null;
      if (Math.hypot(dx, dy) > 6) return; // 拖拽视角，不算点击
      if (this.gizmo.dragging) return;
      if (!this.pickingEnabled) return; // 正在绘制水面：点击归绘制逻辑

      // 水体与模型一起参与拾取，取离相机更近的那个
      const waterHit = this.pickWater(event.clientX, event.clientY);
      const modelHit = this.pick(event.clientX, event.clientY);
      const waterDist = waterHit?.point ? this.camera.position.distanceTo(waterHit.point) : Infinity;
      const modelDist = modelHit?.point ? this.camera.position.distanceTo(modelHit.point) : Infinity;

      if (waterHit && waterDist <= modelDist) {
        this.clearSelection();
        this.waterSystem.select({ kind: waterHit.kind, id: waterHit.id });
        return;
      }
      if (modelHit?.model) this.select(modelHit.model.id); // 场景点击只选整体，不选部件
      else this.clearSelection();
    });
  }

  /** 拾取水体（区域 / 流动水）；与模型拾取一起比较距离决定选中谁 */
  pickWater(clientX, clientY) {
    if (!this.waterSystem) return null;
    const rect = this.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.waterSystem.raycast(this.raycaster);
  }

  pick(clientX, clientY) {
    const rect = this.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const roots = this.models.filter((m) => m.root.visible).map((m) => m.root);
    if (!roots.length) return null;
    const hits = this.raycaster.intersectObjects(roots, true);
    if (!hits.length) return null;
    const hit = hits[0];
    const model = this.modelOf(hit.object);
    const partPath = model ? this.pathOfPart(model, hit.object) : null;
    return { model, object: hit.object, partPath, point: hit.point };
  }
}

function measure(object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return { box, size, center };
}

function suggestName(filename, models) {
  const base = filename.replace(/\.(glb|gltf)$/i, '') || '模型';
  const used = new Set(models.map((m) => m.name));
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
