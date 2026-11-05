/**
 * 地形编辑（DEM 笔刷）与灰度图导出。
 *
 * 设计要点：
 *   - 高度数据就存在 HeightField.half / heightField.texture 里（R16F），
 *     笔刷直接改 CPU 数组并置 texture.needsUpdate —— 顶点着色器采样的是这张
 *     原始高度图，所以**下一帧地形就按新高度渲染**（实时），不需要重建几何。
 *   - AO / 梯度的查询纹理（gpuLookup）由 main 节流重建（约 180ms 一次，笔画结束立即重建），
 *     只影响光照细节，不影响高度位移的实时性。
 *   - 撤销 / 复位以「归一化高度快照 + 原始 half 位模式」实现，恢复是逐字节精确的。
 *   - 编辑结果自动存 IndexedDB（world store），刷新后恢复；导出的 16 bit 灰度 PNG
 *     与 resourses/heightmap64.png 同格式，可放回源图目录后重新 `npm run assets`。
 */
import { encodeHeightPng, normalizeSourceRange } from '../terrain/heightPng.js';
import { deleteWorld, getWorld, putWorld } from './store.js';

const SAVE_KEY = 'terrain-edit-v1';
const UNDO_LIMIT = 8;
const SAVE_DEBOUNCE = 900;
export const TERRAIN_TOOLS = ['raise', 'lower', 'flatten', 'smooth'];
export const RADIUS_MIN = 10;
export const RADIUS_MAX = 600;

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const isTypingTarget = (target) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  target?.isContentEditable;

/**
 * 启动时恢复上次保存的地形编辑；必须在构建查询纹理之前调用。
 * @returns {Promise<{restored: boolean, updatedAt?: number}>}
 */
export async function restoreSavedTerrainEdits(heightField) {
  try {
    const record = await getWorld(SAVE_KEY);
    if (!record?.buffer) return { restored: false };
    if (record.width !== heightField.width || record.height !== heightField.height) {
      return { restored: false };
    }
    const array = new Float32Array(record.buffer);
    if (array.length !== heightField.width * heightField.height) return { restored: false };
    heightField.applyNormalizedArray(array);
    return { restored: true, updatedAt: record.updatedAt ?? null };
  } catch (err) {
    console.warn('[terrain-edit] 读取已保存的地形失败（当作未编辑）', err);
    return { restored: false };
  }
}

export class TerrainEditor {
  /**
   * @param {object} opts
   * @param {import('../terrain/heightfield.js').HeightField} opts.heightField
   * @param {import('three').PerspectiveCamera} opts.camera
   * @param {HTMLCanvasElement} opts.domElement
   * @param {object} opts.cameraControls TerrainControls（pick / setEnabled）
   * @param {object} [opts.editor] Editor（setPickingEnabled / clearSelection）
   * @param {boolean} [opts.hasSavedEdits] 启动时是否恢复了已保存的编辑
   * @param {(info:object)=>void} [opts.onEdit] 每帧高度变化（main 用来把查询纹理标脏）
   * @param {(info:object)=>void} [opts.onStrokeEnd] 一次笔画/一次程序化编辑结束（main 立即重建查询纹理）
   * @param {(state:object)=>void} [opts.onStateChange] 工具 / 笔刷 / 编辑状态变化（UI 刷新）
   * @param {(text:string|null)=>void} [opts.onStatus] 状态行文字
   */
  constructor({
    heightField,
    camera,
    domElement,
    cameraControls,
    editor,
    hasSavedEdits = false,
    onEdit,
    onStrokeEnd,
    onStateChange,
    onStatus,
  }) {
    this.heightField = heightField;
    this.camera = camera;
    this.dom = domElement;
    this.cameraControls = cameraControls;
    this.editor = editor;
    this.onEdit = onEdit;
    this.onStrokeEnd = onStrokeEnd;
    this.onStateChange = onStateChange;
    this.onStatus = onStatus;

    this.active = false;
    this.tool = 'raise';
    this.radius = 80; // 米
    this.strength = 0.3; // 0..1

    this.editCount = 0; // 已应用的笔刷帧数（状态显示用）
    this._edited = Boolean(hasSavedEdits);
    this._dirtyMask = null;
    this._dirtyCount = 0;
    this._undo = [];
    this._stroke = null;
    this._raf = 0;
    this._saveTimer = 0;
    this._lastFlattenTarget = 0;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._tick = this._tick.bind(this);

    this.dom.addEventListener('pointerdown', this._onPointerDown);
    this.dom.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
    window.addEventListener('keydown', this._onKeyDown);
  }

