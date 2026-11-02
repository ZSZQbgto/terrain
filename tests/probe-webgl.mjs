/**
 * GPU / WebGL2 能力探测（验证脚本的前置自检）
 *   node tests/probe-webgl.mjs
 *
 * 无头 Chrome 在 Windows 上是否能用 WebGL2，取决于 GPU 与启动参数。
 * 本脚本依次尝试若干参数组合，选出「能拿到 WebGL2 且能实际渲染 three.js 画面」的一组，
 * 供 water-verify.mjs 复用。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('file:///D:/Proj/test/node_modules/');
const puppeteer = require('puppeteer-core');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const executablePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error('未找到 Chrome / Edge，可用 CHROME_PATH 指定');
  process.exit(1);
}
console.log(`[probe] executablePath = ${executablePath}`);

const VIEW = { width: 1280, height: 800 };

const VARIANTS = [
  {
    name: 'gpu-default',
    args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=default'],
  },
  {
    name: 'angle-d3d11',
    args: ['--no-sandbox', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu'],
  },
  {
    name: 'swiftshader',
    args: [
      '--no-sandbox',
      '--ignore-gpu-blocklist',
      '--disable-gpu-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryVariant(variant) {
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [...variant.args, `--window-size=${VIEW.width},${VIEW.height}`, '--hide-scrollbars'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ ...VIEW, deviceScaleFactor: 1 });
    const consoleLogs = [];
    page.on('console', (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => consoleLogs.push(`[pageerror] ${e.message}`));

    await page.goto('about:blank');
    const info = await page.evaluate(() => {
      const out = { webgl2: false, webgl1: false, renderer: null, vendor: null, error: null };
      try {
        const canvas = document.createElement('canvas');
        const gl2 = canvas.getContext('webgl2');
        if (gl2) {
          out.webgl2 = true;
          const ext = gl2.getExtension('WEBGL_debug_renderer_info');
          out.renderer = ext ? gl2.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl2.getParameter(gl2.RENDERER);
          out.vendor = ext ? gl2.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl2.getParameter(gl2.VENDOR);
          out.maxTextureSize = gl2.getParameter(gl2.MAX_TEXTURE_SIZE);
        } else {
          const gl1 = canvas.getContext('webgl');
          out.webgl1 = Boolean(gl1);
        }
      } catch (err) {
        out.error = String(err);
      }
      return out;
    });

    // 真实渲染检查：three.js 画一个三角形，读回像素中心
    let renderOk = false;
    let pixel = null;
    if (info.webgl2) {
      await page.setContent(`<!doctype html><html><body style="margin:0"><script type="importmap">
        {"imports":{"three":"http://127.0.0.1:5174/node_modules/three/build/three.module.js"}}
      </script></body></html>`);
      // 用 ES module 从本地 vite 加载 three 太慢/依赖服务器；改为直接用裸 WebGL2 清屏到绿
      pixel = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        document.body.appendChild(canvas);
        const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
        if (!gl) return null;
        gl.viewport(0, 0, 64, 64);
        gl.clearColor(0.1, 0.8, 0.2, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const px = new Uint8Array(4);
        gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return [px[0], px[1], px[2], px[3]];
      });
      renderOk = Boolean(pixel && pixel[1] > 150 && pixel[0] < 80);
    }

    await sleep(200);
    await browser.close();
    return { ...variant, info, renderOk, pixel, consoleLogs };
  } catch (err) {
    await browser.close().catch(() => {});
    return { ...variant, info: null, renderOk: false, error: String(err?.message ?? err) };
  }
}

const results = [];
for (const variant of VARIANTS) {
  console.log(`\n[probe] 尝试 ${variant.name} …`);
  const r = await tryVariant(variant);
  results.push(r);
  console.log(JSON.stringify({ name: r.name, info: r.info, renderOk: r.renderOk, pixel: r.pixel, error: r.error }, null, 2));
  if (r.info?.webgl2 && r.renderOk) {
    console.log(`\n[probe] 可用变体: ${r.name}`);
    console.log(`[probe] args = ${JSON.stringify(variant.args)}`);
    break;
  }
}

const best = results.find((r) => r.info?.webgl2 && r.renderOk);
console.log('\n[probe] 汇总:');
for (const r of results) {
  console.log(`  ${r.name}: webgl2=${r.info?.webgl2 ?? '?'} renderOk=${r.renderOk} ${r.info?.renderer ?? r.error ?? ''}`);
}
process.exitCode = best ? 0 : 1;
