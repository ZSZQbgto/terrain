/**
 * 水面系统：圈定的静止水面区域 + 流动水路径。
 *
 * 不再有"覆盖全图的统一水面"：
 *   areas  多边形区域，各自一个水平面高度（来自选点平均，可再编辑）
 *   flows  沿 Catmull-Rom 曲线生成的水带，纹理沿路径滚动，speed 控制流速
 *
 * 单位约定：对外一律用「绝对高程米」，内部换算成世界 y：
 *   worldY = (meters - elevation.minMeters) × 垂直夸张
 */
import * as THREE from 'three';
import { makeWaterMaterial } from '../terrain/waterShaders.js';
import { createWaterNormalTexture } from '../terrain/waterTextures.js';
import { normalizeWater, uid } from './project.js';

export class WaterSystem {
  constructor({ scene, heightField, env, getSurfaceTargets, maxAnisotropy = 8 }) {
    this.hf = heightField;
    this.env = env;
    // 波纹法线贴图（静止水与流动水共享）：mipmap + 各向异性 → 近处细节细碎、远处不糊不闪
    this.waterNormals = createWaterNormalTexture(256, maxAnisotropy);
    // 水带"贴到物体表面"用：返回模型 content 列表（glb 是真实几何，可 raycast）
    this.getSurfaceTargets = getSurfaceTargets ?? (() => []);
    this.raycaster = new THREE.Raycaster();
    this._DOWN = new THREE.Vector3(0, -1, 0);
    this._UP = new THREE.Vector3(0, 1, 0);
    this.group = new THREE.Group();
    this.group.name = 'water';
    scene.add(this.group);

    this.state = normalizeWater(null); // { enabled, level, areas[], flows[] }
    this.selected = null; // { kind: 'area'|'flow', id }
    this.meshes = new Map(); // `${kind}:${id}` -> mesh
    this.materials = new Set(); // 需要按帧更新 uTime 的材质
    this.onChange = null;

    // 撤回：每次数据变更前把旧状态压栈（500ms 内的连续变更合并，避免滑块拖爆栈）
    this.undoStack = [];
    this._lastStateJson = JSON.stringify(this.state);
    this._lastUndoPush = 0;

    this.areaMaterial = this._makeAreaMaterial();
    this.highlight = this._makeHighlight();
    this.group.visible = this.state.enabled;
  }

  // ── 单位换算 ──────────────────────────────────────────────────────────────
  metersToWorldY(meters) {
    return (meters - this.hf.elevation.minMeters) * this.env.uExaggeration.value;
  }

  worldYToMeters(y) {
    return this.hf.elevation.minMeters + y / this.env.uExaggeration.value;
  }

  /** 地表绝对高程（米） */
  groundMetersAt(x, z) {
    return this.hf.elevation.minMeters + this.hf.sampleWorld(x, z) * this.hf.reliefMeters;
  }

  // ── 开关 / 默认高度 ───────────────────────────────────────────────────────
  setEnabled(on) {
    this.state.enabled = Boolean(on);
    this.group.visible = this.state.enabled;
    this._emit();
  }

  /** 新建区域时的默认水面高度（米） */
  setDefaultLevel(meters) {
    if (!Number.isFinite(meters)) return;
    this.state.level = Number(meters);
    this._emit();
  }

  // ── 区域 ──────────────────────────────────────────────────────────────────
  addArea({ name, points, level } = {}) {
    if (!Array.isArray(points) || points.length < 3) return null;
    const area = {
      id: uid('area'),
      name: name || `水面区域 ${this.state.areas.length + 1}`,
      level: Number.isFinite(level) ? level : this.state.level,
      points: points.map(([x, z]) => [x, z]),
      labels: [],
    };
    this.state.areas.push(area);
    this._rebuildArea(area);
    this._emit();
    return area;
  }

  updateArea(id, patch) {
    const area = this.state.areas.find((a) => a.id === id);
    if (!area) return;
    Object.assign(area, patch);
    this._rebuildArea(area);
    this._emit();
  }

