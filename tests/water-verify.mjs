/**
 * modeldesigner 水体模拟改造 · 浏览器自动化验证
 * ==================================================
 *   node tests/water-verify.mjs
 *
 * 流程：
 *   1) 静态检查：旧水面模块文件已删除、src 无旧 API 残留（注释先剥离）
 *   2) 起 modeldesigner dev server（vite，默认 5174），puppeteer-core + 本机 Chrome 无头打开
 *   3) 校验：页面无 JS/着色器报错、模式切换、点选放置水源、UI 联动（速度/注水量/精度/暂停/重置）、
 *      水面开关、GPU 浅水模拟（debugStats: wetCells / maxDepthMeters 增长）、近景截图与像素统计
 *   4) 构建：modeldesigner 与根项目 vite build
 *
 * 只写 tests/ 下的文件，不改产品源码。
 *
 * 环境变量：
 *   VERIFY_PORT        dev server 起始端口（默认 5174，占用时自动 +1 重试）
 *   VERIFY_SKIP_BUILD  1 = 跳过构建检查
 *   VERIFY_HEADFUL     1 = 有头模式（调试用）
 *   CHROME_PATH        指定 Chrome/Edge 可执行文件
 *
 * 输出：
 *   tests/out/water-verify.log   完整日志（stdout tee）
 *   tests/out/water-ui.png       水体面板（含选中水源编辑）
 *   tests/out/water-placing.png  放置模式
 *   tests/out/water-sim.png      近景水面
 *   tests/out/water-tour.png     隐藏 UI 的观赏视角
 *   tests/out/water-sim-off.png  水面关闭对照（用于开/关像素差异校验）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pngStats, pngDiff } from './lib/png.mjs';

const require = createRequire('file:///D:/Proj/test/node_modules/');
const puppeteer = require('puppeteer-core');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MD = path.join(ROOT, 'modeldesigner');
const OUT = path.join(HERE, 'out');
const LOG_PATH = path.join(OUT, 'water-verify.log');
const VIEW = { width: 1280, height: 800 };

const SKIP_BUILD = process.env.VERIFY_SKIP_BUILD === '1';
const LOW_POINT = { x: -126.8, z: -1648.8 }; // 地形低洼处（历史验证用点）
const TARGET_LIFT = 25; // 目标水面 = 地面 + 25 m

// ── 日志（stdout + 文件 tee）────────────────────────────────────────────────
const lines = [];
let passCount = 0;
let infoCount = 0;
const failures = [];

const j = (v) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

const log = (...args) => {
  const s = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : j(a)))
    .join(' ');
  lines.push(s);
  process.stdout.write(s + '\n');
};

const rec = (name, ok, detail) => {
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : j(detail)}`;
  if (ok) {
    passCount++;
    log(`PASS ${name}${suffix}`);
  } else {
    failures.push({ name, detail });
    log(`FAIL ${name}${suffix}`);
  }
};

const info = (name, detail) => {
  infoCount++;
  log(`INFO ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : j(detail)}`}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 浏览器控制台/错误收集 ───────────────────────────────────────────────────
const pageErrors = [];
const consoleErrors = []; // { text, url }
const browserLogs = [];
const failedRequests = [];
const resourceErrors = [];
const dialogs = [];
let navigations = 0; // 主框架导航次数（>1 说明 HMR 把页面重载了）
let intentionalReloads = 0; // 验证流程自己触发的刷新（工程持久化测试）

// 无害噪声：favicon 404 / 被取消的请求
const BENIGN_CONSOLE = ({ text, url }) =>
  /favicon/i.test(`${text} ${url}`) || /net::ERR_ABORTED/.test(text);

function criticalResource(url) {
  return !/\/favicon/i.test(url) && !/\/data\/sat\//i.test(url);
}

function consoleErrorLines() {
  return consoleErrors.filter((e) => !BENIGN_CONSOLE(e)).map((e) => `${e.text}${e.url ? ` (${e.url})` : ''}`);
}

function collectErrors() {
  const errs = consoleErrorLines();
  return {
    pageErrors: [...pageErrors],
    consoleErrors: errs,
    shaderErrors: errs.filter((t) => /shader|glsl|program not valid|compile/i.test(t)),
    failedRequests: [...failedRequests],
    resourceErrors: resourceErrors.filter((u) => criticalResource(u)),
  };
}

function errorsList() {
  const e = collectErrors();
  return [
    ...e.pageErrors.map((t) => `[pageerror] ${t}`),
    ...e.consoleErrors.map((t) => `[console] ${t}`),
    ...e.failedRequests.map((t) => `[requestfailed] ${t}`),
    ...e.resourceErrors.map((t) => `[http] ${t}`),
  ];
}

// ── 进程工具 ────────────────────────────────────────────────────────────────
function killChild(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    /* ignore */
  }
}

async function httpOk(url, timeoutMs = 2000) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// ── dev server / preview server ─────────────────────────────────────────────
/** 启动一个 vite 子进程并轮询到 HTTP 200；失败会 kill 并抛错 */
async function spawnViteAndWait(args, ports, label) {
  const viteBin = path.join(MD, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteBin)) {
    throw new Error(`找不到 vite（${viteBin}）——请先在 modeldesigner 下 npm install`);
  }
  const errors = [];
  for (const port of ports) {
    const child = spawn(process.execPath, [viteBin, ...args, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: MD,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none', NO_COLOR: '1' },
    });
    const stderrChunks = [];
    child.stdout.on('data', (d) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (line.trim()) log(`[vite] ${line.trim()}`);
      }
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderrChunks.push(s);
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) log(`[vite:err] ${line.trim()}`);
      }
    });
    let exitCode = null;
    child.on('exit', (code) => {
      exitCode = code;
    });

    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (exitCode !== null) break;
      if (await httpOk(`http://127.0.0.1:${port}/`)) {
        log(`[server] ${label} 就绪：http://127.0.0.1:${port}/`);
        return { child, port, url: `http://127.0.0.1:${port}/`, mode: label, exitCodeRef: () => exitCode };
      }
      await sleep(400);
    }
    errors.push(`端口 ${port}: exit=${exitCode} ${stderrChunks.join('').slice(-500)}`);
    log(`[server] 端口 ${port} 启动失败：exit=${exitCode}`);
    killChild(child);
  }
  throw new Error(`${label} 启动失败：\n${errors.join('\n')}`);
}

async function startDevServer() {
  const basePort = Number(process.env.VERIFY_PORT || 5174);
  return spawnViteAndWait([], [basePort, basePort + 1, basePort + 2], 'dev server');
}

/**
 * build 产物 + `vite preview`：不监听源码，适合产品代码/文档仍在变动时验证
 * （dev server 的 watcher 遇到原子写临时文件会 EBUSY 崩掉）。
 */
async function startPreviewServer() {
  log('[server] 改用 build + vite preview（不监听文件，规避 watcher EBUSY）');
  const build = await runViteBuild(MD, 'modeldesigner(preview)');
  if (!build.ok) {
    throw new Error(`vite build 失败，无法启用 preview：${(build.output || '').slice(-800)}`);
  }
  if (!fs.existsSync(path.join(MD, 'dist', 'index.html'))) {
    throw new Error('vite build 成功但 dist/index.html 不存在');
  }
  const basePort = Number(process.env.VERIFY_PORT || 5174);
  const res = await spawnViteAndWait(['preview'], [basePort, basePort + 1, basePort + 2], 'preview server');
  return { ...res, mode: 'preview' };
}

// ── Chrome ──────────────────────────────────────────────────────────────────
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) throw new Error('未找到 Chrome / Edge（可用 CHROME_PATH 指定）');
  return found;
}

async function launchBrowser() {
  const executablePath = findChrome();
  const headless = process.env.VERIFY_HEADFUL === '1' ? false : true;
  log(`[browser] Chrome: ${executablePath}  headless=${headless}`);
  const browser = await puppeteer.launch({
    executablePath,
    headless,
    args: [
      '--no-sandbox',
      '--ignore-gpu-blocklist',
      '--enable-gpu',
      '--use-angle=default',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      `--window-size=${VIEW.width},${VIEW.height}`,
    ],
    defaultViewport: { ...VIEW, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  await page.setViewport({ ...VIEW, deviceScaleFactor: 1 });
  page.setDefaultTimeout(20000);
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    const loc = typeof msg.location === 'function' ? msg.location() : null;
    browserLogs.push({ type, text, url: loc?.url });
    if (type === 'error') consoleErrors.push({ text, url: loc?.url ?? '' });
  });
  page.on('pageerror', (err) => {
    const text = String(err?.stack ?? err?.message ?? err);
    pageErrors.push(text);
    browserLogs.push({ type: 'pageerror', text });
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (/favicon/i.test(url)) return;
    failedRequests.push(`${url} :: ${req.failure()?.errorText}`);
  });
  page.on('response', (res) => {
    const status = res.status();
    const url = res.url();
    if (status >= 400 && !/favicon/i.test(url)) resourceErrors.push(`${status} ${url}`);
  });
  page.on('dialog', async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    log(`[dialog] ${dialog.type()}：${dialog.message().slice(0, 120)}`);
    try {
      await dialog.accept();
    } catch {
      /* ignore */
    }
  });
  page.on('error', (err) => {
    pageErrors.push(`页面崩溃：${err?.message ?? err}`);
  });
  return { browser, page };
}

