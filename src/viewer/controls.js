/**
 * 自由浏览控制：轨道相机（鼠标/触摸）+ WASD/QE 飞行 + 双击聚焦 + 射线步进拾取。
 * 始终把相机托在地表之上，避免钻进山体。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const KEY_SPEED = { KeyW: 1, KeyS: 1, KeyA: 1, KeyD: 1, KeyQ: 1, KeyE: 1 };

export class TerrainControls {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} dom
   * @param {import('../terrain/heightfield.js').HeightField} heightField
   * @param {{getExaggeration: () => number}} opts
   */
  constructor(camera, dom, heightField, opts = {}) {
    this.camera = camera;
    this.dom = dom;
    this.hf = heightField;
    this.getExaggeration = opts.getExaggeration ?? (() => 4);

    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.rotateSpeed = 0.62;
    this.controls.panSpeed = 0.85;
    this.controls.zoomSpeed = 0.9;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 60;
    this.controls.maxDistance = 26000;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.target.set(0, 0, 0);
    this.controls.zoomToCursor = true;

    this.keys = new Set();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(0, 0);
    this.enabled = true;
    this._onKeyDown = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (KEY_SPEED[e.code]) {
        this.keys.add(e.code);
        e.preventDefault();
      }
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => this.keys.clear();
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  setTarget(x, y, z) {
    this.controls.target.set(x, y, z);
  }

  /** 相机离地高度（米） */
  groundClearance() {
    const c = this.camera.position;
    const exag = this.getExaggeration();
    const ground = this.hf.sampleWorld(c.x, c.z) * this.hf.reliefMeters * exag;
    return c.y - ground;
  }

  /** 屏幕坐标 → 地形交点（沿射线步进 + 二分细化，比 100 万三角面 raycast 快几个数量级） */
  pick(clientX, clientY) {
    const rect = this.dom.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const { origin, direction } = this.raycaster.ray;
    const exag = this.getExaggeration();
    const relief = this.hf.reliefMeters * exag;
    const half = this.hf.sizeMeters / 2;

    const heightAt = (t) => {
      const x = origin.x + direction.x * t;
      const z = origin.z + direction.z * t;
      if (Math.abs(x) > half || Math.abs(z) > half) return null;
      return this.hf.sampleWorld(x, z) * relief;
    };

    const step = 16;
    const maxT = 40000;
    let prevDiff = null;
    let prevT = 0;

    for (let t = 0; t <= maxT; t += step) {
      const h = heightAt(t);
      if (h === null) {
        // 射线起点可能在地形外侧（相机在外围俯视），先平行移动直到进入范围
        prevDiff = null;
        prevT = t;
        continue;
      }
      const y = origin.y + direction.y * t;
      const diff = y - h;

      if (prevDiff !== null && prevDiff > 0 && diff <= 0) {
        // 二分细化
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 24; i++) {
          const mid = (lo + hi) * 0.5;
          const mh = heightAt(mid);
          if (mh === null) break;
          const my = origin.y + direction.y * mid;
          if (my - mh > 0) lo = mid;
          else hi = mid;
        }
        const tHit = (lo + hi) * 0.5;
        const hHit = heightAt(tHit) ?? 0;
        return {
          x: origin.x + direction.x * tHit,
          z: origin.z + direction.z * tHit,
          y: hHit,
          normalized: hHit / relief,
        };
      }

      if (prevDiff === null && diff <= 0) {
        // 从地形外侧切入就在地表以下：交点即为进入点
        return {
          x: origin.x + direction.x * t,
          z: origin.z + direction.z * t,
          y: h,
          normalized: h / relief,
        };
      }

      prevDiff = diff;
      prevT = t;
    }
    return null;
  }

  /** 双击聚焦到地表点 */
  focusAt(point, distance = 900) {
    if (!point) return;
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    this.controls.target.set(point.x, point.y, point.z);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, Math.min(distance, this.camera.position.distanceTo(this.controls.target)));
  }

  update(dt) {
    if (this.enabled) {
      const c = this.camera;
      const target = this.controls.target;
      let forward = 0;
      let right = 0;
      let up = 0;
      if (this.keys.has('KeyW')) forward += 1;
      if (this.keys.has('KeyS')) forward -= 1;
      if (this.keys.has('KeyD')) right += 1;
      if (this.keys.has('KeyA')) right -= 1;
      if (this.keys.has('KeyE')) up += 1;
      if (this.keys.has('KeyQ')) up -= 1;

      if (forward || right || up) {
        const dist = c.position.distanceTo(target);
        const speed = Math.max(120, dist * 0.85) * (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3.2 : 1);
        const step = speed * Math.min(dt, 0.05);

        const fwd = new THREE.Vector3().subVectors(target, c.position);
        fwd.y = 0;
        if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
        fwd.normalize();
        // 水平右方向 = fwd × up（y 向上右手系）：面朝 -Z 时得到 +X。
        // 写成 (-fwd.z, 0, fwd.x)；取反会让 A/D 左右颠倒。
        const side = new THREE.Vector3(-fwd.z, 0, fwd.x);

        const move = new THREE.Vector3()
          .addScaledVector(fwd, forward * step)
          .addScaledVector(side, right * step);
        move.y += up * step;

        c.position.add(move);
        target.add(move);

        // 平移后把移动量投影回地表高度，保持观察点贴地
        const ground = this.hf.sampleWorld(target.x, target.z) * this.hf.reliefMeters * this.getExaggeration();
        if (Math.abs(target.y - ground) > this.hf.reliefMeters * 4) target.y = ground;
      }

      this.controls.update();

      // 防钻地：保持最小离地高度，并限制在地形上方
      const exag = this.getExaggeration();
      const relief = this.hf.reliefMeters * exag;
      const half = this.hf.sizeMeters / 2;
      const groundY = this.hf.sampleWorld(c.position.x, c.position.z) * relief;
      const minClear = Math.max(35, c.position.distanceTo(target) * 0.035);
      if (c.position.y < groundY + minClear) c.position.y = groundY + minClear;

      const limit = half * 2.4;
      c.position.x = Math.min(limit, Math.max(-limit, c.position.x));
      c.position.z = Math.min(limit, Math.max(-limit, c.position.z));
      target.x = Math.min(half, Math.max(-half, target.x));
      target.z = Math.min(half, Math.max(-half, target.z));
      void this.controls.maxPolarAngle;
    }
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this.controls.dispose();
  }
}