  removeArea(id) {
    this.state.areas = this.state.areas.filter((a) => a.id !== id);
    this._disposeMesh('area', id);
    if (this.selected?.kind === 'area' && this.selected.id === id) this.select(null);
    this._emit();
  }

  // ── 流动水 ────────────────────────────────────────────────────────────────
  addFlow({ name, points, speed = 1, width = 8 } = {}) {
    if (!Array.isArray(points) || points.length < 2) return null;
    const flow = {
      id: uid('flow'),
      name: name || `流动水 ${this.state.flows.length + 1}`,
      speed: Math.max(0.05, Number(speed) || 1),
      width: Math.max(1, Number(width) || 8),
      // 保留每点的 width / dir（对象点）；旧的数组点补成对象点
      points: points.map((p) =>
        Array.isArray(p)
          ? { x: p[0], y: p[1], z: p[2], width: null, dir: null }
          : { x: p.x, y: p.y, z: p.z, width: p.width ?? null, dir: p.dir ?? null },
      ),
      labels: [],
    };
    this.state.flows.push(flow);
    this._rebuildFlow(flow);
    this._emit();
    return flow;
  }

  /** 拖动静止水面的节点：只改水平位置，水面高度（level）保持不变 */
  moveAreaPoint(id, index, x, z, commit = true) {
    const area = this.state.areas.find((a) => a.id === id);
    if (!area || !area.points[index]) return;
    area.points[index] = [x, z];
    this._rebuildArea(area);
    if (commit) this._emit();
  }

  /** 拖动流动水的节点：x/y/z 都可改（该点自己的宽度与横向朝向保留） */
  moveFlowPoint(id, index, x, y, z, commit = true) {
    const flow = this.state.flows.find((f) => f.id === id);
    if (!flow || !flow.points[index]) return;
    flow.points[index] = { ...flow.points[index], x, y, z };
    this._rebuildFlow(flow);
    if (commit) this._emit();
  }

  /** 拖动结束：提交一次变更（进撤回栈 + 触发自动保存） */
  commitChange() {
    this._emit();
  }

  updateFlow(id, patch) {
    const flow = this.state.flows.find((f) => f.id === id);
    if (!flow) return;
    Object.assign(flow, patch);
    this._rebuildFlow(flow);
    this._emit();
  }

  removeFlow(id) {
    this.state.flows = this.state.flows.filter((f) => f.id !== id);
    this._disposeMesh('flow', id);
    if (this.selected?.kind === 'flow' && this.selected.id === id) this.select(null);
    this._emit();
  }

  // ── 选中 ──────────────────────────────────────────────────────────────────
  select(sel) {
    this.selected = sel && sel.id ? { kind: sel.kind, id: sel.id } : null;
    this._updateHighlight();
    this._emit();
  }

  clearSelection() {
    if (!this.selected) return;
    this.select(null);
  }

  get selectedItem() {
    if (!this.selected) return null;
    const list = this.selected.kind === 'area' ? this.state.areas : this.state.flows;
    return list.find((x) => x.id === this.selected.id) ?? null;
  }

  /** 用射线在水体网格上拾取（区域 / 流动水） */
  /**
   * 表面投射：水带要"贴在物体表面上"。
   *  - 先打模型几何（glb 是真实几何，raycast 能拿到真实表面与面法线）
   *  - 没有模型命中时用地形 CPU 高度采样兜底（地形几何是平的，raycast 打不出真实表面）
   */
  surfaceAt(point) {
    const targets = this.getSurfaceTargets() ?? [];
    if (targets.length) {
      const origin = point.clone().setY(point.y + 3000);
      this.raycaster.set(origin, this._DOWN);
      this.raycaster.far = 6000;
      const hits = this.raycaster.intersectObjects(targets, true);
      for (const hit of hits) {
        if (Math.abs(hit.point.y - point.y) > 80) continue; // 只接受目标点附近的表面
        const normal = hit.face
          ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
          : this._UP.clone();
        return { point: hit.point.clone(), normal };
      }
    }
    const groundY = this.metersToWorldY(this.groundMetersAt(point.x, point.z));
    if (!Number.isFinite(groundY)) return null;
    return {
      point: new THREE.Vector3(point.x, groundY, point.z),
      normal: this._groundNormal(point.x, point.z),
    };
  }

