/**
 * HUD：性能指标 + 模式切换 + 渲染参数面板。纯 DOM，不引入 UI 依赖。
 */
export class Hud {
  /**
   * @param {object} handlers
   * @param {boolean} [handlers.hasSatellite] 卫星瓦片是否可用；不可用时隐藏卫星模式与高清块数
   */
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.root = document.getElementById('overlay');
    const hasSatellite = handlers.hasSatellite !== false;

    // 只在有卫星瓦片时渲染模式切换与瓦片预算控件；否则页面固定为高程分层地形
    const modeSeg = hasSatellite
      ? `
        <div class="seg" id="mode-seg">
          <button data-mode="hypsometric" class="active">高程分层</button>
          <button data-mode="satellite">卫星影像</button>
        </div>
      `
      : '';
    const budgetField = hasSatellite
      ? `
        <label class="field">
          <span>近景高清块数 <b id="v-budget">3</b></span>
          <select id="sel-budget">
            <option value="3" selected>3 块 · 约 64 MB</option>
            <option value="6">6 块 · 约 128 MB</option>
            <option value="9">9 块 · 约 192 MB</option>
          </select>
        </label>
      `
      : '';

    this.root.innerHTML = `
      <div class="panel stats">
        <div class="title">地形查看 · 8 km 三维地形</div>
        <div class="row"><span>FPS</span><b id="hud-fps">--</b></div>
        <div class="row"><span>帧时间</span><b id="hud-ms">--</b></div>
        <div class="row"><span>三角面</span><b id="hud-tris">--</b></div>
        <div class="row"><span>渲染分辨率</span><b id="hud-res">--</b></div>
        <div class="row"><span>光标高程</span><b id="hud-elev">--</b></div>
      </div>

      <div class="panel controls">
        ${modeSeg}

        <div class="gpu-name" id="gpu-name">检测中…</div>

        <label class="field">
          <span>垂直夸张 <b id="v-exag">1.8×</b></span>
          <input id="s-exag" type="range" min="1" max="8" step="0.1" value="1.8" />
        </label>

        <label class="field">
          <span>分层数 <b id="v-bands">48</b></span>
          <input id="s-bands" type="range" min="6" max="48" step="1" value="48" />
        </label>

        <label class="field">
          <span>等高线 <b id="v-contour">100%</b></span>
          <input id="s-contour" type="range" min="0" max="1" step="0.05" value="1" />
        </label>

        ${budgetField}

        <label class="field inline">
          <input id="chk-water" type="checkbox" checked />
          <span>水面</span>
        </label>
        <label class="field">
          <span>水位 <b id="v-water">--</b></span>
          <input id="s-water" type="range" min="0" max="0.4" step="0.005" value="0.06" />
        </label>
      </div>

      <div class="tip">
        左键拖拽旋转 · 右键平移 · 滚轮缩放 · W/A/S/D 平移 · Q/E 升降 · Shift 加速 · Ctrl 慢速 · 双击聚焦
      </div>
      <!-- 前往地形模型编辑：dev 下在 5174 独立运行，构建后由 Pages 部署到 ./modeldesigner/ -->
      <a class="editor-link"
         href="${import.meta.env?.DEV ? 'http://127.0.0.1:5174/' : './modeldesigner/'}"
         target="_blank" rel="noopener">打开地形模型编辑 →</a>
    `;

    this.el = {
      fps: this.root.querySelector('#hud-fps'),
      ms: this.root.querySelector('#hud-ms'),
      tris: this.root.querySelector('#hud-tris'),
      res: this.root.querySelector('#hud-res'),
      elev: this.root.querySelector('#hud-elev'),
      modeSeg: this.root.querySelector('#mode-seg'),
      gpuName: this.root.querySelector('#gpu-name'),
    };

    this.el.modeSeg?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-mode]');
      if (!btn) return;
      this.setMode(btn.dataset.mode);
      this.handlers.onMode?.(btn.dataset.mode);
    });

    const exag = this.root.querySelector('#s-exag');
    exag.addEventListener('input', () => {
      const v = Number(exag.value);
      this.root.querySelector('#v-exag').textContent = `${v.toFixed(1)}×`;
      this.handlers.onExaggeration?.(v);
    });

    const bands = this.root.querySelector('#s-bands');
    bands.addEventListener('input', () => {
      const v = Number(bands.value);
      this.root.querySelector('#v-bands').textContent = String(v);
      this.handlers.onBands?.(v);
    });

    const contour = this.root.querySelector('#s-contour');
    contour.addEventListener('input', () => {
      const v = Number(contour.value);
      this.root.querySelector('#v-contour').textContent = `${Math.round(v * 100)}%`;
      this.handlers.onContour?.(v);
    });

    const budgetSel = this.root.querySelector('#sel-budget');
    budgetSel?.addEventListener('change', () => {
      this.root.querySelector('#v-budget').textContent = budgetSel.value;
      this.handlers.onHiResBudget?.(Number(budgetSel.value));
    });

    const water = this.root.querySelector('#chk-water');
    water.addEventListener('change', () => this.handlers.onWaterToggle?.(water.checked));

    const waterLevel = this.root.querySelector('#s-water');
    waterLevel.addEventListener('input', () => {
      const v = Number(waterLevel.value);
      this.handlers.onWaterLevel?.(v);
    });
    this.waterSlider = waterLevel;
    this.waterLabel = this.root.querySelector('#v-water');
  }

  setMode(mode) {
    const seg = this.el.modeSeg;
    if (!seg) return;
    for (const btn of seg.querySelectorAll('button')) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    }
  }

  /** 显示当前上下文实际绑定的 GPU（仅信息展示，渲染设备由浏览器自动分配） */
  setGpuName(name) {
    this.el.gpuName.textContent = name;
    this.el.gpuName.title = name;
  }

  setWaterLevelLabel(normalized, meters) {
    this.waterLabel.textContent = `${meters.toFixed(0)} m`;
    this.waterSlider.value = String(normalized);
  }

  update({ fps, frameMs, triangles, pixelRatio, width, height }) {
    this.el.fps.textContent = fps.toFixed(0);
    this.el.ms.textContent = `${frameMs.toFixed(1)} ms`;
    this.el.tris.textContent = `${(triangles / 1000).toFixed(0)}k`;
    this.el.res.textContent = `${width}×${height} @${pixelRatio.toFixed(2)}×`;
  }

  setElevation(meters) {
    this.el.elev.textContent = meters === null ? '--' : `${meters.toFixed(0)} m`;
  }
}
