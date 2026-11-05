/**
 * 地形编辑笔刷指示圈：跟随鼠标在地形上的落点，并「贴」在地形表面（逐顶点采样高度）。
 *
 * 实现要点：
 *   - 用一条三角带（内圈 + 外圈）做成有宽度的圆环，128 段足够平滑；
 *   - 每个顶点用 heightField.sampleWorld 取地形高度，再乘垂直夸张 —— 与顶点着色器
 *     的地形位移公式一致，所以起伏地形上圆环也会跟着起伏，而不是漂在空中；
 *   - 只用一个几何体原地更新顶点（不重建），每帧 256 次采样，代价可忽略；
 *   - 只在地形编辑模式、鼠标在地形上时显示（tour 模式 / 离开画布时隐藏）。
 */
import * as THREE from 'three';

const Y_OFFSET = 1.5; // 抬到地表上方一点，避免与地形深度打架

export class BrushIndicator {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene
   * @param {import('../terrain/heightfield.js').HeightField} opts.heightField
   * @param {() => number} [opts.getExaggeration]
   * @param {number} [opts.color]
   * @param {number} [opts.segments]
   */
  constructor({ scene, heightField, getExaggeration = () => 1, color = 0x6fd3ff, segments = 128 }) {
    this.scene = scene;
    this.hf = heightField;
    this.getExaggeration = getExaggeration;
    this.segments = Math.max(24, Math.round(segments));
    this.ringHalfWidth = 1.4; // 圆环线宽（米）
    this.visible = false;
    this.x = 0;
    this.z = 0;
    this.radius = 80;

    const vertexCount = this.segments * 2;
    this.positions = new Float32Array(vertexCount * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));

    // 内圈 i0/i1 + 外圈之间连成三角带（双面材质，绕序不重要）
    const indices = [];
    for (let i = 0; i < this.segments; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = ((i + 1) % this.segments) * 2;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
    this.geometry.setIndex(indices);

    this.material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'brush-indicator';
    this.mesh.renderOrder = 20;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** 世界坐标 (x,z) 处的贴地 y（含垂直夸张） */
  _groundY(x, z) {
    const exag = this.getExaggeration?.() ?? 1;
    return this.hf.sampleWorld(x, z) * this.hf.reliefMeters * exag + Y_OFFSET;
  }

  /** 更新指示圈：圆心 (x,z)、半径 radius（米）；传 null 隐藏 */
  update(x, z, radius) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius)) {
      this.hide();
      return;
    }
    this.x = x;
    this.z = z;
    this.radius = radius;
    this.visible = true;
    this.mesh.visible = true;

    const half = Math.max(0.35, this.ringHalfWidth);
    const inner = Math.max(0.4, radius - half);
    const outer = radius + half;
    const pos = this.positions;
    for (let i = 0; i < this.segments; i++) {
      const ang = (i / this.segments) * Math.PI * 2;
      const cx = Math.cos(ang);
      const sz = Math.sin(ang);
      const i0 = i * 2 * 3;
      const i1 = i0 + 3;
      const ix = x + cx * inner;
      const iz = z + sz * inner;
      const ox = x + cx * outer;
      const oz = z + sz * outer;
      pos[i0] = ix;
      pos[i0 + 1] = this._groundY(ix, iz);
      pos[i0 + 2] = iz;
      pos[i1] = ox;
      pos[i1 + 1] = this._groundY(ox, oz);
      pos[i1 + 2] = oz;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  /** 用最近一次的位置/半径重画（垂直夸张变化、地形高度变化后调用） */
  refresh() {
    if (!this.visible) return;
    this.update(this.x, this.z, this.radius);
  }

  hide() {
    this.visible = false;
    this.mesh.visible = false;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
