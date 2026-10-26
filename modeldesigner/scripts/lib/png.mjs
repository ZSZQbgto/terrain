// 最小 PNG 解码器（Node 端，资产预处理用）：
// 支持非隔行 8/16 bit、灰度(0) / 真彩(2) / 真彩+Alpha(6)，流式逐行回调，内存占用低。
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function pngHeader(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG file');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    interlace: buf[28],
  };
}

function* chunks(buf) {
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    yield { type, data: buf.subarray(off + 8, off + 8 + len) };
    off += 12 + len;
    if (type === 'IEND') return;
  }
}

/**
 * 逐行解码 PNG。onRow(rowBytes: Uint8Array, y: number) —— rowBytes 已反滤波，
 * 长度 = width * channels * (bitDepth/8)，按大端样本排列（16bit 时每样本 2 字节）。
 */
export async function decodePngRows(buf, onRow) {
  const hdr = pngHeader(buf);
  if (hdr.interlace !== 0) throw new Error('interlaced PNG not supported');
  if (hdr.bitDepth !== 8 && hdr.bitDepth !== 16) throw new Error(`unsupported bitDepth ${hdr.bitDepth}`);
  const channels = CHANNELS[hdr.colorType];
  if (!channels || channels === 2) throw new Error(`unsupported colorType ${hdr.colorType}`);

  const bytesPerSample = hdr.bitDepth / 8;
  const bpp = channels * bytesPerSample;
  const rowBytes = hdr.width * bpp;

  const inflate = zlib.createInflate({ chunkSize: 1 << 20 });
  inflate.on('error', () => {}); // 由下面的 for-await 抛出

  const feed = (async () => {
    for (const c of chunks(buf)) {
      if (c.type === 'IDAT') {
        if (!inflate.write(c.data)) await new Promise((r) => inflate.once('drain', r));
      } else if (c.type === 'IEND') break;
    }
    inflate.end();
  })();

  let pending = Buffer.alloc(rowBytes * 2);
  let pendingLen = 0;
  let prev = new Uint8Array(rowBytes);
  let y = 0;

  const unfilter = (raw, out) => {
    const ft = raw[0];
    const src = raw.subarray(1, 1 + rowBytes);
    switch (ft) {
      case 0: out.set(src); break;
      case 1:
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? out[i - bpp] : 0;
          out[i] = (src[i] + a) & 0xff;
        }
        break;
      case 2:
        for (let i = 0; i < rowBytes; i++) out[i] = (src[i] + prev[i]) & 0xff;
        break;
      case 3:
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? out[i - bpp] : 0;
          out[i] = (src[i] + ((a + prev[i]) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? out[i - bpp] : 0;
          const b = prev[i];
          const c = i >= bpp ? prev[i - bpp] : 0;
          const p = a + b - c;
          const pa = p > a ? p - a : a - p;
          const pb = p > b ? p - b : b - p;
          const pc = p > c ? p - c : c - p;
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          out[i] = (src[i] + pred) & 0xff;
        }
        break;
      default: throw new Error(`bad filter type ${ft} at row ${y}`);
    }
  };

  let rowBuf = new Uint8Array(rowBytes);
  const rowScratch = new Uint8Array(rowBytes + 1); // +1 给滤波类型字节

  const handle = (chunk) => {
    if (pendingLen + chunk.length > pending.length) {
      const grown = Buffer.alloc(Math.max(pending.length * 2, pendingLen + chunk.length));
      pending.copy(grown, 0, 0, pendingLen);
      pending = grown;
    }
    chunk.copy(pending, pendingLen);
    pendingLen += chunk.length;

    while (pendingLen >= rowBytes + 1) {
      // 反滤波需要目标可读写：先拷出原始行
      rowScratch.set(pending.subarray(0, rowBytes + 1));
      unfilter(rowScratch, rowBuf);
      onRow(rowBuf, y);
      y++;
      // 交换 prev / rowBuf，避免每行分配
      const t = prev; prev = rowBuf; rowBuf = t;
      pending.copy(pending, 0, rowBytes + 1, pendingLen);
      pendingLen -= rowBytes + 1;
    }
  };

  for await (const chunk of inflate) handle(chunk);
  await feed;
  if (y !== hdr.height) throw new Error(`expected ${hdr.height} rows, decoded ${y}`);
  return { ...hdr, channels, bytesPerSample };
}

/** 16bit 大端灰度 → Uint16Array（值 0..65535） */
export function rowToU16(row, width) {
  const out = new Uint16Array(width);
  for (let i = 0, o = 0; i < width; i++, o += 2) out[i] = (row[o] << 8) | row[o + 1];
  return out;
}
