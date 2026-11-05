/**
 * tests/height-png.test.mjs —— `src/terrain/heightPng.js` 的 Node 端往返测试。
 *
 * 运行：node tests/height-png.test.mjs
 * 依赖：Node 内置模块 + 项目 devDependency `sharp` + 仓库已有的 `scripts/lib/png.mjs`。
 * 无其他第三方依赖，不启动服务器、不修改任何产品文件。
 *
 * 覆盖内容：
 *   1. normalizeSourceRange 的合法区间 / 缺省 / 非法输入回退；
 *   2. normalizedToGray16 的取整、越界夹紧、NaN 处理；
 *   3. 16 位灰度导出（sourceRange {min:1234,max:60123,bitDepth:16}）：
 *      PNG 签名、chunk CRC32（用独立逐位算法校验）、IHDR 字段、IDAT 单条 zlib 流、
 *      每行滤波字节为 0、16 位采样大端；再用 scripts/lib/png.mjs 的
 *      pngHeader / decodePngRows / rowToU16 逐像素比对；
 *   4. 用 sharp 独立解码：metadata（png / depth=ushort / channels=1 / 宽高）+
 *      raw 像素逐值比对；
 *   5. 8 位灰度路径（encodeGrayPng + encodeHeightPng bitDepth:8）结构与往返；
 *   6. 输入参数校验（错误位深 / 像素数量不符应抛错）。
 *
 * 每项输出 `PASS ...` 或 `FAIL ...`，有失败时退出码非 0。
 */
import os from 'node:os';
import sharp from 'sharp';
import { pngHeader, decodePngRows, rowToU16 } from '../scripts/lib/png.mjs';
import {
  normalizeSourceRange,
  normalizedToGray16,
  encodeGrayPng,
  encodeHeightPng,
} from '../src/terrain/heightPng.js';

// ── 测试台：逐项执行、累计失败数 ──────────────────────────────────────────
let passed = 0;
let failed = 0;