  // ── 状态 ──────────────────────────────────────────────────────────────────
  getState() {
    return {
      active: this.active,
      tool: this.tool,
      radius: this.radius,
      strength: this.strength,
      edited: this._edited,
      editCount: this.editCount,
      dirtyCount: this._dirtyCount,
      undoCount: this._undo.length,
    };
  }

  getExportInfo() {
    const hf = this.heightField;
    const range = normalizeSourceRange(hf.sourceRange);
    return {
      width: hf.width,
      height: hf.height,
      bitDepth: range.bitDepth,
      minGray: range.minGray,
      maxGray: range.maxGray,
      edited: this._edited,
      dirtyCount: this._dirtyCount,
    };
  }

  _emitState() {
    this.onStateChange?.(this.getState());
  }

  setActive(on) {
    const next = Boolean(on);
    if (next === this.active) return;
    this.active = next;
    this.dom.style.cursor = next ? 'crosshair' : '';
    if (next) {
      this._ensureReady();
      // 地形编辑模式下点击画布用于涂抹，不参与模型选择；清掉当前选择避免 gizmo 抢指针
      this.editor?.clearSelection?.();
      this.editor?.setPickingEnabled?.(false);
      this.onStatus?.(null); // 用法提示在面板 note / 底部 hint 里，不在状态行重复
    } else {
      this._cancelStroke({ keepChanges: true });
      this.editor?.setPickingEnabled?.(true);
      this.onStatus?.(null);
    }
    this._emitState();
  }

  setTool(tool) {
    if (!TERRAIN_TOOLS.includes(tool)) return;
    this.tool = tool;
    this._emitState();
  }

  setRadius(meters) {
    this.radius = clamp(meters, RADIUS_MIN, RADIUS_MAX, this.radius);
    this._emitState();
  }

  setStrength(value) {
    this.strength = clamp(value, 0.01, 1, this.strength);
    this._emitState();
  }

  // ── 编辑核心 ──────────────────────────────────────────────────────────────
  _ensureReady() {
    this.heightField.ensureNormalized();
    if (!this._dirtyMask) {
      this._dirtyMask = new Uint8Array(this.heightField.width * this.heightField.height);
      if (this._edited) this._recomputeDirty();
    }
  }

  /** 与原始 half 位模式比较，重算「已修改点」统计（撤销 / 恢复后调用） */
  _recomputeDirty() {
    const hf = this.heightField;
    this._ensureDirtyMask();
    const mask = this._dirtyMask;
    let count = 0;
    for (let i = 0; i < mask.length; i++) {
      const changed = hf.half[i] !== hf.originalHalf[i];
      mask[i] = changed ? 1 : 0;
      if (changed) count++;
    }
    this._dirtyCount = count;
    this._edited = count > 0;
    return count;
  }

  _ensureDirtyMask() {
    if (this._dirtyMask) return this._dirtyMask;
    this._dirtyMask = new Uint8Array(this.heightField.width * this.heightField.height);
    if (this._edited) {
      // 恢复保存的地形：按原始 half 比较出真正的「已修改点」
      const hf = this.heightField;
      let count = 0;
      for (let i = 0; i < this._dirtyMask.length; i++) {
        const changed = hf.half[i] !== hf.originalHalf[i];
        this._dirtyMask[i] = changed ? 1 : 0;
        if (changed) count++;
      }
      this._dirtyCount = count;
      this._edited = count > 0;
    }
    return this._dirtyMask;
  }

