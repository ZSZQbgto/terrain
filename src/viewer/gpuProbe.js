/**
 * 渲染硬件探测。
 *
 * WebGL 没有枚举显卡的 API，能拿到真实硬件信息的方式只有两条：
 *   1. 用不同的 powerPreference 各建一个 WebGL2 上下文，读 WEBGL_debug_renderer_info。
 *      双显卡机器上两者会落到不同 GPU，于是能"看见"两块设备；
 *      单卡或系统强制指定时两者会返回同一块 —— 那也是真实情况。
 *   2. navigator.gpu.requestAdapter() 的 adapter.info（Chrome 113+），补充厂商/架构。
 *
 * 探测结果代表"本浏览器当前实际能分配到的渲染设备"，不等于系统里装了几块卡。
 */

const DISCRETE_RE = /(nvidia|geforce|rtx|gtx|quadro|tesla|radeon\s+(rx|pro|vii)|arc\s+[ab]\d|apple\s+m\d+\s+(pro|max|ultra))/i;
const INTEGRATED_RE = /(intel|uhd|iris|hd graphics|vega\s*\d|radeon\(tm\) graphics|radeon graphics|apple\s+m\d+)/i;

/** 从 ANGLE 的长串里取出型号，例如
 *  "ANGLE (Intel, Intel(R) UHD Graphics (0x0000A78B) Direct3D11 vs_5_0 ps_5_0, D3D11)"
 *  → "Intel(R) UHD Graphics" */
export function shortGpuName(raw) {
  if (typeof raw !== 'string' || !raw) return '未知 GPU';
  const angle = raw.match(/ANGLE \((.+?),\s*(.+?)\s+(?:Direct3D|OpenGL|Vulkan|Metal)/i);
  if (angle) return angle[2].replace(/\s*\(0x[0-9a-f]+\)/i, '').trim();
  return raw.replace(/\s*\(0x[0-9a-f]+\)/i, '').trim();
}

export function classifyGpu(name) {
  if (DISCRETE_RE.test(name)) return 'discrete';
  if (INTEGRATED_RE.test(name)) return 'integrated';
  return 'unknown';
}

function readCaps(gl) {
  return {
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0,
    maxSamples: gl.getParameter(gl.MAX_SAMPLES) || 0,
    maxVertexTextures: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) || 0,
    maxRenderbuffer: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 0,
  };
}

/**
 * 用两种 GPU 偏好各开一次上下文，读出实际绑定的设备与能力。
 * @returns {Array<{powerPreference: string, name: string, shortName: string, kind: string, caps: object}>}
 */
export function probeWebglDevices() {
  const byName = new Map();

  for (const pref of ['high-performance', 'low-power']) {
    let canvas = null;
    let gl = null;
    try {
      canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      gl = canvas.getContext('webgl2', {
        powerPreference: pref,
        alpha: false,
        depth: false,
        stencil: false,
        antialias: false,
        failIfMajorPerformanceCaveat: false,
      });
    } catch {
      gl = null;
    }
    if (!gl) continue;

    let name = '未知 GPU';
    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      name = (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || name;
    } catch {
      /* 隐私模式可能屏蔽，保持默认名 */
    }
    const caps = readCaps(gl);

    const existing = byName.get(name);
    if (existing) {
      // 两种偏好落到同一块卡：记录下两个偏好都能索引到它
      existing.prefers.push(pref);
    } else {
      byName.set(name, {
        powerPreference: pref,
        prefers: [pref],
        name,
        shortName: shortGpuName(name),
        kind: classifyGpu(name),
        caps,
      });
    }

    // 释放探测用的上下文，避免占用显存
    try {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* ignore */
    }
  }

  return [...byName.values()];
}

/** 能力打分：先按独显/集显定性，再用硬件参数拉开差距 */
export function scoreDevice(device) {
  let score = 0;
  if (device.kind === 'discrete') score += 1000;
  else if (device.kind === 'integrated') score += 300;
  else score += 500;

  const maxTex = Math.max(2048, device.caps.maxTextureSize || 2048);
  score += Math.round(Math.log2(maxTex) * 12);
  score += (device.caps.maxSamples || 0) * 3;
  score += (device.caps.maxVertexTextures || 0) * 2;
  return score;
}

/** 选出探测结果里最强的一块 */
export function pickBestDevice(devices) {
  if (!devices.length) return null;
  return devices.reduce((best, d) => (scoreDevice(d) > scoreDevice(best) ? d : best), devices[0]);
}

/**
 * 用两种偏好各请求一次 WebGPU adapter，比较是否为同一适配器。
 *
 * macOS Chrome 的行为值得注意：不指定 powerPreference 时它会按电源状态自动选
 * （插电给独显、电池给集显），所以显式传偏好能更明确地表达意图；
 * 但浏览器仍可能出于省电（例如标签页不可见）把上下文换回集显 —— 那时 WebGL
 * 会抛出上下文丢失事件，见 main.js 的处理。
 */
export async function probeWebGpuDevices() {
  if (!navigator.gpu?.requestAdapter) return [];
  const out = [];
  for (const pref of ['high-performance', 'low-power']) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: pref });
      if (!adapter) continue;
      const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
      const description = info
        ? [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ')
        : '';
      out.push({
        powerPreference: pref,
        description: description || 'unknown',
        fallback: Boolean(adapter.isFallbackAdapter),
      });
    } catch {
      /* 某些环境会拒绝请求，忽略 */
    }
  }
  return out;
}