  /** 地形法线：用高程梯度近似（地形几何是平面 + shader 位移，没有可用面法线） */
  _groundNormal(x, z) {
    const d = 20;
    const h = (px, pz) => this.metersToWorldY(this.groundMetersAt(px, pz));
    const nx = h(x - d, z) - h(x + d, z);
    const nz = h(x, z - d) - h(x, z + d);
    return new THREE.Vector3(nx, 2 * d, nz).normalize();
  }

  raycast(raycaster) {
    const targets = [...this.meshes.values()].filter((m) => m.visible);
    if (!targets.length) return null;
    const hits = raycaster.intersectObjects(targets, false);
    if (!hits.length) return null;
    const data = hits[0].object.userData;
    return data?.waterKind ? { kind: data.waterKind, id: data.waterId, point: hits[0].point } : null;
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────
  /** 静止水面：与流动水同一套材质，只是 uFlow = 0（波纹随时间缓慢起伏） */
  _makeAreaMaterial() {
    return makeWaterMaterial(this.env, {
      flow: false,
      opacity: 0.88,
      speed: 0.22,
      normalMap: this.waterNormals,
      normalScale: 0.95,
    });
  }

  /** 供水体绘制预览复用：生成一个带流动动画的水带材质 */
  createFlowMaterial() {
    return this._makeFlowMaterial();
  }

  /** 流动水：同一套材质，uFlow = 1（纹理沿路径滚动 + 横向收边） */
  _makeFlowMaterial() {
    const material = makeWaterMaterial(this.env, {
      flow: true,
      opacity: 0.9,
      speed: 1,
      normalMap: this.waterNormals,
      normalScale: 1.1,
    });
    this.materials.add(material);
    return material;
  }

  _disposeMesh(kind, id) {
    const key = `${kind}:${id}`;
    const mesh = this.meshes.get(key);
    if (!mesh) return;
    mesh.parent?.remove(mesh);
    mesh.geometry?.dispose();
    if (kind === 'flow') {
      this.materials.delete(mesh.material);
      mesh.material?.dispose();
    }
    this.meshes.delete(key);
  }

  _rebuildArea(area) {
    this._disposeMesh('area', area.id);
    const shape = new THREE.Shape();
    area.points.forEach(([x, z], i) => {
      // ShapeGeometry 在 XY 平面，rotateX(-90°) 后 (x, y) → (x, 0, -y)，所以用 -z
      if (i === 0) shape.moveTo(x, -z);
      else shape.lineTo(x, -z);
    });
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, this.areaMaterial);
    mesh.position.y = this.metersToWorldY(area.level);
    mesh.renderOrder = 10;
    mesh.userData = { waterKind: 'area', waterId: area.id };
    this.meshes.set(`area:${area.id}`, mesh);
    this.group.add(mesh);
    this._updateHighlight();
  }

  _rebuildFlow(flow) {
    this._disposeMesh('flow', flow.id);
    // 传表面投射回调：水带按模型/地形表面生成，而不是浮在一个水平面上
    const geometry = buildFlowGeometry(flow, 14, (p) => this.surfaceAt(p));
    const material = this._makeFlowMaterial();
    material.uniforms.uSpeed.value = flow.speed;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 11;
    mesh.userData = { waterKind: 'flow', waterId: flow.id };
    this.meshes.set(`flow:${flow.id}`, mesh);
    this.group.add(mesh);
    this._updateHighlight();
  }

  _makeHighlight() {
    const material = new THREE.LineBasicMaterial({ color: 0x7fe6d4, transparent: true, opacity: 0.95 });
    const line = new THREE.Line(new THREE.BufferGeometry(), material);
    line.visible = false;
    line.renderOrder = 12;
    this.group.add(line);
    return line;
  }