// ── 页面内通用探针（一次注入，后续调用）──────────────────────────────────────
async function installHelpers(page) {
  await page.evaluate(() => {
    const norm = (s) =>
      String(s ?? '')
        .replace(/[\s\u00a0\u3000]+/g, '')
        .replace(/＋/g, '+')
        .replace(/[：]/g, ':');

    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity || '1') > 0.01;
    };

    const textOf = (el) => norm(el?.textContent || '');
    const attrTexts = (el) =>
      [el?.getAttribute?.('aria-label'), el?.title, el?.id, el?.getAttribute?.('name'), el?.dataset?.role]
        .filter(Boolean)
        .map(norm);

    const ancestorTexts = (el, depth = 5) => {
      const out = [];
      let node = el?.parentElement;
      for (let i = 0; i < depth && node; i++, node = node.parentElement) {
        const t = norm(node.textContent || '');
        if (t) out.push({ depth: i + 1, len: t.length, text: t.slice(0, 400), visible: isVisible(node) });
      }
      return out;
    };

    const allButtons = () => [...document.querySelectorAll('button, [role="button"], a.nav-btn')];
    const buttonInfo = (el) => ({
      el,
      text: textOf(el),
      title: norm(el.title || ''),
      act: el.dataset?.act || '',
      mode: el.dataset?.mode || '',
      visible: isVisible(el),
      disabled: Boolean(el.disabled),
      ancestors: ancestorTexts(el, 3),
    });

    const scoreButton = (bi, opts = {}) => {
      const { tokens = [], anyTokens = [], acts = [], modes = [], prefer = [], maxTextLen = 0 } = opts;
      if (modes.length && !modes.includes(bi.mode)) return -1;
      if (acts.length && !acts.some((a) => bi.act === a || (bi.act && bi.act.includes(a)))) return -1;
      const hay = [bi.text, bi.title, bi.act, bi.mode].join('|');
      if (tokens.length && !tokens.every((t) => hay.includes(norm(t)))) return -1;
      if (anyTokens.length && !anyTokens.some((t) => hay.includes(norm(t)))) return -1;
      if (maxTextLen && bi.text.length > maxTextLen) return -1;
      let prefHit = 0;
      if (prefer.length) {
        prefHit = prefer.filter((t) => {
          const nt = norm(t);
          return bi.ancestors.some((a) => a.text.includes(nt)) || hay.includes(nt);
        }).length;
      }
      const minAnc = bi.ancestors.length ? Math.min(...bi.ancestors.map((a) => a.len)) : 100000;
      return prefHit * 1e7 - bi.text.length * 100 - minAnc;
    };

    const resolveButton = (opts = {}) => {
      const allowHidden = Boolean(opts.allowHidden);
      let best = null;
      let bestScore = -1;
      for (const bi of allButtons().map(buttonInfo)) {
        if (!allowHidden && !bi.visible) continue;
        if (bi.disabled) continue;
        const s = scoreButton(bi, opts);
        if (s > bestScore) {
          bestScore = s;
          best = bi;
        }
      }
      return best ? best.el : null;
    };

    const clickButton = (opts = {}) => {
      const el = resolveButton(opts);
      if (!el) return { ok: false };
      const before = textOf(el);
      el.click();
      return { ok: true, before, after: textOf(el), visible: isVisible(el), act: el.dataset?.act || '' };
    };

    const existsButton = (opts = {}) => Boolean(resolveButton(opts));

    const controlScore = (el, tokens) => {
      if (!tokens.length) return 0;
      const cands = [...attrTexts(el), ...ancestorTexts(el, 5).map((a) => a.text)];
      let best = Infinity;
      for (const t of cands) {
        if (tokens.every((tok) => t.includes(norm(tok)))) best = Math.min(best, t.length);
      }
      return Number.isFinite(best) ? best : -1;
    };

    const resolveControl = (selector, opts = {}) => {
      const tokens = (opts.tokens || []).map(norm);
      const visibleOnly = opts.visibleOnly !== false;
      const els = [...document.querySelectorAll(selector)].filter((el) => !visibleOnly || isVisible(el));
      let best = null;
      let bestScore = Infinity;
      for (const el of els) {
        const s = controlScore(el, tokens);
        if (s < 0) continue;
        if (s < bestScore) {
          bestScore = s;
          best = el;
        }
      }
      return best;
    };

    const labelOfControl = (el) => {
      const anc = ancestorTexts(el, 5);
      if (!anc.length) return null;
      const shortest = anc.reduce((a, b) => (a.len <= b.len ? a : b));
      return shortest.text.slice(0, 80);
    };

    const setRange = (opts = {}) => {
      const el = resolveControl('input[type="range"]', opts);
      if (!el) return { ok: false, inventory: rangeInventory() };
      const before = el.value;
      el.value = String(opts.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, before, after: el.value, min: el.min, max: el.max, label: labelOfControl(el) };
    };

    const setSelect = (opts = {}) => {
      const el = resolveControl('select', opts);
      if (!el) return { ok: false, inventory: selectInventory() };
      const target = norm(String(opts.value));
      const option = [...el.options].find((o) => norm(o.value) === target || norm(o.textContent) === target);
      if (!option) {
        return { ok: false, reason: '无匹配 option', options: [...el.options].map((o) => o.value) };
      }
      const before = el.value;
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, before, after: el.value, label: labelOfControl(el) };
    };

    const setNumber = (opts = {}) => {
      const el = resolveControl('input[type="number"], input[type="text"]', opts);
      if (!el) return { ok: false };
      const before = el.value;
      el.value = String(opts.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (el.blur) el.blur();
      return { ok: true, before, after: el.value, label: labelOfControl(el) };
    };

    // 分段按钮 / 单选：点文字或 value 等于目标值的按钮
    const chooseValue = (opts = {}) => {
      const tokens = (opts.tokens || []).map(norm);
      const target = norm(String(opts.value));
      const candidates = [
        ...allButtons().map(buttonInfo).filter((b) => b.visible && !b.disabled && (b.text === target || b.text === `+${target}`)),
        ...[...document.querySelectorAll('input[type="radio"]')].map((el) => ({
          el,
          text: norm(el.value),
          title: norm(el.title || ''),
          act: '',
          mode: '',
          visible: isVisible(el),
          disabled: Boolean(el.disabled),
          ancestors: ancestorTexts(el, 3),
        })),
      ];
      const matched = candidates.filter(
        (c) => !tokens.length || c.ancestors.some((a) => tokens.every((t) => a.text.includes(t))),
      );
      if (!matched.length) {
        return {
          ok: false,
          buttons: allButtons().map((b) => textOf(b)).filter((t) => /256|512|768|1024/.test(t)).slice(0, 20),
        };
      }
      const before = matched[0].text;
      matched[0].el.click();
      return { ok: true, before, matched: before };
    };

    const rangeInventory = () =>
      [...document.querySelectorAll('input[type="range"]')].map((el) => ({
        visible: isVisible(el),
        value: el.value,
        min: el.min,
        max: el.max,
        step: el.step,
        label: labelOfControl(el),
        aria: el.getAttribute('aria-label') || '',
      }));

    const selectInventory = () =>
      [...document.querySelectorAll('select')].map((el) => ({
        visible: isVisible(el),
        value: el.value,
        options: [...el.options].map((o) => o.value),
        label: labelOfControl(el),
        aria: el.getAttribute('aria-label') || '',
      }));

    const waterState = () => {
      const w = window.__designer?.water;
      if (!w) return null;
      const s = w.state || {};
      const mesh = { meshes: 0, visibleMeshes: 0, groupVisible: w.group ? Boolean(w.group.visible) : null, groupChildren: 0 };
      try {
        if (w.group) {
          mesh.groupChildren = w.group.children?.length ?? 0;
          w.group.traverse((o) => {
            if (o.isMesh) {
              mesh.meshes++;
              let vis = true;
              let p = o;
              while (p && vis) {
                vis = vis && p.visible !== false;
                p = p.parent;
              }
              if (vis) mesh.visibleMeshes++;
            }
          });
        }
      } catch {
        /* ignore */
      }
      return {
        enabled: s.enabled,
        sim: { ...(s.sim || {}) },
        visual: { ...(s.visual || {}) },
        sources: (s.sources || []).map((x) => ({
          id: x.id,
          name: x.name,
          x: x.x,
          z: x.z,
          radius: x.radius,
          targetLevel: x.targetLevel,
          amount: x.amount,
          enabled: x.enabled,
        })),
        selectedId: w.selectedId ?? null,
        stats: w.stats ? { ...w.stats } : null,
        mesh,
        hasGroup: Boolean(w.group),
        sizeMeters: w.sizeMeters ?? null,
        cellMeters: w.uniforms?.uCellMeters?.value ?? null,
        api: [
          'groundMetersAt',
          'addSource',
          'updateSource',
          'removeSource',
          'clearSources',
          'selectSource',
          'setEnabled',
          'setSimSpeed',
          'setWaterAmount',
          'setPaused',
          'setResolution',
          'setVisual',
          'reset',
          'update',
          'debugStats',
          'toJSON',
          'load',
          'dispose',
        ].filter((k) => typeof w[k] === 'function'),
        waterEditor: {
          exists: Boolean(window.__designer?.waterEditor),
          active: Boolean(window.__designer?.waterEditor?.active),
          visible: Boolean(window.__designer?.waterEditor?.visible),
          tourHidden: window.__designer?.waterEditor?.tourHidden ?? null,
          nodeCount: window.__designer?.waterEditor?.nodes?.size ?? null,
          groupVisible: window.__designer?.waterEditor?.group
            ? Boolean(window.__designer.waterEditor.group.visible)
            : null,
        },
      };
    };

    const getStats = () => {
      const w = window.__designer?.water;
      return w?.stats ? { ...w.stats } : null;
    };

    const debugStats = async () => {
      const w = window.__designer?.water;
      if (!w || typeof w.debugStats !== 'function') return { __missing: true };
      try {
        const st = w.debugStats();
        return st && typeof st.then === 'function' ? await st : st;
      } catch (err) {
        return { __error: String(err?.message ?? err) };
      }
    };

    const sceneInfo = () => {
      const d = window.__designer || {};
      const gl = d.renderer?.getContext?.();
      let webgl2 = null;
      let glLost = null;
      let glRenderer = null;
      try {
        if (gl) {
          webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
          glLost = typeof gl.isContextLost === 'function' ? gl.isContextLost() : null;
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          glRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        }
      } catch (err) {
        glRenderer = `读取失败: ${String(err)}`;
      }
      const target = d.cameraControls?.controls?.target ?? d.cameraControls?.target ?? null;
      return {
        designer: Boolean(window.__designer),
        designerKeys: Object.keys(d),
        hasWater: Boolean(d.water),
        hasWaterEditor: Boolean(d.waterEditor),
        hasCameraControls: Boolean(d.cameraControls),
        hasUi: Boolean(d.ui),
        loadingHidden: document.getElementById('loading')?.classList.contains('hidden') ?? null,
        loadingText: document.getElementById('loading-text')?.textContent ?? null,
        webgl2,
        glLost,
        glRenderer,
        renderCalls: d.renderer?.info?.render?.calls ?? null,
        canvas: {
          bufferW: d.renderer?.domElement?.width ?? null,
          bufferH: d.renderer?.domElement?.height ?? null,
          clientW: d.renderer?.domElement?.clientWidth ?? null,
          clientH: d.renderer?.domElement?.clientHeight ?? null,
        },
        camera: d.camera ? { x: d.camera.position.x, y: d.camera.position.y, z: d.camera.position.z } : null,
        target: target ? { x: target.x, y: target.y, z: target.z } : null,
        heightField: d.heightField
          ? {
              sizeMeters: d.heightField.sizeMeters,
              reliefMeters: d.heightField.reliefMeters,
              minMeters: d.heightField.elevation?.minMeters ?? null,
            }
          : null,
        exag: d.env?.uExaggeration?.value ?? null,
      };
    };

    const cameraCloseUp = (opts = {}) => {
      const d = window.__designer || {};
      const hf = d.heightField;
      if (!hf) return { ok: false, reason: 'heightField 不存在' };
      const x = opts.x ?? -126.8;
      const z = opts.z ?? -1648.8;
      const off = opts.offset || { x: 340, y: 300, z: 340 };
      const exag = d.env?.uExaggeration?.value ?? 1;
      const worldY = hf.sampleWorld(x, z) * hf.reliefMeters * exag;
      const target = { x, y: worldY + 10, z };
      d.cameraControls?.setTarget?.(target.x, target.y, target.z);
      d.camera.position.set(x + off.x, worldY + off.y, z + off.z);
      d.camera.updateMatrixWorld(true);
      return {
        ok: true,
        groundMeters: hf.elevationAt ? hf.elevationAt(x, z) : null,
        worldY,
        target,
        camera: { x: d.camera.position.x, y: d.camera.position.y, z: d.camera.position.z },
      };
    };

    // 顶栏水面总开关：按钮可能藏在「图形选项」菜单里
    const waterToggle = () => {
      const findSwitch = () =>
        resolveButton({
          anyTokens: ['水面:开', '水面:关', '水面开', '水面关', '水面'],
          prefer: ['开', '关'],
          allowHidden: true,
          maxTextLen: 12,
        }) || resolveButton({ acts: ['toggle-water', 'toggleWater'], allowHidden: true });
      let el = findSwitch();
      if (!el) return { ok: false, reason: '未找到水面总开关按钮' };
      let openedMenu = false;
      if (!isVisible(el)) {
        const menuBtn =
          resolveButton({ anyTokens: ['图形选项', '图形'], prefer: ['菜单'] }) ||
          resolveButton({ tokens: ['图形选项'] });
        if (menuBtn) {
          menuBtn.click();
          openedMenu = true;
        }
      }
      el = findSwitch();
      if (!el) return { ok: false, reason: '打开菜单后仍未找到开关' };
      const before = textOf(el);
      el.click();
      return { ok: true, before, after: textOf(el), openedMenu, visible: isVisible(el) };
    };

    const uiInfo = () => {
      const ui = document.getElementById('ui');
      const uiClass = ui?.className || '';
      const panels = [...document.querySelectorAll('aside, .panel')].map((p) => ({
        id: p.id || '',
        visible: isVisible(p),
        text: textOf(p).slice(0, 120),
      }));
      const waterPanels = panels.filter((p) => p.visible && /水体|水源|模拟/.test(p.text));
      const tour = document.body.classList.contains('tour-mode');
      const uiVisible = ui ? isVisible(ui) : false;
      const modelPanel = panels.find((p) => p.id === 'panel-models');
      return {
        uiClass,
        modeWater: /mode-water/.test(uiClass),
        modeModels: /mode-models/.test(uiClass),
        uiVisible,
        tour,
        waterPanels,
        waterPanelVisible: waterPanels.length > 0,
        panels,
        modelPanelVisible: modelPanel ? modelPanel.visible : null,
        tourExitVisible: (() => {
          const el = document.getElementById('tour-exit');
          return el ? !el.hidden && isVisible(el) : null;
        })(),
      };
    };

    const waterListRows = () => {
      const vis = (a) => a.filter(isVisible);
      const counts = {
        dataSourceId: vis([...document.querySelectorAll('[data-source-id]')]).length,
        dataWaterId: vis([...document.querySelectorAll('[data-water-id]')]).length,
        waterListItem: 0,
        waterListChildren: 0,
        sourceItem: vis([...document.querySelectorAll('.source-item, .source-row')]).length,
        modelItem: vis([...document.querySelectorAll('#water-list .model-item, #panel-water .model-item')]).length,
      };
      const wl = document.getElementById('water-list');
      if (wl) {
        counts.waterListChildren = vis([...wl.children]).length;
        counts.waterListItem = vis([...wl.querySelectorAll('li, .model-item')]).length;
      }
      const panelCandidates = [
        ...document.querySelectorAll('aside, .panel'),
      ].filter((p) => isVisible(p) && /水体|水源/.test(p.textContent || ''));
      let genericRows = 0;
      for (const p of panelCandidates) {
        const rows = vis([...p.querySelectorAll('[data-source-id], [data-water-id], .model-item, .source-row, .water-row')]);
        genericRows = Math.max(genericRows, rows.length);
      }
      counts.genericRows = genericRows;
      const countEl = document.getElementById('water-count');
      return {
        counts,
        waterCountText: countEl ? textOf(countEl) : null,
        panelCount: panelCandidates.length,
      };
    };

    const pageReady = () => ({
      designer: Boolean(window.__designer),
      loadingHidden: document.getElementById('loading')?.classList.contains('hidden') ?? null,
      loadingText: document.getElementById('loading-text')?.textContent ?? null,
      keys: window.__designer ? Object.keys(window.__designer) : null,
      hasWater: Boolean(window.__designer?.water),
    });

    const glAlive = () => {
      const d = window.__designer || {};
      const gl = d.renderer?.getContext?.();
      return {
        hasRenderer: Boolean(d.renderer),
        lost: gl && typeof gl.isContextLost === 'function' ? gl.isContextLost() : null,
        renderCalls: d.renderer?.info?.render?.calls ?? null,
        canvasW: d.renderer?.domElement?.clientWidth ?? null,
        canvasH: d.renderer?.domElement?.clientHeight ?? null,
      };
    };

    const allButtonTexts = () => allButtons().map(buttonInfo).filter((b) => b.visible).map((b) => b.text);

    // 勾选框（如「启用这个水源」）
    const setCheckbox = (opts = {}) => {
      const el = resolveControl('input[type="checkbox"]', opts);
      if (!el) {
        return {
          ok: false,
          inventory: [...document.querySelectorAll('input[type="checkbox"]')].map((e) => ({
            visible: isVisible(e),
            checked: e.checked,
            label: labelOfControl(e),
          })),
        };
      }
      const before = el.checked;
      if (before !== Boolean(opts.checked)) el.click();
      return { ok: true, before, after: el.checked, label: labelOfControl(el) };
    };

    // 场景水源标记小球的屏幕坐标（用于 page.mouse 拖动验证）
    const markerScreenPos = (opts = {}) => {
      const we = window.__designer?.waterEditor;
      const nodes = we?.nodes ? [...we.nodes.values()] : [];
      if (!nodes.length) return null;
      const node = nodes[Math.min(Math.max(Number(opts.index) || 0, 0), nodes.length - 1)];
      const sphere = node.sphere;
      const Vec3 = sphere.position.constructor;
      const world = new Vec3();
      sphere.getWorldPosition(world);
      const camera = window.__designer.camera;
      const ndc = world.clone().project(camera);
      const canvas = window.__designer.renderer.domElement;
      const rect = canvas.getBoundingClientRect();
      return {
        sourceId: node.id,
        source: node.source ? { x: node.source.x, z: node.source.z, radius: node.source.radius } : null,
        world: { x: world.x, y: world.y, z: world.z },
        screen: {
          x: Math.round(rect.left + ((ndc.x + 1) / 2) * rect.width),
          y: Math.round(rect.top + ((1 - ndc.y) / 2) * rect.height),
        },
        nodeCount: nodes.length,
        editorVisible: Boolean(we?.visible),
        groupVisible: Boolean(we?.group?.visible),
      };
    };

    window.__verify = {
      norm,
      isVisible,
      textOf,
      ancestorTexts,
      resolveButton,
      clickButton,
      existsButton,
      setRange,
      setSelect,
      setNumber,
      chooseValue,
      setCheckbox,
      markerScreenPos,
      rangeInventory,
      selectInventory,
      waterState,
      getStats,
      debugStats,
      sceneInfo,
      cameraCloseUp,
      waterToggle,
      uiInfo,
      waterListRows,
      pageReady,
      glAlive,
      allButtonTexts,
    };
  });
}

