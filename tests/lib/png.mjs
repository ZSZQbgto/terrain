/**
 * 零依赖 PNG 解码 + 像素统计（供 water-verify.mjs 检查截图）
 *
 * 只支持 Chrome 截图会产出的格式：8-bit、非隔行、colorType 0/2/4/6。
 * 解码用 node:zlib inflate，不装任何第三方依赖。
 */
import zlib from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 逐行反滤波（PNG filter 0..4），写入 out（紧密排列的像素字节） */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const srcOff = y * (stride + 1) + 1;
    const dstOff = y * stride;
    const prevOff = dstOff - stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[srcOff + x];
      const a = x >= bpp ? out[dstOff + x - bpp] : 0; // 左
      const b = y > 0 ? out[prevOff + x] : 0; // 上
      const c = x >= bpp && y > 0 ? out[prevOff + x - bpp] : 0; // 左上
      let val;
      switch (filter) {
        case 0:
          val = rawByte;
          break;
        case 1:
          val = rawByte + a;
          break;
        case 2:
          val = rawByte + b;
          break;
        case 3:
          val = rawByte + ((a + b) >> 1);
          break;
        case 4: {
          // Paeth
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          val = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`不支持的 PNG 行滤波类型 ${filter}（第 ${y} 行）`);
      }
      out[dstOff + x] = val & 0xff;
    }
  }
  return out;
}

/**
 * 解码 PNG → { width, height, channels, data }
 * data 为逐像素原始通道字节（1=灰度 / 2=灰度+alpha / 3=RGB / 4=RGBA）。
 */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('不是合法的 PNG（签名不匹配）');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  const idat = [];
  let sawIHDR = false;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd > buf.length) throw new Error(`PNG chunk ${type} 越界`);
    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      const interlace = buf[dataStart + 12];
      if (bitDepth !== 8) throw new Error(`只支持 8-bit PNG（实际 ${bitDepth}）`);
      if (interlace !== 0) throw new Error('不支持隔行 PNG');
      sawIHDR = true;
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    off = dataEnd + 4; // 跳过 CRC
  }
  if (!sawIHDR) throw new Error('PNG 缺少 IHDR');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的 PNG colorType ${colorType}`);
  if (!idat.length) throw new Error('PNG 缺少 IDAT');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const expected = (width * bpp + 1) * height;
  if (raw.length < expected) {
    throw new Error(`PNG 数据不足：${raw.length} < ${expected}`);
  }
  const data = unfilter(raw, width, height, bpp);
  return { width, height, channels, data };
}

function channelLum(data, i, channels) {
  if (channels === 1 || channels === 2) return data[i];
  return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
}

/**
 * 两张同尺寸截图逐像素差异比例（用于证明「水面开/关」「模拟前后」确有画面变化）。
 * 返回 { width, height, sampled, changed, ratio }，ratio ∈ [0,1]。
 */
export function pngDiff(bufA, bufB, { step = 2, threshold = 14 } = {}) {
  const a = decodePng(bufA);
  const b = decodePng(bufB);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`截图尺寸不一致：${a.width}×${a.height} vs ${b.width}×${b.height}`);
  }
  let sampled = 0;
  let changed = 0;
  for (let y = 0; y < a.height; y += step) {
    for (let x = 0; x < a.width; x += step) {
      const ia = (y * a.width + x) * a.channels;
      const ib = (y * b.width + x) * b.channels;
      const la = channelLum(a.data, ia, a.channels);
      const lb = channelLum(b.data, ib, b.channels);
      sampled++;
      if (Math.abs(la - lb) > threshold) changed++;
    }
  }
  return {
    width: a.width,
    height: a.height,
    sampled,
    changed,
    ratio: sampled ? Number((changed / sampled).toFixed(4)) : 0,
  };
}

/**
 * 截图统计：亮度、黑色占比、蓝色（水/天空）占比、量化色数。
 * sampleStep 用于降采样，1280×800 时 step=2 约 25 万采样点，足够且快。
 */
export function pngStats(buf, { sampleStep = 2 } = {}) {
  const { width, height, channels, data } = decodePng(buf);
  const colors = new Set();
  let samples = 0;
  let lumSum = 0;
  let lumSqSum = 0;
  let black = 0;
  let blue = 0;
  let flatGray = 0;

  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const i = (y * width + x) * channels;
      let r;
      let g;
      let b;
      let a = 255;
      if (channels === 1 || channels === 2) {
        r = g = b = data[i];
        if (channels === 2) a = data[i + 1];
      } else {
        r = data[i];
        g = data[i + 1];
        b = data[i + 2];
        if (channels === 4) a = data[i + 3];
      }
      if (a === 0) continue;
      samples++;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumSum += lum;
      lumSqSum += lum * lum;
      if (lum < 8) black++;
      // 蓝/青主导像素：水与天空通常满足；地形（绿/棕/灰）b 不占优
      if (b >= r + 8 && b >= 40) blue++;
      // 低饱和亮灰（纯色背景 / 白屏）
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max > 200 && max - min < 6) flatGray++;
      if (colors.size < 6000) {
        colors.add(((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2));
      }
    }
  }

  const meanLum = samples ? lumSum / samples : 0;
  const variance = samples ? Math.max(0, lumSqSum / samples - meanLum * meanLum) : 0;
  return {
    width,
    height,
    channels,
    samples,
    meanLum: Number(meanLum.toFixed(2)),
    lumStd: Number(Math.sqrt(variance).toFixed(2)),
    blackFraction: samples ? Number((black / samples).toFixed(4)) : 0,
    blueFraction: samples ? Number((blue / samples).toFixed(4)) : 0,
    flatGrayFraction: samples ? Number((flatGray / samples).toFixed(4)) : 0,
    uniqueColors: colors.size,
    colorsCapped: colors.size >= 6000,
  };
}
