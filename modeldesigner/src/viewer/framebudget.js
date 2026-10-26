/**
 * 帧预算：滚动统计帧时间，按档位自适应渲染分辨率，并把 FPS/耗时喂给 HUD。
 * 目标：稳定 60fps —— 宁可牺牲一点像素密度，也不掉帧。
 */
export class FrameBudget {
  /**
   * @param {import('three').WebGLRenderer} renderer
   * @param {{targetFps?: number, onDegrade?: (level:number) => void}} opts
   */
  constructor(renderer, { targetFps = 60, onDegrade } = {}) {
    this.renderer = renderer;
    this.targetMs = 1000 / targetFps;
    this.onDegrade = onDegrade;

    // 分辨率档位（相对上限的缩放系数）
    this.scales = [1, 0.88, 0.78, 0.68, 0.6];
    this.scaleIndex = 0;
    this.basePixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    this.samples = [];
    this.window = 90;
    this.framesSinceEval = 0;
    this.slowStreak = 0;
    this.fps = targetFps;
    this.frameMs = this.targetMs;
  }

  applyScale() {
    const scale = this.scales[this.scaleIndex];
    this.renderer.setPixelRatio(Math.max(0.5, this.basePixelRatio * scale));
  }

  /** 清空统计窗口（加载完成、切回前台后调用，避免长任务被误判为持续掉帧） */
  reset() {
    this.samples.length = 0;
    this.framesSinceEval = 0;
    this.slowStreak = 0;
  }

  /** 每帧结束调用 */
  tick(dt) {
    const ms = dt * 1000;
    // 超过 250 ms 的帧是长任务/切标签页造成的暂停，不代表渲染能力，直接丢弃
    if (ms > 250) return;

    this.samples.push(ms);
    if (this.samples.length > this.window) this.samples.shift();
    this.framesSinceEval++;

    if (this.framesSinceEval < this.window) return;
    this.framesSinceEval = 0;

    const sorted = this.samples.slice().sort((a, b) => a - b);
    const p10 = sorted[(sorted.length * 0.1) | 0];
    const p50 = sorted[(sorted.length * 0.5) | 0];
    const p90 = sorted[(sorted.length * 0.9) | 0];
    this.frameMs = p50;
    this.fps = 1000 / Math.max(p50, 0.001);
    this.refreshMs = p10;

    // 环境本身的刷新周期就很长（30 Hz 屏、无头浏览器限帧等）时，
    // 降分辨率换不来帧率，只会白白牺牲画质 —— 直接不降档。
    if (p10 > 25) {
      this.slowStreak = 0;
      return;
    }

    // 用“抖动”而不是绝对帧时间判断是否掉帧：
    // 30Hz/120Hz 显示器上帧间隔本来就不同，只要 p90 与最快帧接近，就不该牺牲画质。
    const jitter = p90 / Math.max(p10, 1);
    if (jitter > 1.75 && p90 > Math.max(this.targetMs, p10 * 1.5)) {
      this.slowStreak++;
    } else {
      this.slowStreak = Math.max(0, this.slowStreak - 1);
    }

    if (this.slowStreak >= 2 && this.scaleIndex < this.scales.length - 1) {
      this.scaleIndex++;
      this.slowStreak = 0;
      this.applyScale();
      this.onDegrade?.(this.scaleIndex);
    }
  }

  get scale() {
    return this.scales[this.scaleIndex];
  }
}