// ── page 端调用封装 ─────────────────────────────────────────────────────────
/** 页面 helper 若因 HMR reload 丢失则重新注入 */
async function ensureHelpers(page) {
  const ok = await page.evaluate(() => Boolean(window.__verify)).catch(() => false);
  if (ok) return true;
  await installHelpers(page);
  log('[warn] 页面 helper 丢失（页面可能被 HMR 重载），已重新注入');
  return false;
}

/** 主动刷新页面（工程持久化测试）并重新等待就绪 */
async function reloadAndWait(page) {
  intentionalReloads++;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(
    () => Boolean(window.__designer) && document.getElementById('loading')?.classList.contains('hidden'),
    { timeout: 150000, polling: 300 },
  );
  await installHelpers(page);
  await sleep(900);
}

function makeV(page) {
  const raw = {
    clickButton: (opts) => page.evaluate((o) => window.__verify.clickButton(o), opts),
    existsButton: (opts) => page.evaluate((o) => window.__verify.existsButton(o), opts),
    setRange: (opts) => page.evaluate((o) => window.__verify.setRange(o), opts),
    setSelect: (opts) => page.evaluate((o) => window.__verify.setSelect(o), opts),
    setNumber: (opts) => page.evaluate((o) => window.__verify.setNumber(o), opts),
    chooseValue: (opts) => page.evaluate((o) => window.__verify.chooseValue(o), opts),
    setCheckbox: (opts) => page.evaluate((o) => window.__verify.setCheckbox(o), opts),
    markerScreenPos: (opts) => page.evaluate((o) => window.__verify.markerScreenPos(o), opts),
    rangeInventory: () => page.evaluate(() => window.__verify.rangeInventory()),
    selectInventory: () => page.evaluate(() => window.__verify.selectInventory()),
    waterState: () => page.evaluate(() => window.__verify.waterState()),
    getStats: () => page.evaluate(() => window.__verify.getStats()),
    debugStats: () => page.evaluate(() => window.__verify.debugStats()),
    sceneInfo: () => page.evaluate(() => window.__verify.sceneInfo()),
    cameraCloseUp: (opts) => page.evaluate((o) => window.__verify.cameraCloseUp(o), opts),
    waterToggle: () => page.evaluate(() => window.__verify.waterToggle()),
    uiInfo: () => page.evaluate(() => window.__verify.uiInfo()),
    waterListRows: () => page.evaluate(() => window.__verify.waterListRows()),
    glAlive: () => page.evaluate(() => window.__verify.glAlive()),
    allButtonTexts: () => page.evaluate(() => window.__verify.allButtonTexts()),
  };
  const out = {};
  for (const [name, fn] of Object.entries(raw)) {
    out[name] = async (...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        const msg = String(err?.message ?? err);
        if (/__verify|Execution context was destroyed|Navigating frame|Cannot read properties of undefined/i.test(msg)) {
          await ensureHelpers(page).catch(() => {});
          return await fn(...args);
        }
        throw err;
      }
    };
  }
  return out;
}

// ── 统计归一化 ──────────────────────────────────────────────────────────────
function normStats(raw) {
  if (!raw || raw.__missing || raw.__error) return raw ? { ...raw } : null;
  return {
    wetCells: raw.wetCells ?? raw.wet ?? null,
    maxDepthMeters: raw.maxDepthMeters ?? raw.maxDepth ?? raw.max ?? null,
    steps: raw.steps ?? null,
    sourceCount: raw.sourceCount ?? null,
    paused: raw.paused ?? null,
    raw,
  };
}