  _updateHighlight() {
    const item = this.selectedItem;
    if (!item) {
      this.highlight.visible = false;
      return;
    }
    this.highlight.visible = this.state.enabled;
    if (this.selected.kind === 'area') {
      const points = item.points.map(([x, z]) => new THREE.Vector3(x, this.metersToWorldY(item.level) + 0.4, z));
      if (points.length) points.push(points[0].clone());
      this.highlight.geometry.dispose();
      this.highlight.geometry = new THREE.BufferGeometry().setFromPoints(points);
    } else if (item.points.length >= 2) {
      const curve = flowCurve(item);
      const pts = curve.getPoints(Math.max(24, item.points.length * 12));
      this.highlight.geometry.dispose();
      this.highlight.geometry = new THREE.BufferGeometry().setFromPoints(pts.map((p) => p.clone().setY(p.y + 0.5)));
    } else {
      this.highlight.visible = false;
    }
  }

  rebuildAll() {
    for (const key of [...this.meshes.keys()]) {
      const [kind, id] = key.split(':');
      this._disposeMesh(kind, id);
    }
    for (const area of this.state.areas) this._rebuildArea(area);
    for (const flow of this.state.flows) this._rebuildFlow(flow);
    this.group.visible = this.state.enabled;
    this._updateHighlight();
  }

  /** 每帧：驱动流动水动画 */
  update(time) {
    this.areaMaterial.uniforms.uTime.value = time;
    for (const material of this.materials) material.uniforms.uTime.value = time;
  }

  // ── 水体标签（只有名称；不在场景里显示）──────────────────────────────────
  _item(kind, id) {
    const list = kind === 'area' ? this.state.areas : this.state.flows;
    return list.find((x) => x.id === id) ?? null;
  }

  addWaterLabel(kind, id, title) {
    const item = this._item(kind, id);
    if (!item) return null;
    const label = { id: uid('wlabel'), title: (title && String(title).trim()) || '未命名水体标签' };
    item.labels.push(label);
    this._emit();
    return label;
  }

  updateWaterLabel(kind, id, labelId, patch) {
    const item = this._item(kind, id);
    const label = item?.labels.find((l) => l.id === labelId);
    if (!label) return;
    if (patch.title != null) label.title = String(patch.title);
    this._emit();
  }

  removeWaterLabel(kind, id, labelId) {
    const item = this._item(kind, id);
    if (!item) return;
    item.labels = item.labels.filter((l) => l.id !== labelId);
    this._emit();
  }

  // ── 序列化 ────────────────────────────────────────────────────────────────
  toJSON() {
    return JSON.parse(JSON.stringify(this.state));
  }

  load(raw) {
    this.state = normalizeWater(raw);
    this.selected = null;
    this.undoStack = [];
    this._lastStateJson = JSON.stringify(this.state);
    this.rebuildAll();
    this._emit();
  }

  /** 撤回上一步数据修改；返回是否有内容可撤回 */
  get canUndo() {
    return this.undoStack.length > 0;
  }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.state = normalizeWater(JSON.parse(previous));
    this._lastStateJson = JSON.stringify(this.state);
    this.selected = null;
    this.rebuildAll();
    this.onChange?.(this); // 直接通知，避免把撤回后的状态又压栈
    return true;
  }

  _emit() {
    // 数据变了就把「变更前」的状态压栈（用于撤回）；纯选中变化不入栈
    const json = JSON.stringify(this.state);
    if (json !== this._lastStateJson) {
      const now = performance.now();
      if (now - this._lastUndoPush > 500) {
        this.undoStack.push(this._lastStateJson);
        if (this.undoStack.length > 60) this.undoStack.shift();
        this._lastUndoPush = now;
      }
      this._lastStateJson = json;
    }
    this.onChange?.(this);
  }
}

/** 流动水路径 → Catmull-Rom 3D 曲线（点支持 [x,y,z] 与 { x, y, z } 两种格式） */
export function flowCurve(flow) {
  const points = flow.points.map((p) =>
    Array.isArray(p) ? new THREE.Vector3(p[0], p[1], p[2]) : new THREE.Vector3(p.x, p.y, p.z),
  );
  return new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.5);
}

