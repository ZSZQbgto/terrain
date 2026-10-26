/**
 * 工程数据模型：标签类型、ID、序列化、localStorage 自动保存。
 *
 * 内存里的模型实例带 THREE 对象（root/content），落盘时只留可序列化部分：
 *   { id, name, assetId, assetName, visible, transform, partTransforms, labels }
 * glb 二进制单独存 IndexedDB（store.js），这里只引用 assetId。
 */
export const STORAGE_KEY = 'modeldesigner.project.v1';
export const PROJECT_VERSION = 1;

/** 标签类型：动态结构（可被控制系统驱动）、静态标注（只读说明），以及尚未分类 */
export const LABEL_KINDS = {
  unset: {
    label: '未分类',
    short: '未分类',
    hint: '刚添加，还没有选择类型',
  },
  dynamic: {
    label: '动态结构',
    short: '动态',
    hint: '可被控制系统驱动的部件',
  },
  static: {
    label: '静态标注',
    short: '标注',
    hint: '只读说明',
  },
};

/** 创建时的默认类型：只填名称即可，默认归为「静态标注」，之后可在标签卡上改 */
export const DEFAULT_LABEL_KIND = 'static';

let seq = 0;
export function uid(prefix = 'id') {
  seq += 1;
  const rnd = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}_${rnd}`;
}

/**
 * 标签只承载三件事：名称、类型、挂在哪（整个模型 / 某个部件）。
 * 其它任何字段（备注、运动参数…）都不属于标签，不参与存储与渲染。
 */
export function createLabel({ kind = DEFAULT_LABEL_KIND, title = '', nodePath = null } = {}) {
  const safeKind = LABEL_KINDS[kind] ? kind : DEFAULT_LABEL_KIND;
  return {
    id: uid('label'),
    kind: safeKind,
    title: title || '未命名标签',
    nodePath: Array.isArray(nodePath) && nodePath.length ? nodePath.slice() : null,
  };
}

/** 把任意来源的工程 JSON 规整成当前版本的可靠结构 */
export function normalizeProject(raw) {
  const out = { version: PROJECT_VERSION, models: [], water: normalizeWater(null), savedAt: Date.now() };
  if (!raw || typeof raw !== 'object') return out;
  out.water = normalizeWater(raw.water);
  const models = Array.isArray(raw.models) ? raw.models : [];
  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    const asset = normalizeAsset(m.asset);
    if (!asset) continue;
    out.models.push({
      id: typeof m.id === 'string' ? m.id : uid('model'),
      name: typeof m.name === 'string' && m.name ? m.name : '未命名模型',
      asset,
      visible: m.visible !== false,
      transform: normalizeTransform(m.transform),
      partTransforms: normalizePartTransforms(m.partTransforms),
      partNames: normalizePartNames(m.partNames),
      labels: Array.isArray(m.labels) ? m.labels.filter(Boolean).map(normalizeLabel) : [],
    });
  }
  return out;
}

/**
 * 资源引用：
 *   { source:'dir',   url,  name }  资源文件夹（public/models）里的文件
 *   { source:'local', id,   name }  IndexedDB 暂存（静态托管时网页导入的退路）
 */
export function normalizeAsset(a) {
  if (!a || typeof a !== 'object') return null;
  const name = typeof a.name === 'string' ? a.name : '';
  if (a.source === 'local') {
    const id = typeof a.id === 'string' ? a.id : '';
    return id ? { source: 'local', id, name } : null;
  }
  const url = typeof a.url === 'string' ? a.url : '';
  return url ? { source: 'dir', url, name } : null;
}

export function normalizeTransform(t) {
  const pick = (arr, fallback) =>
    Array.isArray(arr) && arr.length === 3 && arr.every((v) => Number.isFinite(v)) ? arr.map(Number) : fallback.slice();
  return {
    position: pick(t?.position, [0, 0, 0]),
    // 旋转以「度」存盘，便于人工编辑 JSON
    rotation: pick(t?.rotation, [0, 0, 0]),
    scale: pick(t?.scale, [1, 1, 1]),
  };
}

function normalizeLabel(l) {
  // 只保留标签自身的三个字段；旧工程里的 note / motion 等一律丢弃
  return {
    id: typeof l.id === 'string' ? l.id : uid('label'),
    kind: LABEL_KINDS[l.kind] ? l.kind : DEFAULT_LABEL_KIND,
    title: typeof l.title === 'string' && l.title ? l.title : '未命名标签',
    nodePath: Array.isArray(l.nodePath) && l.nodePath.length ? l.nodePath.map((n) => Number(n) | 0) : null,
  };
}

function normalizePartTransforms(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw) {
    if (!p || !Array.isArray(p.path) || !p.path.length) continue;
    const t = normalizeTransform(p.transform);
    out.push({ path: p.path.map((n) => Number(n) | 0), transform: t });
  }
  return out;
}

function normalizePartNames(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || !Array.isArray(item.path) || !item.path.length) continue;
    if (typeof item.name !== 'string' || !item.name) continue;
    out.push({ path: item.path.map((n) => Number(n) | 0), name: item.name });
  }
  return out;
}

/** 水体标签：只有名称，不在场景里显示（与物体标签区分） */
function normalizeWaterLabels(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l) => l && typeof l === 'object')
    .map((l) => ({
      id: typeof l.id === 'string' ? l.id : uid('wlabel'),
      title: typeof l.title === 'string' && l.title ? l.title : '未命名水体标签',
    }));
}

/** 水面系统：默认平面水位 + 圈定区域 + 流动水路径（都带水体标签） */
export function normalizeWater(raw) {
  const out = { enabled: true, level: 69, areas: [], flows: [] };
  if (!raw || typeof raw !== 'object') return out;
  out.enabled = raw.enabled !== false;
  if (Number.isFinite(raw.level)) out.level = Number(raw.level);

  const areas = Array.isArray(raw.areas) ? raw.areas : [];
  for (const a of areas) {
    if (!a || !Array.isArray(a.points)) continue;
    const points = a.points
      .filter((p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(n)))
      .map(([x, z]) => [Number(x), Number(z)]);
    if (points.length < 3) continue;
    out.areas.push({
      id: typeof a.id === 'string' ? a.id : uid('area'),
      name: typeof a.name === 'string' && a.name ? a.name : '水面区域',
      level: Number.isFinite(a.level) ? Number(a.level) : out.level,
      points,
      labels: normalizeWaterLabels(a.labels),
    });
  }

  const flows = Array.isArray(raw.flows) ? raw.flows : [];
  for (const f of flows) {
    if (!f || !Array.isArray(f.points)) continue;
    // 关键点：支持 [x,y,z] 旧格式与 { x, y, z, width, dir } 新格式（每点可独立宽度 / 横向朝向）
    const points = f.points
      .map((p) => {
        if (Array.isArray(p) && p.length === 3 && p.every((n) => Number.isFinite(n))) {
          return { x: Number(p[0]), y: Number(p[1]), z: Number(p[2]), width: null, dir: null };
        }
        if (p && typeof p === 'object' && [p.x, p.y, p.z].every((n) => Number.isFinite(n))) {
          return {
            x: Number(p.x),
            y: Number(p.y),
            z: Number(p.z),
            width: Number.isFinite(p.width) ? Math.max(0.5, Number(p.width)) : null,
            dir: Number.isFinite(p.dir) ? Number(p.dir) : null,
          };
        }
        return null;
      })
      .filter(Boolean);
    if (points.length < 2) continue;
    out.flows.push({
      id: typeof f.id === 'string' ? f.id : uid('flow'),
      name: typeof f.name === 'string' && f.name ? f.name : '流动水',
      speed: Number.isFinite(f.speed) ? Math.max(0.05, Number(f.speed)) : 1,
      width: Number.isFinite(f.width) ? Math.max(1, Number(f.width)) : 8,
      points,
      labels: normalizeWaterLabels(f.labels),
    });
  }
  return out;
}

export function serializeProject(models, water = null) {
  return {
    version: PROJECT_VERSION,
    savedAt: Date.now(),
    water: normalizeWater(water),
    models: models.map(serializeModel),
  };
}

export function serializeModel(model) {
  return {
    id: model.id,
    name: model.name,
    asset: { ...model.asset },
    visible: model.root.visible,
    transform: {
      position: model.root.position.toArray().map(round3),
      rotation: [
        round3((model.root.rotation.x * 180) / Math.PI),
        round3((model.root.rotation.y * 180) / Math.PI),
        round3((model.root.rotation.z * 180) / Math.PI),
      ],
      scale: model.root.scale.toArray().map(round4),
    },
    partTransforms: model.partTransforms.map((p) => ({
      path: p.path,
      transform: {
        position: p.object.position.toArray().map(round3),
        rotation: [
          round3((p.object.rotation.x * 180) / Math.PI),
          round3((p.object.rotation.y * 180) / Math.PI),
          round3((p.object.rotation.z * 180) / Math.PI),
        ],
        scale: p.object.scale.toArray().map(round4),
      },
    })),
    partNames: model.partNames.map((p) => ({ path: p.path, name: p.name })),
    labels: model.labels.map((l) => ({ ...l })),
  };
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}
function round4(v) {
  return Math.round(v * 10000) / 10000;
}

export function loadStoredProject() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeProject(JSON.parse(raw));
  } catch (err) {
    console.warn('[project] 读取本地工程失败', err);
    return null;
  }
}

export function saveStoredProject(project) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    return true;
  } catch (err) {
    console.warn('[project] 保存本地工程失败（可能超配额）', err);
    return false;
  }
}

export function clearStoredProject() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
