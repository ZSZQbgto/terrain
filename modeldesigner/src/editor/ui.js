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

export class Ui {
  constructor({
    editor,
    library,
    gizmo,
    waterSystem,
    waterEditor,
    onImportFiles,
    onImportProject,
    onExportProject,
    onReset,
    onToggleTextures,
    onToggleCollision,
    onToggleWater,
    onDrawArea,
    onDrawFlow,
    onWaterUndo,
    onWaterRedraw,
    onWaterSave,
    onWaterUndoPoint,
    onWaterFinish,
    onWaterCancel,
    onFogChange,
    onToggleTour,
    onMode,
  }) {
    this.editor = editor;
    this.library = library;
    this.gizmo = gizmo;
    this.waterSystem = waterSystem ?? null;
    this.waterEditor = waterEditor ?? null;
    this.onImportFiles = onImportFiles;
    this.onImportProject = onImportProject;
    this.onExportProject = onExportProject;
    this.onReset = onReset;
    this.onToggleTextures = onToggleTextures;
    this.onToggleCollision = onToggleCollision;
    this.onToggleWater = onToggleWater;
    this.onDrawArea = onDrawArea;
    this.onDrawFlow = onDrawFlow;
    this.onWaterUndo = onWaterUndo;
    this.onWaterRedraw = onWaterRedraw;
    this.onWaterSave = onWaterSave;
    this.onWaterUndoPoint = onWaterUndoPoint;
    this.onWaterFinish = onWaterFinish;
    this.onWaterCancel = onWaterCancel;
    this.onFogChange = onFogChange;
    this.onToggleTour = onToggleTour;
    this.onMode = onMode;
    this.mode = 'models';

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

    // 水体模式：左 = 水体对象列表，右 = 选中对象的编辑面板（与模型模式对称）
    this.waterPanelEl.innerHTML = `
      <div class="panel-head">
        <span>水体对象</span>
        <span class="count" id="water-count">0 个</span>
      </div>
      <div class="panel-scroll">
        <div class="row" style="padding:8px 10px 2px;gap:6px">
          <button class="btn small primary" data-act="draw-area"
                  title="在地形上点选围出水面区域，双击完成">＋水面区域</button>
          <button class="btn small primary" data-act="draw-flow"
                  title="点起点→途经点→终点，双击完成，生成流动水">＋流动水</button>
        </div>
        <div class="panel-body" id="water-list"></div>
      </div>
    `;

    this.waterEditorPanelEl.innerHTML = `
      <div class="panel-head">
        <span>水体编辑</span>
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
    if (this.mode === 'water') this.refreshWaterPanel();
    else this.renderAll();
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
      '[data-act], .tree-node, .model-item[data-model-id], .model-item[data-water-id], .seg button',
    );
    if (!target) return;

    // 场景模型选择
    if (target.classList.contains('model-item') && target.dataset.modelId) {
      this.editor.select(target.dataset.modelId);
      return;
    }

    // 水体列表行点击 → 选中并打开编辑面板
    if (target.classList.contains('model-item') && target.dataset.waterId) {
      this.waterSystem?.select({ kind: target.dataset.waterKind, id: target.dataset.waterId });
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
      case 'water-delete': {
        const sel = this.waterSystem?.selected;
        if (!sel) break;
        if (sel.kind === 'area') this.waterSystem.removeArea(sel.id);
        else this.waterSystem.removeFlow(sel.id);
        break;
      }
      case 'water-select': {
        const kind = target.dataset.kind;
        const id = target.dataset.id;
        if (kind && id) this.waterSystem?.select({ kind, id });
        break;
      }
      case 'water-remove': {
        const kind = target.dataset.kind;
        const id = target.dataset.id;
        if (!kind || !id) break;
        if (kind === 'area') this.waterSystem.removeArea(id);
        else this.waterSystem.removeFlow(id);
        break;
      }
      case 'water-undo-point':
        this.onWaterUndoPoint?.();
        break;
      case 'water-finish':
        this.onWaterFinish?.();
        break;
      case 'water-cancel':
        this.onWaterCancel?.();
        break;
      case 'water-undo':
        this.onWaterUndo?.();
        break;
      case 'water-redraw':
        this.onWaterRedraw?.();
        break;
      case 'water-save':
        this.onWaterSave?.();
        break;
      case 'water-label-add': {
        const sel = this.waterSystem?.selected;
        if (!sel) break;
        const input = this.inspectorBody.querySelector('[data-role="water-label-name"]');
        this.waterSystem.addWaterLabel(sel.kind, sel.id, input?.value ?? '');
        if (input) input.value = '';
        break;
      }
      case 'water-label-remove': {
        const sel = this.waterSystem?.selected;
        if (sel) this.waterSystem.removeWaterLabel(sel.kind, sel.id, target.dataset.label);
        break;
      }
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

      // 面板里的按钮（水体添加、导入、开关等）与顶栏共用同一套动作
      case 'import':
      case 'export':
      case 'import-project':
      case 'draw-area':
      case 'draw-flow':
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

    if (act === 'rename' && model) {
      // 名称随当前选择：整体改模型名，部件改节点名；空值回退
      if (!this.editor.renameCurrent(el.value)) el.value = this.editor.currentName();
      return;
    }
    if (act === 'water-rename') {
      this._updateWater({ name: el.value });
      return;
    }
    if (act === 'flow-point-width' || act === 'flow-point-dir') {
      this._setFlowPoint(
        Number(el.dataset.index),
        act === 'flow-point-width'
          ? { width: Math.max(0.5, Number(el.value) || 0.5) }
          : { dir: Number(el.value) || 0 },
      );
      return;
    }
    if (el.dataset?.field && el.dataset?.role === 'tv') this._commitTransformInput(el);
  }

  _onInput(event) {
    const el = event.target;
    const act = el.dataset?.act;
    // 标签只有名称可编辑（类型是按钮选择）
    if (act === 'label-title') this.editor.updateLabel(el.dataset.label, { title: el.value });
    else if (act === 'water-level') this._updateWaterSilently({ level: Number(el.value) });
    else if (act === 'water-speed') this._updateWaterSilently({ speed: Number(el.value) });
    else if (act === 'water-width') this._updateWaterSilently({ width: Number(el.value) });
    else if (act === 'water-label-title') {
      const sel = this.waterSystem?.selected;
      if (sel) {
        this._suppressWaterRender = true;
        try {
          this.waterSystem.updateWaterLabel(sel.kind, sel.id, el.dataset.label, { title: el.value });
        } finally {
          this._suppressWaterRender = false;
        }
      }
    } else if (el.dataset?.role === 'tv') this._commitTransformInput(el);
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

  /** 水面总开关的按钮状态 */
  setWaterState(enabled) {
    const btn = this.toolbar.querySelector('[data-act="toggle-water"]');
    if (!btn) return;
    btn.textContent = enabled ? '水面：开' : '水面：关';
    btn.classList.toggle('on', enabled);
    btn.title = enabled ? '水面总开关：正在显示所有水面区域与流动水' : '水面总开关：已隐藏所有水面区域与流动水';
  }

  /** 水面数据/选中变化后刷新：列表 + 编辑面板 */
  refreshWaterPanel() {
    if (this._suppressWaterRender) return;
    this.renderWaterList();
    this.renderWaterInspector();
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
    else if (act === 'draw-area') this.onDrawArea?.();
    else if (act === 'draw-flow') this.onDrawFlow?.();
    else if (act === 'tour') this.onToggleTour?.();    else if (act === 'reset') {
      if (confirm('清空所有场景模型与本地工程？（资源文件夹里的 glb 不会被删除）')) this.onReset?.();
    }
  }

  /** 水体列表：水面区域 + 流动水，点击选中后打开编辑面板 */
  renderWaterList() {
    const ws = this.waterSystem;
    if (!this.waterList || !ws) return;
    this.waterList.innerHTML = '';
    const items = [
      ...ws.state.areas.map((item) => ({ kind: 'area', item })),
      ...ws.state.flows.map((item) => ({ kind: 'flow', item })),
    ];
    this.waterCount.textContent = `${items.length} 个`;

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '还没有水体对象。<br />点上方「＋水面区域」或「＋流动水」开始绘制。';
      this.waterList.append(empty);
      return;
    }

    for (const { kind, item } of items) {
      const active = ws.selected?.kind === kind && ws.selected?.id === item.id;
      const row = document.createElement('div');
      row.className = `model-item${active ? ' active' : ''}`;
      row.dataset.waterKind = kind;
      row.dataset.waterId = item.id;
      row.innerHTML = `
        <span class="dot" style="background:${kind === 'area' ? 'var(--accent)' : 'var(--accent-2)'}"></span>
        <span class="name" title="${esc(item.name)}">${esc(item.name)}</span>
        <span class="meta">${kind === 'area' ? `水面 ${item.points.length} 点` : `流动 ${item.points.length} 点`}</span>
        <button class="icon-btn danger" data-act="water-remove" data-kind="${kind}" data-id="${item.id}" title="删除">✕</button>
      `;
      this.waterList.append(row);
    }
  }

  /** 改流动水某个关键点的宽度 / 横向朝向，并重建水带 */
  _setFlowPoint(index, patch) {
    const ws = this.waterSystem;
    if (!ws || ws.selected?.kind !== 'flow' || !Number.isInteger(index)) return;
    const flow = ws.selectedItem;
    if (!flow || !flow.points[index]) return;
    const points = flow.points.map((p, i) => (i === index ? { ...p, ...patch } : p));
    this._suppressWaterRender = true;
    try {
      ws.updateFlow(flow.id, { points });
    } finally {
      this._suppressWaterRender = false;
    }
    this.refreshWaterPanel();
  }

  _updateWater(patch) {
    const ws = this.waterSystem;
    const sel = ws?.selected;
    if (!sel) return;
    if (sel.kind === 'area') {
      const allowed = {};
      if (patch.name != null) allowed.name = patch.name;
      if (patch.level != null && Number.isFinite(patch.level)) allowed.level = patch.level;
      ws.updateArea(sel.id, allowed);
    } else {
      const allowed = {};
      if (patch.name != null) allowed.name = patch.name;
      if (patch.speed != null && Number.isFinite(patch.speed)) allowed.speed = Math.max(0.05, patch.speed);
      if (patch.width != null && Number.isFinite(patch.width)) allowed.width = Math.max(1, patch.width);
      ws.updateFlow(sel.id, allowed);
    }
  }

  _updateWaterSilently(patch) {
    this._suppressWaterRender = true;
    try {
      this._updateWater(patch);
    } finally {
      this._suppressWaterRender = false;
    }
  }

  /** 水体检查器：名称 / 高度（区域）或流速宽度（流动水）/ 撤回·编辑·保存 / 水体标签 / 删除 */
  renderWaterInspector() {
    if (!this.waterBody) return;

    // 绘制中（从第一个点开始）就显示草稿面板
    if (this.waterEditor?.active) {
      this.renderWaterDraft();
      return;
    }

    const ws = this.waterSystem;
    const sel = ws?.selected;
    const item = ws?.selectedItem;
    this.waterBody.innerHTML = '';
    if (this.waterSelHint) this.waterSelHint.textContent = '';
    if (!sel || !item) {
      const hint = document.createElement('div');
      hint.className = 'empty';
      hint.style.padding = '14px 12px';
      hint.innerHTML = '从左侧列表选择水面区域或流动水<br />选中后可改名称 / 高度 / 流速。';
      this.waterBody.append(hint);
      return;
    }
    const isArea = sel.kind === 'area';
    if (this.waterSelHint) this.waterSelHint.textContent = isArea ? '水面区域' : '流动水';

    // 重新编辑 / 保存（「撤回」只用于绘制中的撤点，见草稿面板）
    const actions = document.createElement('div');
    actions.className = 'section';
    actions.innerHTML = `
      <div class="row">
        <button class="btn small" data-act="water-redraw" title="重新点选边界 / 路径，替换当前对象">重新编辑</button>
        <button class="btn small primary" data-act="water-save" title="立即保存到本地工程">保存</button>
      </div>
    `;
    this.waterBody.append(actions);

    const base = document.createElement('div');
    base.className = 'section';
    base.innerHTML = `
      <div class="section-title">
        <span>${isArea ? '水面区域' : '流动水'}</span>
        <span style="font-weight:400;color:var(--dim)">${item.points.length} 个选点</span>
      </div>
      <label class="field"><span>名称 / 标签</span>
        <input type="text" data-act="water-rename" value="${esc(item.name)}" />
      </label>
      ${
        isArea
          ? `<div class="field"><span>水面高度（米）</span>
               <input type="number" step="0.5" data-act="water-level" value="${item.level.toFixed(2)}" />
             </div>
             <div style="font-size:10.5px;color:var(--dim);line-height:1.5">
               高度取自选点地表高程的平均值，可在此微调；整块水面保持水平。
             </div>`
          : `<div class="row">
               <label class="field grow"><span>流速（倍率）</span>
                 <input type="number" step="0.1" min="0.05" data-act="water-speed" value="${item.speed}" />
               </label>
               <label class="field grow"><span>宽度（米）</span>
                 <input type="number" step="1" min="1" data-act="water-width" value="${item.width}" />
               </label>
             </div>
             <div style="font-size:10.5px;color:var(--dim);line-height:1.5">
               水贴图沿路径方向滚动，流速越大动画越快。
             </div>`
      }
    `;
    this.waterBody.append(base);

    // 关键点：每个点可单独调宽度与横向朝向（水带贴模型表面时尤其有用）
    if (!isArea) {
      const keys = document.createElement('div');
      keys.className = 'section';
      keys.innerHTML = `
        <div class="section-title">
          <span>关键点</span>
          <span style="font-weight:400;color:var(--dim)">每点独立宽度 / 方向</span>
        </div>
        ${item.points
          .map(
            (p, i) => `
          <div class="row" style="align-items:center;gap:6px;margin-bottom:4px">
            <span class="badge" style="flex:none">P${i + 1}</span>
            <label class="field grow" style="margin:0"><span>宽 m</span>
              <input type="number" step="1" min="0.5" data-act="flow-point-width" data-index="${i}"
                     value="${(Number.isFinite(p.width) ? p.width : item.width).toFixed(1)}" />
            </label>
            <label class="field grow" style="margin:0"><span>方向 °</span>
              <input type="number" step="5" data-act="flow-point-dir" data-index="${i}"
                     value="${Number.isFinite(p.dir) ? p.dir : 0}" />
            </label>
          </div>`,
          )
          .join('')}
        <div style="font-size:10.5px;color:var(--dim);line-height:1.5">
          方向 = 该点的横向朝向（绕表面法线旋转，0° 自动）；水带贴到模型 / 地形表面。
        </div>
      `;
      this.waterBody.append(keys);
    }

    const danger = document.createElement('div');
    danger.className = 'section';
    danger.innerHTML = `<button class="btn small danger" data-act="water-delete">删除${isArea ? '这个水面区域' : '这条流动水'}</button>`;
    this.waterBody.append(danger);
  }

  /** 绘制中的草稿面板：点数 / 实时平均水面 / 撤回上一点 / 完成 / 取消 */
  renderWaterDraft() {
    const we = this.waterEditor;
    const d = we?.drawing;
    if (!d || !this.waterBody) return;
    const isArea = d.type === 'area';
    const minPoints = isArea ? 3 : 2;
    const enough = d.points.length >= minPoints;

    this.waterBody.innerHTML = '';
    if (this.waterSelHint) this.waterSelHint.textContent = '草稿';

    const box = document.createElement('div');
    box.className = 'section';
    box.innerHTML = `
      <div class="section-title">
        <span>正在绘制 · ${isArea ? '水面区域' : '流动水'}</span>
        <span style="font-weight:400;color:var(--dim)">${d.points.length} 个选点</span>
      </div>
      ${
        isArea
          ? `<div class="field"><span>实时平均水面 <b>${we.averageMeters().toFixed(1)} m</b></span></div>`
          : `<div class="field"><span>已选 ${d.points.length} 点（起点 → 途经点 → 终点）</span></div>`
      }
      <div class="row">
        <button class="btn small" data-act="water-undo-point" ${d.points.length ? '' : 'disabled'}
                title="撤掉刚刚选的那个点">撤回上一点</button>
        <button class="btn small primary" data-act="water-finish" ${enough ? '' : 'disabled'}
                title="${isArea ? '至少 3 点才能完成' : '至少 2 点才能完成'}">完成</button>
        <button class="btn small" data-act="water-cancel">取消</button>
      </div>
      <div style="font-size:10.5px;color:var(--dim);line-height:1.5">
        在地形上点击继续选点${isArea ? '（至少 3 点）' : '（起点 → 途经点 → 终点，至少 2 点）'}，
        完成后点「完成」；Esc 也可取消。
      </div>
    `;
    this.waterBody.append(box);
  }

  toast(message) {
    this.hint.textContent = message;
    this.hint.style.color = 'var(--text)';
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => this.resetHint(), 6000);
  }

  /** 恢复默认提示（绘制结束/取消时用） */
  resetHint() {
    clearTimeout(this._hintTimer);
    this.hint.style.color = '';
    this.hint.textContent = DEFAULT_HINT;
  }
}