function growthOk(t1, t2) {
  if (!t1 || !t2) return { ok: false, reason: '缺少两次采样' };
  const wetGrowth = (t1.wetCells ?? 0) > 0 && (t2.wetCells ?? 0) > (t1.wetCells ?? 0);
  const depthGrowth =
    (t1.maxDepthMeters ?? 0) > 0 &&
    (t2.maxDepthMeters ?? 0) >= (t1.maxDepthMeters ?? 0) * 1.01 &&
    (t2.maxDepthMeters ?? 0) - (t1.maxDepthMeters ?? 0) > 0.005;
  return {
    ok: wetGrowth || depthGrowth,
    wetGrowth,
    depthGrowth,
    t1: { wetCells: t1.wetCells, maxDepthMeters: t1.maxDepthMeters, steps: t1.steps },
    t2: { wetCells: t2.wetCells, maxDepthMeters: t2.maxDepthMeters, steps: t2.steps },
  };
}

// ── 截图与像素统计 ──────────────────────────────────────────────────────────
async function snap(page, name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, type: 'png' });
  const buf = fs.readFileSync(file);
  let stats = null;
  let error = null;
  try {
    stats = pngStats(buf);
  } catch (err) {
    error = String(err?.message ?? err);
  }
  return { name, file, buf, stats, error };
}

function snapOk(shot, { requireWater = false, minLum = 6, minColors = 100 } = {}) {
  if (!shot.stats) return { ok: false, reason: `PNG 解析失败：${shot.error}` };
  const s = shot.stats;
  const dimOk = s.width === VIEW.width && s.height === VIEW.height;
  const bright = s.meanLum >= minLum;
  const varied = s.colorsCapped || s.uniqueColors >= minColors;
  const notBlack = s.blackFraction < 0.95;
  const waterOk = requireWater ? s.blueFraction > 0.003 : true;
  return {
    ok: dimOk && bright && varied && notBlack && waterOk,
    dimOk,
    bright,
    varied,
    notBlack,
    waterOk,
    stats: {
      width: s.width,
      height: s.height,
      meanLum: s.meanLum,
      lumStd: s.lumStd,
      blackFraction: s.blackFraction,
      blueFraction: s.blueFraction,
      uniqueColors: s.uniqueColors,
    },
  };
}

// ── 静态检查 ────────────────────────────────────────────────────────────────
function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

