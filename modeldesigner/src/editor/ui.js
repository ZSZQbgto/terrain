/**
 * 编辑器 UI：工具栏、资源库 / 场景模型列表、检查器（变换 / 部件树 / 标签）。
 *
 * 纯 DOM，无 UI 框架。渲染策略：
 *   - 'transform' 变更只同步数字输入框（gizmo 拖动时不重建 DOM，避免丢焦点）
 *   - 其它变更重建列表与检查器
 *   - 标签文案输入用 input 事件，只写数据不重建（场景标签由 TagLayer 同步）
 */
import { LABEL_KINDS } from './project.js';
import { collectParts, pathToLabel, resolvePath } from './labels.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtSize = (bytes) => {
  if (!Number.isFinite(bytes)) return '--';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
};

const DEFAULT_HINT =
  '拖入 .glb 或点「导入模型」 · 左键选择模型 · 1/2/3 切换移动/旋转/缩放 · Esc 取消选择 · Delete 删除 · Ctrl+D 复制';

/** 水体编辑模式的默认提示（与模型编辑的提示分开，避免模式切换后提示串味） */
const WATER_HINT =
  '点「＋水源」在地形上放置水源（可连续放）· 拖动水源小球改位置 · 左侧列表选中后可改半径/目标水位/名称 · Esc 结束放置';

/** 水体面板的兜底默认值（正常情况下直接用 water.state 里的值） */
const WATER_SIM_FALLBACK = { speed: 1, waterAmount: 15, resolution: 768, paused: false };
const WATER_VISUAL_FALLBACK = { shimmer: 1, ripple: 1, clarity: 0.62 };
const WATER_RESOLUTIONS = [256, 512, 768, 1024];

/** 目标水面高程输入：空 / 0 → null（不限制） */
function parseTargetLevel(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value === 0) return null;
  return value;
}

export class Ui {
  constructor({
    editor,
    library,
    gizmo,
    water,
    waterEditor,
    onImportFiles,
    onImportProject,
    onExportProject,
    onReset,
    onToggleTextures,
    onToggleCollision,
    onToggleWater,
    onWaterAddSource,
    onWaterSave,
    onWaterReset,
    onFogChange,
    onToggleTour,
    onMode,
  }) {
    this.editor = editor;
    this.library = library;
    this.gizmo = gizmo;
    this.water = water ?? null;
    this.waterEditor = waterEditor ?? null;
    this.onImportFiles = onImportFiles;
    this.onImportProject = onImportProject;
    this.onExportProject = onExportProject;
    this.onReset = onReset;
    this.onToggleTextures = onToggleTextures;
    this.onToggleCollision = onToggleCollision;
    this.onToggleWater = onToggleWater;
    this.onWaterAddSource = onWaterAddSource;
    this.onWaterSave = onWaterSave;
    this.onWaterReset = onWaterReset;
    this.onFogChange = onFogChange;
    this.onToggleTour = onToggleTour;
    this.onMode = onMode;
    this.mode = 'models';
    this._suppressWaterRender = false; // 拖滑杆时避免 water.onChange → 面板重建

    this.toolbar = document.getElementById('toolbar');
    this.modelsPanel = document.getElementById('panel-models');
    this.inspectorPanelEl = document.getElementById('panel-inspector');
    this.waterPanelEl = document.getElementById('panel-water');
    this.waterEditorPanelEl = document.getElementById('panel-water-editor');
    this.hint = document.getElementById('hint');
    this.stats = { fps: 0, saved: null };

    this._buildShell();
    this._bind();
    this.renderAll();
  }

  // ── 骨架 ──────────────────────────────────────────────────────────────────
  _buildShell() {
    // 顶栏：项目管理 / 模型编辑 / 水体编辑 / 图形选项
    this.toolbar.innerHTML = `
      <div class="brand">地形模型编辑<small>8 km 地形沙盘</small></div>
      <!-- 返回地形查看：dev 下主项目在 5173，构建后是 Pages 上一级目录 -->
      <a class="nav-btn" href="${import.meta.env?.DEV ? 'http://127.0.0.1:5173/' : '../'}"
         title="返回地形查看">← 地形查看</a>
      <nav class="nav">
        <div class="nav-group" data-group="project">
          <button class="nav-btn" data-menu="project">项目管理 ▾</button>
          <div class="menu">
            <button data-act="export">导出工程</button>
            <button data-act="import-project">导入工程</button>
            <div class="menu-sep"></div>
            <button data-act="reset" class="menu-danger">清空场景</button>
          </div>
        </div>
        <button class="nav-btn active" data-mode="models">模型编辑</button>
        <button class="nav-btn" data-mode="water">水体编辑</button>
        <div class="nav-group" data-group="graphics">
          <button class="nav-btn" data-menu="graphics">图形选项 ▾</button>
          <div class="menu">
            <button data-act="toggle-textures" class="on">贴图：开</button>
            <button data-act="toggle-collision" class="on">碰撞：开</button>
            <button data-act="toggle-water" class="on">水面：开</button>
            <button data-act="toggle-tags" class="on">标签显示：开</button>
            <div class="menu-sep"></div>
            <label class="menu-field">
              <span>薄雾强度 <b data-role="fog-value">1.0×</b></span>
              <input type="range" min="0" max="300" step="10" value="100" data-act="fog-range" />
            </label>
          </div>
        </div>
        <button class="nav-btn" data-act="tour"
                title="隐藏所有面板，进入无 UI 游览（相机带惯性与缓动）">游览</button>
      </nav>
      <div class="spacer"></div>
      <div class="stats" id="tb-stats">--</div>
    `;

    // 模型模式：左 = 场景资源（资源库 + 场景模型），右 = 模型编辑器
    this.modelsPanel.innerHTML = `
      <div class="panel-head">
        <span>场景资源</span>
        <span class="count" id="model-count-head">0 个</span>
      </div>
      <div class="panel-scroll">
        <div class="sub-head"><span>资源库</span><span class="count" id="lib-count">0</span></div>
        <div class="panel-body" id="lib-list"></div>
        <div class="row" style="padding:0 10px 6px">
          <button class="btn small primary" data-act="import">导入 glb 模型</button>
        </div>
        <div class="sub-head"><span>场景模型</span><span class="count" id="model-count">0</span></div>
        <div class="panel-body" id="model-list"></div>
      </div>
    `;

    this.inspectorPanelEl.innerHTML = `
      <div class="panel-head">
        <span>模型编辑</span>
        <span class="count" id="sel-hint"></span>
      </div>
      <div class="panel-scroll"><div id="inspector-body"></div></div>
    `;

    // 水体模式：左 = 水源列表，右 = 模拟参数 / 选中水源 / 外观（与模型模式对称）
    this.waterPanelEl.innerHTML = `
      <div class="panel-head">
        <span>水体模拟</span>
        <span class="count" id="water-count">0 个水源</span>
      </div>
      <div class="panel-scroll">
        <div class="row" style="padding:8px 10px 2px;gap:6px">
          <button class="btn small primary" data-act="water-add-source"
                  title="在地形上点选放置水源（可连续放置，Esc 结束）">＋水源</button>
          <button class="btn small" data-act="water-clear-sources"
                  title="删除全部水源（模拟会重新开始）">清空</button>
        </div>
        <div class="panel-body" id="water-list"></div>
      </div>
    `;

    this.waterEditorPanelEl.innerHTML = `
      <div class="panel-head">
        <span>水体模拟</span>
        <span class="count" id="water-sel-hint"></span>
      </div>
      <div class="panel-scroll"><div id="water-panel"></div></div>
    `;

    this.libList = this.modelsPanel.querySelector('#lib-list');
    this.modelList = this.modelsPanel.querySelector('#model-list');
    this.libCount = this.modelsPanel.querySelector('#lib-count');
    this.modelCount = this.modelsPanel.querySelector('#model-count');
    this.modelCountHead = this.modelsPanel.querySelector('#model-count-head');
    this.inspectorBody = this.inspectorPanelEl.querySelector('#inspector-body');
    this.selHint = this.inspectorPanelEl.querySelector('#sel-hint');
    this.waterList = this.waterPanelEl.querySelector('#water-list');
    this.waterCount = this.waterPanelEl.querySelector('#water-count');
    this.waterBody = this.waterEditorPanelEl.querySelector('#water-panel');
    this.waterSelHint = this.waterEditorPanelEl.querySelector('#water-sel-hint');
    this.statsEl = this.toolbar.querySelector('#tb-stats');
    this.hint.textContent = DEFAULT_HINT;
  }

