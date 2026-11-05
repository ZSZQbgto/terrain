/**
 * 地形高度场 → 灰度 PNG 编码器（浏览器 / Node 24 通用，零外部依赖，不依赖 canvas）。
 *
 * 用途：把编辑后的归一化 DEM（0..1）按 terrain.json 的 `sourceRange` 反算成 16 位
 * （或 8 位）灰度采样值，编码为可直接替换 `resourses/heightmap64.png` 的 PNG，
 * 之后重新执行 `npm run assets` 即可生成 height.f16 / terrain.json。
 *
 * 只使用标准 Web API 全局对象（Node 24 已内置）：
 *   - CompressionStream('deflate')：输出 zlib（RFC 1950）包装的 deflate 流，
 *     正好是 PNG IDAT 要求的压缩格式；'deflate-raw' 则不带 zlib 头，不能用。
 *   - DataView / Uint8Array / Uint16Array：写大端二进制。
 * 不使用 Node 的 zlib 模块，也不使用任何第三方库。
 *
 * PNG 结构（非隔行、灰度、无调色板）：
 *   8 字节签名
 *   IHDR（13 字节：宽、高、bitDepth、colorType=0、compression/filter/interlace=0）
 *   IDAT（单个 zlib 流：逐扫描线「滤波字节 0 + 原始像素」，16 位采样为大端）
 *   IEND（空）
 * 每个 chunk 都带 CRC32（覆盖 type + data）。
 */

/** PNG 文件签名：89 50 4E 47 0D 0A 1A 0A */
const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC32 查表（PNG 规范使用的 IEEE 802.3 多项式 0xEDB88320） */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * 把字符串转成 ASCII 字节（chunk 类型只用 4 个大写字母，无需 TextEncoder）。
 * @param {string} text
 * @returns {Uint8Array}
 */
function asciiBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * 增量计算 CRC32，返回内部状态（未取反），便于把 type 与 data 分两次喂入。
 * @param {number} crc 上一次返回的状态（首次用 0xffffffff）
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function crc32Update(crc, bytes) {
  let c = crc >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return c >>> 0;
}

/** 最终 CRC32 值（内部状态取反） */
function crc32Final(crc) {
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 组装一个 PNG chunk：长度(4, BE) + 类型(4) + 数据 + CRC32(4, BE)。
 * @param {string} type 4 字符类型，如 'IHDR'
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function makeChunk(type, data) {
  const typeBytes = asciiBytes(type);
  const crc = crc32Final(crc32Update(crc32Update(0xffffffff, typeBytes), data));
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false); // 大端
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc, false);
  return out;
}

/** 把数字限制为 [min, max] 内的整数（非有限数回退 fallback） */
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const r = Math.round(n);
  return r < min ? min : r > max ? max : r;
}

/**
 * 归一化 sourceRange（terrain.json 中的 `{ min, max, bitDepth }`）。
 *
 * 约定：灰度图是「源图灰度值」而不是物理高程；`min` / `max` 是源图的灰度区间，
 * 导出时把 0..1 的归一化高度线性映射回该区间，从而保证再次 `npm run assets`
 * 得到的 height.f16 与编辑前口径一致，且高程范围不漂移。
 *
 * 容错规则：
 *   - 参数缺失或不是对象 → 默认 `{ bitDepth: 16, minGray: 0, maxGray: 65535 }`；
 *   - bitDepth 非法（不是 8/16）→ 按 16 位处理；
 *   - min/max 非法（非有限数、负数、max < min、超过 bitDepth 上限）→ 用该位深的满量程。
 *   合法的 min/max 会被取整并保留。
 *
 * @param {{min?: number, max?: number, bitDepth?: number}|null|undefined} sourceRange
 * @returns {{bitDepth: 8|16, minGray: number, maxGray: number}}
 */
export function normalizeSourceRange(sourceRange) {
  if (!sourceRange || typeof sourceRange !== 'object') {
    return { bitDepth: 16, minGray: 0, maxGray: 65535 };
  }
  const bitDepth = Number(sourceRange.bitDepth) === 8 ? 8 : 16;
  const maxAllowed = bitDepth === 16 ? 65535 : 255;

  const rawMin = Number(sourceRange.min);
  const rawMax = Number(sourceRange.max);
  const valid =
    Number.isFinite(rawMin) &&
    Number.isFinite(rawMax) &&
    rawMin >= 0 &&
    rawMax >= rawMin &&
    rawMax <= maxAllowed;

  if (!valid) return { bitDepth, minGray: 0, maxGray: maxAllowed };
  return { bitDepth, minGray: Math.round(rawMin), maxGray: Math.round(rawMax) };
}

/**
 * 归一化高度（0..1）→ 16 位灰度值（Uint16Array）。
 * 公式：round(minGray + n * (maxGray - minGray))，结果夹紧到 0..65535；
 * 非有限数按 0 处理，n 会先夹紧到 0..1（防止笔刷越界或浮动误差）。
 *
 * @param {ArrayLike<number>} normalized 归一化高度，长度 = width * height
 * @param {number} minGray 源图灰度下限
 * @param {number} maxGray 源图灰度上限
 * @returns {Uint16Array}
 */