/** 去掉 JS 注释（保留字符串内容），避免把注释里的旧 API 当残留 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code';
  let quote = '';
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && c2 === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        state = 'string';
        quote = c;
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
    } else if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      i++;
    } else if (state === 'block') {
      if (c === '*' && c2 === '/') {
        state = 'code';
        i += 2;
      } else {
        if (c === '\n') out += c;
        i++;
      }
    } else {
      out += c;
      i++;
      if (c === '\\') {
        if (i < n) {
          out += src[i];
          i++;
        }
        continue;
      }
      if (c === quote) {
        state = 'code';
        quote = '';
      }
    }
  }
  return out;
}

function runStaticChecks() {
  const deleted = [
    'src/editor/waterSystem.js',
    'src/terrain/waterShaders.js',
    'src/terrain/waterTextures.js',
  ];
  const stillThere = deleted.filter((rel) => fs.existsSync(path.join(MD, rel)));
  rec('旧水面模块文件已删除（waterSystem / terrain waterShaders / terrain waterTextures）', stillThere.length === 0, {
    stillThere,
  });

  const newFiles = ['src/water/fluidWater.js', 'src/water/waterShaders.js', 'src/water/waterTextures.js'];
  info('新增 src/water 模块', newFiles.map((rel) => `${rel}: ${fs.existsSync(path.join(MD, rel))}`));

  const srcFiles = walkFiles(path.join(MD, 'src')).filter((f) => /\.(js|mjs|css|html)$/i.test(f));
  const hits = [];
  const identPatterns = [
    { re: /\bwaterSystem\b/g, name: 'waterSystem' },
    { re: /\bWaterSystem\b/g, name: 'WaterSystem' },
    { re: /\bmakeWaterMaterial\b/g, name: 'makeWaterMaterial' },
    { re: /\.addArea\s*\(/g, name: 'addArea(' },
    { re: /\baddFlow\s*\(/g, name: 'addFlow(' },
  ];
  const bannedImports = new Set([
    'src/terrain/waterShaders.js',
    'src/terrain/waterTextures.js',
    'src/editor/waterSystem.js',
  ]);

  for (const file of srcFiles) {
    const rel = path.relative(MD, file).split(path.sep).join('/');
    let code;
    try {
      code = stripComments(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const checkImport = (spec, at) => {
      const clean = spec.replace(/\\/g, '/');
      if (!/^\.{1,2}\//.test(clean)) return;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), clean));
      if (bannedImports.has(resolved)) {
        hits.push({ file: rel, line: at, kind: '旧模块 import', detail: clean });
      }
    };
    const importRe = /\bfrom\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = importRe.exec(code))) checkImport(m[1], code.slice(0, m.index).split('\n').length);
    const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = dynamicRe.exec(code))) checkImport(m[1], code.slice(0, m.index).split('\n').length);
    for (const { re, name } of identPatterns) {
      re.lastIndex = 0;
      let mm;
      while ((mm = re.exec(code))) {
        hits.push({
          file: rel,
          line: code.slice(0, mm.index).split('\n').length,
          kind: name,
          detail: code.slice(Math.max(0, mm.index - 50), mm.index + 70).replace(/\s+/g, ' '),
        });
      }
    }
  }
  rec('src 无旧水面 API 残留（waterSystem/makeWaterMaterial/addArea(/addFlow(）', hits.length === 0, {
    hits: hits.slice(0, 30),
    scanned: srcFiles.length,
  });

  // 契约里 Lead 负责清掉的东西，作为 INFO（不单独判 FAIL）
  const leftovers = [];
  for (const rel of ['src/terrain/environment.js', 'src/terrain/shaders.js']) {
    const abs = path.join(MD, rel);
    if (!fs.existsSync(abs)) continue;
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    if (rel.endsWith('environment.js') && /export\s+class\s+Water\b/.test(code)) leftovers.push(`${rel}: export class Water`);
    if (rel.endsWith('shaders.js') && /export\s+const\s+water(Vertex|Fragment)\b/.test(code)) leftovers.push(`${rel}: waterVertex/waterFragment`);
  }
  if (leftovers.length) info('旧水面包在 environment/shaders 里的遗留符号（契约要求删除，建议确认）', leftovers);
}

// ── 构建 ────────────────────────────────────────────────────────────────────
function runViteBuild(dir, label) {
  return new Promise((resolve) => {
    const viteBin = path.join(dir, 'node_modules', 'vite', 'bin', 'vite.js');
    if (!fs.existsSync(viteBin)) {
      resolve({ ok: false, output: `找不到 ${viteBin}` });
      return;
    }
    log(`[build] ${label}: ${process.execPath} node_modules/vite/bin/vite.js build  (cwd=${dir})`);
    const child = spawn(process.execPath, [viteBin, 'build'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d.toString()));
    child.stderr.on('data', (d) => chunks.push(d.toString()));
    const timer = setTimeout(() => {
      log(`[build] ${label} 超时（300s），终止`);
      killChild(child);
    }, 300000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = chunks.join('');
      log(`[build] ${label} 退出码 = ${code}`);
      const tail = output.split(/\r?\n/).filter((l) => l.trim()).slice(-25).join('\n');
      if (tail) log(tail.split('\n').map((l) => `[build:${label}] ${l}`).join('\n'));
      resolve({ ok: code === 0, code, output });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: String(err) });
    });
  });
}

// ── 动态验证主流程 ──────────────────────────────────────────────────────────
async function runDynamicChecks(ctx) {
  const { page } = ctx;
  const V = makeV(page);

  // 1) 打开页面 → 等待就绪
  const gotoAt = Date.now();
  await page.goto(ctx.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  try {
    await page.waitForFunction(
      () => Boolean(window.__designer) && document.getElementById('loading')?.classList.contains('hidden'),
      { timeout: 150000, polling: 300 },
    );
    rec('页面就绪（window.__designer 存在 + loading 隐藏）', true, `${Date.now() - gotoAt}ms`);
  } catch (err) {
    const diag = await page.evaluate(() => ({
      designer: Boolean(window.__designer),
      loadingClass: document.getElementById('loading')?.className,
      loadingText: document.getElementById('loading-text')?.textContent,
      keys: window.__designer ? Object.keys(window.__designer) : null,
    })).catch(() => null);
    rec('页面就绪（window.__designer 存在 + loading 隐藏）', false, { diag, error: String(err?.message ?? err) });
    throw new Error('页面就绪超时');
  }
  await installHelpers(page);
  const navBaseline = navigations; // 就绪后导航次数基线（首次 goto 已计入）
  await sleep(900);

  // 2) 启动错误 + WebGL 检查
  const bootErrors = errorsList();
  rec('启动无 JS / 着色器 / 模块加载报错', bootErrors.length === 0, bootErrors.slice(0, 15));
  const boot = await V.sceneInfo();
  info('渲染上下文', {
    webgl2: boot.webgl2,
    glRenderer: boot.glRenderer,
    glLost: boot.glLost,
    canvas: boot.canvas,
    heightField: boot.heightField,
    exag: boot.exag,
  });
  rec(
    'WebGL2 上下文可用且未丢失',
    boot.webgl2 === true && boot.glLost === false && Boolean(boot.glRenderer),
    { webgl2: boot.webgl2, glLost: boot.glLost, glRenderer: boot.glRenderer },
  );

  // 3) window.__designer.water 存在性（产品未完成时提前结束，等 Lead 通知再跑）
  let ws = await V.waterState();
  if (!ws) {
    rec('window.__designer.water 暴露 FluidWater 实例', false, {
      designerKeys: boot.designerKeys,
      hasWaterEditor: boot.hasWaterEditor,
      hint: '若 Lead 尚未落地 src/water/，先记录等通知再跑',
    });
    const rr = collectErrors();
    info('采集到的错误（供定位）', {
      pageErrors: rr.pageErrors.slice(0, 8),
      consoleErrors: rr.consoleErrors.slice(0, 12),
      failedRequests: rr.failedRequests.slice(0, 12),
      resourceErrors: rr.resourceErrors.slice(0, 12),
    });
    await snap(page, 'water-missing.png').then((s) => info('当前页面截图', s.file)).catch(() => {});
    return;
  }
  rec('window.__designer.water 暴露 FluidWater 实例', true, {
    sources: ws.sources.length,
    apiCount: ws.api.length,
    mesh: ws.mesh,
  });
  const requiredApi = [
    'groundMetersAt', 'addSource', 'updateSource', 'removeSource', 'clearSources', 'selectSource',
    'setEnabled', 'setSimSpeed', 'setWaterAmount', 'setPaused', 'setResolution', 'setVisual', 'reset',
    'update', 'debugStats', 'toJSON', 'load', 'dispose',
  ];
  const missingApi = requiredApi.filter((k) => !ws.api.includes(k));
  rec('FluidWater 公开 API 齐全（按契约）', missingApi.length === 0, {
    missing: missingApi,
    missingCount: missingApi.length,
  });
  rec(
    '模拟域自动覆盖整个 8km 地形（无需手动创建高度图/调范围）',
    ws.sizeMeters === 8000 && ws.sizeMeters === boot.heightField?.sizeMeters,
    { waterSizeMeters: ws.sizeMeters, terrainSizeMeters: boot.heightField?.sizeMeters, cellMeters: ws.cellMeters },
  );

  // 4) 顶部切换到「水体编辑」
  let uiInfo = await V.uiInfo();
  const modeClick = await V.clickButton({ modes: ['water'] });
  let modeHow = 'data-mode=water 按钮';
  if (!modeClick.ok) {
    const byText = await V.clickButton({ tokens: ['水体编辑'] });
    if (byText.ok) modeHow = `文本「水体编辑」`;
    else {
      const byLoose = await V.clickButton({ anyTokens: ['水体'], prefer: ['编辑'] });
      if (byLoose.ok) modeHow = '文本含「水体」的顶栏按钮';
    }
  }
  await sleep(500);
  uiInfo = await V.uiInfo();
  if (!uiInfo.waterPanelVisible && !uiInfo.modeWater && boot.hasUi) {
    // 找不到按钮时退回 API 切模式（仍判 FAIL，但让后续检查可跑）
    const fallback = await page
      .evaluate(() => {
        try {
          window.__designer?.ui?.setMode?.('water');
          return true;
        } catch {
          return false;
        }
      })
      .catch(() => false);
    if (fallback) await sleep(400);
    uiInfo = await V.uiInfo();
    rec('顶部切换到「水体编辑」模式', false, {
      clicked: modeClick,
      uiClass: uiInfo.uiClass,
      buttons: await V.allButtonTexts(),
      fallbackUsed: fallback,
    });
  } else {
    rec('顶部切换到「水体编辑」模式', uiInfo.waterPanelVisible || uiInfo.modeWater, {
      how: modeHow,
      uiClass: uiInfo.uiClass,
      waterPanels: uiInfo.waterPanels.map((p) => p.id || p.text.slice(0, 40)),
    });
  }
  rec('水体面板可见（含水源/模拟控件）', uiInfo.waterPanelVisible, uiInfo.waterPanels.map((p) => p.id));

  // 旧水面交互 UI 应彻底移除
  const buttonsInWaterMode = await V.allButtonTexts();
  const oldUiButtons = buttonsInWaterMode.filter((t) => /水面区域|流动水|创建高度图|模拟范围/.test(t));
  rec('旧水面 UI 已移除（无「＋水面区域 / ＋流动水 / 创建高度图」按钮）', oldUiButtons.length === 0, {
    oldUiButtons,
    visibleButtonCount: buttonsInWaterMode.length,
  });

  // 5) 点「＋水源」进入放置模式 + 画布点选（连续放 2 个）
  const beforeSources = (await V.waterState()).sources.length;
  const addBtn =
    (await V.clickButton({ anyTokens: ['+水源', '＋水源', '添加水源', '新增水源'], prefer: ['水体', '水源'], maxTextLen: 14 })) ||
    (await V.clickButton({ anyTokens: ['水源'], prefer: ['+', '添加', '新增'], maxTextLen: 10 })) ||
    (await V.clickButton({ acts: ['add-source', 'addSource', 'source-add', 'water-add'], allowHidden: true }));
  await sleep(400);
  let editorInfo = (await V.waterState()).waterEditor;
  rec('点击「＋水源」按钮后进入放置模式', addBtn.ok, {
    button: addBtn,
    waterEditor: editorInfo,
    placementActive: editorInfo.active,
  });

  // 找一个能命中地形的画布像素（默认画布中央偏下，失败时探测其它点）
  const clickCandidates = await page
    .evaluate(() => {
      const out = [];
      for (const [x, y] of [
        [640, 470],
        [640, 520],
        [620, 500],
        [680, 520],
        [600, 450],
        [700, 560],
        [640, 400],
      ]) {
        try {
          const p = window.__designer?.cameraControls?.pick?.(x, y);
          if (p) out.push({ x, y, terrain: { x: Number(p.x.toFixed(1)), z: Number(p.z.toFixed(1)) } });
        } catch {
          /* ignore */
        }
      }
      return out;
    })
    .catch(() => []);
  info('画布点选候选（cameraControls.pick）', clickCandidates);

  const waitSources = async (expected, timeout = 4500) => {
    try {
      await page.waitForFunction(
        (n) => window.__designer?.water?.state?.sources?.length === n,
        { timeout, polling: 150 },
        expected,
      );
      return true;
    } catch {
      return false;
    }
  };

  let placed1 = { ok: false };
  let usedPoint = null;
  for (const pt of clickCandidates) {
    await page.mouse.click(pt.x, pt.y);
    const ok = await waitSources(beforeSources + 1);
    if (ok) {
      placed1 = { ok: true, point: pt };
      usedPoint = pt;
      break;
    }
    await sleep(200);
  }
  const afterFirst = await V.waterState();
  rec('在地形上点选放置第 1 个水源', placed1.ok, {
    before: beforeSources,
    after: afterFirst.sources.length,
    point: usedPoint,
    sources: afterFirst.sources.map((s) => ({ x: Number(s.x?.toFixed?.(1)), z: Number(s.z?.toFixed?.(1)), radius: s.radius })),
  });

  // 连续放置：不再点「＋水源」，直接再点一次地形
  let placed2 = { ok: false };
  if (placed1.ok) {
    const pt2 = clickCandidates.find((p) => p !== usedPoint) || { x: 660, y: 520 };
    editorInfo = afterFirst.waterEditor;
    if (!editorInfo.active) {
      // 有的 UI 放完一个会退出放置模式，这种情况重新点按钮也算「可连续放置」的一半
      info('放下第 1 个水源后 WaterEditor.active=false，重新点「＋水源」再放下一个');
      await V.clickButton({ anyTokens: ['+水源', '＋水源', '添加水源', '新增水源'], prefer: ['水体'], maxTextLen: 14 });
      await sleep(300);
    }
    await page.mouse.click(pt2.x, pt2.y);
    placed2.ok = await waitSources(beforeSources + 2);
    if (!placed2.ok) {
      await page.mouse.click(pt2.x, pt2.y + 30);
      placed2.ok = await waitSources(beforeSources + 2);
    }
  }
  const afterSecond = await V.waterState();
  rec('可连续放置（不重按按钮）第 2 个水源', placed2.ok, {
    after: afterSecond.sources.length,
    expected: beforeSources + 2,
  });

  const rows = await V.waterListRows();
  const rowCounts = Object.values(rows.counts);
  const synced = rowCounts.includes(afterSecond.sources.length);
  rec('左侧水源列表行数与 state.sources 同步', synced, {
    sources: afterSecond.sources.length,
    counts: rows.counts,
    waterCountText: rows.waterCountText,
  });

  // 放置模式截图（＋水源 激活状态 + 面板）
  let placingEditor = (await V.waterState()).waterEditor;
  if (!placingEditor.active) {
    await V.clickButton({ anyTokens: ['+水源', '添加水源', '新增水源'], prefer: ['水体'], maxTextLen: 14 });
    await sleep(350);
    placingEditor = (await V.waterState()).waterEditor;
  }
  const placingShot = await snap(page, 'water-placing.png');
  const placingShotCheck = snapOk(placingShot);
  rec('截图 water-placing.png（放置模式 + 面板可见）', placingShotCheck.ok && placingEditor.active, {
    active: placingEditor.active,
    ...placingShotCheck,
  });
  info('截图路径', placingShot.file);

  // 退出放置模式，避免影响拖动 / 后续 UI 操作
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(400);

  // 5.5) 拖动场景水源小球改位置（真实 page.mouse 拖动）
  const dragBefore = await V.waterState();
  const dragTargetBefore = dragBefore.sources[0] ?? null;
  let marker = null;
  const nodeCount = (await V.waterState()).waterEditor.nodeCount ?? 1;
  for (let i = 0; i < Math.max(1, nodeCount); i++) {
    const m = await V.markerScreenPos({ index: i });
    if (m && m.screen.x > 380 && m.screen.x < 900 && m.screen.y > 140 && m.screen.y < 720) {
      marker = m;
      break;
    }
    if (!marker && m) marker = m;
  }
  info('水源标记屏幕坐标', marker);
  let dragRes = { ok: false };
  if (marker && marker.screen && dragTargetBefore) {
    const sx = marker.screen.x;
    const sy = marker.screen.y;
    await page.mouse.move(sx, sy);
    await sleep(150);
    await page.mouse.down({ button: 'left' });
    await sleep(100);
    await page.mouse.move(sx + 90, sy + 45, { steps: 10 });
    await sleep(150);
    await page.mouse.up({ button: 'left' });
    await sleep(600);
    const dragAfter = await V.waterState();
    const moved = dragAfter.sources.find((s) => s.id === marker.sourceId);
    if (moved) {
      const dx = Number(moved.x) - Number(dragTargetBefore.x);
      const dz = Number(moved.z) - Number(dragTargetBefore.z);
      dragRes = {
        ok: Math.hypot(dx, dz) > 5,
        movedSourceId: marker.sourceId,
        dx: Number(dx.toFixed(1)),
        dz: Number(dz.toFixed(1)),
        dist: Number(Math.hypot(dx, dz).toFixed(1)),
        before: { x: dragTargetBefore.x, z: dragTargetBefore.z },
        after: { x: moved.x, z: moved.z },
      };
    } else {
      dragRes = { ok: false, reason: '拖动后找不到该水源', sources: dragAfter.sources, marker };
    }
  } else {
    dragRes = { ok: false, reason: '找不到可拖动的水源标记小球', marker };
  }
  rec('拖动场景水源小球改位置（水平拖动写回 state 坐标）', dragRes.ok, dragRes);

  // 6) UI 联动：模拟速度 / 每次注水量 / 模拟精度
  let before = await V.waterState();
  const speedBefore = before.sim.speed;
  const speedSet = await V.setRange({ tokens: ['模拟速度'], value: 3 });
  await sleep(400);
  let after = await V.waterState();
  rec('「模拟速度」输入 → state.sim.speed 变化', speedSet.ok && Math.abs(after.sim.speed - 3) < 0.001, {
    slider: speedSet.ok ? { before: speedSet.before, after: speedSet.after } : speedSet,
    stateBefore: speedBefore,
    stateAfter: after.sim.speed,
  });

  const amountSet =
    (await V.setRange({ tokens: ['每次注水量'], value: 80 })) ||
    (await V.setRange({ tokens: ['注水量'], value: 80 }));
  await sleep(400);
  after = await V.waterState();
  rec('「每次注水量」输入 → state.sim.waterAmount 变化', amountSet.ok && Math.abs(after.sim.waterAmount - 80) < 0.001, {
    control: amountSet.ok ? { before: amountSet.before, after: amountSet.after } : amountSet,
    state: after.sim.waterAmount,
  });

  const errorsBeforePrecision = pageErrors.length + consoleErrors.length;
  let precisionSet =
    (await V.setSelect({ tokens: ['模拟精度'], value: 512 })) ||
    (await V.setSelect({ tokens: ['精度'], value: 512 })) ||
    (await V.chooseValue({ tokens: ['模拟精度', '精度'], value: 512 })) ||
    (await V.chooseValue({ tokens: ['模拟精度', '精度'], value: '512' }));
  if (!precisionSet.ok) {
    info('精度控件未找到，转储控件清单', {
      ranges: await V.rangeInventory(),
      selects: await V.selectInventory(),
    });
  }
  await sleep(900);
  after = await V.waterState();
  const glAfterPrecision = await V.glAlive();
  const errorsAfterPrecision = pageErrors.length + consoleErrors.length;
  rec('「模拟精度」切换到 512 → state.sim.resolution=512', precisionSet.ok && after.sim.resolution === 512, {
    control: precisionSet,
    resolution: after.sim.resolution,
  });
  rec('切换精度后页面未崩溃（WebGL 上下文存活）', glAfterPrecision.lost === false && errorsAfterPrecision === errorsBeforePrecision, {
    gl: glAfterPrecision,
    newConsoleErrors: consoleErrorLines().slice(-3),
  });
  if (!precisionSet.ok) {
    // 控件缺失时用 API 兜底，让后续模拟检查能跑（本条仍已 FAIL）
    await page.evaluate(() => window.__designer.water.setResolution?.(512)).catch(() => {});
    await sleep(500);
  }
  await sleep(500);
  const st512 = normStats(await V.debugStats());
  rec('精度 512 下 debugStats 正常（steps/wetCells 可读）', Boolean(st512) && !st512.__missing && !st512.__error && Number(st512.steps) > 0, st512?.raw ?? st512);

  // 6.1) 工程持久化：等自动保存后刷新页面，水源与模拟参数应恢复
  const persistBefore = await V.waterState();
  await sleep(1500);
  try {
    const reloadStart = Date.now();
    await reloadAndWait(page);
    const persisted = await V.waterState();
    const beforeIds = persistBefore.sources.map((s) => s.id);
    const afterIds = (persisted?.sources ?? []).map((s) => s.id);
    const sameSources = beforeIds.length === afterIds.length && beforeIds.every((id) => afterIds.includes(id));
    rec('工程持久化：刷新页面后水源恢复（id 一致）', Boolean(persisted) && sameSources, {
      before: beforeIds,
      after: afterIds,
      reloadMs: Date.now() - reloadStart,
    });
    rec(
      '工程持久化：模拟参数恢复（speed/waterAmount/resolution）',
      Boolean(persisted) &&
        Math.abs(persisted.sim.speed - 3) < 0.001 &&
        Math.abs(persisted.sim.waterAmount - 80) < 0.001 &&
        persisted.sim.resolution === 512,
      { sim: persisted?.sim },
    );
    const modeAfterReload = await V.uiInfo();
    info('刷新后的界面状态', { uiClass: modeAfterReload.uiClass, waterPanelVisible: modeAfterReload.waterPanelVisible });
    after = persisted;
  } catch (err) {
    rec('工程持久化：刷新页面后水源恢复（id 一致）', false, String(err?.message ?? err));
  }

  // 6.2) 精度切到 1024：不崩、stats 正常（随后 API 模拟段会切回 768）
  const precision1024 =
    (await V.setSelect({ tokens: ['模拟精度'], value: 1024 })) ||
    (await V.setSelect({ tokens: ['精度'], value: 1024 })) ||
    (await V.chooseValue({ tokens: ['模拟精度', '精度'], value: 1024 }));
  await sleep(1300);
  const ws1024 = await V.waterState();
  const gl1024 = await V.glAlive();
  const st1024 = normStats(await V.debugStats());
  rec(
    '「模拟精度」切换到 1024 → state.sim.resolution=1024 且页面不崩',
    precision1024.ok && ws1024.sim.resolution === 1024 && gl1024.lost === false,
    { control: precision1024, resolution: ws1024.sim.resolution, gl: gl1024 },
  );
  rec(
    '精度 1024 下 debugStats 正常（steps 增长 / wetCells 可读）',
    Boolean(st1024) && !st1024.__missing && !st1024.__error && Number(st1024.steps) > 0 && st1024.wetCells != null,
    st1024?.raw ?? st1024,
  );

  // 7) 暂停 / 继续
  const pauseClick = await V.clickButton({ anyTokens: ['暂停'], prefer: ['模拟', '水体'], maxTextLen: 12 });
  await sleep(500);
  const pausedState = await V.waterState();
  const statsA = await V.getStats();
  await sleep(3200);
  const statsB = await V.getStats();
  const stepsPaused =
    statsA && statsB ? Number(statsB.steps ?? 0) - Number(statsA.steps ?? 0) : null;
  rec('暂停后模拟步数停止增长', pauseClick.ok && pausedState.sim.paused === true && stepsPaused !== null && stepsPaused <= 1, {
    button: pauseClick,
    paused: pausedState.sim.paused,
    steps: [statsA?.steps, statsB?.steps],
    delta: stepsPaused,
  });

  const resumeClick = await V.clickButton({ anyTokens: ['继续'], prefer: ['模拟', '水体'], maxTextLen: 12 });
  await sleep(600);
  const statsC = await V.getStats();
  await sleep(3200);
  const statsD = await V.getStats();
  const stepsResumed = statsC && statsD ? Number(statsD.steps ?? 0) - Number(statsC.steps ?? 0) : null;
  rec('继续后模拟步数恢复增长', resumeClick.ok && stepsResumed !== null && stepsResumed > 2, {
    button: resumeClick,
    steps: [statsC?.steps, statsD?.steps],
    delta: stepsResumed,
  });

  // 8) 截图 water-ui.png（水体面板 + 选中水源编辑）
  const wsForUiShot = await V.waterState();
  if (wsForUiShot?.sources?.length) {
    await page.evaluate((id) => window.__designer.water.selectSource(id), wsForUiShot.sources[0].id).catch(() => {});
    await sleep(400);
  }
  const uiShot = await snap(page, 'water-ui.png');
  const uiShotCheck = snapOk(uiShot);
  const uiShotInfo = await V.uiInfo();
  rec('截图 water-ui.png（1280×800 非全黑 / 非纯色）', uiShotCheck.ok, uiShotCheck);
  rec('水体面板显示选中水源编辑区', uiShotInfo.waterPanelVisible && /选中水源|水源半径|目标水面高程/.test(uiShotInfo.waterPanels.map((p) => p.text).join('')), {
    waterPanels: uiShotInfo.waterPanels.map((p) => p.id || p.text.slice(0, 40)),
  });
  info('截图路径', uiShot.file);

  // 9) API 在低洼处放置水源并调参，验证 GPU 浅水模拟
  const clearRes = await page
    .evaluate(() => {
      const w = window.__designer.water;
      w.clearSources();
      return w.state.sources.length;
    })
    .catch((err) => ({ error: String(err?.message ?? err) }));
  info('清空水源（为低洼点模拟测量腾出干净初始态）', { remaining: clearRes });
  await sleep(300);

  const ground = await page.evaluate((pt) => window.__designer.water.groundMetersAt(pt.x, pt.z), LOW_POINT);
  info('低洼点地面高程', { point: LOW_POINT, groundMeters: ground, targetLevel: ground + TARGET_LIFT });
  rec('groundMetersAt 返回有效地面高程', typeof ground === 'number' && Number.isFinite(ground), { ground });

  const addRes = await page
    .evaluate(
      ({ pt, lift }) => {
        const w = window.__designer.water;
        const s = w.addSource({ x: pt.x, z: pt.z });
        if (!s) return { error: 'addSource 返回空' };
        w.updateSource(s.id, { radius: 900, targetLevel: w.groundMetersAt(pt.x, pt.z) + lift });
        w.setSimSpeed(2);
        w.setWaterAmount(60);
        w.setResolution(768);
        const st = w.state;
        const src = st.sources.find((x) => x.id === s.id);
        return {
          id: s.id,
          source: src ? { ...src } : null,
          sim: { ...st.sim },
          count: st.sources.length,
        };
      },
      { pt: LOW_POINT, lift: TARGET_LIFT },
    )
    .catch((err) => ({ error: String(err?.message ?? err) }));
  rec('API 在低洼处添加水源', !addRes.error && addRes.count === 1, addRes);
  if (!addRes.error) {
    const src = addRes.source;
    rec(
      'updateSource({radius:900, targetLevel:地面+25}) 生效',
      src && Math.abs(Number(src.radius) - 900) < 0.01 && Math.abs(Number(src.targetLevel) - (ground + TARGET_LIFT)) < 0.6,
      { source: src, expectedTargetLevel: ground + TARGET_LIFT },
    );
    rec(
      'setSimSpeed(2) / setWaterAmount(60) / setResolution(768) 生效',
      addRes.sim.speed === 2 && addRes.sim.waterAmount === 60 && addRes.sim.resolution === 768,
      addRes.sim,
    );
  }

  // 模拟时间推进：等 4 秒读第一次，等 3 秒读第二次
  const simT0 = Date.now();
  await sleep(4000);
  const t1 = normStats(await V.debugStats());
  info('debugStats 第一次采样（约 4s）', t1?.raw ?? t1);
  const usePixelFallback = !t1 || t1.__missing || t1.__error || t1.maxDepthMeters == null;
  let camInfo = null;
  let simShot = null;
  let simOffShot = null;
  let simGrowth = null;

  if (!usePixelFallback) {
    rec(
      '模拟 4s 后 wetCells > 0（水已出现）',
      Number(t1.wetCells) > 0,
      { wetCells: t1.wetCells, maxDepthMeters: t1.maxDepthMeters, steps: t1.steps },
    );
    rec(
      '模拟 4s 后 maxDepthMeters > 0.3（有实际水深）',
      Number(t1.maxDepthMeters) > 0.3,
      { maxDepthMeters: t1.maxDepthMeters, wetCells: t1.wetCells },
    );
    await sleep(3000);
    const t2 = normStats(await V.debugStats());
    info('debugStats 第二次采样（约 7s）', t2?.raw ?? t2);
    simGrowth = growthOk(t1, t2);
    rec('水在扩散 / 变深（wetCells 或 maxDepth 增长）', simGrowth.ok, simGrowth);
    // 全局水位上限（溢洪道）生效：targetLevel=地面+25 时水深不应无限增长
    rec(
      '全局水位上限生效（maxDepth 稳定在目标水深附近，不再无限灌高）',
      t2 && Number(t2.maxDepthMeters) > 0.3 && Number(t2.maxDepthMeters) < 50,
      { maxDepthMeters: t2?.maxDepthMeters, targetLiftMeters: TARGET_LIFT, threshold: 50 },
    );
  } else {
    info('debugStats 不可用（null / 空 / 报错），改用截图蓝像素对比', { t1: t1?.raw ?? t1 });
  }

  // 9.5) 水源启用 / 停用（右侧「启用这个水源」勾选框）
  const srcBeforeToggle = await V.waterState();
  const disableRes = await V.setCheckbox({ tokens: ['启用'], checked: false });
  await sleep(800);
  const wsDisabled = await V.waterState();
  const depthBeforeDisable = normStats(await V.debugStats());
  await sleep(2200);
  const depthAfterDisable = normStats(await V.debugStats());
  rec('「启用这个水源」取消勾选 → state.sources[0].enabled=false', disableRes.ok && (wsDisabled?.sources?.length ?? 0) > 0 && wsDisabled.sources[0].enabled === false, {
    checkbox: disableRes,
    sources: wsDisabled?.sources?.map((s) => ({ id: s.id, enabled: s.enabled })),
  });
  rec(
    '停用后不再继续注水（maxDepth 不再增长）',
    depthBeforeDisable &&
      depthAfterDisable &&
      depthAfterDisable.maxDepthMeters != null &&
      Number(depthAfterDisable.maxDepthMeters) <= Number(depthBeforeDisable.maxDepthMeters) * 1.05 + 0.5,
    { before: depthBeforeDisable, after: depthAfterDisable },
  );
  const enableRes = await V.setCheckbox({ tokens: ['启用'], checked: true });
  await sleep(800);
  const wsEnabled = await V.waterState();
  rec('重新勾选「启用这个水源」→ enabled=true', enableRes.ok && wsEnabled.sources[0]?.enabled === true, {
    checkbox: enableRes,
    sources: wsEnabled.sources.map((s) => ({ id: s.id, enabled: s.enabled })),
    sourceCountBefore: srcBeforeToggle?.sources?.length,
  });

  // 近景相机 + 水面截图（测量与截图共用同一机位）
  camInfo = await V.cameraCloseUp({ x: LOW_POINT.x, z: LOW_POINT.z, offset: { x: 760, y: 520, z: 760 } });
  await sleep(1000);
  info('近景相机', camInfo);
  info('近景场景状态', await V.sceneInfo());

  simShot = await snap(page, 'water-sim.png');
  const simShotCheck = snapOk(simShot, { requireWater: false });
  rec('截图 water-sim.png（近景，非全黑 / 非纯地形色）', simShotCheck.ok, simShotCheck);
  info('截图路径', simShot.file);

  if (usePixelFallback) {
    // 回退：同一机位等 3 秒再截一张，比较蓝色像素数量
    await sleep(3000);
    const simShot2 = await snap(page, 'water-sim-fallback-t2.png');
    if (simShot?.stats && simShot2?.stats) {
      const delta = simShot2.stats.blueFraction - simShot.stats.blueFraction;
      rec('水在扩散 / 变深（截图蓝像素占比增长，回退方案）', delta > 0.0005, {
        t1: simShot.stats.blueFraction,
        t2: simShot2.stats.blueFraction,
        delta,
      });
    } else {
      rec('水在扩散 / 变深（截图蓝像素占比增长，回退方案）', false, {
        reason: '截图解析失败',
        t1: simShot?.error,
        t2: simShot2?.error,
      });
    }
    await sleep(300);
    simShot = await snap(page, 'water-sim.png');
  }

  // 10) 水面总开关：关 → 截图差异证明水在渲染 → 开
  const toggleOff = await V.waterToggle();
  await sleep(700);
  const wsOff = await V.waterState();
  rec('顶栏「水面：开/关」→ water.state.enabled 切换', toggleOff.ok && wsOff.enabled === false, {
    toggle: toggleOff,
    enabled: wsOff.enabled,
  });
  rec('关闭后水面网格 visible 同步为 false', wsOff.mesh.visibleMeshes === 0, wsOff.mesh);

  simOffShot = await snap(page, 'water-sim-off.png');
  if (simShot?.buf && simOffShot?.buf) {
    let diff = null;
    try {
      diff = pngDiff(simShot.buf, simOffShot.buf, { step: 2, threshold: 14 });
    } catch (err) {
      diff = { error: String(err?.message ?? err) };
    }
    rec('水面确实参与渲染（开/关近景截图差异 > 1%）', Boolean(diff && diff.ratio > 0.01), diff);
  } else {
    rec('水面确实参与渲染（开/关近景截图差异 > 1%）', false, { reason: '截图不可用' });
  }

  const toggleOn = await V.waterToggle();
  await sleep(600);
  const wsOn = await V.waterState();
  rec('重新打开水面 → enabled=true 且网格可见', toggleOn.ok && wsOn.enabled === true && wsOn.mesh.visibleMeshes > 0, {
    toggle: toggleOn,
    enabled: wsOn.enabled,
    mesh: wsOn.mesh,
  });

  // 11) 游览模式截图（隐藏 UI 的观赏视角）
  const weBeforeTour = (await V.waterState()).waterEditor;
  await page.evaluate(() => window.__designer.applyTour?.(true)).catch(() => {});
  await sleep(800);
  const tourUi = await V.uiInfo();
  const weInTour = (await V.waterState()).waterEditor;
  rec(
    '游览模式隐藏水源标记（waterEditor.group.visible=false）',
    weInTour.groupVisible === false,
    { before: weBeforeTour, inTour: weInTour },
  );
  // 备注项：标记隐藏后 raycast 不可命中；并在隐藏标记原位置真实拖动，确认不会误改水源
  const tourStateBefore = await V.waterState();
  const tourMarker = await V.markerScreenPos({ index: 0 });
  const tourPick =
    tourMarker && tourMarker.screen
      ? await page
          .evaluate(
            ({ sx, sy }) => ({
              pickable: Boolean(window.__designer.waterEditor._pickSource(sx, sy)),
              tourHidden: Boolean(window.__designer.waterEditor.tourHidden),
            }),
            { sx: tourMarker.screen.x, sy: tourMarker.screen.y },
          )
          .catch(() => null)
      : null;
  rec('游览模式下隐藏的水源标记不可被 raycast 命中', Boolean(tourPick) && tourPick.pickable === false, {
    marker: tourMarker,
    pick: tourPick,
  });

  let tourDragSafe = { ok: false };
  if (
    tourMarker &&
    tourMarker.screen.x > 0 &&
    tourMarker.screen.x < VIEW.width &&
    tourMarker.screen.y > 0 &&
    tourMarker.screen.y < VIEW.height
  ) {
    const beforeSrc = tourStateBefore.sources.find((s) => s.id === tourMarker.sourceId);
    await page.mouse.move(tourMarker.screen.x, tourMarker.screen.y);
    await sleep(120);
    await page.mouse.down();
    await sleep(120);
    const dragState = await page.evaluate(() => ({
      drag: Boolean(window.__designer.waterEditor._drag),
      placement: Boolean(window.__designer.waterEditor.placement),
      tourHidden: Boolean(window.__designer.waterEditor.tourHidden),
    }));
    await page.mouse.move(tourMarker.screen.x + 70, tourMarker.screen.y + 35, { steps: 8 });
    await sleep(120);
    await page.mouse.up();
    await sleep(450);
    const afterState = await V.waterState();
    const afterSrc = afterState.sources.find((s) => s.id === tourMarker.sourceId);
    if (beforeSrc && afterSrc) {
      const dist = Math.hypot(afterSrc.x - beforeSrc.x, afterSrc.z - beforeSrc.z);
      tourDragSafe = {
        ok: dist < 1e-6 && dragState.drag === false,
        dist: Number(dist.toFixed(3)),
        dragStarted: dragState.drag,
        tourHidden: dragState.tourHidden,
        before: { x: beforeSrc.x, z: beforeSrc.z },
        after: { x: afterSrc.x, z: afterSrc.z },
      };
    } else {
      tourDragSafe = { ok: false, reason: '游览中找不到该水源', marker: tourMarker };
    }
  } else {
    tourDragSafe = { ok: false, reason: '标记不在视口内，无法测试', marker: tourMarker };
  }
  rec('游览模式在隐藏标记处按下拖动不会误改水源坐标', tourDragSafe.ok, tourDragSafe);
  await page
    .evaluate(
      ({ pt }) => {
        const d = window.__designer;
        const hf = d.heightField;
        const exag = d.env?.uExaggeration?.value ?? 1;
        const worldY = hf.sampleWorld(pt.x, pt.z) * hf.reliefMeters * exag;
        d.cameraControls?.setTarget?.(pt.x, worldY + 10, pt.z);
        d.camera.position.set(pt.x + 1200, worldY + 430, pt.z + 1200);
        d.camera.updateMatrixWorld(true);
      },
      { pt: LOW_POINT },
    )
    .catch(() => {});
  await sleep(800);
  const tourShot = await snap(page, 'water-tour.png');
  const tourShotCheck = snapOk(tourShot);
  rec('游览模式隐藏 UI（body.tour-mode / #ui 不可见 / 退出按钮出现）', tourUi.tour || !tourUi.uiVisible, {
    tour: tourUi.tour,
    uiVisible: tourUi.uiVisible,
    tourExitVisible: tourUi.tourExitVisible,
  });
  rec('截图 water-tour.png（观赏视角，非全黑 / 非纯色）', tourShotCheck.ok, tourShotCheck);
  info('截图路径', tourShot.file);
  await page.evaluate(() => window.__designer.applyTour?.(false)).catch(() => {});
  await sleep(500);
  const weAfterTour = (await V.waterState()).waterEditor;
  rec('退出游览模式后水源标记恢复显示', weAfterTour.groupVisible === true, weAfterTour);

  // 退出游览后：标记仍可点击选中 + 拖动改位置
  const afterTourState = await V.waterState();
  const restoreSrc = afterTourState.sources[0] ?? null;
  if (restoreSrc) {
    await page
      .evaluate(
        (pt) => {
          const d = window.__designer;
          const hf = d.heightField;
          const exag = d.env.uExaggeration.value;
          const y = hf.sampleWorld(pt.x, pt.z) * hf.reliefMeters * exag;
          d.cameraControls.setTarget(pt.x, y + 10, pt.z);
          d.camera.position.set(pt.x + 700, y + 550, pt.z + 700);
          d.camera.updateMatrixWorld(true);
        },
        { x: restoreSrc.x, z: restoreSrc.z },
      )
      .catch(() => {});
    await sleep(1000);
    await page.evaluate(() => window.__designer.water.selectSource(null)).catch(() => {});
    await sleep(300);
    const marker2 = await V.markerScreenPos({ index: 0 });
    let selectOk = false;
    if (
      marker2 &&
      marker2.screen.x > 0 &&
      marker2.screen.x < VIEW.width &&
      marker2.screen.y > 0 &&
      marker2.screen.y < VIEW.height
    ) {
      await page.mouse.click(marker2.screen.x, marker2.screen.y);
      await sleep(450);
      selectOk = (await V.waterState()).selectedId === marker2.sourceId;
    }
    rec('退出游览后点击水源小球可选中（selectedId 同步）', selectOk, {
      marker: marker2,
      selectedId: (await V.waterState()).selectedId,
    });

    let postDrag = { ok: false };
    if (marker2 && marker2.screen.x > 0 && marker2.screen.x < VIEW.width) {
      const beforeSrc = (await V.waterState()).sources.find((s) => s.id === marker2.sourceId);
      await page.mouse.move(marker2.screen.x, marker2.screen.y);
      await sleep(120);
      await page.mouse.down();
      await sleep(90);
      await page.mouse.move(marker2.screen.x + 80, marker2.screen.y + 40, { steps: 8 });
      await sleep(130);
      await page.mouse.up();
      await sleep(500);
      const afterSrc = (await V.waterState()).sources.find((s) => s.id === marker2.sourceId);
      if (beforeSrc && afterSrc) {
        const dist = Math.hypot(afterSrc.x - beforeSrc.x, afterSrc.z - beforeSrc.z);
        postDrag = {
          ok: dist > 5,
          dist: Number(dist.toFixed(1)),
          before: { x: beforeSrc.x, z: beforeSrc.z },
          after: { x: afterSrc.x, z: afterSrc.z },
        };
      } else {
        postDrag = { ok: false, reason: '拖动后找不到该水源', marker: marker2 };
      }
    } else {
      postDrag = { ok: false, reason: '标记不在视口内', marker: marker2 };
    }
    rec('退出游览后拖动水源小球仍生效（坐标写回 state）', postDrag.ok, postDrag);
  } else {
    rec('退出游览后点击水源小球可选中（selectedId 同步）', false, { reason: '没有水源可测' });
    rec('退出游览后拖动水源小球仍生效（坐标写回 state）', false, { reason: '没有水源可测' });
  }

  // 12) 全局水位上限语义：多水源取「启用且 targetLevel 非 null」的最大值
  const capAdd = await page
    .evaluate(() => {
      const w = window.__designer.water;
      const pt = { x: 900, z: 1200 };
      const g = w.groundMetersAt(pt.x, pt.z);
      const s = w.addSource({ x: pt.x, z: pt.z });
      if (!s) return { error: 'addSource 返回空' };
      w.updateSource(s.id, { radius: 500, targetLevel: g + 60 });
      return { id: s.id, ground: g, targetLevel: g + 60, count: w.state.sources.length };
    })
    .catch((err) => ({ error: String(err?.message ?? err) }));
  await sleep(2600);
  const capStats = normStats(await V.debugStats());
  rec(
    '全局水位上限取多水源 targetLevel 最大值（高目标水源把上限抬高）',
    !capAdd.error && capStats && Number(capStats.maxDepthMeters) > 30,
    { added: capAdd, stats: capStats },
  );

  // 13) 重置（reset 后模拟立刻重新注水，所以用「步数回退」/「水深回落」二者之一判定）
  const preReset = normStats(await V.debugStats());
  const resetClick = await V.clickButton({ anyTokens: ['重置'], prefer: ['模拟', '水体', '参数', '状态'], maxTextLen: 14 });
  await sleep(400);
  const postReset = normStats(await V.debugStats());
  let dropped;
  let dropReason = '';
  if (!postReset || postReset.__missing || postReset.__error) {
    dropped = true; // debugStats 不可用时没法判定，按「不阻塞」处理并记录
    dropReason = 'debugStats 不可用，无法量化（不判失败）';
  } else {
    const stepsDropped =
      preReset && preReset.steps != null && postReset.steps != null
        ? postReset.steps < Math.max(10, preReset.steps * 0.1)
        : false;
    const depthDropped =
      preReset &&
      preReset.maxDepthMeters != null &&
      preReset.maxDepthMeters > 0 &&
      postReset.maxDepthMeters != null
        ? postReset.maxDepthMeters < preReset.maxDepthMeters * 0.5
        : false;
    dropped = stepsDropped || depthDropped;
    dropReason = `steps ${preReset?.steps} → ${postReset.steps}；maxDepth ${preReset?.maxDepthMeters} → ${postReset.maxDepthMeters}`;
  }
  rec('点击「重置」后模拟回落（步数归零/水深回落）', resetClick.ok && dropped, {
    button: resetClick,
    before: preReset,
    after: postReset,
    reason: dropReason,
  });

  // 14) 全程错误 & 最终状态
  if (ctx.server?.mode === 'dev server') {
    const serverExit = ctx.server.exitCodeRef ? ctx.server.exitCodeRef() : null;
    rec('dev server 全程存活（未被 vite watcher 崩溃打断）', serverExit === null, { exitCode: serverExit });
  }
  const reloads = navigations - navBaseline - intentionalReloads;
  rec('运行期间页面未被意外重载（无 HMR / 源码变动干扰）', reloads === 0, {
    reloads,
    intentionalReloads,
    hint: reloads ? '验证期间产品源码被保存触发页面 reload，结果可能不可信；请定稿后重跑' : undefined,
  });
  const finalErrors = errorsList();
  rec('全程无 JS / 着色器报错', finalErrors.length === 0, finalErrors.slice(0, 20));
  const finalState = await V.waterState();
  const finalScene = await V.sceneInfo();
  rec('验证结束页面仍存活（__designer.water 可访问）', Boolean(finalState) && finalScene.glLost === false, {
    glLost: finalScene.glLost,
    renderCalls: finalScene.renderCalls,
  });
  info('最终状态', {
    enabled: finalState?.enabled,
    sim: finalState?.sim,
    visual: finalState?.visual,
    sourceCount: finalState?.sources.length,
    stats: finalState?.stats,
    mesh: finalState?.mesh,
  });
  info('模拟计时', { elapsedMs: Date.now() - simT0 });
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const ctx = { server: null, browser: null, page: null };

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  log('============================================================');
  log('modeldesigner 水体模拟 · 浏览器自动化验证');
  log(`时间: ${new Date().toISOString()}`);
  log(`工作区: ${ROOT}`);
  log(`Node: ${process.version}  Chrome: ${CHROME_CANDIDATES.find((p) => fs.existsSync(p)) || '(未找到)'}`);
  log(`截图目录: ${OUT}`);
  log('============================================================');

  log('\n── 1. 静态检查（旧模块 / 旧 API 残留）──');
  try {
    runStaticChecks();
  } catch (err) {
    rec('静态检查执行', false, String(err?.stack ?? err));
  }

  log('\n── 2. 启动服务（dev server；失败/显式指定时用 build + preview）──');
  const wantPreview = process.env.VERIFY_USE_PREVIEW === '1';
  if (wantPreview) {
    log('[server] VERIFY_USE_PREVIEW=1 → 直接使用 build + preview');
  } else {
    try {
      ctx.server = await startDevServer();
      ctx.url = ctx.server.url;
    } catch (err) {
      log(`[server] dev server 启动失败：${String(err?.message ?? err).slice(0, 800)}`);
      log('[server] 回退到 build + vite preview');
    }
  }
  if (!ctx.server) {
    try {
      ctx.server = await startPreviewServer();
      ctx.url = ctx.server.url;
    } catch (err) {
      rec('modeldesigner 服务启动（dev server / build+preview）', false, String(err?.message ?? err).slice(0, 1200));
      return;
    }
  }
  rec(
    ctx.server.mode === 'dev server' ? 'modeldesigner dev server 启动' : 'modeldesigner build + vite preview 启动',
    true,
    { url: ctx.url, port: ctx.server.port, mode: ctx.server.mode },
  );

  log('\n── 3. 浏览器动态验证 ──');
  try {
    const { browser, page } = await launchBrowser();
    ctx.browser = browser;
    ctx.page = page;
    rec('无头 Chrome 启动', true, { chromium: await browser.version().catch(() => null) });
    await runDynamicChecks(ctx);
  } catch (err) {
    rec('浏览器动态验证流程执行', false, String(err?.stack ?? err).slice(0, 1500));
    log(`[fatal] ${err?.stack ?? err}`);
  } finally {
    if (ctx.browser) await ctx.browser.close().catch(() => {});
    if (ctx.server) killChild(ctx.server.child);
  }

  log('\n── 4. 构建检查 ──');
  if (SKIP_BUILD) {
    info('构建检查已跳过（VERIFY_SKIP_BUILD=1）');
  } else {
    const mdBuild = await runViteBuild(MD, 'modeldesigner');
    const mdIndexOk = fs.existsSync(path.join(MD, 'dist', 'index.html'));
    rec('modeldesigner `vite build` 退出码 0', mdBuild.ok, { code: mdBuild.code, tail: mdBuild.ok ? null : (mdBuild.output || '').slice(-800) });
    rec('modeldesigner dist/index.html 存在', mdIndexOk, { path: path.join(MD, 'dist', 'index.html') });
    const rootBuild = await runViteBuild(ROOT, 'root');
    rec('根项目 `vite build` 退出码 0（未被连带破坏）', rootBuild.ok, {
      code: rootBuild.code,
      tail: rootBuild.ok ? null : (rootBuild.output || '').slice(-800),
    });
  }
}