  /** 模式切换：模型编辑 / 水体编辑（互斥，面板互不显示） */
  setMode(mode) {
    this.mode = mode === 'water' ? 'water' : 'models';
    const root = document.getElementById('ui');
    root?.classList.toggle('mode-models', this.mode === 'models');
    root?.classList.toggle('mode-water', this.mode === 'water');
    for (const btn of this.toolbar.querySelectorAll('[data-mode]')) {
      btn.classList.toggle('active', btn.dataset.mode === this.mode);
    }
    this._closeMenus();
    // 场景里的水源标记只在「水体编辑」模式下显示；离开时顺手结束放置
    if (this.mode !== 'water') this.waterEditor?.cancel?.();
    this.waterEditor?.setVisible?.(this.mode === 'water');
    if (this.mode === 'water') this.refreshWaterPanel();
    else this.renderAll();
    // 提示文案跟着模式走（cancel() 里可能已经把提示重置成旧模式的了）
    this.resetHint();
    this.onMode?.(this.mode);
  }

  _toggleMenu(name) {
    const group = this.toolbar.querySelector(`[data-group="${name}"]`);
    if (!group) return;
    const wasOpen = group.classList.contains('open');
    this._closeMenus();
    if (!wasOpen) group.classList.add('open');
  }

  _closeMenus() {
    for (const group of this.toolbar.querySelectorAll('.nav-group.open')) group.classList.remove('open');
  }