/** 断言辅助：失败即抛错，由 test() 捕获并记 FAIL */
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}：期望 ${expected}，实际 ${actual}`);
}
function assertBytesEqual(actual, expected, message) {
  if (actual.length !== expected.length) {
    throw new Error(`${message}：长度不同（期望 ${expected.length}，实际 ${actual.length}）`);
  }
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${message}：第 ${i} 个元素不同（期望 ${expected[i]}，实际 ${actual[i]}）`);
    }
  }
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}：${err.message}`);
  }
}

// ── 确定性测试数据 ────────────────────────────────────────────────────────
const WIDTH = 41;
const HEIGHT = 27;
const COUNT = WIDTH * HEIGHT;
const RANGE_16 = { min: 1234, max: 60123, bitDepth: 16 };

/**
 * 41×27 归一化高度场：首像素 0、末像素 1，其余 = sin 条纹 + 阶梯组合（确定性）。
 * 保证覆盖 0、1 以及 0..1 之间大量不同取值。
 */
function buildNormalized() {
  const normalized = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    if (i === 0) {
      normalized[i] = 0;
    } else if (i === COUNT - 1) {
      normalized[i] = 1;
    } else {
      const x = i % WIDTH;
      const y = (i / WIDTH) | 0;
      const v = 0.5 + 0.45 * Math.sin(x * 0.31 + y * 0.57) + 0.03 * ((x + y) % 3);
      normalized[i] = Math.min(1, Math.max(0, v));
    }
  }
  return normalized;
}

/**
 * 期望灰度值：与编码器同一公式（0..1 先夹紧再 round），但独立实现，
 * 便于定位编码器与测试公式的偏差。
 */
function grayOf(normalized, minGray, maxGray) {
  let n = Number(normalized);
  if (!Number.isFinite(n)) n = 0;
  n = Math.min(1, Math.max(0, n));
  return Math.round(minGray + n * (maxGray - minGray));
}
function expectedGrays(normalized, minGray, maxGray) {
  const out = new Uint16Array(COUNT);
  for (let i = 0; i < COUNT; i++) out[i] = grayOf(normalized[i], minGray, maxGray);
  return out;
}

function buildGray8Pixels() {
  const px = new Uint8Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    if (i === 0) px[i] = 0;
    else if (i === COUNT - 1) px[i] = 255;
    else px[i] = (i * 7 + 13) % 256; // 确定性覆盖 8 位整个范围
  }
  return px;
}

// ── 独立 PNG 结构解析 / CRC32 / zlib 解压 ─────────────────────────────────

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 独立 CRC32（逐位算法，故意不复用编码器的查表实现） */
function crc32Bitwise(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 解析并校验 PNG 结构：
 *   - 8 字节签名；
 *   - 逐个 chunk 校验长度边界与 CRC32（type + data），不允许 IEND 之后有残余字节；
 *   - IHDR 必须是第一个、IEND 必须是最后一个。
 * @param {Uint8Array} png
 * @returns {{type: string, data: Buffer}[]}
 */
function parseAndVerifyPng(png) {
  const bytes = Buffer.from(png);
  assert(bytes.length > 8 + 25 + 12 + 12, `PNG 太短：${bytes.length} 字节`);
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    assertEqual(bytes[i], PNG_MAGIC[i], `PNG 签名字节 ${i}`);
  }

  const chunks = [];
  let off = 8;
  while (off + 12 <= bytes.length) {
    const len = bytes.readUInt32BE(off);
    const type = bytes.toString('latin1', off + 4, off + 8);
    assert(off + 12 + len <= bytes.length, `${type} chunk 越界`);
    const data = bytes.subarray(off + 8, off + 8 + len);
    const storedCrc = bytes.readUInt32BE(off + 8 + len);
    const computedCrc = crc32Bitwise(Buffer.concat([Buffer.from(type, 'latin1'), data]));
    assertEqual(storedCrc, computedCrc, `${type} chunk 的 CRC32`);
    chunks.push({ type, data });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  assertEqual(off, bytes.length, 'IEND 之后不应有多余字节');
  assert(chunks.length >= 3, `chunk 数量过少：${chunks.length}`);
  assertEqual(chunks[0].type, 'IHDR', '第一个 chunk 必须是 IHDR');
  assertEqual(chunks[chunks.length - 1].type, 'IEND', '最后一个 chunk 必须是 IEND');
  return chunks;
}

/** 用 DecompressionStream 解 IDAT，验证是「单条 zlib 流」且能完整还原扫描线 */
async function inflateIdatRaw(chunks) {
  const idatParts = chunks.filter((c) => c.type === 'IDAT');
  assert(idatParts.length >= 1, '缺少 IDAT chunk');
  const idat = Buffer.concat(idatParts.map((c) => c.data));
  assert(idat.length > 0, 'IDAT 为空');
  const stream = new Blob([idat]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 从 IHDR chunk 的 data 中读字段（data 为 13 字节大端） */
function parseIhdr(data) {
  assertEqual(data.length, 13, 'IHDR 长度');
  return {
    width: data.readUInt32BE(0),
    height: data.readUInt32BE(4),
    bitDepth: data[8],
    colorType: data[9],
    compression: data[10],
    filter: data[11],
    interlace: data[12],
  };
}

// ── 共享测试数据（只编码一次，多个用例复用）──────────────────────────────
const normalized = buildNormalized();
const expected16 = expectedGrays(normalized, RANGE_16.min, RANGE_16.max);
const encoded16 = await encodeHeightPng({
  normalized,
  width: WIDTH,
  height: HEIGHT,
  sourceRange: RANGE_16,
});
const png16 = encoded16.bytes;

const gray8Pixels = buildGray8Pixels();
const png8 = await encodeGrayPng({ width: WIDTH, height: HEIGHT, pixels: gray8Pixels, bitDepth: 8 });

// ── 1. sourceRange 归一化 ────────────────────────────────────────────────
await test('normalizeSourceRange：缺失/非法回退到 16 位满量程', () => {
  const fallback = { bitDepth: 16, minGray: 0, maxGray: 65535 };
  for (const input of [undefined, null, {}, 'bad', 42]) {
    const r = normalizeSourceRange(input);
    assertEqual(r.bitDepth, fallback.bitDepth, `bitDepth（输入 ${String(input)}）`);
    assertEqual(r.minGray, fallback.minGray, `minGray（输入 ${String(input)}）`);
    assertEqual(r.maxGray, fallback.maxGray, `maxGray（输入 ${String(input)}）`);
  }
  // min/max 不合法（NaN、负、倒置、超出位深上限）→ 满量程
  for (const bad of [
    { min: NaN, max: 10, bitDepth: 16 },
    { min: -1, max: 10, bitDepth: 16 },
    { min: 60000, max: 1234, bitDepth: 16 },
    { min: 0, max: 70000, bitDepth: 16 },
    { min: 0, max: 60123, bitDepth: 8 },
  ]) {
    const r = normalizeSourceRange(bad);
    assertEqual(r.minGray, 0, `非法区间 minGray（${JSON.stringify(bad)}）`);
    assertEqual(r.maxGray, r.bitDepth === 8 ? 255 : 65535, `非法区间 maxGray（${JSON.stringify(bad)}）`);
  }
});

await test('normalizeSourceRange：terrain.json 风格区间原样保留', () => {
  const r16 = normalizeSourceRange(RANGE_16);
  assertEqual(r16.bitDepth, 16, 'bitDepth 16');
  assertEqual(r16.minGray, 1234, 'minGray');
  assertEqual(r16.maxGray, 60123, 'maxGray');

  const r8 = normalizeSourceRange({ min: 7, max: 250, bitDepth: 8 });
  assertEqual(r8.bitDepth, 8, 'bitDepth 8');
  assertEqual(r8.minGray, 7, 'minGray 8bit');
  assertEqual(r8.maxGray, 250, 'maxGray 8bit');

  // 缺 bitDepth 字段：仍按 16 位解释，且保留合法 min/max
  const rNoDepth = normalizeSourceRange({ min: 100, max: 500 });
  assertEqual(rNoDepth.bitDepth, 16, '缺 bitDepth 时默认 16 位');
  assertEqual(rNoDepth.minGray, 100, '缺 bitDepth 时 minGray');
  assertEqual(rNoDepth.maxGray, 500, '缺 bitDepth 时 maxGray');
});

// ── 2. normalizedToGray16 ───────────────────────────────────────────────
await test('normalizedToGray16：round + 夹紧 0..1 与 0..65535', () => {
  const input = [0, 1, 0.5, -0.5, 1.5, NaN, 0.25];
  const out = normalizedToGray16(input, 100, 200);
  assert(out instanceof Uint16Array, '返回值应为 Uint16Array');
  assertBytesEqual(
    out,
    new Uint16Array([100, 200, 150, 100, 200, 100, 125]),
    '归一化 → 灰度映射',
  );

  // 灰色下限/上限本身越界时夹紧到 16 位范围（-100 → 0，70000 → 65535），中点即 32768
  const clamped = normalizedToGray16([0, 1, 0.5], -100, 70000);
  assertBytesEqual(clamped, new Uint16Array([0, 65535, 32768]), '上下限夹紧');
});

// ── 3. 16 位：PNG 结构 / CRC / IHDR / IDAT ──────────────────────────────
await test('16 位：签名、chunk CRC32、IHDR 字段、IEND 收尾', () => {
  assert(png16 instanceof Uint8Array, 'encodeHeightPng 返回的 bytes 应为 Uint8Array');
  assertEqual(encoded16.bitDepth, 16, 'encodeHeightPng 返回的 bitDepth');
  const chunks = parseAndVerifyPng(png16);
  const ihdr = parseIhdr(chunks[0].data);
  assertEqual(ihdr.width, WIDTH, 'IHDR width');
  assertEqual(ihdr.height, HEIGHT, 'IHDR height');
  assertEqual(ihdr.bitDepth, 16, 'IHDR bitDepth');
  assertEqual(ihdr.colorType, 0, 'IHDR colorType（0=灰度）');
  assertEqual(ihdr.compression, 0, 'IHDR compression');
  assertEqual(ihdr.filter, 0, 'IHDR filter');
  assertEqual(ihdr.interlace, 0, 'IHDR interlace');
});

await test('16 位：IDAT 是单条 zlib 流，逐行滤波字节 0，采样大端', async () => {
  const chunks = parseAndVerifyPng(png16);
  const raw = await inflateIdatRaw(chunks);
  const rowBytes = WIDTH * 2;
  assertEqual(raw.length, HEIGHT * (1 + rowBytes), '解压后扫描线总长度');

  for (let y = 0; y < HEIGHT; y++) {
    const rowStart = y * (1 + rowBytes);
    assertEqual(raw[rowStart], 0, `第 ${y} 行滤波类型字节`);
    for (let x = 0; x < WIDTH; x++) {
      const o = rowStart + 1 + x * 2;
      const beValue = (raw[o] << 8) | raw[o + 1]; // PNG 规定 16 位采样大端
      const expected = expected16[y * WIDTH + x];
      if (beValue !== expected) {
        throw new Error(`第 (${x},${y}) 像素大端值 ${beValue} != 期望 ${expected}`);
      }
    }
  }
});

// ── 4. 16 位：scripts/lib/png.mjs 往返解码 ──────────────────────────────
await test('16 位：pngHeader / decodePngRows / rowToU16 逐像素往返', async () => {
  const buf = Buffer.from(png16);
  const hdr = pngHeader(buf);
  assertEqual(hdr.width, WIDTH, 'pngHeader width');
  assertEqual(hdr.height, HEIGHT, 'pngHeader height');
  assertEqual(hdr.bitDepth, 16, 'pngHeader bitDepth');
  assertEqual(hdr.colorType, 0, 'pngHeader colorType');
  assertEqual(hdr.interlace, 0, 'pngHeader interlace');

  let rowCount = 0;
  await decodePngRows(buf, (row, y) => {
    assertEqual(y, rowCount, '行号连续');
    const values = rowToU16(row, WIDTH);
    assertEqual(values.length, WIDTH, `第 ${y} 行像素数`);
    for (let x = 0; x < WIDTH; x++) {
      const expected = expected16[y * WIDTH + x];
      if (values[x] !== expected) {
        throw new Error(
          `第 (${x},${y}) 像素 ${values[x]} != 期望 ${expected}（round(min + n*(max-min))）`,
        );
      }
    }
    rowCount++;
  });
  assertEqual(rowCount, HEIGHT, '解码行数');
});

// ── 5. 16 位：sharp 独立验证 ────────────────────────────────────────────
await test('16 位：sharp metadata（png / ushort / 单通道 / 宽高）', async () => {
  const meta = await sharp(Buffer.from(png16)).metadata();
  assertEqual(meta.format, 'png', 'sharp metadata.format');
  assertEqual(meta.width, WIDTH, 'sharp metadata.width');
  assertEqual(meta.height, HEIGHT, 'sharp metadata.height');
  assertEqual(meta.depth, 'ushort', 'sharp metadata.depth（16 位灰度应为 ushort）');
  assertEqual(meta.channels, 1, 'sharp metadata.channels（灰度应为 1）');
});

await test('16 位：sharp raw 像素逐值等于 round(min + n*(max-min))', async () => {
  // 说明：sharp/libvips 的 raw 输出使用「宿主字节序」（本机 x86_64 为小端），
  // 而 PNG 文件内部是固定大端（上面的 IDAT 扫描线用例已直接验证）。
  // 所以这里按 os.endianness() 解释 raw 的 Uint16 采样；不预设固定字节序。
  const { data, info } = await sharp(Buffer.from(png16))
    .toColourspace('grey16')
    .raw({ depth: 'ushort' })
    .toBuffer({ resolveWithObject: true });

  assertEqual(info.width, WIDTH, 'sharp raw width');
  assertEqual(info.height, HEIGHT, 'sharp raw height');
  assertEqual(info.channels, 1, 'sharp raw channels');
  assertEqual(info.depth, 'ushort', 'sharp raw depth');
  assertEqual(info.size ?? data.length, COUNT * 2, 'sharp raw 字节数（每像素 2 字节）');

  const littleEndian = os.endianness() === 'LE';
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < COUNT; i++) {
    const actual = view.getUint16(i * 2, littleEndian);
    const expected = expected16[i];
    if (actual !== expected) {
      throw new Error(
        `第 ${i} 个像素 ${actual} != 期望 ${expected}（按 ${littleEndian ? '小端' : '大端'}解释 sharp raw）`,
      );
    }
  }
});

// ── 6. 8 位路径 ─────────────────────────────────────────────────────────
await test('8 位：PNG 结构 + png.mjs 往返解码', async () => {
  assert(png8 instanceof Uint8Array, 'encodeGrayPng 返回 Uint8Array');
  const chunks = parseAndVerifyPng(png8);
  const ihdr = parseIhdr(chunks[0].data);
  assertEqual(ihdr.width, WIDTH, 'IHDR width');
  assertEqual(ihdr.height, HEIGHT, 'IHDR height');
  assertEqual(ihdr.bitDepth, 8, 'IHDR bitDepth');
  assertEqual(ihdr.colorType, 0, 'IHDR colorType');
  assertEqual(ihdr.interlace, 0, 'IHDR interlace');

  const raw = await inflateIdatRaw(chunks);
  const rowBytes = WIDTH;
  assertEqual(raw.length, HEIGHT * (1 + rowBytes), '解压后扫描线总长度');
  for (let y = 0; y < HEIGHT; y++) {
    const rowStart = y * (1 + rowBytes);
    assertEqual(raw[rowStart], 0, `第 ${y} 行滤波类型字节`);
    for (let x = 0; x < WIDTH; x++) {
      assertEqual(raw[rowStart + 1 + x], gray8Pixels[y * WIDTH + x], `第 (${x},${y}) 像素`);
    }
  }

  const buf = Buffer.from(png8);
  const hdr = pngHeader(buf);
  assertEqual(hdr.bitDepth, 8, 'pngHeader bitDepth');
  assertEqual(hdr.colorType, 0, 'pngHeader colorType');
  let rowCount = 0;
  await decodePngRows(buf, (row, y) => {
    assertEqual(row.length, WIDTH, `第 ${y} 行字节数`);
    for (let x = 0; x < WIDTH; x++) {
      assertEqual(row[x], gray8Pixels[y * WIDTH + x], `第 (${x},${y}) 像素（png.mjs）`);
    }
    rowCount++;
  });
  assertEqual(rowCount, HEIGHT, 'png.mjs 解码行数');
});

await test('8 位：sharp metadata + raw 像素逐值比对', async () => {
  const meta = await sharp(Buffer.from(png8)).metadata();
  assertEqual(meta.format, 'png', 'sharp metadata.format');
  assertEqual(meta.width, WIDTH, 'sharp metadata.width');
  assertEqual(meta.height, HEIGHT, 'sharp metadata.height');
  assertEqual(meta.depth, 'uchar', 'sharp metadata.depth（8 位应为 uchar）');
  assertEqual(meta.channels, 1, 'sharp metadata.channels');

  // 8 位灰度用 b-w 色彩空间读 raw，才能得到单通道 uchar
  const { data, info } = await sharp(Buffer.from(png8))
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });
  assertEqual(info.channels, 1, 'sharp raw channels');
  assertEqual(info.depth, 'uchar', 'sharp raw depth');
  assertBytesEqual(new Uint8Array(data), gray8Pixels, 'sharp raw 像素');
});

await test('8 位：encodeHeightPng（sourceRange bitDepth:8）往返', async () => {
  const result = await encodeHeightPng({
    normalized,
    width: WIDTH,
    height: HEIGHT,
    sourceRange: { min: 0, max: 255, bitDepth: 8 },
  });
  assertEqual(result.bitDepth, 8, 'encodeHeightPng 返回 bitDepth 应为 8');

  const hdr = pngHeader(Buffer.from(result.bytes));
  assertEqual(hdr.bitDepth, 8, 'IHDR bitDepth');
  assertEqual(hdr.colorType, 0, 'IHDR colorType');

  const expected8 = new Uint8Array(COUNT);
  for (let i = 0; i < COUNT; i++) expected8[i] = grayOf(normalized[i], 0, 255);

  let rowCount = 0;
  await decodePngRows(Buffer.from(result.bytes), (row, y) => {
    for (let x = 0; x < WIDTH; x++) {
      const expected = expected8[y * WIDTH + x];
      if (row[x] !== expected) {
        throw new Error(`第 (${x},${y}) 像素 ${row[x]} != 期望 ${expected}`);
      }
    }
    rowCount++;
  });
  assertEqual(rowCount, HEIGHT, '解码行数');
});

// ── 7. 输入校验 ─────────────────────────────────────────────────────────
await test('参数校验：错误位深 / 像素数量不符应抛错', async () => {
  let threw = 0;
  try {
    await encodeGrayPng({ width: WIDTH, height: HEIGHT, pixels: gray8Pixels, bitDepth: 12 });
  } catch {
    threw++;
  }
  try {
    await encodeGrayPng({ width: WIDTH, height: HEIGHT, pixels: new Uint8Array(5), bitDepth: 8 });
  } catch {
    threw++;
  }
  try {
    await encodeGrayPng({ width: 0, height: HEIGHT, pixels: new Uint8Array(0), bitDepth: 8 });
  } catch {
    threw++;
  }
  assertEqual(threw, 3, '应抛出 3 次参数错误');
});

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`FAIL height-png：${failed} 个用例失败`);
  process.exitCode = 1;
} else {
  console.log('PASS height-png：全部用例通过');
}