/**
 * 沿曲线生成水带网格：u 横向 0..1，v 沿程（按 20 m 一个周期）。
 *
 * 与早期版本的两点差别：
 *   1. 每个采样点通过 `surface(point)` 投射到**模型 / 地形表面** —— 水带贴着物体表面走，
 *      横向方向用「切线 × 表面法线」，所以在坡面、坝顶、渠壁上都能正确展开，
 *      水贴图正好覆盖在物体贴图之上；
 *   2. 每个关键点可带自己的 `width` 与 `dir`（横向朝向，单位度），沿曲线在关键点之间
 *      线性插值；`dir` 为 null 表示自动方向（切线 × 表面法线）。
 */
export function buildFlowGeometry(flow, segmentsPerPoint = 14, surface = null) {
  const curve = flowCurve(flow);
  const length = Math.max(1, curve.getLength());
  const segments = Math.max(12, flow.points.length * segmentsPerPoint);
  const repeat = Math.max(1, length / 20);
  const baseWidth = Math.max(0.5, flow.width ?? 8);
  const pts = flow.points;
  const keyCount = Math.max(1, pts.length);

  const positions = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3();
  const p = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const surfacePoint = new THREE.Vector3();

  const widthAt = (i) => {
    const w = pts[i]?.width;
    return Number.isFinite(w) ? Math.max(0.5, w) : baseWidth;
  };
  const dirAt = (i) => {
    const d = pts[i]?.dir;
    return Number.isFinite(d) ? d : null;
  };

  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    curve.getPoint(u, p);
    curve.getTangent(u, tangent).normalize();

    // 关键点插值：u 与关键点索引线性对应（Catmull-Rom 的控制点正好落在 k/(n-1)）
    const keyPos = keyCount > 1 ? u * (keyCount - 1) : 0;
    const i0 = Math.min(keyCount - 1, Math.floor(keyPos));
    const i1 = Math.min(keyCount - 1, i0 + 1);
    const f = keyPos - i0;
    const width = widthAt(i0) * (1 - f) + widthAt(i1) * f;
    const dirA = dirAt(i0);
    const dirB = dirAt(i1);
    const dir = dirA === null && dirB === null ? null : (dirA ?? 0) * (1 - f) + (dirB ?? 0) * f;

    // 贴到表面：模型几何优先，地形高度兜底
    normal.copy(up);
    surfacePoint.copy(p);
    if (surface) {
      const hit = surface(p);
      if (hit) {
        surfacePoint.copy(hit.point);
        if (hit.normal) normal.copy(hit.normal);
      }
    }

    side.crossVectors(tangent, normal);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    if (dir !== null && Math.abs(dir) > 1e-3) {
      side.applyAxisAngle(normal, THREE.MathUtils.degToRad(dir));
    }
    side.multiplyScalar(width / 2);

    // 沿表面法线轻抬，避免与模型/地形 z-fighting（水贴图覆盖在物体贴图上）
    const lift = 0.6;
    const cx = surfacePoint.x + normal.x * lift;
    const cy = surfacePoint.y + normal.y * lift;
    const cz = surfacePoint.z + normal.z * lift;

    const o = i * 6;
    positions[o] = cx - side.x;
    positions[o + 1] = cy - side.y;
    positions[o + 2] = cz - side.z;
    positions[o + 3] = cx + side.x;
    positions[o + 4] = cy + side.y;
    positions[o + 5] = cz + side.z;

    // v 用弧长参数，纹理滚动速度沿路径保持均匀
    const tArc = curve.getUtoTmapping(u);
    const uo = i * 4;
    uvs[uo] = 0;
    uvs[uo + 1] = tArc * repeat;
    uvs[uo + 2] = 1;
    uvs[uo + 3] = tArc * repeat;
  }

  const indices = [];
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, c, b, b, c, d);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