  _bind() {
    this.toolbar.addEventListener('click', (event) => {
      // 模式切换（模型编辑 / 水体编辑）
      const modeBtn = event.target.closest('[data-mode]');
      if (modeBtn) {
        this.setMode(modeBtn.dataset.mode);
        return;
      }
      // 下拉菜单开合
      const menuBtn = event.target.closest('[data-menu]');
      if (menuBtn) {
        this._toggleMenu(menuBtn.dataset.menu);
        return;
      }
      // 菜单项 / 面板按钮动作
      const btn = event.target.closest('button[data-act]');
      if (!btn) return;
      this._runAction(btn.dataset.act, btn);
      this._closeMenus();
    });

    // 点菜单以外的区域收起下拉
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.nav-group')) this._closeMenus();
    });

    // 图形选项里的薄雾滑杆：拖动实时生效
    this.toolbar.addEventListener('input', (event) => {
      const range = event.target?.closest?.('[data-act="fog-range"]');
      if (!range) return;
      this.onFogChange?.(Number(range.value) / 100);
    });

    // 资源库 / 模型列表 / 检查器共用的点击委托
    document.addEventListener('click', (event) => this._onClick(event));
    document.addEventListener('change', (event) => this._onChange(event));
    document.addEventListener('input', (event) => this._onInput(event));

    this.editor.addEventListener('change', (event) => {
      if (event.detail?.kind === 'transform') this.syncTransform();
      else if (event.detail?.kind === 'labels') this.syncLabelTexts();
      else this.renderAll();
    });
    this.editor.addEventListener('saved', (event) => {
      this.stats.saved = event.detail?.ok ? Date.now() : -1;
      this.renderStats();
    });
    this.library.subscribe(() => this.renderModels());
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────
  renderAll() {
    this.renderModels();
    this.renderInspector();
    this.renderStats();
  }

  renderStats() {
    const { fps } = this.stats;
    const saved = this.stats.saved;
    const savedText = saved === null ? '未修改' : saved === -1 ? '保存失败' : `已自动保存 ${new Date(saved).toLocaleTimeString()}`;
    this.statsEl.textContent = `${fps.toFixed(0)} fps · ${this.editor.models.length} 个实例 · ${this.library.all.length} 个资源 · ${savedText}`;
    this.statsEl.style.color = saved === -1 ? 'var(--warn)' : '';
  }

  renderModels() {
    const assets = this.library.all;
    this.libCount.textContent = `${assets.length} 个`;
    this.libList.innerHTML = '';

    const dirHint = document.createElement('div');
    dirHint.className = 'empty';
    dirHint.style.padding = '4px 6px 8px';
    dirHint.style.textAlign = 'left';
    dirHint.textContent = this.library.canWriteDir
      ? 'public/models · 网页导入会自动写入此目录'
      : 'public/models（静态清单）· 导入只存浏览器，可「导出到文件夹」';
    this.libList.append(dirHint);

    if (!assets.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '资源文件夹是空的。<br />把 .glb 放进 <code>public/models/</code>，或点「导入模型」。';
      this.libList.append(empty);
    }

    for (const asset of assets) {
      const row = document.createElement('div');
      row.className = 'model-item';
      row.innerHTML = `
        <span class="dot" style="background:${asset.source === 'dir' ? 'var(--accent)' : 'var(--accent-2)'}"></span>
        <span class="name" title="${esc(asset.name)}">${esc(asset.name)}</span>
        <span class="meta">${asset.source === 'dir' ? '' : '本地 · '}${fmtSize(asset.size)}</span>
        <button class="icon-btn" data-act="add-asset" data-key="${esc(asset.key)}" title="添加到场景">＋</button>
        ${
          asset.source === 'local'
            ? `<button class="icon-btn" data-act="move-local" data-key="${esc(asset.key)}" title="移入 public/models">⇥</button>
               <button class="icon-btn" data-act="download-local" data-key="${esc(asset.key)}" title="下载文件">⭳</button>
               <button class="icon-btn danger" data-act="remove-local" data-key="${esc(asset.key)}" title="从浏览器删除">✕</button>`
            : `<button class="icon-btn danger" data-act="remove-dir" data-key="${esc(asset.key)}" title="删除文件">✕</button>`
        }
      `;
      this.libList.append(row);
    }

    // 场景实例
    this.modelCount.textContent = `${this.editor.models.length} 个`;
    if (this.modelCountHead) this.modelCountHead.textContent = `${this.editor.models.length} 个`;
    this.modelList.innerHTML = '';
    if (!this.editor.models.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '还没有放置模型。<br />从上方资源库点「＋」添加。';
      this.modelList.append(empty);
    }
    for (const model of this.editor.models) {
      const row = document.createElement('div');
      row.className = `model-item${model.id === this.editor.selectedId ? ' active' : ''}`;
      row.dataset.modelId = model.id;
      row.innerHTML = `
        <span class="dot" style="background:${model.root.visible ? 'var(--accent)' : 'rgba(140,175,205,0.35)'}"></span>
        <span class="name" title="${esc(model.name)}">${esc(model.name)}</span>
        <span class="meta">${model.labels.length ? `${model.labels.length} 标签` : ''}</span>
        <button class="icon-btn" data-act="toggle-visible" data-model="${model.id}" title="显示/隐藏">${model.root.visible ? '◉' : '◌'}</button>
        <button class="icon-btn" data-act="duplicate" data-model="${model.id}" title="复制">⧉</button>
        <button class="icon-btn danger" data-act="delete-model" data-model="${model.id}" title="删除">✕</button>
      `;
      this.modelList.append(row);
    }
    this.renderStats();
  }

  renderInspector() {
    const editor = this.editor;
    const model = editor.selected;
    this.inspectorBody.innerHTML = '';
    this.selHint.textContent = model ? esc(model.name) : '未选择';

    if (!model) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML =
        '点击场景中的模型进行编辑。<br /><br />· 从左侧资源库添加模型<br />· 拖入 .glb 文件导入<br />· 选中后可改位置 / 旋转 / 缩放、复制、加标签';
      this.inspectorBody.append(empty);
      return;
    }

    const partPath = editor.selectedPartPath;
    const currentLabel = partPath ? pathToLabel(model.content, partPath) : '整个模型';

    // ① 部件（最上）：这里的点击决定下面「名称 / 变换 / 标签」作用于谁
    const parts = document.createElement('div');
    parts.className = 'section';
    parts.innerHTML = `
      <div class="section-title">
        <span>部件</span>
        <span style="font-weight:400;color:var(--dim)">点击选择编辑对象</span>
      </div>
    `;
    const tree = document.createElement('div');
    tree.className = 'tree';
    tree.dataset.role = 'part-tree';
    const list = collectParts(model.content);
    const rows = [
      `<div class="tree-node ${partPath ? '' : 'active'}" data-part-path="" data-model="${model.id}">
         <span class="kind">root</span><span class="nm">整个模型</span>
       </div>`,
      ...list.map((part) => {
        const active = partPath && part.path.join('.') === partPath.join('.');
        const tagged = model.labels.some((l) => l.nodePath && l.nodePath.join('.') === part.path.join('.'));
        return `<div class="tree-node ${active ? 'active' : ''} ${tagged ? 'has-tag' : ''}"
                     data-part-path="${part.path.join('.')}" data-model="${model.id}"
                     style="padding-left:${6 + part.depth * 10}px">
                   <span class="kind">${part.mesh ? 'mesh' : part.type.toLowerCase()}</span>
                   <span class="nm">${esc(part.name)}</span>
                 </div>`;
      }),
    ];
    tree.innerHTML = list.length ? rows.join('') : '<div class="empty">这个 glb 没有可编辑的子节点</div>';
    parts.append(tree);
    this.inspectorBody.append(parts);

    // ② 名称（当前选择：整体=模型名，部件=节点名）
    const nameSec = document.createElement('div');
    nameSec.className = 'section';
    nameSec.innerHTML = `
      <div class="section-title">
        <span>名称</span>
        <span style="font-weight:400;color:var(--dim)">${esc(currentLabel)}</span>
      </div>
      <input type="text" data-act="rename" value="${esc(editor.currentName())}" />
    `;
    this.inspectorBody.append(nameSec);

    // ③ 变换
    const transform = document.createElement('div');
    transform.className = 'section';
    const modeHint =
      this.gizmo.mode === 'rotate'
        ? '绕轴旋转（度）'
        : this.gizmo.mode === 'scale'
          ? '缩放（倍率）'
          : '位移（米）';
    transform.innerHTML = `
      <div class="section-title">
        <span>变换</span>
        <span style="font-weight:400;color:var(--dim)">${esc(currentLabel)} · ${modeHint}</span>
      </div>
      <div class="seg" data-role="gizmo-mode">
        <button data-mode="translate" class="${this.gizmo.mode === 'translate' ? 'active' : ''}">移动</button>
        <button data-mode="rotate" class="${this.gizmo.mode === 'rotate' ? 'active' : ''}">旋转</button>
        <button data-mode="scale" class="${this.gizmo.mode === 'scale' ? 'active' : ''}">缩放</button>
      </div>
      <div data-role="transform-inputs"></div>
    `;
    this.inspectorBody.append(transform);
    this._buildTransformInputs(transform.querySelector('[data-role="transform-inputs"]'), model);
    this.syncTransform();

    // ④ 标签（只作用于当前选择：整体=模型级，部件=该部件）
    const labels = document.createElement('div');
    labels.className = 'section';
    const scopedLabels = editor.labelsFor(model, partPath);
    const scopeName = partPath ? pathToLabel(model.content, partPath).split(' / ').pop() : '整个模型';
    labels.innerHTML = `
      <div class="section-title">
        <span>标签</span>
        <span style="font-weight:400;color:var(--dim)">${esc(scopeName)} · ${scopedLabels.length} 个</span>
      </div>
      <div class="row">
        <input type="text" class="grow" data-role="new-label-name"
               placeholder="标签名称（留空即用「${esc(scopeName)}」）" />
        <button class="btn small" data-act="add-label">+ 添加到${partPath ? '该部件' : '整个模型'}</button>
      </div>
      <div style="font-size:10.5px;color:var(--dim);line-height:1.5">
        默认「静态标注」，可在卡片上切换类型。
      </div>
      <div class="tag-list" data-role="tag-list"></div>
    `;
    this.inspectorBody.append(labels);
    this._renderTagList(labels.querySelector('[data-role="tag-list"]'), model, scopedLabels);

    // ⑤ 模型（最下：只保留贴地与删除）
    const modelSec = document.createElement('div');
    modelSec.className = 'section';
    modelSec.innerHTML = `
      <div class="section-title">模型</div>
      <div class="row">
        <button class="btn small" data-act="snap-ground" title="把模型包围盒最低点落回地表">贴地</button>
        <button class="btn small danger" data-act="delete-sel">删除模型</button>
      </div>
    `;
    this.inspectorBody.append(modelSec);
  }

  _buildTransformInputs(host, model) {
    const AXES = ['X', 'Y', 'Z'];
    const rows = [
      {
        field: 'position',
        label: 'P',
        step: 1,
        unit: 'm',
        rowTitle: '位置（米）',
        title: (axis) => `${axis} 轴位置（米）`,
      },
      {
        field: 'rotation',
        label: 'R',
        step: 5,
        unit: '°',
        rowTitle: '绕轴旋转（度）',
        title: (axis) => `绕 ${axis} 轴旋转（度）`,
      },
      {
        field: 'scale',
        label: 'S',
        step: 0.1,
        unit: '×',
        rowTitle: '缩放（倍率）',
        title: (axis) => `${axis} 轴缩放倍率`,
      },
    ];
    host.innerHTML = rows
      .map(
        (row) => `
      <div class="vec-row" title="${row.rowTitle}">
        <label>${row.label}</label>
        ${AXES.map(
          (axis, i) => `
          <div class="tv">
            <span class="axis ${axis.toLowerCase()}">${axis}</span>
            <input type="number" step="${row.step}" data-field="${row.field}" data-axis="${i}"
                   data-role="tv" title="${row.title(axis)}" />
          </div>`,
        ).join('')}
        <span class="unit">${row.unit}</span>
      </div>`,
      )
      .join('');
    this.transformHost = host;
  }

  /** 只刷新数字输入框（gizmo 拖动时高频调用） */
  syncTransform() {
    const editor = this.editor;
    const model = editor.selected;
    if (!model || !this.transformHost) return;
    const target = this._transformTarget();
    if (!target) return;
    const values = {
      position: target.position,
      rotation: {
        x: (target.rotation.x * 180) / Math.PI,
        y: (target.rotation.y * 180) / Math.PI,
        z: (target.rotation.z * 180) / Math.PI,
      },
      scale: target.scale,
    };
    for (const input of this.transformHost.querySelectorAll('input[data-role="tv"]')) {
      const field = input.dataset.field;
      const axis = Number(input.dataset.axis);
      const vec = values[field];
      const v = axis === 0 ? vec.x : axis === 1 ? vec.y : vec.z;
      if (document.activeElement === input) continue; // 正在输入时不要覆盖
      input.value = field === 'scale' ? Number(v.toFixed(3)) : Number(v.toFixed(2));
    }
  }

  _transformTarget() {
    const editor = this.editor;
    const model = editor.selected;
    if (!model) return null;
    if (editor.selectedPartPath) {
      return resolvePath(model.content, editor.selectedPartPath) ?? model.root;
    }
    return model.root;
  }

  _renderTagList(host, model, labels = model.labels) {
    host.innerHTML = '';
    if (!labels.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.style.padding = '8px';
      empty.textContent = '这个范围内还没有标签。';
      host.append(empty);
      return;
    }
    for (const label of labels) {
      const card = document.createElement('div');
      card.className = 'tag-card';
      card.dataset.labelId = label.id;
      card.innerHTML = `
        <div class="tag-head">
          <span class="badge ${label.kind}">${LABEL_KINDS[label.kind]?.short ?? label.kind}</span>
          <input type="text" class="tag-title" data-act="label-title" data-label="${label.id}" value="${esc(label.title)}" />
          <button class="icon-btn danger" data-act="remove-label" data-label="${label.id}" title="删除标签">✕</button>
        </div>
        <div class="tag-path" title="${esc(pathToLabel(model.content, label.nodePath))}">${esc(pathToLabel(model.content, label.nodePath))}</div>
        <div class="row">
          <button class="btn tiny ${label.kind === 'dynamic' ? 'on' : ''}" data-act="set-label-kind"
                  data-kind="dynamic" data-label="${label.id}" title="可被控制系统驱动的部件">动态结构</button>
          <button class="btn tiny ${label.kind === 'static' ? 'on' : ''}" data-act="set-label-kind"
                  data-kind="static" data-label="${label.id}" title="只读说明">静态标注</button>
        </div>
      `;
      host.append(card);
    }
  }

  syncLabelTexts() {
    // 标签标题输入时不重建 DOM：场景标签已由 TagLayer 更新，这里什么都不用做
  }

  // ── 事件处理 ──────────────────────────────────────────────────────────────
  _assetByKey(key) {
    return this.library.all.find((a) => a.key === key) ?? null;
  }

  _onClick(event) {
    // 顶栏内的动作由 toolbar 自己的 handler 处理，这里跳过以免重复执行
    if (event.target.closest('#toolbar')) return;
    const target = event.target.closest(
      '[data-act], .tree-node, .model-item[data-model-id], .model-item[data-source-id], .seg button',
    );
    if (!target) return;

    // 场景模型选择
    if (target.classList.contains('model-item') && target.dataset.modelId) {
      this.editor.select(target.dataset.modelId);
      return;
    }

    // 水源列表行点击 → 选中并打开编辑面板
    if (target.classList.contains('model-item') && target.dataset.sourceId) {
      this.water?.selectSource(target.dataset.sourceId);
      return;
    }

    // gizmo 模式 / 目标
    if (target.tagName === 'BUTTON' && target.closest('[data-role="gizmo-mode"]')) {
      this.gizmo.setMode(target.dataset.mode);
      this.editor.emitChange();
      return;
    }

    // 部件栏：点击决定「名称 / 变换 / 标签」作用于整体还是某个部件
    if (target.classList.contains('tree-node')) {
      const path = target.dataset.partPath;
      const modelId = target.dataset.model;
      const parsed = path ? path.split('.').map(Number) : null;
      this.editor.select(modelId, parsed);
      return;
    }

    const act = target.dataset.act;
    if (!act) return;
    const model = this.editor.selected;

    switch (act) {
      case 'add-asset': {
        const asset = this._assetByKey(target.dataset.key);
        if (asset) this.editor.addFromLibrary(asset);
        break;
      }
      case 'move-local': {
        const asset = this._assetByKey(target.dataset.key);
        if (!asset) break;
        this.library.moveLocalToDir(asset.id).then((res) => {
          if (!res.ok) alert(`移入 public/models 失败：${res.error}`);
        });
        break;
      }
      case 'download-local': {
        const asset = this._assetByKey(target.dataset.key);
        if (asset) this.library.downloadLocal(asset.id);
        break;
      }
      case 'remove-local': {
        const asset = this._assetByKey(target.dataset.key);
        if (asset) this.library.removeLocalAsset(asset.id);
        break;
      }
      case 'remove-dir': {
        const asset = this._assetByKey(target.dataset.key);
        if (!asset) break;
        if (!confirm(`删除 public/models/${asset.name}？（同时会移除引用它的场景实例）`)) break;
        this.library.removeDirFile(asset.name).then((res) => {
          if (!res.ok) alert(`删除失败：${res.error}`);
          else {
            for (const m of [...this.editor.models]) {
              if (m.asset.source === 'dir' && m.asset.name === asset.name) this.editor.removeModel(m.id);
            }
          }
        });
        break;
      }
      case 'toggle-visible':
        this.editor.setVisible(this.editor.models.find((m) => m.id === target.dataset.model), !this._modelVisible(target.dataset.model));
        break;
      case 'duplicate':
        this.editor.select(target.dataset.model);
        this.editor.duplicateSelected();
        break;
      case 'delete-model':
        this.editor.removeModel(target.dataset.model);
        break;
      case 'snap-ground': {
        const res = this.editor.snapToGround(model);
        if (!res) {
          this.toast('贴地失败：模型没有有效包围盒');
          break;
        }
        const moved = Math.abs(res.delta) < 0.5 ? '（本来就在地面上）' : `，底座移动 ${res.delta > 0 ? '+' : ''}${res.delta.toFixed(1)} m`;
        this.toast(`已贴地：底座落到 y = ${res.ground.toFixed(1)} m${moved}`);
        break;
      }
      case 'delete-sel':
        this.editor.removeSelected();
        break;
      case 'water-add-source': {
        // 已在放置模式时再点一次 = 结束放置
        if (this.waterEditor?.active) this.waterEditor.cancel();
        else if (this.onWaterAddSource) this.onWaterAddSource();
        else this.waterEditor?.startPlacement?.();
        break;
      }
      case 'water-placement-end':
        this.waterEditor?.cancel?.();
        break;
      case 'water-clear-sources': {
        const count = this._waterSources().length;
        if (!count) break;
        if (!confirm(`清空全部 ${count} 个水源？（模拟水面会重新开始）`)) break;
        this.water?.clearSources();
        break;
      }
      case 'water-source-remove': {
        const id = target.dataset.source;
        if (id) this.water?.removeSource(id);
        break;
      }
      case 'water-source-toggle': {
        const id = target.dataset.source;
        const source = this._waterSources().find((s) => s.id === id);
        if (source) this.water?.updateSource(id, { enabled: !source.enabled });
        break;
      }
      case 'water-pause-toggle':
        this.water?.setPaused(!this._waterSim().paused);
        break;
      case 'water-reset':
        if (this.onWaterReset) this.onWaterReset();
        else this.water?.reset();
        break;
      case 'water-save':
        this.onWaterSave?.();
        break;
      case 'add-label': {
        if (!model) break;
        const input = this.inspectorBody.querySelector('[data-role="new-label-name"]');
        const title = (input?.value ?? '').trim();
        const label = this.editor.addLabel({ title });
        if (input) input.value = '';
        if (label) this.toast(`已添加标签「${label.title}」（默认为静态标注，可在卡片上切换类型）`);
        break;
      }
      case 'set-label-kind':
        this.editor.updateLabel(target.dataset.label, { kind: target.dataset.kind });
        break;
      case 'remove-label':
        this.editor.removeLabel(target.dataset.label);
        break;

      // 面板里的按钮（导入、开关等）与顶栏共用同一套动作
      case 'import':
      case 'export':
      case 'import-project':
      case 'toggle-tags':
      case 'toggle-textures':
      case 'toggle-collision':
      case 'toggle-water':
      case 'reset':
        this._runAction(act, target);
        break;
      default:
        break;
    }
  }

  _modelVisible(id) {
    return this.editor.models.find((m) => m.id === id)?.root.visible ?? true;
  }

  _onChange(event) {
    const el = event.target;
    const act = el.dataset?.act;
    const model = this.editor.selected;

    // ── 水体模拟：select / checkbox / 数字输入（滑杆走 _onInput）────────────────
    if (act === 'water-resolution') {
      this._waterApply(() => this.water?.setResolution(Number(el.value)));
      return;
    }
    if (act === 'water-source-enabled') {
      const id = this._selectedWaterSource()?.id;
      if (id) this._waterApply(() => this.water?.updateSource(id, { enabled: el.checked }));
      return;
    }
    if (act === 'water-source-target') {
      const id = this._selectedWaterSource()?.id;
      if (id) this._waterApply(() => this.water?.updateSource(id, { targetLevel: parseTargetLevel(el.value) }));
      // 失焦后按归一化结果重绘（0 / 留空 → 不限制）
      this.refreshWaterPanel();
      return;
    }
    if (act === 'water-source-name') {
      // 名称在 input 事件里已经写入，失焦时刷新列表文案
      this.refreshWaterPanel();
      return;
    }

    if (act === 'rename' && model) {
      // 名称随当前选择：整体改模型名，部件改节点名；空值回退
      if (!this.editor.renameCurrent(el.value)) el.value = this.editor.currentName();
      return;
    }
    if (el.dataset?.field && el.dataset?.role === 'tv') this._commitTransformInput(el);
  }

  _onInput(event) {
    const el = event.target;
    const act = el.dataset?.act;
    const water = this.water;

    // ── 水体模拟：拖动滑杆实时生效；只调 water，不让面板整块重建（避免丢焦点）──
    if (water && act === 'water-sim-speed') {
      this._waterApply(() => water.setSimSpeed(Number(el.value)));
      this._setRangeValue(el, `${Number(el.value).toFixed(1)}×`);
      return;
    }
    if (water && act === 'water-amount') {
      this._waterApply(() => water.setWaterAmount(Number(el.value)));
      this._setRangeValue(el, `${Number(el.value).toFixed(0)} 米`);
      return;
    }
    if (water && act === 'water-shimmer') {
      this._waterApply(() => water.setVisual({ shimmer: Number(el.value) }));
      this._setRangeValue(el, Number(el.value).toFixed(2));
      return;
    }
    if (water && act === 'water-ripple') {
      this._waterApply(() => water.setVisual({ ripple: Number(el.value) }));
      this._setRangeValue(el, Number(el.value).toFixed(2));
      return;
    }
    if (water && act === 'water-clarity') {
      this._waterApply(() => water.setVisual({ clarity: Number(el.value) }));
      this._setRangeValue(el, Number(el.value).toFixed(2));
      return;
    }
    if (water && act === 'water-source-radius') {
      const id = this._selectedWaterSource()?.id;
      if (id) {
        this._waterApply(() => water.updateSource(id, { radius: Number(el.value) }));
        this._setRangeValue(el, `${Number(el.value).toFixed(0)} 米`);
      }
      return;
    }
    if (water && act === 'water-source-name') {
      const id = this._selectedWaterSource()?.id;
      if (id) this._waterApply(() => water.updateSource(id, { name: el.value }));
      return;
    }

    // 标签只有名称可编辑（类型是按钮选择）
    if (act === 'label-title') this.editor.updateLabel(el.dataset.label, { title: el.value });
    else if (el.dataset?.role === 'tv') this._commitTransformInput(el);
  }

  /** 数值输入 → 模型或部件变换 */
  _commitTransformInput(input) {
    const editor = this.editor;
    const model = editor.selected;
    if (!model) return;
    const field = input.dataset.field;
    const axis = Number(input.dataset.axis);
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;

    const target = this._transformTarget();
    if (!target) return;

    if (field === 'position') target.position.setComponent(axis, value);
    else if (field === 'rotation') {
      const arr = [target.rotation.x, target.rotation.y, target.rotation.z];
      arr[axis] = (value * Math.PI) / 180;
      target.rotation.set(arr[0], arr[1], arr[2]);
    } else target.scale.setComponent(axis, Math.max(0.001, value));

    if (target !== model.root && editor.selectedPartPath) {
      editor.recordPartTransform(model, target, editor.selectedPartPath);
    }
    editor.emitChange('transform');
    editor.scheduleSave();
  }

  setFps(fps) {
    this.stats.fps = fps;
    this.renderStats();
    // 水体模式右下角的模拟步数 / 状态每 0.25s 跟着刷新
    if (this.mode === 'water') this.renderWaterStats();
  }

  /** 更新工具栏「贴图」开关的文案/高亮（地形无瓦片时在提示里说明） */
  setTextureState(enabled, { hasTerrainTexture = true } = {}) {
    const btn = this.toolbar.querySelector('[data-act="toggle-textures"]');
    if (!btn) return;
    btn.textContent = enabled ? '贴图：开' : '贴图：关';
    btn.classList.toggle('on', enabled);
    const scope = hasTerrainTexture
      ? '地形卫星影像 + 模型自带贴图'
      : '模型自带贴图（当前没有卫星瓦片，地形仍是高程分层）';
    btn.title = enabled ? `全局贴图开启：${scope}` : `全局贴图关闭：地形回高程分层、模型回纯色`;
  }

  /** 更新工具栏「碰撞」开关的文案/高亮 */
  setCollisionState(enabled) {
    const btn = this.toolbar.querySelector('[data-act="toggle-collision"]');
    if (!btn) return;
    btn.textContent = enabled ? '碰撞：开' : '碰撞：关';
    btn.classList.toggle('on', enabled);
    btn.title = enabled
      ? '相机碰撞开启：不会钻进地形，也不会飞出土地方形边界'
      : '相机碰撞关闭：可以钻到地形以下、飞出边界（自由穿行）';
  }

  /** 水面总开关的按钮状态（水体模拟的总开关，main 负责 setEnabled） */
  setWaterState(enabled) {
    const btn = this.toolbar.querySelector('[data-act="toggle-water"]');
    if (!btn) return;
    btn.textContent = enabled ? '水面：开' : '水面：关';
    btn.classList.toggle('on', enabled);
    btn.title = enabled ? '水体模拟总开关：正在显示模拟水面' : '水体模拟总开关：已隐藏模拟水面';
  }

  // ── 水体模拟面板 ──────────────────────────────────────────────────────────
  _waterSources() {
    return this.water?.state?.sources ?? [];
  }

  _waterSim() {
    return this.water?.state?.sim ?? WATER_SIM_FALLBACK;
  }

  _waterVisual() {
    return this.water?.state?.visual ?? WATER_VISUAL_FALLBACK;
  }

  _selectedWaterSource() {
    const id = this.water?.selectedId;
    if (!id) return null;
    return this._waterSources().find((source) => source.id === id) ?? null;
  }

  /** 包住一次 water 调用：期间 water.onChange 触发的面板刷新直接跳过（滑杆不丢焦点） */
  _waterApply(fn) {
    this._suppressWaterRender = true;
    try {
      fn();
    } finally {
      this._suppressWaterRender = false;
    }
  }

  /** 滑杆旁边的数值显示（拖动时只改这一个 <b>，不重建面板） */
  _setRangeValue(input, text) {
    const out = input.closest('.field')?.querySelector('span b');
    if (out) out.textContent = text;
  }

  /** 水体数据/选中变化后刷新：列表 + 编辑面板 + 场景水源标记 */
  refreshWaterPanel() {
    if (this._suppressWaterRender) return;
    this.renderWaterList();
    this.renderWaterInspector();
    this.renderWaterStats();
    this.waterEditor?.syncNodes?.(); // 场景标记跟着数据 / 选中变化
  }

  /** 底部状态文字：模拟步数 / 水源数（每 0.25s 由 setFps 顺带刷新） */
  renderWaterStats() {
    const host = this.waterBody?.querySelector?.('[data-role="water-stats"]');
    if (!host) return;
    const stats = this.water?.stats ?? {};
    const steps = Number.isFinite(stats.steps) ? stats.steps : 0;
    const sourceCount = Number.isFinite(stats.sourceCount) ? stats.sourceCount : this._waterSources().length;
    const paused = stats.paused ?? this._waterSim().paused;
    const wet = Number.isFinite(stats.wetCells) ? ` · ${stats.wetCells} 个湿格` : '';
    const depth = Number.isFinite(stats.maxDepthMeters) ? ` · 最深 ${stats.maxDepthMeters.toFixed(2)} m` : '';
    host.textContent = `步数 ${steps} · 水源 ${sourceCount}${wet}${depth}${paused ? ' · 已暂停' : ''}`;
  }

  /** 菜单/开关按钮的文案与高亮 */
  _syncToggle(btn, enabled, label) {
    btn.classList.toggle('on', enabled);
    btn.textContent = `${label}：${enabled ? '开' : '关'}`;
  }

  /** 薄雾强度：滑杆位置 + 数值显示 */
  setFogState(scale) {
    const range = this.toolbar.querySelector('[data-act="fog-range"]');
    if (range && document.activeElement !== range) range.value = String(Math.round(scale * 100));
    const out = this.toolbar.querySelector('[data-role="fog-value"]');
    if (out) out.textContent = `${scale.toFixed(1)}×`;
  }

  /** 游览模式：隐藏全部 UI 与场景标签，只留右下角退出按钮 */
  setTourState(on) {
    const tour = Boolean(on);
    document.body.classList.toggle('tour-mode', tour);
    const exit = document.getElementById('tour-exit');
    if (exit) exit.hidden = !tour;
  }

  /** 顶栏菜单与面板按钮共用的动作分派 */
  _runAction(act, btn) {
    if (act === 'import') this.onImportFiles?.();
    else if (act === 'export') this.onExportProject?.();
    else if (act === 'import-project') this.onImportProject?.();
    else if (act === 'toggle-tags') {
      this.editor.setShowTags(!this.editor.showTags);
      this._syncToggle(btn, this.editor.showTags, '标签显示');
    } else if (act === 'toggle-textures') this.onToggleTextures?.();
    else if (act === 'toggle-collision') this.onToggleCollision?.();
    else if (act === 'toggle-water') this.onToggleWater?.();
    else if (act === 'tour') this.onToggleTour?.();
    else if (act === 'reset') {
      if (confirm('清空所有场景模型与本地工程？（资源文件夹里的 glb 不会被删除）')) this.onReset?.();
    }
  }

  /** 水源列表：名称 / 地面高程 / 半径 / 启用状态 / 删除，点击选中 */
  renderWaterList() {
    if (!this.waterList) return;
    const sources = this._waterSources();
    const selectedId = this.water?.selectedId ?? null;
    this.waterList.innerHTML = '';
    if (this.waterCount) this.waterCount.textContent = `${sources.length} 个水源`;

    if (!sources.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '还没有水源。<br />点上方「＋水源」，在地形上点选放置。';
      this.waterList.append(empty);
      return;
    }

    for (const source of sources) {
      const active = source.id === selectedId;
      const ground = this.water?.groundMetersAt?.(source.x, source.z);
      const groundText = Number.isFinite(ground) ? `${ground.toFixed(1)} m` : '--';
      const radiusText = Number.isFinite(source.radius) ? `${Math.round(source.radius)} m` : '--';
      const row = document.createElement('div');
      row.className = `model-item${active ? ' active' : ''}`;
      row.dataset.sourceId = source.id;
      row.title = `x ${Number(source.x).toFixed(1)} · z ${Number(source.z).toFixed(1)}`;
      row.innerHTML = `
        <span class="dot" style="background:${source.enabled ? 'var(--accent-2)' : 'rgba(140,175,205,0.35)'}"></span>
        <span class="name" title="${esc(source.name)}">${esc(source.name)}</span>
        <span class="meta">地面 ${groundText} · R ${radiusText}</span>
        <button class="icon-btn ${source.enabled ? 'on' : ''}" data-act="water-source-toggle" data-source="${source.id}"
                title="${source.enabled ? '停用这个水源' : '启用这个水源'}">${source.enabled ? '◉' : '◌'}</button>
        <button class="icon-btn danger" data-act="water-source-remove" data-source="${source.id}" title="删除水源">✕</button>
      `;
      this.waterList.append(row);
    }
  }

  /** 右面板：放置提示 / 模拟参数 / 选中水源 / 外观 / 保存 + 状态 */
  renderWaterInspector() {
    if (!this.waterBody) return;
    this.waterBody.innerHTML = '';

    // 放置模式：只显示放置提示 + 结束按钮
    if (this.waterEditor?.active) {
      if (this.waterSelHint) this.waterSelHint.textContent = '放置模式';
      const box = document.createElement('div');
      box.className = 'section';
      box.innerHTML = `
        <div class="section-title">
          <span>放置水源</span>
          <span style="font-weight:400;color:var(--dim)">可连续放置</span>
        </div>
        <div class="hint-line">
          在地形上点击放置水源（左键拖动仍然是转视角，不会误放点）。Esc 或下方按钮结束放置。
        </div>
        <button class="btn small primary" data-act="water-placement-end">结束放置</button>
      `;
      this.waterBody.append(box);
      return;
    }

    const source = this._selectedWaterSource();
    if (this.waterSelHint) this.waterSelHint.textContent = source ? source.name : '未选择水源';

    // ① 模拟参数
    const sim = this._waterSim();
    const simSection = document.createElement('div');
    simSection.className = 'section';
    const resolutionOptions = WATER_RESOLUTIONS.map(
      (value) => `<option value="${value}" ${value === sim.resolution ? 'selected' : ''}>${value}</option>`,
    ).join('');
    simSection.innerHTML = `
      <div class="section-title">
        <span>模拟参数</span>
        <span style="font-weight:400;color:var(--dim)">${this._waterSources().length} 个水源</span>
      </div>
      <label class="field"><span>模拟速度 <b>${Number(sim.speed).toFixed(1)}×</b></span>
        <input type="range" data-act="water-sim-speed" min="0.1" max="4" step="0.1" value="${sim.speed}" />
      </label>
      <label class="field"><span>每次注水量 <b>${Math.round(sim.waterAmount)} 米</b></span>
        <input type="range" data-act="water-amount" min="1" max="300" step="1" value="${Math.round(sim.waterAmount)}" />
      </label>
      <div class="row">
        <label class="field grow"><span>模拟精度</span>
          <select data-act="water-resolution">${resolutionOptions}</select>
        </label>
        <div class="field grow"><span>模拟</span>
          <button class="btn small ${sim.paused ? 'primary' : ''}" data-act="water-pause-toggle">
            ${sim.paused ? '继续' : '暂停'}
          </button>
        </div>
      </div>
      <div class="row">
        <button class="btn small" data-act="water-reset" title="把水位与流量清零，重新开始模拟">重置模拟</button>
      </div>
      <div class="hint-line">
        模拟域自动覆盖整个 8 km 地形；精度越高越细腻，但 GPU 开销也越大。
      </div>
    `;
    this.waterBody.append(simSection);

    // ② 选中水源
    if (source) {
      const ground = this.water?.groundMetersAt?.(source.x, source.z);
      const groundText = Number.isFinite(ground) ? `${ground.toFixed(1)} m` : '--';
      const targetValue = source.targetLevel == null ? '' : Number(source.targetLevel.toFixed(1));
      const editSection = document.createElement('div');
      editSection.className = 'section';
      editSection.innerHTML = `
        <div class="section-title">
          <span>选中水源</span>
          <span style="font-weight:400;color:var(--dim)">x ${Number(source.x).toFixed(1)} · z ${Number(source.z).toFixed(1)}</span>
        </div>
        <label class="field"><span>名称</span>
          <input type="text" data-act="water-source-name" value="${esc(source.name)}" />
        </label>
        <div class="field"><span>地面高程 <b>${groundText}</b></span>
          <div class="readout">随水源位置自动更新（只读）</div>
        </div>
        <label class="field"><span>水源半径 <b>${Math.round(source.radius)} 米</b></span>
          <input type="range" data-act="water-source-radius" min="20" max="2000" step="10" value="${Math.round(source.radius)}" />
        </label>
        <label class="field"><span>目标水面高程（米，0 = 不限制）</span>
          <input type="number" step="1" data-act="water-source-target" value="${targetValue}"
                 placeholder="0 / 留空 = 不限制" />
        </label>
        <label class="field inline">
          <input type="checkbox" data-act="water-source-enabled" ${source.enabled ? 'checked' : ''} />
          <span>启用这个水源</span>
        </label>
        <button class="btn small danger" data-act="water-source-remove" data-source="${source.id}">删除这个水源</button>
      `;
      this.waterBody.append(editSection);
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.style.padding = '14px 12px';
      empty.innerHTML = '从左侧列表或场景里的标记选择一个水源<br />可改名称 / 半径 / 目标水面高程。';
      this.waterBody.append(empty);
    }

    // ③ 外观
    const visual = this._waterVisual();
    const visualSection = document.createElement('div');
    visualSection.className = 'section';
    visualSection.innerHTML = `
      <div class="section-title"><span>外观</span></div>
      <label class="field"><span>太阳高光 <b>${Number(visual.shimmer).toFixed(2)}</b></span>
        <input type="range" data-act="water-shimmer" min="0" max="3" step="0.05" value="${visual.shimmer}" />
      </label>
      <label class="field"><span>波纹强度 <b>${Number(visual.ripple).toFixed(2)}</b></span>
        <input type="range" data-act="water-ripple" min="0" max="2" step="0.05" value="${visual.ripple}" />
      </label>
      <label class="field"><span>水体清澈度 <b>${Number(visual.clarity).toFixed(2)}</b></span>
        <input type="range" data-act="water-clarity" min="0" max="1" step="0.01" value="${visual.clarity}" />
      </label>
      <div class="hint-line">清澈度 0 = 浑浊、1 = 通透；太阳高光与波纹强度控制水面质感。</div>
    `;
    this.waterBody.append(visualSection);

    // ④ 保存 + 状态
    const saveSection = document.createElement('div');
    saveSection.className = 'section';
    saveSection.innerHTML = `
      <div class="row">
        <button class="btn small primary" data-act="water-save" title="立即保存到本地工程">保存</button>
      </div>
      <div class="water-stats" data-role="water-stats"></div>
    `;
    this.waterBody.append(saveSection);
    this.renderWaterStats();
  }

  toast(message) {
    this.hint.textContent = message;
    this.hint.style.color = 'var(--text)';
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => this.resetHint(), 6000);
  }

  /** 恢复默认提示（放置结束/取消、卡点提示过期时用） */
  resetHint() {
    clearTimeout(this._hintTimer);
    this.hint.style.color = '';
    this.hint.textContent = this._defaultHint();
  }

  /** 当前模式的默认提示文案 */
  _defaultHint() {
    return this.mode === 'water' ? WATER_HINT : DEFAULT_HINT;
  }
}