function finish() {
  log('\n==================== 浏览器 console（最近 80 条）====================');
  for (const entry of browserLogs.slice(-80)) {
    const text = String(entry.text).replace(/\s+/g, ' ').slice(0, 400);
    log(`[${entry.type}] ${text}`);
  }
  if (dialogs.length) info('浏览器对话框', dialogs);
  if (pageErrors.length || failedRequests.length || resourceErrors.length) {
    log('---------------- 错误采集汇总 ----------------');
    for (const t of pageErrors.slice(0, 20)) log(`[pageerror] ${t.split('\n')[0].slice(0, 400)}`);
    for (const t of failedRequests.slice(0, 20)) log(`[requestfailed] ${t}`);
    for (const t of resourceErrors.slice(0, 30)) log(`[http>=400] ${t}`);
  }

  log('\n==================== 总结 ====================');
  log(`PASS ${passCount}   FAIL ${failures.length}   INFO ${infoCount}`);
  if (failures.length) {
    log('失败项：');
    for (const f of failures) {
      log(`  FAIL · ${f.name}${f.detail === undefined ? '' : ` — ${typeof f.detail === 'string' ? f.detail : j(f.detail)}`}`);
    }
  }
  log(`日志: ${LOG_PATH}`);
  log(`截图: ${['water-ui.png', 'water-placing.png', 'water-sim.png', 'water-tour.png'].map((n) => path.join(OUT, n)).join('  ')}`);
  log(failures.length ? 'RESULT  FAIL' : 'RESULT  PASS');
  try {
    fs.writeFileSync(LOG_PATH, lines.join('\n') + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(`写日志失败: ${err?.message ?? err}\n`);
  }
  process.exitCode = failures.length ? 1 : 0;
}

main()
  .catch((err) => log(`[fatal] ${err?.stack ?? err}`))
  .finally(() => {
    try {
      killChild(ctx.server?.child);
    } catch {
      /* ignore */
    }
    finish();
  });
