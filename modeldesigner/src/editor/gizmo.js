/**
 * TransformControls 封装：位移 / 旋转 / 缩放三模式。
 *
 * three r166+ 的 TransformControls 继承自 Controls 而不是 Object3D，
 * 场景里要加的是 control.getHelper()。
 *
 * 拖拽期间通过 onDragChange 通知外部（用来禁用轨道相机，避免和 gizmo 抢指针）。
 */
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export const GIZMO_MODES = ['translate', 'rotate', 'scale'];

export class Gizmo {
  /**
   * @param {import('three').Camera} camera
   * @param {HTMLElement} domElement
   * @param {{onDragChange?: (dragging: boolean) => void, onChange?: () => void}} handlers
   */
  constructor(camera, domElement, { onDragChange, onChange } = {}) {
    this.control = new TransformControls(camera, domElement);
    this.control.size = 0.85;
    this.control.setSpace('world');
    this.helper = this.control.getHelper();
    this.helper.name = 'gizmo';

    this.dragging = false;
    this.control.addEventListener('dragging-changed', (event) => {
      this.dragging = Boolean(event.value);
      onDragChange?.(this.dragging);
    });
    this.control.addEventListener('objectChange', () => onChange?.());
  }

  get attached() {
    return this.control.object ?? null;
  }

  attach(object) {
    if (!object) return;
    this.control.attach(object);
  }

  detach() {
    this.control.detach();
  }

  setMode(mode) {
    if (!GIZMO_MODES.includes(mode)) return;
    this.control.setMode(mode);
  }

  get mode() {
    return this.control.mode;
  }

  setSpace(space) {
    this.control.setSpace(space === 'local' ? 'local' : 'world');
  }

  dispose() {
    this.detach();
    this.control.dispose();
  }
}
