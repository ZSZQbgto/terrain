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
    // 游览模式的相机惯性：起步缓动 + 松键后滑行
    this.inertia = false;
    this.velocity = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._move = new THREE.Vector3();
    this.collisionEnabled = true; // 相机碰撞：不钻地、不出地形边界
    this.modifiers = { shift: false, ctrl: false }; // Ctrl=缓动，Shift=加速
    this._onKeyDown = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      // 修饰键单独记录：它们不在 KEY_SPEED 里，之前放进 keys 集合的方式永远读不到
      this.modifiers.shift = e.shiftKey;
      this.modifiers.ctrl = e.ctrlKey || e.metaKey;
      if (KEY_SPEED[e.code]) {
        this.keys.add(e.code);
        e.preventDefault();
      }
    };
    this._onKeyUp = (e) => {
      this.modifiers.shift = e.shiftKey;
      this.modifiers.ctrl = e.ctrlKey || e.metaKey;
      this.keys.delete(e.code);
    };
    this._onBlur = () => {
      this.keys.clear();
      this.modifiers.shift = false;
      this.modifiers.ctrl = false;
    };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  setTarget(x, y, z) {
    this.controls.target.set(x, y, z);
  }

  /**
   * 一次性开关相机交互。
   * 注意必须同时设置 OrbitControls 的 enabled —— 只改 this.enabled 时，
   * 鼠标左键拖动仍会旋转视角（编辑器里拖 gizmo 时会和物体抢指针）。
   */
  /** 游览模式：相机惯性（起步缓动 + 松键滑行），旋转也更柔 */
  setInertia(on) {
    this.inertia = Boolean(on);
    this.controls.dampingFactor = this.inertia ? 0.05 : 0.075;
    this.controls.rotateSpeed = this.inertia ? 0.52 : 0.62;
    if (!this.inertia) this.velocity.set(0, 0, 0);
  }

  setEnabled(on) {
    this.enabled = on;
    this.controls.enabled = on;
    if (!on) this.keys.clear();
  }

  /** 相机碰撞开关：关掉后允许钻到地形以下、飞出地形边界 */
  setCollisionEnabled(on) {
    this.collisionEnabled = Boolean(on);
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

      const dtClamped = Math.min(dt, 0.05);
      // 期望速度（单位/秒）：Ctrl（⌘）= 缓动精细移动，Shift = 加速
      this._desired.set(0, 0, 0);
      if (forward || right || up) {
        const dist = c.position.distanceTo(target);
        const boost = this.modifiers.ctrl ? 0.25 : this.modifiers.shift ? 3.2 : 1;
        const speed = Math.max(120, dist * 0.85) * boost;

        const fwd = new THREE.Vector3().subVectors(target, c.position);
        fwd.y = 0;
        if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
        fwd.normalize();
        // 水平右方向 = fwd × up（y 向上右手系）：面朝 -Z 时得到 +X。
        // 写成 (-fwd.z, 0, fwd.x)；取反会让 A/D 左右颠倒。
        const side = new THREE.Vector3(-fwd.z, 0, fwd.x);

        this._desired.addScaledVector(fwd, forward).addScaledVector(side, right);
        this._desired.y += up;
        if (this._desired.lengthSq() > 1e-6) this._desired.normalize().multiplyScalar(speed);
      }

      if (this.inertia) {
        // 游览模式：起步缓动、松键后滑行（指数衰减），不硬停
        const k =
          this._desired.lengthSq() > 0
            ? 1 - Math.exp(-dtClamped * 6.5)
            : 1 - Math.exp(-dtClamped * 1.7);
        this.velocity.lerp(this._desired, Math.min(1, Math.max(0.02, k)));
        if (this._desired.lengthSq() === 0 && this.velocity.lengthSq() < 1) this.velocity.set(0, 0, 0);
      } else {
        this.velocity.copy(this._desired);
      }

      if (this.velocity.lengthSq() > 1e-6) {
        this._move.copy(this.velocity).multiplyScalar(dtClamped);
        c.position.add(this._move);
        target.add(this._move);

        // 平移后把移动量投影回地表高度，保持观察点贴地
        const ground = this.hf.sampleWorld(target.x, target.z) * this.hf.reliefMeters * this.getExaggeration();
        if (Math.abs(target.y - ground) > this.hf.reliefMeters * 4) target.y = ground;
      }

      this.controls.update();

      // 相机碰撞（可关闭）：防钻地 + 限制在地形范围内
      if (this.collisionEnabled) {
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
      }
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
