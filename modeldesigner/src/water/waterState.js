/**
 * 水体模拟的纯数据层：默认值 / 归一化 / id 生成。
 *
 * 只处理可序列化状态，不依赖 three.js 与编辑器 —— 工程 (project.js) 与运行时
 * (fluidWater.js) 共用同一套归一化逻辑，避免两处 schema 走样。
 *
 * 单位约定（与地形一致）：
 *   x / z / radius / targetLevel / waterAmount 一律是「米」或世界坐标；
 *   uExaggeration 只在渲染层换算世界 y。
 */
export const WATER_RESOLUTIONS = [256, 512, 768, 1024];
export const DEFAULT_WATER_RESOLUTION = 768;
export const MAX_WATER_SOURCES = 8;

export const WATER_DEFAULTS = {
  enabled: true,
  sim: {
    speed: 1,
    waterAmount: 15,
    resolution: DEFAULT_WATER_RESOLUTION,
    paused: false,
  },
  visual: {
    shimmer: 1,
    ripple: 1,
    clarity: 0.62,
  },
  sources: [],
};

let seq = 0;
/** 水源 id：与 project.js 的 uid 同风格，但保持水模块独立可复现 */
export function waterSourceId() {
  seq += 1;
  const rnd = Math.random().toString(36).slice(2, 7);
  return `wsrc_${Date.now().toString(36)}_${seq.toString(36)}_${rnd}`;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function normalizeResolution(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_WATER_RESOLUTION;
  let best = WATER_RESOLUTIONS[0];
  let bestErr = Infinity;
  for (const r of WATER_RESOLUTIONS) {
    const err = Math.abs(r - n);
    if (err < bestErr) {
      bestErr = err;
      best = r;
    }
  }
  return best;
}

/** 单个水源：缺字段回落到默认，非法坐标直接丢弃（返回 null） */
function normalizeSource(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const z = Number(raw.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : waterSourceId(),
    name: typeof raw.name === 'string' && raw.name ? raw.name : `水源 ${index + 1}`,
    x,
    z,
    radius: finite(Number(raw.radius)) ? clamp(Number(raw.radius), 20, 3000) : 150,
    // null = 不限制；数字 = 目标水面绝对高程（米）
    targetLevel: finite(Number(raw.targetLevel)) ? Number(raw.targetLevel) : null,
    // null = 跟随全局「每次注水量」；数字 = 该水源自己的每次注水水深（米）
    amount: finite(Number(raw.amount)) ? clamp(Number(raw.amount), 0.5, 300) : null,
    enabled: raw.enabled !== false,
  };
}

/** 把任意来源（localStorage / 导入工程 / 旧版 areas+flows）归一化成当前 schema */
export function normalizeWaterState(raw) {
  const out = {
    enabled: WATER_DEFAULTS.enabled,
    sim: { ...WATER_DEFAULTS.sim },
    visual: { ...WATER_DEFAULTS.visual },
    sources: [],
  };
  if (!raw || typeof raw !== 'object') return out;

  out.enabled = raw.enabled !== false;

  const sim = raw.sim && typeof raw.sim === 'object' ? raw.sim : {};
  out.sim.speed = finite(Number(sim.speed)) ? clamp(Number(sim.speed), 0.1, 4) : WATER_DEFAULTS.sim.speed;
  out.sim.waterAmount = finite(Number(sim.waterAmount))
    ? clamp(Number(sim.waterAmount), 1, 300)
    : WATER_DEFAULTS.sim.waterAmount;
  out.sim.resolution = normalizeResolution(sim.resolution);
  out.sim.paused = sim.paused === true;

  const visual = raw.visual && typeof raw.visual === 'object' ? raw.visual : {};
  out.visual.shimmer = finite(Number(visual.shimmer)) ? clamp(Number(visual.shimmer), 0, 3) : WATER_DEFAULTS.visual.shimmer;
  out.visual.ripple = finite(Number(visual.ripple)) ? clamp(Number(visual.ripple), 0, 2) : WATER_DEFAULTS.visual.ripple;
  out.visual.clarity = finite(Number(visual.clarity)) ? clamp(Number(visual.clarity), 0, 1) : WATER_DEFAULTS.visual.clarity;

  const sources = Array.isArray(raw.sources) ? raw.sources : [];
  for (let i = 0; i < sources.length && out.sources.length < MAX_WATER_SOURCES; i++) {
    const s = normalizeSource(sources[i], i);
    if (s) out.sources.push(s);
  }
  return out;
}