export function normalizedToGray16(normalized, minGray, maxGray) {
  if (!normalized || typeof normalized.length !== 'number') {
    throw new TypeError('normalizedToGray16: normalized 必须是数组或 TypedArray');
  }
  let min = clampInt(minGray, 0, 65535, 0);
  let max = clampInt(maxGray, 0, 65535, 65535);
  if (max < min) max = min;
  const span = max - min;

  const out = new Uint16Array(normalized.length);
  for (let i = 0; i < out.length; i++) {
    let n = Number(normalized[i]);
    if (!Number.isFinite(n)) n = 0;
    else if (n < 0) n = 0;
    else if (n > 1) n = 1;
    const v = Math.round(min + n * span);
    out[i] = v < 0 ? 0 : v > 65535 ? 65535 : v;
  }
  return out;
}

/**
 * 用 `CompressionStream('deflate')` 压缩为 zlib 流（PNG IDAT 所需格式）。
 * 写入与读取并发进行，避免大图（上百万像素）时管道背压造成死锁。
 *
 * @param {Uint8Array} bytes 原始（已加滤波字节的）扫描线数据
 * @returns {Promise<Uint8Array>} zlib 包装的压缩数据
 */
async function deflateZlib(bytes) {
  if (typeof CompressionStream !== 'function') {
    throw new Error('当前环境不支持 CompressionStream，无法编码 PNG（需要浏览器或 Node 18+）');
  }
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();

  // 先启动读取端，再写数据：两者同时推进，CompressionStream 的内部队列就不会堵死。
  const collected = (async () => {
    const reader = stream.readable.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  })();

  const written = (async () => {
    await writer.write(bytes);
    await writer.close();
  })();

  await Promise.all([written, collected]);
  return collected;
}

/**
 * 编码灰度 PNG。像素按行优先（左上角为第 0 行第 0 列，不翻转）。
 *
 * @param {object} options
 * @param {number} options.width 宽度（像素）
 * @param {number} options.height 高度（像素）
 * @param {ArrayLike<number>} options.pixels 灰度采样值，长度必须等于 width * height；
 *        16 位模式取 0..65535，8 位模式取 0..255（越界值自动夹紧）
 * @param {8|16} [options.bitDepth=16] 位深
 * @returns {Promise<Uint8Array>} 完整 PNG 文件字节
 */
export async function encodeGrayPng({ width, height, pixels, bitDepth = 16 } = {}) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
    throw new TypeError(`encodeGrayPng: width/height 必须是正整数，收到 ${width}x${height}`);
  }
  const depth = bitDepth === 8 ? 8 : bitDepth === 16 ? 16 : null;
  if (depth === null) {
    throw new TypeError(`encodeGrayPng: bitDepth 只支持 8 或 16，收到 ${bitDepth}`);
  }
  if (!pixels || typeof pixels.length !== 'number' || pixels.length !== w * h) {
    throw new TypeError(
      `encodeGrayPng: pixels 长度应为 ${w * h}（width * height），收到 ${pixels && pixels.length}`,
    );
  }

  const bytesPerSample = depth === 16 ? 2 : 1;
  const rowBytes = w * bytesPerSample;
  // 每条扫描线：1 字节滤波类型（0 = None）+ rowBytes 像素字节
  const raw = new Uint8Array(h * (1 + rowBytes));
  const maxSample = depth === 16 ? 65535 : 255;
  let offset = 0;
  for (let y = 0; y < h; y++) {
    raw[offset++] = 0; // 滤波类型 0：None（每行都显式写出）
    const base = y * w;
    for (let x = 0; x < w; x++) {
      const v = clampInt(pixels[base + x], 0, maxSample, 0);
      if (depth === 16) {
        raw[offset++] = (v >>> 8) & 0xff; // 16 位采样：高字节在前（大端）
        raw[offset++] = v & 0xff;
      } else {
        raw[offset++] = v & 0xff;
      }
    }
  }

  // IHDR：宽、高、位深、颜色类型 0（灰度）、压缩 0、滤波 0、隔行 0
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, w, false);
  ihdrView.setUint32(4, h, false);
  ihdr[8] = depth;
  ihdr[9] = 0; // colorType = 0（灰度）
  ihdr[10] = 0; // compression = 0（deflate）
  ihdr[11] = 0; // filter method = 0
  ihdr[12] = 0; // interlace = 0

  const idat = await deflateZlib(raw);
  const chunks = [
    new Uint8Array(PNG_SIGNATURE),
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', new Uint8Array(0)),
  ];

  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const png = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    png.set(chunk, cursor);
    cursor += chunk.length;
  }
  return png;
}

/**
 * 地形高度图导出入口：归一化 DEM → 灰度 PNG。
 * 位深与灰度区间取自 terrain.json 的 sourceRange（缺省/非法时按 16 位满量程）。
 *
 * @param {object} options
 * @param {ArrayLike<number>} options.normalized 归一化高度（0..1），行优先，长度 = width * height
 * @param {number} options.width 宽度（像素）
 * @param {number} options.height 高度（像素）
 * @param {{min?: number, max?: number, bitDepth?: number}} [options.sourceRange] terrain.json 的 sourceRange
 * @returns {Promise<{bytes: Uint8Array, bitDepth: 8|16}>} PNG 字节与所用位深
 */
export async function encodeHeightPng({ normalized, width, height, sourceRange } = {}) {
  const { bitDepth, minGray, maxGray } = normalizeSourceRange(sourceRange);
  const gray = normalizedToGray16(normalized, minGray, maxGray);
  const bytes = await encodeGrayPng({ width, height, pixels: gray, bitDepth });
  return { bytes, bitDepth };
}
