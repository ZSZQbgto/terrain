/**
 * 水面绘制/编辑交互。
 *
 *   area：在地形上依次点选 → 实时取各点地表高程的**平均值**作为该区域水平面高度，
 *         预览里立刻出现真实水面材质（与最终水面同一 shader）；
 *   flow：依次点起点 → 若干途经点 → 终点，预览直接生成流动水带（同一套流动材质）。
 *
 * 关键点：
 *   - 选点用 cameraControls.pick()（射线步进 + CPU 高度采样）而不是 raycast 打网格 ——
 *     地形几何是平面（高度在 shader 里位移），打网格得到的点是错的
 *   - 每个选点都有编号标记，连线 + 实时水面，避免"选点不清楚"
 *   - 完成用面板上的「完成」按钮；Enter 是快捷方式，双击不再生效
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { flowCurve, buildFlowGeometry } from './waterSystem.js';

export class WaterEditor {
  constructor({ system, editor, camera, domElement, scene, cameraControls, onStatus, onDraftChange }) {
    this.system = system;
    this.editor = editor;
    this.camera = camera;
    this.dom = domElement;
    this.cameraControls = cameraControls ?? null;
    this.onStatus = onStatus;
    this.onDraftChange = onDraftChange;

    this.drawing = null; // { type: 'area'|'flow', points: [], target? }
    this._down = null;

    this.preview = new THREE.Group();
    this.preview.name = 'water-preview';
    this.preview.renderOrder = 20;
    scene.add(this.preview);

    this.lineMaterial = new THREE.LineBasicMaterial({
      color: 0xffd166,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
    this.markerGeometry = new THREE.SphereGeometry(10, 12, 8);
    this.markerMaterial = new THREE.MeshBasicMaterial({ color: 0xffd166, depthTest: false });
    this._previewMaterials = []; // 需要随预览一起释放的材质（流动水带）

    // 选中水体的可拖动节点（青色小球 + 序号）
    this.nodes = new THREE.Group();
    this.nodes.name = 'water-nodes';
    scene.add(this.nodes);
    this.nodeMeshes = [];
    this.nodeMaterial = new THREE.MeshBasicMaterial({ color: 0x7fe6d4, depthTest: false });
    this.nodeHoverMaterial = new THREE.MeshBasicMaterial({ color: 0xf2fbff, depthTest: false });
    this.nodeRaycaster = new THREE.Raycaster();
    this._drag = null; // { kind, id, index, plane }
    this._plane = new THREE.Plane();

    this._bind();
  }

  get active() {
    return Boolean(this.drawing);
  }

  start(type) {
    this.cancel();
    this.drawing = { type: type === 'flow' ? 'flow' : 'area', points: [] };
    this.editor.setPickingEnabled(false); // 绘制时别去选模型
    this.system.clearSelection();
    this._draftChanged();
    return this.drawing;
  }

  /**
   * 重新编辑已有水体：重新点选边界/路径，完成后替换原对象
   * （名称、流速/宽度都保留）
   */
  redraw(kind, id) {
    const list = kind === 'area' ? this.system.state.areas : this.system.state.flows;
    const item = list.find((x) => x.id === id);
    if (!item) return false;
    this.start(kind);
    this.drawing.target = { kind, id };
    this._draftChanged();
    return true;
  }

  cancel() {
    if (!this.drawing) return;
    this.drawing = null;
    this._clearPreview();
    this.editor.setPickingEnabled(true);
    this.onStatus?.(null);
    this.onDraftChange?.();
  }

  finish() {
    const d = this.drawing;
    if (!d) return null;
    const minPoints = d.type === 'area' ? 3 : 2;
    if (d.points.length < minPoints) {
      this.onStatus?.(
        d.type === 'area' ? '水面区域至少需要 3 个点' : '流动水至少需要起点和终点',
      );
      return null;
    }

    let created = null;
    if (d.type === 'area') {
      const level = this.averageMeters();
      if (d.target) {
        this.system.updateArea(d.target.id, { points: d.points, level });
        created = { id: d.target.id };
      } else {
        created = this.system.addArea({ points: d.points, level });
      }
    } else if (d.target) {
      this.system.updateFlow(d.target.id, { points: d.points });
      created = { id: d.target.id };
    } else {
      created = this.system.addFlow({ points: d.points });
    }

    const kind = d.type;
    this.drawing = null;
    this._clearPreview();
    this.editor.setPickingEnabled(true);
    this.onStatus?.(null);
    if (created) this.system.select({ kind, id: created.id });
    this.onDraftChange?.();
    return created;
  }

  /** 撤回刚刚选完的那一个点 */
  undoPoint() {
    const d = this.drawing;
    if (!d || !d.points.length) return false;
    d.points.pop();
    this._updatePreview();
    this._draftChanged();
    return true;
  }

  /** 追加一个选点（鼠标选点与程序化调用共用） */
  addPointAt(point) {
    if (!this.drawing || !point) return;
    if (this.drawing.type === 'area') {
      this.drawing.points.push([point.x, point.z]);
    } else {
      // 流动水的关键点带自己的宽度 / 横向朝向（null = 跟随全局与自动方向）
      this.drawing.points.push({ x: point.x, y: point.y + 0.6, z: point.z, width: null, dir: null });
    }
    this._updatePreview();
    this._draftChanged();
  }

  /** 当前选点的平均地表高程（米） */
  averageMeters() {
    const pts = this.drawing?.points ?? [];
    if (!pts.length) return this.system.state.level;
    let sum = 0;
    for (const p of pts) {
      const x = Array.isArray(p) ? p[0] : p.x;
      const z = Array.isArray(p) ? (p.length === 3 ? p[2] : p[1]) : p.z;
      sum += this.system.groundMetersAt(x, z);
    }
    return sum / pts.length;
  }

  _status() {
    const d = this.drawing;
    if (!d) {
      this.onStatus?.(null);
      return;
    }
    if (d.type === 'area') {
      this.onStatus?.(
        `水面区域：已选 ${d.points.length} 点 · 实时平均水面 ${this.averageMeters().toFixed(1)} m · 右侧点「完成」结束`,
      );
    } else {
      this.onStatus?.(
        `流动水：已选 ${d.points.length} 点（起点 → 途经点 → 终点）· 右侧点「完成」结束`,
      );
    }
  }

  _draftChanged() {
    this._status();
    this.onDraftChange?.(this);
  }

  _bind() {
    // 非绘制状态下：点住选中水体的节点即可拖动
    this.dom.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (!this.drawing) {
        const hit = this._pickNode(event.clientX, event.clientY);
        if (hit) {
          this._startNodeDrag(hit);
          return;
        }
      }
      if (!this.drawing) return;
      this._down = { x: event.clientX, y: event.clientY };
    });

    this.dom.addEventListener('pointermove', (event) => {
      if (this._drag) this._dragMove(event);
    });

    this.dom.addEventListener('pointerup', (event) => {
      if (this._drag) {
        this._endNodeDrag();
        return;
      }
      if (!this.drawing || event.button !== 0 || !this._down) return;
      const dx = event.clientX - this._down.x;
      const dy = event.clientY - this._down.y;
      this._down = null;
      if (Math.hypot(dx, dy) > 6) return; // 拖拽视角，不算选点
      const hit = this._groundHit(event.clientX, event.clientY);
      if (!hit) return;
      this.addPointAt(hit);
    });

    window.addEventListener('keydown', (event) => {
      if (!this.drawing) return;
      const typing =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement;
      if (typing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        this.finish();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.cancel();
      }
    });
  }

  /** 精确取地表交点：射线步进 + CPU 高度采样（cameraControls.pick） */
  _groundHit(clientX, clientY) {
    const hit = this.cameraControls?.pick?.(clientX, clientY);
    if (!hit) return null;
    return new THREE.Vector3(hit.x, hit.y, hit.z);
  }

  // ── 选中水体的节点：显示 + 拖动 ───────────────────────────────────────────
  /** 节点世界坐标：静止水面画在水平面上，流动水画在点自己的空间位置上 */
  _nodeWorldPosition(kind, id, index) {
    if (kind === 'area') {
      const area = this.system.state.areas.find((a) => a.id === id);
      const p = area?.points[index];
      if (!p) return null;
      return new THREE.Vector3(p[0], this.system.metersToWorldY(area.level) + 4, p[1]);
    }
    const flow = this.system.state.flows.find((f) => f.id === id);
    const p = flow?.points[index];
    if (!p) return null;
    return new THREE.Vector3(p.x, p.y + 4, p.z);
  }

  /** 与当前选中同步：给选中的水体画一排可拖动节点 */
  syncNodes() {
    this._clearNodes();
    const sel = this.system.selected;
    const item = this.system.selectedItem;
    if (!sel || !item) return;
    item.points.forEach((_, index) => {
      const position = this._nodeWorldPosition(sel.kind, sel.id, index);
      if (!position) return;
      const marker = new THREE.Mesh(this.markerGeometry, this.nodeMaterial);
      marker.position.copy(position);
      marker.renderOrder = 30;
      marker.userData = { nodeKind: sel.kind, nodeId: sel.id, nodeIndex: index };
      // 序号挂成子对象，节点移动时自动跟随
      const el = document.createElement('div');
      el.className = 'pick-index';
      el.textContent = String(index + 1);
      const label = new CSS2DObject(el);
      label.position.set(0, 20, 0);
      marker.add(label);
      this.nodes.add(marker);
      this.nodeMeshes.push(marker);
    });
  }

  _clearNodes() {
    for (const marker of [...this.nodes.children]) {
      this.nodes.remove(marker);
      for (const child of marker.children) child.element?.remove?.();
    }
    this.nodeMeshes.length = 0;
  }

  _pickNode(clientX, clientY) {
    if (!this.nodeMeshes.length) return null;
    const rect = this.dom.getBoundingClientRect();
    this.nodeRaycaster.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -(((clientY - rect.top) / rect.height) * 2 - 1),
      ),
      this.camera,
    );
    const hits = this.nodeRaycaster.intersectObjects(this.nodeMeshes, false);
    return hits[0] ?? null;
  }

  _startNodeDrag(hit) {
    const { nodeKind: kind, nodeId: id, nodeIndex: index } = hit.object.userData;
    if (kind === 'area') {
      // 静止水面：在水平面内拖动 → 水平位置可变，水面高度保持不变
      const area = this.system.state.areas.find((a) => a.id === id);
      const surfaceY = this.system.metersToWorldY(area.level);
      this._plane.setFromNormalAndCoplanarPoint(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, surfaceY, 0),
      );
    } else {
      // 流动水：在过该点、朝向相机的平面内拖动 → 空间位置（x/y/z）都可改
      const normal = new THREE.Vector3();
      this.camera.getWorldDirection(normal).negate();
      this._plane.setFromNormalAndCoplanarPoint(normal, hit.object.position.clone());
    }
    this._drag = { kind, id, index };
    this.cameraControls?.setEnabled(false); // 拖节点时不要同时转视角
    this.editor.setPickingEnabled(false);
    this.onStatus?.(
      kind === 'area' ? '拖动节点改水平位置（水面高度不变）· 松开提交' : '拖动节点改空间位置 · 松开提交',
    );
  }

  _dragMove(event) {
    const drag = this._drag;
    if (!drag) return;
    const rect = this.dom.getBoundingClientRect();
    this.nodeRaycaster.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -(((event.clientY - rect.top) / rect.height) * 2 - 1),
      ),
      this.camera,
    );
    const point = new THREE.Vector3();
    if (!this.nodeRaycaster.ray.intersectPlane(this._plane, point)) return;
    if (drag.kind === 'area') {
      this.system.moveAreaPoint(drag.id, drag.index, point.x, point.z, false);
    } else {
      this.system.moveFlowPoint(drag.id, drag.index, point.x, point.y, point.z, false);
    }
    this.syncNodes(); // 节点与序号跟着走
  }

  _endNodeDrag() {
    if (!this._drag) return;
    this._drag = null;
    this.cameraControls?.setEnabled(true);
    this.editor.setPickingEnabled(true);
    this.system.commitChange(); // 一次变更：进撤回栈 + 触发自动保存
    this.onStatus?.(null);
  }

  _clearPreview() {
    for (const child of [...this.preview.children]) {
      this.preview.remove(child);
      child.geometry?.dispose();
      child.element?.remove?.(); // CSS2DObject 的 DOM
    }
    for (const material of this._previewMaterials) {
      this.system.materials?.delete(material);
      material.dispose();
    }
    this._previewMaterials.length = 0;
  }

  /** 选点在地表上的世界坐标（标记画在这里，而不是水面高度上） */
  _pointPosition(p, isArea) {
    const x = Array.isArray(p) ? p[0] : p.x;
    const z = Array.isArray(p) ? (isArea ? p[1] : p[2]) : p.z;
    const worldY = Array.isArray(p)
      ? this.system.metersToWorldY(this.system.groundMetersAt(x, z))
      : p.y;
    return new THREE.Vector3(x, worldY + 6, z);
  }

  _updatePreview() {
    this._clearPreview();
    const d = this.drawing;
    if (!d || !d.points.length) return;

    const isArea = d.type === 'area';
    const pts = d.points;

    // 每个选点：小球 + 序号，点在哪一目了然
    pts.forEach((p, index) => {
      const position = this._pointPosition(p, isArea);
      const marker = new THREE.Mesh(this.markerGeometry, this.markerMaterial);
      marker.position.copy(position);
      marker.renderOrder = 22;
      this.preview.add(marker);

      const element = document.createElement('div');
      element.className = 'pick-index';
      element.textContent = String(index + 1);
      const label = new CSS2DObject(element);
      label.position.copy(position).add(new THREE.Vector3(0, 24, 0));
      this.preview.add(label);
    });

    if (isArea) {
      // 边界连线（闭合预览）
      if (pts.length > 1) {
        const ring = pts.map((p) => this._pointPosition(p, true));
        ring.push(ring[0].clone());
        this.preview.add(
          new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), this.lineMaterial),
        );
      }
      // 实时水面：直接用最终区域的材质（波纹 + 雾），所见即所得
      if (pts.length >= 3) {
        const shape = new THREE.Shape();
        pts.forEach(([x, z], i) => (i === 0 ? shape.moveTo(x, -z) : shape.lineTo(x, -z)));
        const geometry = new THREE.ShapeGeometry(shape);
        geometry.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(geometry, this.system.areaMaterial);
        mesh.position.y = this.system.metersToWorldY(this.averageMeters());
        mesh.renderOrder = 19;
        this.preview.add(mesh);
      }
    } else {
      if (pts.length >= 2) {
        const curve = flowCurve({ points: pts });
        const linePts = curve.getPoints(Math.max(24, pts.length * 12));
        this.preview.add(
          new THREE.Line(new THREE.BufferGeometry().setFromPoints(linePts), this.lineMaterial),
        );

        // 实时流动水带：与最终流动水同一套材质，同样贴到模型/地形表面
        const geometry = buildFlowGeometry({ points: pts, width: 14 }, 14, (p) => this.system.surfaceAt(p));
        const material = this.system.createFlowMaterial();
        this._previewMaterials.push(material);
        const ribbon = new THREE.Mesh(geometry, material);
        ribbon.renderOrder = 19;
        this.preview.add(ribbon);
      }
    }
  }
}