  /** 笔刷核心：在 (x,z)（米，世界坐标）处按当前工具施加一次笔刷 */
  _applyBrush(x, z, { tool, radius, strength, dt, flattenTarget }) {
    const hf = this.heightField;
    const W = hf.width;
    const H = hf.height;
    const normalized = hf.ensureNormalized();
    const mask = this._ensureDirtyMask();

    const u = x / hf.sizeMeters + 0.5;
    const v = z / hf.sizeMeters + 0.5;
    const cx = u * (W - 1);
    const cy = v * (H - 1);
    const rTex = Math.max(1, clamp(radius, RADIUS_MIN, RADIUS_MAX, this.radius) / hf.pxMeters);

    const x0 = Math.max(0, Math.floor(cx - rTex));
    const x1 = Math.min(W - 1, Math.ceil(cx + rTex));
    const y0 = Math.max(0, Math.floor(cy - rTex));
    const y1 = Math.min(H - 1, Math.ceil(cy + rTex));
    if (x0 > x1 || y0 > y1) return false;

    const step = clamp(dt, 0.001, 0.05, 1 / 60);
    const power = clamp(strength, 0.01, 1, this.strength);
    // 每秒最大变化量：strength=1 时约 0.72/s（≈满量程 1.4 秒），60fps 下每帧约 1.2%
    const deltaPerSecond = power * 1.2;
    const blendPerSecond = power * 2.6;
    let changed = false;
    let changedCount = 0;

    for (let iy = y0; iy <= y1; iy++) {
      const dy = (iy - cy) / rTex;
      if (dy > 1 || dy < -1) continue;
      const d2y = dy * dy;
      const row = iy * W;
      for (let ix = x0; ix <= x1; ix++) {
        const dx = (ix - cx) / rTex;
        const d2 = dx * dx + d2y;
        if (d2 > 1) continue;
        const falloff = (1 - d2) * (1 - d2); // 平滑钟形，越靠中心越强
        if (falloff <= 1e-5) continue;

        const idx = row + ix;
        const current = normalized[idx];
        let next = current;

        if (tool === 'raise') next = current + deltaPerSecond * step * falloff;
        else if (tool === 'lower') next = current - deltaPerSecond * step * falloff;
        else if (tool === 'flatten') {
          const target = flattenTarget ?? current;
          const alpha = Math.min(1, blendPerSecond * step * falloff);
          next = current + (target - current) * alpha;
        } else if (tool === 'smooth') {
          // 以 3×3 邻域均值做局部平滑（边缘按 clamp 取样）
          let sum = 0;
          let n = 0;
          for (let oy = -1; oy <= 1; oy++) {
            const sy = Math.min(H - 1, Math.max(0, iy + oy)) * W;
            for (let ox = -1; ox <= 1; ox++) {
              const sx = Math.min(W - 1, Math.max(0, ix + ox));
              sum += normalized[sy + sx];
              n++;
            }
          }
          const alpha = Math.min(1, blendPerSecond * step * falloff);
          next = current + (sum / n - current) * alpha;
        }

        if (next < 0) next = 0;
        else if (next > 1) next = 1;
        if (Math.abs(next - current) < 1e-6) continue;

        hf.setNormalizedAt(idx, next);
        changed = true;
        changedCount++;
        if (!mask[idx]) {
          mask[idx] = 1;
          this._dirtyCount++;
        }
      }
    }

    if (changed) {
      this.editCount++;
      this._edited = true;
    }
    return changed;
  }

  /** 程序化涂抹（测试/自动化入口）：在指定世界坐标施加 N 次笔刷 */
  paintAtWorld(x, z, { tool = this.tool, radius = this.radius, strength = this.strength, iterations = 1, dt = 1 / 60 } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return this.getState();
    this._ensureReady();
    const startsStroke = !this._stroke;
    if (startsStroke) this._pushUndo();
    const flattenTarget = this.heightField.sampleWorld(x, z);
    let changed = false;
    for (let i = 0; i < Math.max(1, iterations); i++) {
      changed = this._applyBrush(x, z, { tool, radius, strength, dt, flattenTarget }) || changed;
    }
    if (changed) {
      this.onEdit?.(this.getState());
      this.onStrokeEnd?.(this.getState());
      this._saveSoon();
      this._emitState();
    }
    return this.getState();
  }

  /** 撤销上一步（笔画开始时的整幅快照） */
  undo() {
    const snapshot = this._undo.pop();
    if (!snapshot) return false;
    this._cancelStroke({ keepChanges: true });
    this.heightField.applyNormalizedArray(snapshot);
    this._recomputeDirty();
    this.editCount = Math.max(0, this.editCount - 1);
    this.onEdit?.(this.getState());
    this.onStrokeEnd?.(this.getState());
    this._saveSoon();
    this._emitState();
    return true;
  }

  /** 恢复原始地形（逐字节还原原始 half） */
  resetToOriginal() {
    this._cancelStroke({ keepChanges: true });
    if (!this.heightField.resetToOriginal()) return false;
    this._undo.length = 0;
    this._dirtyMask?.fill(0);
    this._dirtyMask = null;
    this._dirtyCount = 0;
    this._edited = false;
    this.editCount = 0;
    this.onEdit?.(this.getState());
    this.onStrokeEnd?.(this.getState());
    this.saveNow().catch(() => {});
    this._emitState();
    return true;
  }

  // ── 指针交互（按住左键连续涂抹）──────────────────────────────────────────
  _onPointerDown(event) {
    if (!this.active || event.button !== 0) return;
    if (this._stroke) return;
    // 游览模式 / 其他无 UI 演示场景下不涂抹（仍然可以拖动旋转视角）
    if (document.body.classList.contains('tour-mode')) return;
    const hit = this.cameraControls?.pick?.(event.clientX, event.clientY);
    if (!hit) {
      this.onStatus?.('没点在地形上：请在地形范围内涂抹');
      return;
    }
    event.preventDefault();
    this._ensureReady();
    this._pushUndo();
    this._stroke = {
      pointerId: event.pointerId,
      x: hit.x,
      z: hit.z,
      lastTime: performance.now(),
      flattenTarget: this.heightField.sampleWorld(hit.x, hit.z),
    };
    this.cameraControls?.setEnabled?.(false);
    this.editor?.setPickingEnabled?.(false);
    try {
      this.dom.setPointerCapture?.(event.pointerId);
    } catch {
      /* 某些浏览器不支持 pointer capture，忽略 */
    }
    this.onStatus?.('正在编辑地形…（松开结束，Ctrl+Z 撤销）');
    this._applyStrokeFrame(performance.now());
    this._raf = requestAnimationFrame(this._tick);
  }

  _onPointerMove(event) {
    if (!this.active || !this._stroke) return;
    const hit = this.cameraControls?.pick?.(event.clientX, event.clientY);
    if (!hit) return;
    this._stroke.x = hit.x;
    this._stroke.z = hit.z;
  }

  _tick(now) {
    if (!this._stroke) return;
    this._applyStrokeFrame(now);
    this._raf = requestAnimationFrame(this._tick);
  }

  _applyStrokeFrame(now) {
    const stroke = this._stroke;
    if (!stroke) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - stroke.lastTime) / 1000));
    stroke.lastTime = now;
    const changed = this._applyBrush(stroke.x, stroke.z, {
      tool: this.tool,
      radius: this.radius,
      strength: this.strength,
      dt,
      flattenTarget: stroke.flattenTarget,
    });
    if (changed) this.onEdit?.(this.getState());
  }

  _onPointerUp(event) {
    if (!this._stroke) return;
    if (event.type === 'pointerup' && event.button !== 0) return;
    this._cancelStroke({ keepChanges: true });
  }

  /** 结束当前笔画：停止 rAF、恢复相机与模型拾取、立即重建着色用查询纹理 */
  _cancelStroke({ keepChanges = true } = {}) {
    if (!this._stroke) return;
    this._stroke = null;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.cameraControls?.setEnabled?.(true);
    if (this.active) this.editor?.setPickingEnabled?.(false);
    else this.editor?.setPickingEnabled?.(true);
    this.onStatus?.(null);
    if (keepChanges) {
      this.onStrokeEnd?.(this.getState());
      this._saveSoon();
      this._emitState();
    }
  }

  _pushUndo() {
    const snapshot = this.heightField.ensureNormalized().slice();
    this._undo.push(snapshot);
    if (this._undo.length > UNDO_LIMIT) this._undo.shift();
  }

  _onKeyDown(event) {
    if (!this.active) return;
    if (isTypingTarget(event.target)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      this.undo();
      return;
    }
    if (event.key === 'Escape' && this._stroke) {
      event.preventDefault();
      this._cancelStroke({ keepChanges: true });
    }
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────
  _saveSoon() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this.saveNow().catch((err) => console.warn('[terrain-edit] 自动保存失败', err));
    }, SAVE_DEBOUNCE);
  }

  /** 立即保存（导出前 / 页面卸载 / 测试用） */
  async saveNow() {
    clearTimeout(this._saveTimer);
    this._saveTimer = 0;
    if (!this._edited) {
      await deleteWorld(SAVE_KEY);
      return false;
    }
    const normalized = this.heightField.ensureNormalized();
    const buffer = normalized.slice().buffer;
    await putWorld(SAVE_KEY, {
      buffer,
      width: this.heightField.width,
      height: this.heightField.height,
      updatedAt: Date.now(),
    });
    return true;
  }

  // ── 导出 16 bit 灰度 PNG ─────────────────────────────────────────────────
  /** 返回 PNG 字节（不触发下载；测试用） */
  async exportPngBytes() {
    const hf = this.heightField;
    const normalized = hf.ensureNormalized();
    const { bytes, bitDepth } = await encodeHeightPng({
      normalized,
      width: hf.width,
      height: hf.height,
      sourceRange: hf.sourceRange,
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return {
      bytes,
      filename: `heightmap-edited-${stamp}.png`,
      width: hf.width,
      height: hf.height,
      bitDepth,
    };
  }

  /** 导出并触发浏览器下载 */
  async exportAndDownload() {
    const result = await this.exportPngBytes();
    const blob = new Blob([result.bytes], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = result.filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return result;
  }

  dispose() {
    this._cancelStroke({ keepChanges: false });
    clearTimeout(this._saveTimer);
    this.dom.removeEventListener('pointerdown', this._onPointerDown);
    this.dom.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    window.removeEventListener('keydown', this._onKeyDown);
  }
}
