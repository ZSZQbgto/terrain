/**
 * 合并后应用端到端验证（零第三方依赖，Node 24 + 本机 Chrome + 原生 WebSocket）
 * =====================================================================
 *   node tests/verify-merged.mjs
 *
 * 验证范围（单一 Vite 前端，仓库根目录，5173 那一份 app）：
 *   [A] 前置条件：vite / Chrome / 源图 / ensure-assets / postbuild / 资产守卫插件
 *   [B] node scripts/ensure-assets.mjs   数据齐全时退出 0 且不重跑管线（no-op）
 *   [C] dev server（固定 127.0.0.1:5199）HTTP：/、terrain.json、height.f16、
 *       sat/0_0_128.jpg、/__models/list
 *   [D] headless Chrome（CDP）页面：启动 / 无 JS·着色器错误 / canvas 渲染 /
 *       卫星贴图 LOD / 编辑器 UI / 图形选项滑块 + GPU 名 / 高程分层↔卫星切换 /
 *       模型编辑↔水体编辑切换 / 游览模式
 *   [E] 缺失资产自动生成：临时把 public/data 改名为 data.__bak，dev 启动应自动补齐，
 *       断言日志 + 生成后的数据 / 页面，最后恢复备份（失败也会在 finally 恢复）
 *   [F] npm run build：dist/index.html、assets js+css、data 高度场/元数据/192 张瓦片、
 *       models/index.json、无 modeldesigner 目录或路径字符串、--dist 自检与修复
 *   [G] vite preview（127.0.0.1:5198）确认 dist 可被静态托管
 *   [H] 地形编辑：模式 / 面板 / 引擎 API / 实时渲染（uHeight 路径 + 编辑前后截图）/
 *       真实鼠标拖拽 / 撤销 / 恢复原始 / 16-bit 灰度 PNG 导出（字节解码 + 像素值）/
 *       UI 导出下载 / IndexedDB 持久化（刷新恢复，测试后清理）
 *
 * 约定：
 *   - 只使用 5199（dev）/ 5198（preview）端口，绝不碰 5173 / 5174 / DSH 的 53831。
 *   - 只结束自己 spawn 的进程（taskkill /PID <pid> /T /F），绝不按名字杀 node。
 *   - 只写 tests/out/（截图 + 报告）；public/data 与 dist 的改动是资产守卫/构建的正常产物。
 *   - 失败以非零退出码结束。
 *
 * 可选环境变量：
 *   CHROME_PATH=...       指定 Chrome/Edge 可执行文件
 *   VERIFY_SKIP_BUILD=1   跳过 [F] 构建与 dist 校验（调试用）
 *   VERIFY_SKIP_AUTOGEN=1 跳过 [E] 缺失资产自动生成（很慢，约数分钟）
 *   VERIFY_SKIP_PREVIEW=1 跳过 [G] preview 校验
 *   VERIFY_SKIP_TERRAIN=1 跳过 [H] 地形编辑 / 导出 / 持久化（调试用）
 *   VERIFY_KEEP_OUT=1     清理 tests/out 时保留旧截图（默认只删本项目生成的 merged-*.png）
 *
 * 输出：
 *   tests/out/verify-report.md      MARKDOWN PASS/FAIL 表
 *   tests/out/verify-report.json    机器可读结果
 *   tests/out/verify-merged.log     完整运行日志
 *   tests/out/merged-01-main.png    主页面（卫星地形）
 *   tests/out/merged-02-graphics.png 图形选项展开
 *   tests/out/merged-03-water-mode.png 水体编辑模式
 *   tests/out/merged-05-tour.png    游览模式
 *   tests/out/merged-06-autogen.png 缺失资产自动生成后的页面
 *   tests/out/merged-07-terrain-mode.png 地形编辑模式
 *   tests/out/merged-08-terrain-before.png 编辑前
 *   tests/out/merged-09-terrain-realtime.png 编辑后立即（geometry）
 *   tests/out/merged-10-terrain-settled.png 着色重建后
 *   tests/out/merged-11-terrain-persisted.png 刷新后持久化
 *   tests/out/downloads/*.png       UI 导出下载的 16-bit 灰度 PNG
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { decodePngRows, pngDiff, pngHeader, pngStats, rowToU16 } from './lib/png.mjs';

// ── 常量 ────────────────────────────────────────────────────────────────────
const HERE = path.resolve(import.meta.dirname);
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'out');
const DATA_DIR = path.join(ROOT, 'public', 'data');
const BACKUP_DIR = path.join(ROOT, 'public', 'data.__bak');
const DIST_DIR = path.join(ROOT, 'dist');
const VITE_BIN = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const DEV_PORT = 5199;
const PREVIEW_PORT = 5198;
const HEIGHT_SIZE = 2337122; // public/data/height.f16 的期望字节数
const SAT_TILE_COUNT = 192; // 8×8 块 × 3 档
const SAT_TILE_RE = /^(\d+)_(\d+)_(2048|512|128)\.jpg$/;
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const SAT_SOURCE_NAMES = ['尚庄炉水库卫星影像64.png'];

const SKIP_BUILD = process.env.VERIFY_SKIP_BUILD === '1';
const SKIP_AUTOGEN = process.env.VERIFY_SKIP_AUTOGEN === '1';
const SKIP_PREVIEW = process.env.VERIFY_SKIP_PREVIEW === '1';
const SKIP_TERRAIN = process.env.VERIFY_SKIP_TERRAIN === '1';

const SHOT_MAIN = path.join(OUT, 'merged-01-main.png');
const SHOT_GRAPHICS = path.join(OUT, 'merged-02-graphics.png');
const SHOT_WATER = path.join(OUT, 'merged-03-water-mode.png');
const SHOT_TOUR = path.join(OUT, 'merged-05-tour.png');
const SHOT_AUTOGEN = path.join(OUT, 'merged-06-autogen.png');
const SHOT_TERRAIN_MODE = path.join(OUT, 'merged-07-terrain-mode.png');
const SHOT_TERRAIN_BEFORE = path.join(OUT, 'merged-08-terrain-before.png');
const SHOT_TERRAIN_REALTIME = path.join(OUT, 'merged-09-terrain-realtime.png');
const SHOT_TERRAIN_SETTLED = path.join(OUT, 'merged-10-terrain-settled.png');
const SHOT_TERRAIN_PERSISTED = path.join(OUT, 'merged-11-terrain-persisted.png');
const DOWNLOAD_DIR = path.join(OUT, 'downloads');
const TERRAIN_DEM_SIZE = 1081;
const SAT_GRAY_MIN = 12596;
const SAT_GRAY_MAX = 53742;

// ── 运行状态 ────────────────────────────────────────────────────────────────
const checks = [];
const transcript = [];
const servers = [];
const children = new Set();
let browserState = null;
let exitCode = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(line = '') {
  transcript.push(line);
  console.log(line);
}

function rec(name, ok, details = undefined) {
  const entry = { name, ok: Boolean(ok), details: details ?? null, at: new Date().toISOString() };
  checks.push(entry);
  const suffix = details === undefined ? '' : `  ${shortJson(details)}`;
  log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${suffix}`);
  return entry;
}

function shortJson(value, max = 320) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return String(value);
  }
}

function tailLines(text, count) {
  const lines = String(text ?? '').split(/\r?\n/);
  return lines.slice(-count).join('\n');
}

// ── 子进程管理（只杀自己 spawn 的 PID 树）────────────────────────────────────
function track(child) {
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* ignore */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已经退出 */
  }
}

function waitChildExit(child, timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function runCommand(file, args, { cwd = ROOT, timeoutMs = 120000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: { ...env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: -1, signal: null, timedOut: false, stdout: '', stderr: String(err), error: String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => finish({ code: -1, signal: null, timedOut, stdout, stderr, error: String(err) }));
    child.on('close', (code, signal) => finish({ code, signal, timedOut, stdout, stderr }));
  });
}

function runNodeScript(args, timeoutMs = 120000) {
  return runCommand(process.execPath, args, { timeoutMs });
}

function startVite({ port, preview = false, label }) {
  const args = [VITE_BIN];
  if (preview) args.push('preview');
  args.push('--port', String(port), '--strictPort');
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines = [];
  let buffer = '';
  let exitInfo = null;
  const sink = (text) => {
    buffer += text;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? '';
    for (const line of parts) if (line.trim()) lines.push(line);
    if (buffer.length > 4000) {
      lines.push(buffer);
      buffer = '';
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', sink);
  child.stderr.on('data', sink);
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    lines.push(`[process exit] code=${code} signal=${signal}`);
  });
  const server = {
    child,
    port,
    label,
    lines,
    stopped: false,
    get exitInfo() {
      return exitInfo;
    },
  };
  track(child);
  servers.push(server);
  log(`[spawn] ${label}: node node_modules/vite/bin/vite.js${preview ? ' preview' : ''} --port ${port} --strictPort (PID ${child.pid})`);
  return server;
}

function portOpen(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

async function waitPortClosed(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portOpen(port))) return true;
    await sleep(250);
  }
  return !(await portOpen(port));
}

async function stopServer(server) {
  if (!server || server.stopped) return;
  server.stopped = true;
  log(`[stop] ${server.label} (PID ${server.child.pid})`);
  killTree(server.child);
  await waitChildExit(server.child, 10000);
  await waitPortClosed(server.port, 15000);
}

async function waitServerReady(server, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${server.port}/`;
  let lastError = '尚未响应';
  while (Date.now() < deadline) {
    if (server.exitInfo) {
      throw new Error(
        `${server.label} 提前退出 ${JSON.stringify(server.exitInfo)}\n${tailLines(server.lines.join('\n'), 40)}`,
      );
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.status < 500) return res;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = String(err?.message ?? err);
    }
    await sleep(500);
  }
  throw new Error(`等待 ${server.label} 就绪超时（${timeoutMs}ms）：${lastError}\n${tailLines(server.lines.join('\n'), 40)}`);
}

// ── HTTP 小工具 ─────────────────────────────────────────────────────────────
async function getText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    return { res, text: await res.text() };
  } catch (err) {
    return { err: String(err?.message ?? err) };
  }
}

async function getJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { res, text, json };
  } catch (err) {
    return { err: String(err?.message ?? err) };
  }
}

async function getBuffer(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    return { res, buf: Buffer.from(await res.arrayBuffer()) };
  } catch (err) {
    return { err: String(err?.message ?? err) };
  }
}

const isJpeg = (buf) => Boolean(buf && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff);
const contentType = (res) => String(res?.headers?.get?.('content-type') ?? '');

function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

// ── 资产目录检查 ────────────────────────────────────────────────────────────
function inspectDataDir(dataDir) {
  const heightPath = path.join(dataDir, 'height.f16');
  const metaPath = path.join(dataDir, 'terrain.json');
  const satPath = path.join(dataDir, 'sat');
  let heightSize = 0;
  try {
    heightSize = statSync(heightPath).size;
  } catch {
    heightSize = 0;
  }
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    meta = null;
  }
  let satFiles = [];
  try {
    satFiles = readdirSync(satPath).filter((name) => SAT_TILE_RE.test(name));
  } catch {
    satFiles = [];
  }
  const tiers = { 2048: 0, 512: 0, 128: 0 };
  for (const name of satFiles) {
    const match = name.match(SAT_TILE_RE);
    if (match) tiers[match[3]] += 1;
  }
  return {
    dataDir,
    heightSize,
    heightOk: heightSize === HEIGHT_SIZE,
    meta,
    metaOk: Boolean(meta && Number.isFinite(meta.width) && meta.width > 0 && Number.isFinite(meta.height) && meta.height > 0),
    satTileCount: satFiles.length,
    satTiers: tiers,
    satOk: satFiles.length === SAT_TILE_COUNT,
    complete: heightSize === HEIGHT_SIZE && Boolean(meta) && satFiles.length === SAT_TILE_COUNT,
  };
}

function sameDataSummary(a, b) {
  return (
    Boolean(a) &&
    Boolean(b) &&
    a.heightSize === b.heightSize &&
    a.satTileCount === b.satTileCount &&
    a.meta?.width === b.meta?.width &&
    a.meta?.height === b.meta?.height
  );
}

function restoreDataBackup() {
  if (!existsSync(BACKUP_DIR)) return { restored: false, reason: '无备份' };
  try {
    if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
    renameSync(BACKUP_DIR, DATA_DIR);
    return { restored: true };
  } catch (err) {
    return { restored: false, error: String(err?.message ?? err) };
  }
}

function analyzeShot(file) {
  try {
    const stats = pngStats(readFileSync(file), { sampleStep: 2 });
    const ok = stats.uniqueColors >= 200 && stats.meanLum >= 8 && stats.lumStd >= 4 && stats.blackFraction <= 0.95;
    return { ok, stats };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// ── CDP / headless Chrome ───────────────────────────────────────────────────
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const listener of this.listeners) listener(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(listener) {
    this.listeners.push(listener);
  }
}

const isFaviconNoise = (text) => /favicon/i.test(String(text ?? ''));

class PageSession {
  constructor(ws, label) {
    this.ws = ws;
    this.label = label;
    this.cdp = new Cdp(ws);
    this.consoleLines = [];
    this.errors = [];
    this.netFailures = [];
    this.satTiles = new Set();
    this.requestUrls = new Map();
    this.cdp.on((msg) => this.onEvent(msg));
  }

  onEvent(msg) {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? '')
        .join(' ')
        .slice(0, 600);
      this.consoleLines.push(`[${msg.params.type}] ${text}`);
      if (msg.params.type === 'error' || msg.params.type === 'assert') {
        if (!isFaviconNoise(text)) this.errors.push(`[console.${msg.params.type}] ${text}`);
      }
      return;
    }
    if (msg.method === 'Log.entryAdded') {
      const entry = msg.params.entry ?? {};
      this.consoleLines.push(`[log:${entry.level}] ${entry.text ?? ''}`);
      if (entry.level === 'error' && !isFaviconNoise(`${entry.url ?? ''} ${entry.text ?? ''}`)) {
        this.errors.push(`[log] ${entry.text ?? ''}`);
      }
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params.exceptionDetails ?? {};
      const text = details.exception?.description ?? details.text ?? 'exception';
      if (!isFaviconNoise(text)) this.errors.push(`[exception] ${String(text).split('\n')[0]}`);
      return;
    }
    if (msg.method === 'Network.requestWillBeSent') {
      this.requestUrls.set(msg.params.requestId, msg.params.request?.url ?? '');
      return;
    }
    if (msg.method === 'Network.responseReceived') {
      const response = msg.params.response ?? {};
      const url = response.url ?? '';
      this.requestUrls.set(msg.params.requestId, url);
      if (response.status >= 400 && !isFaviconNoise(url)) {
        this.netFailures.push(`${response.status} ${url}`);
      }
      if (response.status === 200 && /\/data\/sat\/[^/]+\.jpg/.test(url)) this.satTiles.add(url);
      return;
    }
    if (msg.method === 'Network.loadingFailed') {
      const url = this.requestUrls.get(msg.params.requestId) ?? msg.params.requestId;
      if (isFaviconNoise(url)) return;
      if (msg.params.errorText === 'net::ERR_ABORTED' && /\/data\/sat\//.test(url)) return;
      this.netFailures.push(`FAILED ${msg.params.errorText} ${url}`);
    }
  }

  async enable() {
    await Promise.all([
      this.cdp.send('Runtime.enable'),
      this.cdp.send('Log.enable'),
      this.cdp.send('Network.enable'),
      this.cdp.send('Page.enable'),
    ]);
    try {
      await this.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
    } catch {
      /* 非致命 */
    }
  }

  async eval(expression) {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 30000,
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate error';
      throw new Error(String(description).split('\n')[0]);
    }
    return result.result?.value;
  }

  async goto(url) {
    this.errors = [];
    this.netFailures = [];
    this.satTiles.clear();
    this.consoleLines = [];
    await this.cdp.send('Page.navigate', { url });
  }

  async screenshot(file) {
    const shot = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  }

  async waitBoot(timeoutMs = 240000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await this.eval(`(() => {
          const d = window.__designer;
          const loading = document.getElementById('loading');
          let hidden = true;
          let opacity = null;
          let pointerEvents = null;
          if (loading) {
            const style = getComputedStyle(loading);
            hidden = loading.classList.contains('hidden') || style.display === 'none' || Number(style.opacity) === 0 || style.pointerEvents === 'none';
            opacity = style.opacity;
            pointerEvents = style.pointerEvents;
          }
          return {
            hasDesigner: Boolean(d),
            hasTerrain: Boolean(d && d.terrain),
            hasRenderer: Boolean(d && d.renderer),
            loadingHidden: hidden,
            loadingOpacity: opacity,
            loadingPointerEvents: pointerEvents,
            loadingText: document.getElementById('loading-text') ? document.getElementById('loading-text').textContent : null,
            title: document.title,
          };
        })()`);
        if (last && last.hasDesigner && last.hasTerrain && last.hasRenderer && last.loadingHidden) {
          return { ok: true, details: last };
        }
      } catch {
        /* 页面还在导航，重试 */
      }
      await sleep(500);
    }
    return { ok: false, details: { last, errors: this.errors.slice(-5), netFailures: this.netFailures.slice(-5) } };
  }

  async waitSatellite(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await this.eval(`(() => {
          const d = window.__designer;
          const chunks = (d && d.terrain && d.terrain.chunks) || [];
          const tiers = {};
          for (const chunk of chunks) tiers[String(chunk.satTier)] = (tiers[String(chunk.satTier)] || 0) + 1;
          return {
            terrainMode: d && d.terrain ? d.terrain.mode : null,
            chunkCount: chunks.length,
            chunkTiers: tiers,
            cache: d && d.satellite && d.satellite.cache ? d.satellite.cache.size : null,
            pending: d && d.satellite && d.satellite.pending ? d.satellite.pending.size : null,
            satelliteEnabled: d && d.satellite ? d.satellite.enabled : null,
          };
        })()`);
        if (last && last.terrainMode === 'satellite' && Number(last.cache) > 0 && Object.keys(last.chunkTiers ?? {}).length > 0) {
          return { ok: true, details: last };
        }
      } catch {
        /* 重试 */
      }
      await sleep(1000);
    }
    return { ok: false, details: last };
  }

  async diagnostics() {
    return this.eval(`(() => {
      const d = window.__designer;
      const chunks = (d && d.terrain && d.terrain.chunks) || [];
      const tiers = {};
      for (const chunk of chunks) tiers[String(chunk.satTier)] = (tiers[String(chunk.satTier)] || 0) + 1;
      const canvas = (d && d.renderer && d.renderer.domElement) || document.querySelector('#app canvas');
      const gl = d && d.renderer && d.renderer.getContext ? d.renderer.getContext() : null;
      let webgl = null;
      if (gl) {
        try {
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          webgl = {
            version: gl.getParameter(gl.VERSION),
            renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          };
        } catch (err) {
          webgl = { error: String(err) };
        }
      }
      const loading = document.getElementById('loading');
      const loadingHidden = !loading || loading.classList.contains('hidden') || getComputedStyle(loading).pointerEvents === 'none';
      const statsEl = document.getElementById('tb-stats');
      return {
        href: location.href,
        title: document.title,
        hasDesigner: Boolean(d),
        terrainMode: d && d.terrain ? d.terrain.mode : null,
        chunkCount: chunks.length,
        chunkTiers: tiers,
        satellite: d && d.satellite ? {
          enabled: d.satellite.enabled,
          cache: d.satellite.cache ? d.satellite.cache.size : null,
          pending: d.satellite.pending ? d.satellite.pending.size : null,
          stats: d.satellite.stats ?? null,
        } : null,
        texturesOn: d && d.isTexturesOn ? d.isTexturesOn() : null,
        canvas: canvas ? { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight } : null,
        webgl,
        render: d && d.renderer && d.renderer.info ? {
          frame: d.renderer.info.render.frame,
          triangles: d.renderer.info.render.triangles,
          calls: d.renderer.info.render.calls,
        } : null,
        loadingHidden,
        bodyClass: document.body.className,
        uiClass: document.getElementById('ui') ? document.getElementById('ui').className : null,
        statsText: statsEl ? statsEl.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160) : null,
        api: d ? {
          applyTour: typeof d.applyTour === 'function',
          applyTextures: typeof d.applyTextures === 'function',
          applyWater: typeof d.applyWater === 'function',
          waterEditor: Boolean(d.waterEditor),
        } : null,
      };
    })()`);
  }

  async blankAndClose() {
    try {
      await this.cdp.send('Page.navigate', { url: 'about:blank' });
    } catch {
      /* ignore */
    }
    await sleep(100);
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function launchChrome(chromePath) {
  const port = 9333 + Math.floor(Math.random() * 400);
  const profile = path.join(os.tmpdir(), 'dsh-verify', `merged-profile-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--window-size=1440,900',
    '--hide-scrollbars',
    'about:blank',
  ];
  const child = spawn(chromePath, args, { stdio: 'ignore', windowsHide: true });
  track(child);
  const browser = { child, port, profile, chromePath };
  for (let i = 0; i < 150; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return browser;
    } catch {
      /* 尚未就绪 */
    }
    if (child.exitCode !== null) throw new Error(`Chrome 启动失败（exit ${child.exitCode}）`);
    await sleep(200);
  }
  throw new Error('Chrome DevTools 端口未就绪');
}

async function ensureBrowser() {
  if (browserState) return browserState;
  const chromePath = findChrome();
  if (!chromePath) return null;
  browserState = await launchChrome(chromePath);
  log(`[chrome] ${chromePath} (devtools ${browserState.port})`);
  return browserState;
}

async function newPageTarget(port) {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
        method: 'PUT',
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const target = await res.json();
        if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
      }
    } catch {
      /* 旧版 Chrome 只支持 GET，走下面的 list */
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
      const list = await res.json();
      const page = list.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 尚未就绪 */
    }
    await sleep(200);
  }
  throw new Error('无法创建 Chrome 页面 target');
}

async function openPage(browser, label) {
  const wsUrl = await newPageTarget(browser.port);
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const page = new PageSession(ws, label);
  await page.enable();
  return page;
}

async function closeBrowser() {
  if (!browserState) return;
  const state = browserState;
  browserState = null;
  log(`[stop] chrome (PID ${state.child.pid})`);
  killTree(state.child);
  await waitChildExit(state.child, 10000);
  try {
    rmSync(state.profile, { recursive: true, force: true });
  } catch {
    /* 配置目录可能被文件锁占用，忽略 */
  }
}

// ── [A] 前置条件 ────────────────────────────────────────────────────────────
async function preflight(env) {
  log('\n=== [A] 前置条件 ===');
  rec('node_modules/vite 存在（node node_modules/vite/bin/vite.js 可执行）', existsSync(VITE_BIN), { viteBin: VITE_BIN });

  let viteVersion = null;
  try {
    viteVersion = JSON.parse(readFileSync(path.join(ROOT, 'node_modules', 'vite', 'package.json'), 'utf8')).version;
  } catch {
    viteVersion = null;
  }
  env.viteVersion = viteVersion;

  const chromePath = findChrome();
  env.chromePath = chromePath;
  rec('本机 Chrome / Edge 可执行文件存在', Boolean(chromePath), { chromePath });

  const heightSrc = path.join(ROOT, 'resourses', 'heightmap64.png');
  const satSrc = SAT_SOURCE_NAMES.map((name) => path.join(ROOT, 'resourses', name)).find((candidate) => existsSync(candidate));
  env.satSource = satSrc ?? null;
  rec(
    'resourses/ 中的地形源图存在（heightmap64.png + 卫星影像，自动生成资产所需）',
    existsSync(heightSrc) && Boolean(satSrc),
    { heightSrc: existsSync(heightSrc), satSrc: satSrc ?? null },
  );

  rec(
    'scripts/prepare-assets.mjs 与 scripts/ensure-assets.mjs 存在',
    existsSync(path.join(ROOT, 'scripts', 'prepare-assets.mjs')) && existsSync(path.join(ROOT, 'scripts', 'ensure-assets.mjs')),
    { prepare: existsSync(path.join(ROOT, 'scripts', 'prepare-assets.mjs')), ensure: existsSync(path.join(ROOT, 'scripts', 'ensure-assets.mjs')) },
  );

  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch {
    pkg = null;
  }
  env.packageScripts = pkg?.scripts ?? null;
  rec(
    'package.json: build=vite build，postbuild 调用 ensure-assets.mjs --dist',
    pkg?.scripts?.build === 'vite build' && /ensure-assets\.mjs\s+--dist/.test(String(pkg?.scripts?.postbuild ?? '')),
    { build: pkg?.scripts?.build ?? null, postbuild: pkg?.scripts?.postbuild ?? null },
  );

  let viteConfig = '';
  try {
    viteConfig = readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8');
  } catch {
    viteConfig = '';
  }
  rec(
    'vite.config.js 启用地形资产守卫插件（vite-plugin-terrain-assets）',
    /vite-plugin-terrain-assets/.test(viteConfig),
    { matched: /vite-plugin-terrain-assets/.test(viteConfig) },
  );

  rec('node_modules/sharp 已安装（自动生成资产所需）', existsSync(path.join(ROOT, 'node_modules', 'sharp', 'package.json')), {
    sharp: existsSync(path.join(ROOT, 'node_modules', 'sharp', 'package.json')),
  });

  rec('仓库根目录已无 modeldesigner/ 子项目（合并为单一 Vite 前端）', !existsSync(path.join(ROOT, 'modeldesigner')), {
    modeldesignerDir: path.join(ROOT, 'modeldesigner'),
  });

  const terrainEditorFile = path.join(ROOT, 'src', 'editor', 'terrainEditor.js');
  const heightPngFile = path.join(ROOT, 'src', 'terrain', 'heightPng.js');
  rec('地形编辑产品文件存在（src/editor/terrainEditor.js + src/terrain/heightPng.js）', existsSync(terrainEditorFile) && existsSync(heightPngFile), {
    terrainEditor: existsSync(terrainEditorFile),
    heightPng: existsSync(heightPngFile),
  });

  env.ports = { dev: DEV_PORT, preview: PREVIEW_PORT, forbidden: [5173, 5174, 53831] };
  env.flags = { skipBuild: SKIP_BUILD, skipAutogen: SKIP_AUTOGEN, skipPreview: SKIP_PREVIEW, skipTerrain: SKIP_TERRAIN };
}

// ── [B] ensure-assets 自检 ──────────────────────────────────────────────────
async function ensureInitialData() {
  log('\n=== [B0] 初始资产数据 ===');
  const before = inspectDataDir(DATA_DIR);
  if (before.complete) {
    rec('初始 public/data 完整（height.f16 + terrain.json + 192 张卫星瓦片）', true, before);
    return before;
  }
  log('[setup] public/data 不完整，先执行 node scripts/ensure-assets.mjs 补齐（可能需要数分钟）…');
  const result = await runNodeScript(['scripts/ensure-assets.mjs'], 16 * 60 * 1000);
  const after = inspectDataDir(DATA_DIR);
  rec('初始 public/data 完整（缺失时由 ensure-assets 自动补齐）', after.complete, {
    before,
    after,
    code: result.code,
    timedOut: result.timedOut,
    tail: tailLines(result.stdout + result.stderr, 12),
  });
  return after;
}

async function ensureAssetsNoop() {
  log('\n=== [B] ensure-assets 数据齐全时 no-op ===');
  const result = await runNodeScript(['scripts/ensure-assets.mjs'], 120000);
  const output = `${result.stdout}\n${result.stderr}`;
  rec('node scripts/ensure-assets.mjs 退出码 0', result.code === 0 && !result.timedOut, {
    code: result.code,
    timedOut: result.timedOut,
    tail: tailLines(output, 10),
  });
  rec(
    '数据齐全时 ensure-assets 不重跑资产管线（日志显示「地形瓦片完整」且无「正在执行资产管线」）',
    /地形瓦片完整/.test(output) && !/正在执行资产管线/.test(output),
    { matchedComplete: /地形瓦片完整/.test(output), ranPipeline: /正在执行资产管线/.test(output), tail: tailLines(output, 6) },
  );
}

// ── [C] dev HTTP ────────────────────────────────────────────────────────────
async function runHttpChecks(server) {
  log('\n=== [C] dev server HTTP 检查 ===');
  const base = `http://127.0.0.1:${server.port}`;

  try {
    const root = await getText(`${base}/`);
    rec(
      'HTTP / 返回 HTML（text/html + id="app"）',
      Boolean(root.res) && root.res.status === 200 && /text\/html/i.test(contentType(root.res)) && /id="app"/.test(root.text),
      { status: root.res?.status ?? null, contentType: contentType(root.res), hasApp: /id="app"/.test(root.text ?? '') },
    );
  } catch (err) {
    rec('HTTP / 返回 HTML（text/html + id="app"）', false, { error: String(err?.message ?? err) });
  }

  const meta = await getJson(`${base}/data/terrain.json`);
  const metaOk =
    !meta.err &&
    meta.res.status === 200 &&
    /application\/json/i.test(contentType(meta.res)) &&
    Boolean(meta.json) &&
    Number.isFinite(meta.json.width) &&
    meta.json.width > 0 &&
    Number.isFinite(meta.json.height) &&
    meta.json.height > 0;
  rec('/data/terrain.json 为 application/json 且可解析（width/height 有效）', metaOk, {
    status: meta.res?.status ?? null,
    contentType: contentType(meta.res),
    error: meta.err ?? null,
    meta: meta.json ?? null,
  });

  const height = await getBuffer(`${base}/data/height.f16`);
  rec(
    `/data/height.f16 大小 ${HEIGHT_SIZE} 字节`,
    !height.err && height.res.status === 200 && height.buf.length === HEIGHT_SIZE,
    { status: height.res?.status ?? null, bytes: height.buf?.length ?? null, expected: HEIGHT_SIZE, error: height.err ?? null },
  );

  const tile = await getBuffer(`${base}/data/sat/0_0_128.jpg`);
  rec(
    '/data/sat/0_0_128.jpg 为 image/jpeg（JPEG 文件头）',
    !tile.err && tile.res.status === 200 && /image\/jpeg/i.test(contentType(tile.res)) && isJpeg(tile.buf),
    { status: tile.res?.status ?? null, contentType: contentType(tile.res), jpeg: isJpeg(tile.buf), bytes: tile.buf?.length ?? null, error: tile.err ?? null },
  );

  const models = await getJson(`${base}/__models/list`);
  rec(
    '/__models/list 返回 ok JSON（files 数组）',
    !models.err &&
      models.res.status === 200 &&
      /application\/json/i.test(contentType(models.res)) &&
      models.json?.ok === true &&
      Array.isArray(models.json?.files),
    { status: models.res?.status ?? null, contentType: contentType(models.res), ok: models.json?.ok ?? null, files: models.json?.files?.length ?? null, error: models.err ?? null },
  );
}

// ── [D] 页面验证 ────────────────────────────────────────────────────────────
const UI_EVAL = `(() => {
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const toolbar = document.getElementById('toolbar');
  const buttons = toolbar ? [...toolbar.querySelectorAll('button, a')] : [];
  const found = {};
  for (const label of ['项目管理', '模型编辑', '水体编辑', '地形编辑', '图形选项', '游览']) {
    const el = buttons.find((button) => button.textContent.includes(label));
    found[label] = el
      ? { text: el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40), visible: visible(el), mode: el.dataset ? el.dataset.mode || null : null, act: el.dataset ? el.dataset.act || null : null }
      : null;
  }
  const stats = document.getElementById('tb-stats');
  return {
    found,
    statsText: stats ? stats.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160) : null,
    statsVisible: visible(stats),
  };
})()`;

const GRAPHICS_EVAL = `(() => {
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const button = [...document.querySelectorAll('#toolbar button')].find((item) => item.textContent.includes('图形选项'));
  if (!button) return { ok: false, reason: '找不到图形选项按钮' };
  button.click();
  const group = button.closest('.nav-group');
  const menu = group ? group.querySelector('.menu') : null;
  const controls = [];
  for (const input of document.querySelectorAll('input[type="range"], select')) {
    if (!visible(input)) continue;
    const holder = input.closest('label, .menu-field, .field, .section, div') || input.parentElement;
    const text = holder ? holder.textContent.replace(/\\s+/g, ' ').trim().slice(0, 180) : '';
    controls.push({
      tag: input.tagName.toLowerCase(),
      type: input.type,
      id: input.id || null,
      act: input.dataset ? input.dataset.act || null : null,
      value: input.value,
      text,
    });
  }
  const menuText = menu ? menu.textContent.replace(/\\s+/g, ' ').trim() : '';
  return {
    ok: true,
    buttonText: button.textContent.replace(/\\s+/g, ' ').trim(),
    groupOpen: group ? group.classList.contains('open') : null,
    menuVisible: menu ? visible(menu) : null,
    menuText: menuText.slice(0, 500),
    controls,
  };
})()`;

const GPU_EVAL = `(() => {
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const nodes = [...document.querySelectorAll('[id*="gpu" i], [class*="gpu" i], [data-role*="gpu" i]')].map((el) => ({
    id: el.id || null,
    cls: typeof el.className === 'string' ? el.className : null,
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
    visible: visible(el),
  }));
  const real = nodes.filter((node) => node.text && !/^检测中/.test(node.text) && node.text.length <= 200);
  const scope = document.getElementById('toolbar') || document.body;
  const match = (scope.textContent || '').match(/ANGLE\\s*\\([^)]*\\)|SwiftShader[^,;)]*|NVIDIA[^,;)]*|GeForce[^,;)]*|Radeon[^,;)]*|Intel[^,;)]*|Apple\\s*M\\d[^,;)]*/i);
  return { nodes: nodes.slice(0, 6), realCount: real.length, real: real[0] || null, regex: match ? match[0].trim() : null };
})()`;

const TOUR_EVAL = `(() => {
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const ui = document.getElementById('ui');
  const exit = document.getElementById('tour-exit');
  return {
    tourMode: document.body.classList.contains('tour-mode'),
    uiDisplay: ui ? getComputedStyle(ui).display : null,
    uiHidden: ui ? !visible(ui) : null,
    exitHidden: exit ? Boolean(exit.hidden) : null,
    exitVisible: visible(exit),
  };
})()`;

const TEXTURE_STATE_EVAL = `(() => {
  const d = window.__designer;
  return {
    terrainMode: d && d.terrain ? d.terrain.mode : null,
    texturesOn: d && typeof d.isTexturesOn === 'function' ? d.isTexturesOn() : null,
    satelliteEnabled: d && d.satellite ? d.satellite.enabled : null,
  };
})()`;

async function pagePhase(server) {
  log('\n=== [D] headless 页面验证（CDP）===');
  const browser = await ensureBrowser();
  if (!browser) {
    rec('headless Chrome 启动', false, { reason: '未找到 Chrome / Edge' });
    return;
  }
  const page = await openPage(browser, 'main');
  try {
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const boot = await page.waitBoot(240000);
    rec('页面启动：window.__designer 存在 + 加载遮罩 hidden', boot.ok, boot.details);
    if (!boot.ok) {
      rec('页面初始化后无 JS / 着色器控制台错误（忽略 favicon 404）', false, {
        boot: boot.details,
        errors: page.errors.slice(0, 10),
      });
      return;
    }

    const satelliteWait = await page.waitSatellite(90000);
    await sleep(4000); // 让卫星瓦片在若干帧里补进来
    const diag = await page.diagnostics();
    log(`[page] diagnostics: ${shortJson(diag, 1200)}`);

    const shotMain = await page.screenshot(SHOT_MAIN);
    const shotStats = analyzeShot(shotMain);
    rec(
      'canvas 渲染非空（renderer triangles > 0 + 截图像素统计）',
      shotStats.ok && Number(diag.render?.triangles ?? 0) > 0 && Number(diag.canvas?.width ?? 0) > 0,
      {
        render: diag.render,
        canvas: diag.canvas,
        webgl: diag.webgl,
        png: shotStats.stats ?? shotStats.error ?? null,
        screenshot: shotMain,
      },
    );

    rec(
      '卫星贴图 LOD 激活（terrain.mode=satellite + 瓦片缓存 + 分块档位 + 网络瓦片）',
      diag.terrainMode === 'satellite' &&
        Number(diag.satellite?.cache ?? 0) > 0 &&
        Object.keys(diag.chunkTiers ?? {}).length > 0 &&
        page.satTiles.size > 0,
      {
        terrainMode: diag.terrainMode,
        satellite: diag.satellite,
        chunkTiers: diag.chunkTiers,
        tileRequestCount: page.satTiles.size,
        tileRequests: [...page.satTiles].slice(0, 3),
        wait: satelliteWait,
      },
    );

    // 顶栏
    const ui = await page.eval(UI_EVAL);
    const missingButtons = Object.entries(ui.found)
      .filter(([, value]) => !value || !value.visible)
      .map(([label]) => label);
    rec('顶栏 UI 完整（6 项：项目管理 / 模型编辑 / 水体编辑 / 地形编辑 / 图形选项 / 游览）', missingButtons.length === 0, {
      found: ui.found,
      missing: missingButtons,
    });

    // 图形选项菜单
    const gfx = await page.eval(GRAPHICS_EVAL);
    await sleep(500);
    const keywords = ['垂直夸张', '分层数', '等高线', '薄雾', '近景高清块数'];
    const controls = Array.isArray(gfx?.controls) ? gfx.controls : [];
    const foundControls = {};
    for (const keyword of keywords) foundControls[keyword] = controls.find((control) => control.text.includes(keyword)) ?? null;
    const missingControls = keywords.filter((keyword) => !foundControls[keyword]);
    rec(
      '图形选项含滑块：垂直夸张 / 分层数 / 等高线 / 薄雾 / 近景高清块数',
      Boolean(gfx?.ok) && missingControls.length === 0,
      { missing: missingControls, found: foundControls, groupOpen: gfx?.groupOpen ?? null },
    );

    // GPU 名（在图形选项菜单展开状态下检查）
    const gpu = await page.eval(GPU_EVAL);
    rec(
      '图形选项显示非空 GPU 名称',
      Number(gpu?.realCount ?? 0) > 0 || Boolean(gpu?.regex),
      gpu,
    );

    const shotGraphics = await page.screenshot(SHOT_GRAPHICS);
    log(`[shot] ${shotGraphics}`);

    // 收起图形选项菜单
    await page.eval(`(() => { document.body.click(); return true; })()`);
    await sleep(200);

    // 统计信息
    const uiAgain = await page.eval(UI_EVAL);
    rec('工具栏统计信息可见（fps / 实例 / 资源）', Boolean(uiAgain?.statsText) && /fps/i.test(uiAgain.statsText) && uiAgain.statsVisible, {
      statsText: uiAgain?.statsText ?? null,
      statsVisible: uiAgain?.statsVisible ?? null,
    });

    // 高程分层 ↔ 卫星
    const offStart = await page.eval(`(() => {
      const d = window.__designer;
      if (!d || typeof d.applyTextures !== 'function') return { ok: false, reason: '缺少 applyTextures' };
      d.applyTextures(false);
      return { ok: true };
    })()`);
    await sleep(900);
    const offState = await page.eval(TEXTURE_STATE_EVAL);
    const onStart = await page.eval(`(() => {
      const d = window.__designer;
      if (!d || typeof d.applyTextures !== 'function') return { ok: false, reason: '缺少 applyTextures' };
      d.applyTextures(true);
      return { ok: true };
    })()`);
    await sleep(1500);
    const onState = await page.eval(TEXTURE_STATE_EVAL);
    rec(
      '高程分层 ↔ 卫星贴图可切换（applyTextures(false) → hypsometric，再恢复 satellite）',
      Boolean(offStart.ok) && offState.terrainMode === 'hypsometric' && Boolean(onStart.ok) && onState.terrainMode === 'satellite',
      { offStart, offState, onStart, onState },
    );

    // 模式切换：水体编辑
    const clickedWater = await page.eval(`(() => {
      const button = document.querySelector('#toolbar [data-mode="water"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await sleep(800);
    const waterState = await page.eval(`(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 2 && rect.height > 2;
      };
      const ui = document.getElementById('ui');
      return {
        modeClass: ui ? ui.className : null,
        modeWater: ui ? ui.classList.contains('mode-water') : false,
        waterPanelVisible:
          visible(document.getElementById('panel-water')) || visible(document.getElementById('panel-water-editor')),
        activeModes: [...document.querySelectorAll('#toolbar [data-mode]')].map((button) => ({
          mode: button.dataset.mode,
          active: button.classList.contains('active'),
        })),
      };
    })()`);
    const shotWater = await page.screenshot(SHOT_WATER);
    rec('切换到「水体编辑」模式（mode-water + 水体面板可见）', clickedWater && waterState.modeWater && waterState.waterPanelVisible, {
      clickedWater,
      ...waterState,
      screenshot: shotWater,
    });

    // 切回模型编辑
    const clickedModels = await page.eval(`(() => {
      const button = document.querySelector('#toolbar [data-mode="models"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await sleep(800);
    const modelsState = await page.eval(`(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 2 && rect.height > 2;
      };
      const ui = document.getElementById('ui');
      return {
        modeClass: ui ? ui.className : null,
        modeModels: ui ? ui.classList.contains('mode-models') : false,
        modelsPanelVisible: visible(document.getElementById('panel-models')) || visible(document.getElementById('panel-inspector')),
      };
    })()`);
    rec('切回「模型编辑」模式（mode-models + 模型面板可见）', clickedModels && modelsState.modeModels && modelsState.modelsPanelVisible, {
      clickedModels,
      ...modelsState,
    });

    // 游览模式（对开发期 HMR 做重试：并行编辑时 Vite 可能整页刷新，tour 状态会被重置）
    let tourStart = null;
    let tourOnState = null;
    for (let attempt = 0; attempt < 3 && !(tourOnState && tourOnState.tourMode === true); attempt += 1) {
      const ready = await page.waitBoot(60000);
      if (!ready.ok) {
        await sleep(500);
        continue;
      }
      tourStart = await page.eval(`(() => {
        const d = window.__designer;
        if (d && typeof d.applyTour === 'function') {
          d.applyTour(true);
          return { via: 'applyTour', attempt: ${attempt + 1} };
        }
        const button = [...document.querySelectorAll('#toolbar button')].find((item) => item.textContent.includes('游览'));
        if (button) {
          button.click();
          return { via: 'button', attempt: ${attempt + 1} };
        }
        return { via: null, attempt: ${attempt + 1} };
      })()`);
      const polled = await pollEval(page, TOUR_EVAL, (value) => Boolean(value) && value.tourMode === true && value.uiHidden === true, 5000);
      tourOnState = polled.ok ? polled.value : null;
    }
    const shotTour = await page.screenshot(SHOT_TOUR);
    let tourExit = null;
    let tourOffState = null;
    for (let attempt = 0; attempt < 3 && !(tourOffState && tourOffState.tourMode === false && tourOffState.uiHidden === false); attempt += 1) {
      tourExit = await page.eval(`(() => {
        const d = window.__designer;
        if (d && typeof d.applyTour === 'function') {
          d.applyTour(false);
          return { via: 'applyTour', attempt: ${attempt + 1} };
        }
        const button = document.getElementById('tour-exit');
        if (button) {
          button.click();
          return { via: 'exit-button', attempt: ${attempt + 1} };
        }
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { via: 'escape', attempt: ${attempt + 1} };
      })()`);
      const polled = await pollEval(page, TOUR_EVAL, (value) => Boolean(value) && value.tourMode === false && value.uiHidden === false, 5000);
      tourOffState = polled.ok ? polled.value : null;
    }
    rec(
      '游览模式：body.tour-mode + UI 隐藏 + 退出按钮出现；退出后恢复',
      Boolean(tourStart?.via) &&
        Boolean(tourOnState) &&
        tourOnState.tourMode === true &&
        tourOnState.uiHidden === true &&
        tourOnState.exitHidden === false &&
        Boolean(tourOffState) &&
        tourOffState.tourMode === false &&
        tourOffState.uiHidden === false,
      { start: tourStart, on: tourOnState, off: tourOffState, exit: tourExit, screenshot: shotTour },
    );

    // 最后统一检查控制台错误（覆盖全部交互过程）
    rec('页面无 JS / 着色器控制台错误（忽略 favicon 404）', page.errors.length === 0, {
      count: page.errors.length,
      errors: page.errors.slice(0, 10),
      consoleTail: page.consoleLines.slice(-15),
    });
    rec('页面无关键资源加载失败（忽略 favicon 404）', page.netFailures.length === 0, {
      count: page.netFailures.length,
      failures: page.netFailures.slice(0, 10),
    });
  } finally {
    await page.blankAndClose();
  }
}

// ── [H] 地形编辑 / 实时渲染 / 灰度 PNG 导出 / 持久化 ────────────────────────
const TERRAIN_HASH_EXPR = `(() => {
  const hf = window.__designer && window.__designer.heightField;
  if (!hf || !hf.half) return null;
  const fnv = (arr) => {
    let hash = 0x811c9dc5 >>> 0;
    for (let i = 0; i < arr.length; i++) {
      const value = arr[i];
      hash ^= value & 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= (value >>> 8) & 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  };
  return {
    halfHash: fnv(hf.half),
    originalHash: hf.originalHalf ? fnv(hf.originalHalf) : null,
    sample00: typeof hf.sampleWorld === 'function' ? hf.sampleWorld(0, 0) : null,
    width: hf.width,
    height: hf.height,
    texels: hf.half.length,
  };
})()`;

const TERRAIN_MODE_EXPR = `(() => {
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const text = (selector) => {
    const el = document.querySelector(selector);
    return el ? el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160) : null;
  };
  const d = window.__designer;
  const te = d && d.terrainEditor;
  const ui = document.getElementById('ui');
  const tools = [...document.querySelectorAll('[data-terrain-tool]')].map((el) => ({
    tool: el.dataset.terrainTool,
    visible: visible(el),
    active: el.classList.contains('active'),
  }));
  const radiusEl = document.querySelector('[data-terrain="radius"]');
  const strengthEl = document.querySelector('[data-terrain="strength"]');
  return {
    uiClass: ui ? ui.className : null,
    modeTerrain: ui ? ui.classList.contains('mode-terrain') : false,
    bodyTerrainMode: document.body.classList.contains('terrain-mode'),
    active: te ? te.active : null,
    panels: {
      terrain: visible(document.getElementById('panel-terrain')),
      terrainExport: visible(document.getElementById('panel-terrain-export')),
      models: visible(document.getElementById('panel-models')),
      inspector: visible(document.getElementById('panel-inspector')),
      water: visible(document.getElementById('panel-water')),
      waterEditor: visible(document.getElementById('panel-water-editor')),
    },
    tools,
    radius: radiusEl ? { value: radiusEl.value, min: radiusEl.min, max: radiusEl.max, visible: visible(radiusEl) } : null,
    strength: strengthEl ? { value: strengthEl.value, min: strengthEl.min, max: strengthEl.max, visible: visible(strengthEl) } : null,
    undo: Boolean(document.querySelector('[data-act="terrain-undo"]')),
    reset: Boolean(document.querySelector('[data-act="terrain-reset"]')),
    exportBtn: Boolean(document.querySelector('[data-act="terrain-export"]')),
    status: text('[data-role="terrain-status"]'),
    size: text('[data-role="terrain-size"]'),
    gray: text('[data-role="terrain-gray"]'),
    editedLabel: text('[data-role="terrain-edited"]'),
    dirty: text('[data-role="terrain-dirty"]'),
  };
})()`;

const TERRAIN_STATE_EXPR = `(() => {
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const text = (selector) => {
    const el = document.querySelector(selector);
    return el ? el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160) : null;
  };
  const d = window.__designer;
  const te = d && d.terrainEditor;
  const hf = d && d.heightField;
  const ui = document.getElementById('ui');
  let state = null;
  if (te && typeof te.getState === 'function') {
    try {
      const raw = te.getState();
      state = raw ? { tool: raw.tool ?? null, radius: raw.radius ?? null, strength: raw.strength ?? null, edited: raw.edited ?? null, editCount: raw.editCount ?? null, dirtyCount: raw.dirtyCount ?? null, undoCount: raw.undoCount ?? null } : null;
    } catch (err) {
      state = { error: String(err) };
    }
  }
  const resolved = state ?? {};
  return {
    uiClass: ui ? ui.className : null,
    modeTerrain: ui ? ui.classList.contains('mode-terrain') : false,
    bodyTerrainMode: document.body.classList.contains('terrain-mode'),
    active: te ? te.active : null,
    tool: resolved.tool ?? (te ? te.tool : null),
    radius: resolved.radius ?? (te ? te.radius : null),
    strength: resolved.strength ?? (te ? te.strength : null),
    edited: resolved.edited ?? (te ? te.edited : null),
    editCount: resolved.editCount ?? (te ? te.editCount : null),
    dirtyCount: resolved.dirtyCount ?? (te ? te.dirtyCount : null),
    undoCount: resolved.undoCount ?? (te ? te.undoCount : null),
    state,
    panels: {
      terrain: visible(document.getElementById('panel-terrain')),
      terrainExport: visible(document.getElementById('panel-terrain-export')),
      models: visible(document.getElementById('panel-models')),
      inspector: visible(document.getElementById('panel-inspector')),
      water: visible(document.getElementById('panel-water')),
      waterEditor: visible(document.getElementById('panel-water-editor')),
    },
    uiText: {
      edited: text('[data-role="terrain-edited"]'),
      dirty: text('[data-role="terrain-dirty"]'),
      status: text('[data-role="terrain-status"]'),
      size: text('[data-role="terrain-size"]'),
      gray: text('[data-role="terrain-gray"]'),
    },
    sample00: hf && typeof hf.sampleWorld === 'function' ? hf.sampleWorld(0, 0) : null,
  };
})()`;

const TERRAIN_API_EXPR = `(() => {
  const d = window.__designer;
  const te = d && d.terrainEditor;
  const hf = d && d.heightField;
  if (!te || !hf) return { ok: false, hasTerrainEditor: Boolean(te), hasHeightField: Boolean(hf) };
  const methods = ['setActive', 'setTool', 'setRadius', 'setStrength', 'undo', 'resetToOriginal', 'paintAtWorld', 'saveNow', 'getState', 'getExportInfo', 'exportPngBytes', 'exportAndDownload'];
  const missingMethods = methods.filter((name) => typeof te[name] !== 'function');
  let rawState = null;
  if (typeof te.getState === 'function') {
    try {
      rawState = te.getState();
    } catch (err) {
      rawState = null;
    }
  }
  const props = ['active', 'tool', 'radius', 'strength', 'edited', 'editCount', 'dirtyCount', 'undoCount'];
  const missingProps = props.filter((name) => te[name] === undefined && (!rawState || rawState[name] === undefined));
  const viaGetState = props.filter((name) => te[name] === undefined && rawState && rawState[name] !== undefined);
  const hfMethods = ['sampleWorld', 'ensureNormalized', 'resetToOriginal'];
  const missingHfMethods = hfMethods.filter((name) => typeof hf[name] !== 'function');
  const hfProps = ['width', 'height', 'half', 'originalHalf', 'sourceRange'];
  const missingHfProps = hfProps.filter((name) => hf[name] === undefined || hf[name] === null);
  let exportInfo = null;
  if (typeof te.getExportInfo === 'function') {
    try {
      const info = te.getExportInfo();
      exportInfo = info ? { width: info.width ?? null, height: info.height ?? null, bitDepth: info.bitDepth ?? null, minGray: info.minGray ?? null, maxGray: info.maxGray ?? null, edited: info.edited ?? null } : null;
    } catch (err) {
      exportInfo = { error: String(err) };
    }
  }
  return {
    ok: missingMethods.length === 0 && missingProps.length === 0 && missingHfMethods.length === 0 && missingHfProps.length === 0,
    missingMethods,
    missingProps,
    viaGetState,
    missingHfMethods,
    missingHfProps,
    sourceRange: hf.sourceRange,
    exportInfo,
    halfLength: hf.half ? hf.half.length : null,
    originalHalfLength: hf.originalHalf ? hf.originalHalf.length : null,
  };
})()`;

const TERRAIN_UHEIGHT_EXPR = `(() => {
  const d = window.__designer;
  const t = d && d.terrain;
  const hf = d && d.heightField;
  if (!t) return { ok: false, reason: 'terrain 不存在' };
  const materials = [];
  const add = (material) => {
    if (material && materials.indexOf(material) < 0) materials.push(material);
  };
  add(t.hypsoMaterial);
  add(t.satMaterial);
  add(t.material);
  for (const chunk of t.chunks || []) {
    add(chunk.mesh && chunk.mesh.material);
    add(chunk.satMaterial);
    add(chunk.hypsoMaterial);
  }
  const entries = materials.map((material) => {
    const vertexShader = String(material.vertexShader || '');
    const uniforms = material.uniforms || {};
    return {
      hasUHeight: vertexShader.indexOf('uHeight') >= 0,
      hasUHeightTexel: vertexShader.indexOf('uHeightTexel') >= 0,
      hasUniform: Boolean(uniforms.uHeight),
      isTexture: Boolean(uniforms.uHeight && uniforms.uHeight.value && uniforms.uHeight.value.isTexture),
      isHeightTexture: Boolean(uniforms.uHeight && uniforms.uHeight.value === hf.texture && hf.texture),
      hasTexelUniform: Boolean(uniforms.uHeightTexel),
    };
  });
  const shaderOk = entries.some((entry) => entry.hasUHeight);
  const uniformOk = entries.some((entry) => entry.hasUniform && (entry.isTexture || entry.isHeightTexture));
  return { ok: shaderOk && uniformOk, materialCount: materials.length, shaderOk, uniformOk, entries: entries.slice(0, 4) };
})()`;

const TERRAIN_PAINT_EXPR = `(async () => {
  const d = window.__designer;
  const te = d && d.terrainEditor;
  const hf = d && d.heightField;
  if (!te || !hf) return { ok: false, reason: 'terrainEditor/heightField 不存在' };
  const fnv = (arr) => {
    let hash = 0x811c9dc5 >>> 0;
    for (let i = 0; i < arr.length; i++) {
      const value = arr[i];
      hash ^= value & 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= (value >>> 8) & 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  };
  const sampleState = () => {
    try {
      const raw = te.getState ? te.getState() : null;
      return raw ? { tool: raw.tool ?? null, radius: raw.radius ?? null, strength: raw.strength ?? null, edited: raw.edited ?? null, editCount: raw.editCount ?? null, dirtyCount: raw.dirtyCount ?? null, undoCount: raw.undoCount ?? null } : null;
    } catch (err) {
      return null;
    }
  };
  const frameOf = () => (d.renderer && d.renderer.info ? d.renderer.info.render.frame : null);
  const before = { halfHash: fnv(hf.half), sample: hf.sampleWorld(0, 0), frame: frameOf(), state: sampleState(), t: performance.now() };
  const paintStart = performance.now();
  await te.paintAtWorld(0, 0, { tool: 'raise', radius: 140, strength: 0.5, iterations: 10 });
  const paintEnd = performance.now();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const rafEnd = performance.now();
  const after = { halfHash: fnv(hf.half), sample: hf.sampleWorld(0, 0), frame: frameOf(), state: sampleState(), t: performance.now() };
  return { ok: true, before, after, paintMs: paintEnd - paintStart, rafMs: rafEnd - paintEnd };
})()`;

const TERRAIN_EXPORT_EXPR = `(async () => {
  const d = window.__designer;
  const te = d && d.terrainEditor;
  const hf = d && d.heightField;
  if (!te || !hf || typeof te.exportPngBytes !== 'function') return { ok: false, reason: '缺少 exportPngBytes', hasEditor: Boolean(te) };
  let exportInfo = null;
  if (typeof te.getExportInfo === 'function') {
    try {
      const info = te.getExportInfo();
      exportInfo = info ? { width: info.width ?? null, height: info.height ?? null, bitDepth: info.bitDepth ?? null, minGray: info.minGray ?? null, maxGray: info.maxGray ?? null } : null;
    } catch (err) {
      exportInfo = { error: String(err) };
    }
  }
  const result = await te.exportPngBytes();
  const rawBytes = result && result.bytes;
  if (!rawBytes) return { ok: false, reason: 'exportPngBytes 未返回 bytes', resultType: typeof result };
  const arr = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < arr.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunkSize));
  }
  const normalized = hf.ensureNormalized();
  let editedIndex = -1;
  let maxDiff = 0;
  for (let i = 0; i < hf.half.length; i++) {
    const diff = Math.abs(hf.half[i] - hf.originalHalf[i]);
    if (diff > maxDiff) {
      maxDiff = diff;
      editedIndex = i;
    }
  }
  const sourceRange = hf.sourceRange || { min: 0, max: 65535 };
  const toGray = (norm) => Math.round(sourceRange.min + norm * (sourceRange.max - sourceRange.min));
  let controlIndex = -1;
  for (let i = 0; i < hf.half.length; i++) {
    if (hf.half[i] !== hf.originalHalf[i]) continue;
    const norm = normalized[i];
    if (norm > 0.2 && norm < 0.8) {
      controlIndex = i;
      break;
    }
  }
  return {
    ok: true,
    base64: btoa(binary),
    byteLength: arr.length,
    filename: result.filename ?? null,
    width: result.width ?? null,
    height: result.height ?? null,
    bitDepth: result.bitDepth ?? null,
    exportInfo,
    heightField: {
      width: hf.width,
      height: hf.height,
      sourceRange,
      editedIndex,
      editedDiff: maxDiff,
      editedNorm: editedIndex >= 0 ? normalized[editedIndex] : null,
      editedGray: editedIndex >= 0 ? toGray(normalized[editedIndex]) : null,
      controlIndex,
      controlNorm: controlIndex >= 0 ? normalized[controlIndex] : null,
      controlGray: controlIndex >= 0 ? toGray(normalized[controlIndex]) : null,
    },
  };
})()`;

const TERRAIN_IDB_EXPR = `(new Promise((resolve) => {
  try {
    const request = indexedDB.open('terrain-modeldesigner');
    request.onerror = () => resolve({ ok: false, error: 'indexedDB.open 失败' });
    request.onsuccess = () => {
      const db = request.result;
      try {
        const stores = [...db.objectStoreNames];
        if (stores.indexOf('world') < 0) {
          db.close();
          resolve({ ok: false, error: '缺少 world store', stores });
          return;
        }
        const tx = db.transaction('world', 'readonly');
        const getRequest = tx.objectStore('world').get('terrain-edit-v1');
        getRequest.onsuccess = () => {
          const value = getRequest.result;
          const summary = value ? {
            keys: Object.keys(value).slice(0, 12),
            byteLength: value.normalized ? value.normalized.byteLength : value.half ? value.half.byteLength : null,
            edited: value.edited ?? null,
          } : null;
          db.close();
          resolve({ ok: Boolean(value), stores, summary });
        };
        getRequest.onerror = () => {
          db.close();
          resolve({ ok: false, error: 'record 读取失败', stores });
        };
      } catch (err) {
        try { db.close(); } catch (closeErr) { /* ignore */ }
        resolve({ ok: false, error: String(err), stores: [] });
      }
    };
  } catch (err) {
    resolve({ ok: false, error: String(err) });
  }
}))`;

async function pollEval(page, expression, predicate, timeoutMs = 30000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await page.eval(expression);
    } catch (err) {
      last = { error: String(err?.message ?? err) };
    }
    if (predicate(last)) return { ok: true, value: last };
    await sleep(intervalMs);
  }
  return { ok: false, value: last };
}

function diffScreenshots(fileA, fileB, options = {}) {
  try {
    return { ok: true, ...pngDiff(readFileSync(fileA), readFileSync(fileB), { step: 2, threshold: 14, ...options }) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

async function terrainPhase(server) {
  log('\n=== [H] 地形编辑 / 实时渲染 / 灰度 PNG 导出 / 持久化 ===');
  const browser = await ensureBrowser();
  if (!browser) {
    rec('地形编辑：headless Chrome 可用', false, { reason: '未找到 Chrome / Edge' });
    return;
  }
  const base = `http://127.0.0.1:${server.port}/`;
  const page = await openPage(browser, 'terrain');
  const accumulatedErrors = [];
  const accumulatedNetFailures = [];
  const accumulate = () => {
    accumulatedErrors.push(...page.errors);
    accumulatedNetFailures.push(...page.netFailures);
  };
  const reload = async () => {
    accumulate();
    await page.goto(base);
    return page.waitBoot(240000);
  };
  try {
    await page.goto(base);
    const boot = await page.waitBoot(240000);
    rec('地形编辑：页面启动且加载完成', boot.ok, boot.details);
    if (!boot.ok) return;

    const baseline = await page.eval(TERRAIN_HASH_EXPR);
    rec('地形编辑：基线高度场快照（half 哈希 == originalHalf 哈希）', Boolean(baseline) && baseline.halfHash === baseline.originalHash, baseline);
    if (!baseline) return;

    // ── 模式与面板 ──
    const switchResult = await page.eval(`(() => {
      const button = document.querySelector('#toolbar [data-mode="terrain"]');
      if (!button) return { ok: false, reason: '找不到 [data-mode="terrain"] 按钮' };
      button.click();
      return { ok: true, text: button.textContent.replace(/\\s+/g, ' ').trim(), active: button.classList.contains('active') };
    })()`);
    await sleep(900);
    const terrainMode = await page.eval(TERRAIN_MODE_EXPR);
    const shotMode = await page.screenshot(SHOT_TERRAIN_MODE);
    const hiddenPanels = !terrainMode.panels.models && !terrainMode.panels.inspector && !terrainMode.panels.water && !terrainMode.panels.waterEditor;
    rec(
      '地形编辑模式：mode-terrain + body.terrain-mode + 地形两个面板可见 + 模型/水体面板隐藏 + 引擎 active',
      Boolean(switchResult.ok) && terrainMode.modeTerrain && terrainMode.bodyTerrainMode && terrainMode.panels.terrain && terrainMode.panels.terrainExport && hiddenPanels && terrainMode.active === true,
      { switch: switchResult, uiClass: terrainMode.uiClass, bodyTerrainMode: terrainMode.bodyTerrainMode, panels: terrainMode.panels, active: terrainMode.active, screenshot: shotMode },
    );

    const toolNames = ['raise', 'lower', 'flatten', 'smooth'];
    const missingTools = toolNames.filter((tool) => !terrainMode.tools.some((item) => item.tool === tool && item.visible));
    rec('地形编辑面板：4 个笔刷工具按钮可见（升高/降低/平整/平滑）', missingTools.length === 0, { tools: terrainMode.tools, missing: missingTools });
    rec(
      '地形编辑面板：半径 10–600 / 强度 1–100 滑杆存在且范围正确',
      Boolean(terrainMode.radius) && Number(terrainMode.radius.min) === 10 && Number(terrainMode.radius.max) === 600 && Boolean(terrainMode.strength) && Number(terrainMode.strength.min) === 1 && Number(terrainMode.strength.max) === 100,
      { radius: terrainMode.radius, strength: terrainMode.strength },
    );
    rec(
      '地形编辑面板：撤销 / 恢复原始 / 导出按钮 + 导出信息文本（尺寸 1081、灰度 12596–53742）',
      terrainMode.undo &&
        terrainMode.reset &&
        terrainMode.exportBtn &&
        typeof terrainMode.size === 'string' &&
        terrainMode.size.includes(String(TERRAIN_DEM_SIZE)) &&
        typeof terrainMode.gray === 'string' &&
        terrainMode.gray.includes(String(SAT_GRAY_MIN)) &&
        terrainMode.gray.includes(String(SAT_GRAY_MAX)) &&
        terrainMode.editedLabel !== null &&
        terrainMode.dirty !== null &&
        terrainMode.status !== null,
      { undo: terrainMode.undo, reset: terrainMode.reset, exportBtn: terrainMode.exportBtn, size: terrainMode.size, gray: terrainMode.gray, editedLabel: terrainMode.editedLabel, dirty: terrainMode.dirty, status: terrainMode.status },
    );

    const api = await page.eval(TERRAIN_API_EXPR);
    rec('地形编辑引擎 API 暴露（terrainEditor 方法/属性 + heightField 数据/方法）', api.ok, api);
    const uheight = await page.eval(TERRAIN_UHEIGHT_EXPR);
    rec('实时位移路径：地形顶点着色器包含 uHeight 且 uniform 绑定 heightField.texture', uheight.ok, uheight);

    await sleep(3000); // 先让卫星瓦片流式加载稳定，避免后续实时对比被瓦片变化干扰
    // ── 实时编辑（程序化 paintAtWorld）──
    const shotBefore = await page.screenshot(SHOT_TERRAIN_BEFORE);
    const paintCallStart = Date.now();
    const paint = await page.eval(TERRAIN_PAINT_EXPR);
    const shotRealtime = await page.screenshot(SHOT_TERRAIN_REALTIME);
    const realtimeWallMs = Date.now() - paintCallStart;
    const diffRealtime = diffScreenshots(SHOT_TERRAIN_BEFORE, SHOT_TERRAIN_REALTIME);
    await sleep(450);
    const shotSettled = await page.screenshot(SHOT_TERRAIN_SETTLED);
    const diffSettled = diffScreenshots(SHOT_TERRAIN_BEFORE, SHOT_TERRAIN_SETTLED);
    const afterSettled = await page.eval(TERRAIN_HASH_EXPR);
    const stateAfterPaint = await page.eval(TERRAIN_STATE_EXPR);

    const sampleRaised = Boolean(paint.ok) && Number(paint.after?.sample) > Number(paint.before?.sample) + 1e-6;
    const hashChanged = Boolean(paint.ok) && paint.after?.halfHash !== paint.before?.halfHash;
    const originalIntact = Boolean(paint.ok) && paint.after?.originalHash === paint.before?.originalHash;
    const frameAdvanced = Boolean(paint.ok) && Number(paint.after?.frame) > Number(paint.before?.frame);
    rec(
      '实时编辑：paintAtWorld(0,0,raise,140,0.5,10) 立即抬高（sample↑ / half 哈希变化 / 帧推进 / editCount·edited·dirty 更新）',
      sampleRaised && hashChanged && originalIntact && frameAdvanced && stateAfterPaint.edited === true && Number(stateAfterPaint.editCount) > 0 && Number(stateAfterPaint.dirtyCount) > 0,
      { paintMs: paint.paintMs, rafMs: paint.rafMs, realtimeWallMs, before: paint.before, after: paint.after, state: stateAfterPaint },
    );
    rec(
      '实时渲染：编辑后帧内截图与编辑前不同（geometry 已随 uHeight 更新，diff 比例 > 0.02%）',
      Boolean(diffRealtime.ok) && diffRealtime.ratio > 0.0002 && hashChanged,
      { diff: diffRealtime, realtimeWallMs, screenshot: shotRealtime },
    );
    rec(
      '着色重建后（约 300–500 ms）画面更新且高度保持（截图与编辑前不同，half 哈希不变）',
      Boolean(diffSettled.ok) && diffSettled.ratio > 0.0002 && afterSettled.halfHash === paint.after?.halfHash,
      { diff: diffSettled, halfHash: afterSettled.halfHash, screenshot: shotSettled },
    );

    // ── 撤销 ──
    const undoCall = await page.eval(`(() => {
      const te = window.__designer && window.__designer.terrainEditor;
      if (!te || typeof te.undo !== 'function') return { ok: false };
      te.undo();
      return { ok: true };
    })()`);
    await sleep(350);
    const afterUndo = await page.eval(TERRAIN_HASH_EXPR);
    const undoState = await page.eval(TERRAIN_STATE_EXPR);
    rec(
      '撤销：undo() 精确恢复到编辑前（half 哈希 == 基线，edited=false）',
      Boolean(undoCall.ok) && afterUndo.halfHash === baseline.halfHash && undoState.edited === false,
      { undo: undoCall, afterUndo, state: undoState },
    );

    // ── UI 控件联动 ──
    const sync = await page.eval(`(() => {
      const clickTool = (tool) => {
        const button = document.querySelector('[data-terrain-tool="' + tool + '"]');
        if (!button) return false;
        button.click();
        return true;
      };
      const setRange = (selector, value) => {
        const input = document.querySelector(selector);
        if (!input) return null;
        input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return input.value;
      };
      return { lowerClicked: clickTool('lower'), radiusValue: setRange('[data-terrain="radius"]', 200), strengthValue: setRange('[data-terrain="strength"]', 60) };
    })()`);
    await sleep(400);
    const syncState = await page.eval(TERRAIN_STATE_EXPR);
    const strengthSynced = Math.abs(Number(syncState.strength) - 0.6) < 1e-6 || Math.abs(Number(syncState.strength) - 60) < 1e-6;
    rec(
      'UI 控件联动引擎：工具按钮 / 半径滑杆 / 强度滑杆 → terrainEditor.tool/radius/strength',
      Boolean(sync.lowerClicked) && syncState.tool === 'lower' && Math.abs(Number(syncState.radius) - 200) < 1e-6 && strengthSynced,
      { sync, tool: syncState.tool, radius: syncState.radius, strength: syncState.strength },
    );
    await page.eval(`(() => {
      const te = window.__designer && window.__designer.terrainEditor;
      if (te) {
        te.setTool('raise');
        te.setRadius(140);
        te.setStrength(0.5);
      }
      return true;
    })()`);

    // ── 真实鼠标拖拽 ──
    const candidatePoints = [[640, 420], [600, 400], [700, 450], [640, 500], [560, 420], [700, 380]];
    let hit = null;
    for (const [x, y] of candidatePoints) {
      const pick = await page.eval(`(() => {
        try {
          const p = window.__designer.cameraControls.pick(${x}, ${y});
          if (!p) return null;
          return {
            sx: ${x},
            sy: ${y},
            worldX: p.x ?? (p.point ? p.point.x : null),
            worldZ: p.z ?? (p.point ? p.point.z : null),
            normalized: p.normalized ?? null,
          };
        } catch (err) {
          return null;
        }
      })()`);
      if (pick && (pick.worldX !== null || pick.worldZ !== null || pick.normalized !== null)) {
        hit = pick;
        break;
      }
    }
    if (!hit) {
      rec('真实鼠标拖拽：画布中心 pick 命中地形并可绘制', false, { reason: '候选点均未命中地形', candidatePoints });
    } else {
      const dragBefore = await page.eval(TERRAIN_HASH_EXPR);
      await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.sx, y: hit.sy, buttons: 0 });
      await page.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.sx, y: hit.sy, button: 'left', buttons: 1, clickCount: 1 });
      for (let step = 1; step <= 12; step += 1) {
        await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.sx + step * 8, y: hit.sy + step * 2, button: 'left', buttons: 1 });
        await sleep(20);
      }
      await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.sx + 96, y: hit.sy + 24, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(700);
      const dragAfter = await page.eval(TERRAIN_HASH_EXPR);
      const dragState = await page.eval(TERRAIN_STATE_EXPR);
      rec(
        '真实鼠标拖拽：mousePressed→move×12→mouseReleased 绘制地形（editCount↑ / half 哈希变化）',
        dragAfter.halfHash !== dragBefore.halfHash && Number(dragState.editCount) > 0 && dragState.edited === true,
        { pick: hit, beforeHash: dragBefore.halfHash, afterHash: dragAfter.halfHash, editCount: dragState.editCount, dirtyCount: dragState.dirtyCount },
      );
      await page.eval(`(() => {
        const te = window.__designer && window.__designer.terrainEditor;
        if (te && typeof te.undo === 'function') te.undo();
        return true;
      })()`);
      await sleep(450);
    }

    // ── 导出（编辑态）──
    const paint2 = await page.eval(TERRAIN_PAINT_EXPR);
    await sleep(500);
    rec('导出前再次编辑（raise @ 0,0）成功', Boolean(paint2.ok) && Number(paint2.after?.sample) > Number(paint2.before?.sample) + 1e-6, { paint: paint2 });
    const editedSnapshot = await page.eval(TERRAIN_HASH_EXPR);
    const editedState = await page.eval(TERRAIN_STATE_EXPR);

    let exportData = null;
    try {
      exportData = await page.eval(TERRAIN_EXPORT_EXPR);
      if (!exportData || !exportData.ok) throw new Error(exportData?.reason ?? 'exportPngBytes 未返回 bytes');
      const metaOk =
        Number(exportData.width) === TERRAIN_DEM_SIZE &&
        Number(exportData.height) === TERRAIN_DEM_SIZE &&
        Number(exportData.bitDepth) === 16 &&
        /\.png$/i.test(String(exportData.filename ?? '')) &&
        Number(exportData.byteLength) > 0;
      rec('导出 API：exportPngBytes() 返回 16-bit PNG bytes（1081×1081，.png 文件名）', metaOk, {
        filename: exportData.filename,
        byteLength: exportData.byteLength,
        width: exportData.width,
        height: exportData.height,
        bitDepth: exportData.bitDepth,
        exportInfo: exportData.exportInfo,
      });

      const pngBuf = Buffer.from(exportData.base64, 'base64');
      const header = pngHeader(pngBuf);
      const rows = [];
      await decodePngRows(pngBuf, (row) => rows.push(rowToU16(row, header.width)));
      rec(
        '导出 PNG 结构正确（1081×1081 / bitDepth 16 / colorType 0 / 非隔行 / zlib 解压逐行成功）',
        header.width === TERRAIN_DEM_SIZE && header.height === TERRAIN_DEM_SIZE && header.bitDepth === 16 && header.colorType === 0 && header.interlace === 0 && rows.length === TERRAIN_DEM_SIZE,
        { header: { width: header.width, height: header.height, bitDepth: header.bitDepth, colorType: header.colorType, interlace: header.interlace }, rows: rows.length, bytes: pngBuf.length },
      );

      const hfInfo = exportData.heightField ?? {};
      const editedPixel = Number.isInteger(hfInfo.editedIndex) && hfInfo.editedIndex >= 0 ? rows[Math.floor(hfInfo.editedIndex / TERRAIN_DEM_SIZE)][hfInfo.editedIndex % TERRAIN_DEM_SIZE] : null;
      const controlPixel = Number.isInteger(hfInfo.controlIndex) && hfInfo.controlIndex >= 0 ? rows[Math.floor(hfInfo.controlIndex / TERRAIN_DEM_SIZE)][hfInfo.controlIndex % TERRAIN_DEM_SIZE] : null;
      const editedGrayOk = editedPixel !== null && hfInfo.editedGray !== null && Math.abs(editedPixel - hfInfo.editedGray) <= 1;
      const controlGrayOk = controlPixel !== null && hfInfo.controlGray !== null && Math.abs(controlPixel - hfInfo.controlGray) <= 1;
      rec(
        '导出内容正确：已编辑像素灰度 = round(min+norm*(max−min)) ±1，未编辑对照像素同理',
        editedGrayOk && controlGrayOk && hfInfo.sourceRange?.min === SAT_GRAY_MIN && hfInfo.sourceRange?.max === SAT_GRAY_MAX,
        {
          editedIndex: hfInfo.editedIndex,
          editedNorm: hfInfo.editedNorm,
          editedGrayExpected: hfInfo.editedGray,
          editedPixel,
          controlIndex: hfInfo.controlIndex,
          controlNorm: hfInfo.controlNorm,
          controlGrayExpected: hfInfo.controlGray,
          controlPixel,
          sourceRange: hfInfo.sourceRange,
        },
      );
    } catch (err) {
      rec('导出 PNG 解码与内容校验', false, { error: String(err?.message ?? err), exportOk: exportData?.ok ?? false });
    }

    // ── UI 导出按钮（真实下载）──
    try {
      rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
      mkdirSync(DOWNLOAD_DIR, { recursive: true });
      let downloadConfigured = false;
      try {
        await page.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR, eventsEnabled: true });
        downloadConfigured = true;
      } catch {
        try {
          await page.cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR });
          downloadConfigured = true;
        } catch {
          downloadConfigured = false;
        }
      }
      const clickExport = await page.eval(`(() => {
        const button = document.querySelector('[data-act="terrain-export"]');
        if (!button) return { ok: false };
        button.click();
        return { ok: true, text: button.textContent.replace(/\\s+/g, ' ').trim() };
      })()`);
      let downloaded = null;
      const downloadDeadline = Date.now() + 30000;
      while (Date.now() < downloadDeadline) {
        let files = [];
        try {
          files = readdirSync(DOWNLOAD_DIR).filter((name) => /\.png$/i.test(name));
        } catch {
          files = [];
        }
        if (files.length) {
          const candidate = path.join(DOWNLOAD_DIR, files[0]);
          try {
            const size = statSync(candidate).size;
            if (size > 0) {
              downloaded = { file: candidate, size };
              break;
            }
          } catch {
            /* 文件正在写入 */
          }
        }
        await sleep(300);
      }
      let downloadHeader = null;
      if (downloaded) {
        await sleep(700);
        const buf = readFileSync(downloaded.file);
        try {
          downloadHeader = pngHeader(buf);
        } catch {
          downloadHeader = null;
        }
        downloaded = { ...downloaded, bytes: buf.length };
      }
      const downloadOk = Boolean(downloadHeader) && downloadHeader.width === TERRAIN_DEM_SIZE && downloadHeader.height === TERRAIN_DEM_SIZE && downloadHeader.bitDepth === 16 && downloadHeader.colorType === 0;
      rec('UI 导出按钮：点击后下载 16-bit 灰度 PNG（1081×1081）并校验文件头', downloadConfigured && Boolean(clickExport.ok) && downloadOk, {
        downloadConfigured,
        clickExport,
        downloaded,
        header: downloadHeader,
      });
    } catch (err) {
      rec('UI 导出按钮：点击后下载 16-bit 灰度 PNG', false, { error: String(err?.message ?? err) });
    }

    // ── 持久化（IndexedDB，刷新恢复）──
    const editedBeforeSave = { hash: editedSnapshot.halfHash, sample: editedSnapshot.sample00 };
    const saveCall = await page.eval(`(async () => {
      const te = window.__designer && window.__designer.terrainEditor;
      if (!te || typeof te.saveNow !== 'function') return { ok: false };
      await te.saveNow();
      return { ok: true };
    })()`);
    const idb = await page.eval(TERRAIN_IDB_EXPR);
    rec('持久化：saveNow() 后 IndexedDB（terrain-modeldesigner/world/terrain-edit-v1）有编辑记录', Boolean(saveCall.ok) && Boolean(idb.ok), { saveCall, idb });

    const reboot = await reload();
    const restoredPoll = await pollEval(page, TERRAIN_STATE_EXPR, (value) => Boolean(value) && value.edited === true, 30000);
    const modeClassAfterReload = await page.eval(`(() => { const ui = document.getElementById('ui'); return ui ? ui.className : null; })()`);
    if (!String(modeClassAfterReload ?? '').includes('mode-terrain')) {
      await page.eval(`(() => {
        const button = document.querySelector('#toolbar [data-mode="terrain"]');
        if (button) button.click();
        return true;
      })()`);
      await sleep(900);
    }
    const restored = await page.eval(TERRAIN_HASH_EXPR);
    const restoredState = await page.eval(TERRAIN_STATE_EXPR);
    const hashEqual = restored.halfHash === editedBeforeSave.hash;
    const sampleDelta = Math.abs(Number(restored.sample00) - Number(editedBeforeSave.sample));
    const persistedOk = reboot.ok && (hashEqual || sampleDelta < 0.003) && /已编辑/.test(String(restoredState.uiText.edited ?? '')) && Number(restoredState.dirtyCount) > 0;
    const shotPersisted = await page.screenshot(SHOT_TERRAIN_PERSISTED);
    rec(
      '持久化：刷新后编辑高度恢复（half 哈希一致 / sample 偏差 < 0.003）+ UI 显示已编辑',
      persistedOk,
      {
        boot: reboot.details,
        restoredPoll,
        editedHash: editedBeforeSave.hash,
        restoredHash: restored.halfHash,
        hashEqual,
        sampleDelta,
        editedLabel: restoredState.uiText.edited,
        dirty: restoredState.uiText.dirty,
        dirtyCount: restoredState.dirtyCount,
        screenshot: shotPersisted,
      },
    );

    // ── 清理（恢复原始 + 保存 + 刷新校验）──
    const cleanup = await page.eval(`(async () => {
      const te = window.__designer && window.__designer.terrainEditor;
      if (!te || typeof te.resetToOriginal !== 'function') return { ok: false };
      te.resetToOriginal();
      if (typeof te.saveNow === 'function') await te.saveNow();
      return { ok: true };
    })()`);
    await sleep(300);
    const cleanBoot = await reload();
    const cleanPoll = await pollEval(page, TERRAIN_STATE_EXPR, (value) => Boolean(value) && value.edited === false, 30000);
    const cleanHash = await page.eval(TERRAIN_HASH_EXPR);
    const cleanState = await page.eval(TERRAIN_STATE_EXPR);
    const cleanSampleDelta = Math.abs(Number(cleanHash.sample00) - Number(baseline.sample00));
    rec(
      '清理：resetToOriginal()+saveNow() 后刷新，高度场与基线逐位一致且 edited=false',
      Boolean(cleanup.ok) && cleanBoot.ok && cleanHash.halfHash === baseline.halfHash && cleanSampleDelta < 1e-9 && cleanState.edited === false,
      { cleanup, boot: cleanBoot.details, cleanPoll, baselineHash: baseline.halfHash, cleanHash: cleanHash.halfHash, sampleDelta: cleanSampleDelta, edited: cleanState.edited },
    );

    // ── 模式互斥（模型 / 水体 / 地形）──
    const modeChecks = [];
    for (const mode of ['models', 'water', 'terrain']) {
      const clicked = await page.eval(`(() => {
        const button = document.querySelector('#toolbar [data-mode="${mode}"]');
        if (!button) return { ok: false };
        button.click();
        return { ok: true };
      })()`);
      await sleep(700);
      modeChecks.push({ mode, clicked: clicked.ok, state: await page.eval(TERRAIN_STATE_EXPR) });
    }
    const panelOk = (item) => {
      const panels = item.state.panels;
      if (item.mode === 'models') return panels.models && !panels.terrain && !panels.terrainExport && !panels.water;
      if (item.mode === 'water') return panels.water && !panels.terrain && !panels.terrainExport && !panels.models;
      return panels.terrain && panels.terrainExport && !panels.models && !panels.water;
    };
    const activeOk = modeChecks[0].state.active === false && modeChecks[1].state.active === false && modeChecks[2].state.active === true;
    rec('模式互斥：模型编辑 / 水体编辑 / 地形编辑 面板互相隐藏且引擎 active 正确', modeChecks.every((item) => item.clicked && panelOk(item)) && activeOk, {
      checks: modeChecks.map((item) => ({ mode: item.mode, panels: item.state.panels, active: item.state.active, uiClass: item.state.uiClass })),
    });

    // 离开时回到模型编辑模式，避免影响后续自动生成阶段的页面
    await page.eval(`(() => {
      const button = document.querySelector('#toolbar [data-mode="models"]');
      if (button) button.click();
      return true;
    })()`);
    await sleep(300);

    accumulate();
    rec('地形编辑页面无 JS / 着色器控制台错误', accumulatedErrors.length === 0, {
      count: accumulatedErrors.length,
      errors: accumulatedErrors.slice(0, 10),
      finalConsoleTail: page.consoleLines.slice(-15),
    });
    rec('地形编辑页面无关键资源加载失败', accumulatedNetFailures.length === 0, {
      count: accumulatedNetFailures.length,
      failures: accumulatedNetFailures.slice(0, 10),
    });
  } finally {
    await page.blankAndClose();
  }
}

// ── [E] 缺失资产自动生成 ────────────────────────────────────────────────────
function analyzeGenerationLog(lines) {
  const text = lines.join('\n');
  const patterns = {
    detectedMissing: /检测到地形瓦片缺失|地形瓦片缺失|缺少/,
    pipeline: /正在执行资产管线|prepare-assets\.mjs|资产管线/,
    height: /\[height\]|height\.f16/,
    satellite: /\[sat\]|卫星瓦片/,
    completed: /自动生成完成|已就绪|生成完毕/,
  };
  const matched = Object.entries(patterns)
    .filter(([, regex]) => regex.test(text))
    .map(([key]) => key);
  const ok =
    matched.includes('detectedMissing') &&
    matched.includes('pipeline') &&
    (matched.includes('height') || matched.includes('satellite')) &&
    matched.includes('completed');
  return { ok, matched, tail: lines.slice(-20) };
}

async function autogenPhase() {
  log('\n=== [E] 缺失资产自动生成（临时移走 public/data）===');
  if (existsSync(BACKUP_DIR)) {
    if (!existsSync(DATA_DIR)) {
      renameSync(BACKUP_DIR, DATA_DIR);
      log('[setup] 发现上次中断遗留的 data.__bak，已恢复为 public/data');
    } else {
      rec('资产自动生成前置：无残留 data.__bak 目录', false, { backup: BACKUP_DIR, data: DATA_DIR });
      return;
    }
  }

  const original = inspectDataDir(DATA_DIR);
  if (!original.complete) {
    rec('资产自动生成前置：public/data 完整（否则无法做备份/恢复）', false, original);
    return;
  }

  let renamed = false;
  try {
    renameSync(DATA_DIR, BACKUP_DIR);
    renamed = true;
    rec('临时移走 public/data → public/data.__bak', true, { backup: BACKUP_DIR, original });
  } catch (err) {
    rec('临时移走 public/data → public/data.__bak', false, { error: String(err?.message ?? err) });
    return;
  }

  let dev = null;
  let page = null;
  try {
    dev = startVite({ port: DEV_PORT, label: 'dev-autogen' });
    let ready = false;
    let readyError = null;
    try {
      await waitServerReady(dev, 13 * 60 * 1000);
      ready = true;
    } catch (err) {
      readyError = String(err?.message ?? err);
    }

    const generation = analyzeGenerationLog(dev.lines);
    rec('dev 启动时自动生成地形资产（日志证据：缺失检测 + 资产管线 + 完成）', ready && generation.ok, {
      ready,
      readyError,
      matched: generation.matched,
      logTail: generation.tail,
    });

    if (ready) {
      const base = `http://127.0.0.1:${dev.port}`;
      const meta = await getJson(`${base}/data/terrain.json`);
      const height = await getBuffer(`${base}/data/height.f16`);
      const tile = await getBuffer(`${base}/data/sat/0_0_128.jpg`);
      rec(
        '自动生成后 HTTP 数据正确（terrain.json / height.f16 / 卫星瓦片）',
        !meta.err &&
          meta.res.status === 200 &&
          Boolean(meta.json) &&
          Number.isFinite(meta.json.width) &&
          !height.err &&
          height.buf.length === HEIGHT_SIZE &&
          !tile.err &&
          /image\/jpeg/i.test(contentType(tile.res)) &&
          isJpeg(tile.buf),
        {
          terrainJson: { status: meta.res?.status ?? null, meta: meta.json ?? null, error: meta.err ?? null },
          height: { status: height.res?.status ?? null, bytes: height.buf?.length ?? null, error: height.err ?? null },
          tile: { status: tile.res?.status ?? null, contentType: contentType(tile.res), jpeg: isJpeg(tile.buf), error: tile.err ?? null },
        },
      );

      const generated = inspectDataDir(DATA_DIR);
      rec('自动生成后 public/data 文件完整（height.f16 + terrain.json + 192 张瓦片）', generated.complete, generated);

      const browser = await ensureBrowser();
      if (browser) {
        page = await openPage(browser, 'autogen');
        await page.goto(`${base}/`);
        const boot = await page.waitBoot(240000);
        let autogenSatellite = null;
        let autogenDiag = null;
        if (boot.ok) {
          autogenSatellite = await page.waitSatellite(90000);
          await sleep(3000);
          autogenDiag = await page.diagnostics();
          await page.screenshot(SHOT_AUTOGEN);
        }
        rec('自动生成后页面可启动 + 卫星贴图激活', boot.ok && autogenSatellite?.ok === true && autogenDiag?.terrainMode === 'satellite', {
          boot: boot.details,
          satellite: autogenSatellite,
          terrainMode: autogenDiag?.terrainMode ?? null,
          screenshot: boot.ok ? SHOT_AUTOGEN : null,
          errors: page.errors.slice(0, 6),
        });
      }
    }
  } finally {
    if (page) {
      try {
        await page.blankAndClose();
      } catch {
        /* ignore */
      }
    }
    if (dev) await stopServer(dev);
    const restore = restoreDataBackup();
    rec('恢复原始 public/data 备份（data.__bak → public/data）', restore.restored, { renamed, ...restore });
    const restored = inspectDataDir(DATA_DIR);
    rec('恢复后 public/data 与备份一致（高度场 + 192 张瓦片 + terrain.json）', sameDataSummary(original, restored), {
      original,
      restored,
    });
  }
}

// ── [F] 构建与 dist ────────────────────────────────────────────────────────
function scanModeldesignerRefs(distDir, jsFiles, cssFiles) {
  const files = [
    { name: 'index.html', file: path.join(distDir, 'index.html') },
    ...jsFiles.map((name) => ({ name: `assets/${name}`, file: path.join(distDir, 'assets', name) })),
    ...cssFiles.map((name) => ({ name: `assets/${name}`, file: path.join(distDir, 'assets', name) })),
  ];
  const indexHtmlHits = [];
  const pathLike = [];
  const allHits = [];
  for (const item of files) {
    let text = '';
    try {
      text = readFileSync(item.file, 'utf8');
    } catch {
      continue;
    }
    const hits = text.match(/[^\s"'`()]{0,40}modeldesigner[^\s"'`()]{0,40}/gi) ?? [];
    if (!hits.length) continue;
    for (const hit of hits) {
      allHits.push({ file: item.name, hit });
      const isPathLike = /modeldesigner[\\/]/i.test(hit) || /[\\/]modeldesigner/i.test(hit) || /\.\.\/modeldesigner/i.test(hit);
      if (isPathLike) pathLike.push({ file: item.name, hit });
      if (item.name === 'index.html') indexHtmlHits.push({ file: item.name, hit });
    }
  }
  return { allHits: allHits.slice(0, 20), allHitCount: allHits.length, pathLike, indexHtmlHits };
}

async function buildPhase() {
  log('\n=== [F] 生产构建与 dist 校验 ===');
  const build = await runCommand(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm run build'], {
    cwd: ROOT,
    timeoutMs: 10 * 60 * 1000,
  });
  const buildText = `${build.stdout}\n${build.stderr}`;
  for (const line of buildText.split(/\r?\n/).slice(-40)) if (line.trim()) log(`  | ${line}`);
  rec('npm run build 成功（退出码 0）', build.code === 0 && !build.timedOut, {
    code: build.code,
    timedOut: build.timedOut,
    tail: tailLines(buildText, 20),
  });
  rec(
    '构建日志显示 postbuild / dist 资产自检执行',
    /postbuild|ensure-assets\.mjs --dist|dist 地形瓦片|terrain-assets/i.test(buildText),
    { matched: /postbuild/.test(buildText) || /ensure-assets\.mjs --dist/.test(buildText) || /dist 地形瓦片/.test(buildText) },
  );

  const distIndex = path.join(DIST_DIR, 'index.html');
  let distIndexText = '';
  try {
    distIndexText = readFileSync(distIndex, 'utf8');
  } catch {
    distIndexText = '';
  }
  rec('dist/index.html 存在且为应用入口（含 #app / module script）', existsSync(distIndex) && /id="app"/.test(distIndexText), {
    exists: existsSync(distIndex),
    bytes: distIndexText.length,
  });

  let assetFiles = [];
  try {
    assetFiles = readdirSync(path.join(DIST_DIR, 'assets'));
  } catch {
    assetFiles = [];
  }
  const jsFiles = assetFiles.filter((name) => /\.js$/i.test(name));
  const cssFiles = assetFiles.filter((name) => /\.css$/i.test(name));
  rec('dist/assets 含 JS 与 CSS 产物', jsFiles.length >= 1 && cssFiles.length >= 1, {
    js: jsFiles,
    css: cssFiles,
  });

  const distData = inspectDataDir(path.join(DIST_DIR, 'data'));
  rec(`dist/data/height.f16 大小 ${HEIGHT_SIZE} 字节`, distData.heightOk, { bytes: distData.heightSize, expected: HEIGHT_SIZE });
  rec('dist/data/terrain.json 存在且可解析（width/height 有效）', distData.metaOk, { meta: distData.meta });
  rec(`dist/data/sat 恰好 ${SAT_TILE_COUNT} 张瓦片`, distData.satOk, {
    count: distData.satTileCount,
    tiers: distData.satTiers,
  });

  const distModels = path.join(DIST_DIR, 'models', 'index.json');
  let distModelsJson = null;
  try {
    distModelsJson = JSON.parse(readFileSync(distModels, 'utf8'));
  } catch {
    distModelsJson = null;
  }
  rec('dist/models/index.json 存在且可解析（files 数组）', Boolean(distModelsJson) && Array.isArray(distModelsJson.files), {
    exists: existsSync(distModels),
    files: distModelsJson?.files?.length ?? null,
  });

  rec('dist 无 modeldesigner 子目录', !existsSync(path.join(DIST_DIR, 'modeldesigner')), {
    modeldesignerDir: path.join(DIST_DIR, 'modeldesigner'),
  });

  const scan = scanModeldesignerRefs(DIST_DIR, jsFiles, cssFiles);
  rec(
    'dist 产物无 modeldesigner 路径字符串（index.html + assets js/css）',
    scan.pathLike.length === 0 && scan.indexHtmlHits.length === 0,
    { pathLike: scan.pathLike.slice(0, 10), indexHtmlHits: scan.indexHtmlHits.slice(0, 10), allHitCount: scan.allHitCount, allHits: scan.allHits.slice(0, 8) },
  );

  // --dist 在完整时 no-op
  const keep = await runNodeScript(['scripts/ensure-assets.mjs', '--dist'], 180000);
  const keepText = `${keep.stdout}\n${keep.stderr}`;
  rec('node scripts/ensure-assets.mjs --dist 在 dist 完整时退出 0（no-op，不重建）', keep.code === 0 && /dist 地形瓦片完整/.test(keepText), {
    code: keep.code,
    tail: tailLines(keepText, 8),
  });

  // --dist 修复缺失
  log('[setup] 删除 dist/data 以验证 ensure-assets --dist 的修复能力…');
  try {
    rmSync(path.join(DIST_DIR, 'data'), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const repair = await runNodeScript(['scripts/ensure-assets.mjs', '--dist'], 5 * 60 * 1000);
  const repairText = `${repair.stdout}\n${repair.stderr}`;
  const repaired = inspectDataDir(path.join(DIST_DIR, 'data'));
  rec(
    'ensure-assets --dist 能修复缺失的 dist/data（重新从 public/data 同步）',
    repair.code === 0 && repaired.complete,
    { code: repair.code, repaired, tail: tailLines(repairText, 10) },
  );
}

// ── [G] preview（dist 静态托管）────────────────────────────────────────────
async function previewPhase() {
  log('\n=== [G] vited preview（dist 静态托管，127.0.0.1:5198）===');
  const server = startVite({ port: PREVIEW_PORT, preview: true, label: 'preview' });
  try {
    await waitServerReady(server, 120000);
    rec('preview server 在 5198 启动', true, { url: `http://127.0.0.1:${PREVIEW_PORT}/` });
    const base = `http://127.0.0.1:${server.port}`;

    const root = await getText(`${base}/`);
    rec(
      'preview / 返回 dist HTML（text/html + id="app"）',
      !root.err && root.res.status === 200 && /text\/html/i.test(contentType(root.res)) && /id="app"/.test(root.text),
      { status: root.res?.status ?? null, contentType: contentType(root.res), error: root.err ?? null },
    );

    const height = await getBuffer(`${base}/data/height.f16`);
    rec(
      `preview /data/height.f16 大小 ${HEIGHT_SIZE} 字节`,
      !height.err && height.res.status === 200 && height.buf.length === HEIGHT_SIZE,
      { status: height.res?.status ?? null, bytes: height.buf?.length ?? null, error: height.err ?? null },
    );

    const tile = await getBuffer(`${base}/data/sat/0_0_128.jpg`);
    rec(
      'preview /data/sat/0_0_128.jpg 为 image/jpeg',
      !tile.err && tile.res.status === 200 && /image\/jpeg/i.test(contentType(tile.res)) && isJpeg(tile.buf),
      { status: tile.res?.status ?? null, contentType: contentType(tile.res), jpeg: isJpeg(tile.buf), error: tile.err ?? null },
    );
  } catch (err) {
    rec('preview server 在 5198 启动', false, { error: String(err?.message ?? err) });
  } finally {
    await stopServer(server);
  }
}

// ── 报告 ────────────────────────────────────────────────────────────────────
function collectEnvironment() {
  return {
    cwd: ROOT,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    timestamp: new Date().toISOString(),
    viteVersion: null,
    chromePath: null,
  };
}

function writeReports(env) {
  const passed = checks.filter((entry) => entry.ok).length;
  const failed = checks.length - passed;
  const allPass = failed === 0 && checks.length > 0;

  const lines = [];
  lines.push('# 合并后应用验证报告（tests/verify-merged.mjs）');
  lines.push('');
  lines.push(`- 时间：${new Date().toISOString()}`);
  lines.push(`- 工作目录：${ROOT}`);
  lines.push(`- Node：${env.node} / ${env.platform}`);
  lines.push(`- Vite：${env.viteVersion ?? 'unknown'}`);
  lines.push(`- Chrome：${env.chromePath ?? '未找到'}`);
  lines.push(`- 端口：dev ${DEV_PORT} / preview ${PREVIEW_PORT}（未使用 5173 / 5174 / 53831）`);
  lines.push(`- 跳过项：构建=${SKIP_BUILD}，自动生成=${SKIP_AUTOGEN}，preview=${SKIP_PREVIEW}，地形编辑=${SKIP_TERRAIN}`);
  lines.push(`- 结论：**${allPass ? 'PASS' : 'FAIL'}**（${passed}/${checks.length} 通过）`);
  lines.push('');
  lines.push('| 结果 | 检查 | 详情 |');
  lines.push('| --- | --- | --- |');
  for (const entry of checks) {
    const details = shortJson(entry.details, 500).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${entry.ok ? 'PASS' : 'FAIL'} | ${entry.name.replace(/\|/g, '\\|')} | ${details} |`);
  }
  lines.push('');
  lines.push('## 截图');
  lines.push('');
  for (const file of [SHOT_MAIN, SHOT_GRAPHICS, SHOT_WATER, SHOT_TOUR, SHOT_AUTOGEN, SHOT_TERRAIN_MODE, SHOT_TERRAIN_BEFORE, SHOT_TERRAIN_REALTIME, SHOT_TERRAIN_SETTLED, SHOT_TERRAIN_PERSISTED]) {
    lines.push(`- ${path.relative(ROOT, file)} ${existsSync(file) ? '' : '（未生成）'}`);
  }
  lines.push('');
  lines.push('## 关键日志尾部');
  lines.push('');
  lines.push('```');
  lines.push(...transcript.slice(-80));
  lines.push('```');
  lines.push('');

  const reportMd = path.join(OUT, 'verify-report.md');
  const reportJson = path.join(OUT, 'verify-report.json');
  const logFile = path.join(OUT, 'verify-merged.log');
  writeFileSync(reportMd, `${lines.join('\n')}\n`, 'utf8');
  writeFileSync(
    reportJson,
    JSON.stringify({ environment: env, summary: { total: checks.length, passed, failed, ok: allPass }, checks, screenshots: [SHOT_MAIN, SHOT_GRAPHICS, SHOT_WATER, SHOT_TOUR, SHOT_AUTOGEN, SHOT_TERRAIN_MODE, SHOT_TERRAIN_BEFORE, SHOT_TERRAIN_REALTIME, SHOT_TERRAIN_SETTLED, SHOT_TERRAIN_PERSISTED] }, null, 2),
    'utf8',
  );
  writeFileSync(logFile, `${transcript.join('\n')}\n`, 'utf8');
  return { passed, failed, allPass, reportMd, reportJson, logFile };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT, { recursive: true });
  log('=== tests/verify-merged.mjs — 合并后应用端到端验证 ===');
  const env = collectEnvironment();
  log(`[env] ${shortJson(env)}`);
  log(`[env] dev=${DEV_PORT} preview=${PREVIEW_PORT}; 绝不触碰 5173 / 5174 / 53831`);

  const phase = async (label, fn) => {
    try {
      await fn();
    } catch (err) {
      rec(`${label}阶段未捕获异常`, false, { error: tailLines(String(err?.stack ?? err?.message ?? err), 12) });
    }
  };

  try {
    await preflight(env);
    if (!existsSync(VITE_BIN) || !findChrome()) {
      rec('验证前置条件满足（vite + Chrome 可执行文件）', false, {
        vite: existsSync(VITE_BIN),
        chrome: findChrome(),
      });
    } else {
      await phase('初始化资产数据', async () => {
        await ensureInitialData();
        await ensureAssetsNoop();
      });

      await phase('dev server / HTTP / 页面', async () => {
        log('\n=== [C] 启动 dev server ===');
        const dev = startVite({ port: DEV_PORT, label: 'dev' });
        try {
          let devReady = false;
          try {
            await waitServerReady(dev, 240000);
            devReady = true;
            rec('dev server 在 5199 启动（--strictPort）', true, { url: `http://127.0.0.1:${dev.port}/` });
          } catch (err) {
            rec('dev server 在 5199 启动（--strictPort）', false, { error: String(err?.message ?? err) });
          }
          if (devReady) {
            await runHttpChecks(dev);
            await pagePhase(dev);
            if (SKIP_TERRAIN) {
              log('\n[skip] VERIFY_SKIP_TERRAIN=1，跳过地形编辑 / 导出 / 持久化验证');
            } else {
              await phase('地形编辑 / 实时 / 导出 / 持久化', async () => {
                await terrainPhase(dev);
              });
            }
          }
        } finally {
          await stopServer(dev);
        }
      });

      if (SKIP_AUTOGEN) {
        log('\n[skip] VERIFY_SKIP_AUTOGEN=1，跳过缺失资产自动生成验证');
      } else {
        await phase('缺失资产自动生成', autogenPhase);
      }

      await closeBrowser();

      if (SKIP_BUILD) {
        log('\n[skip] VERIFY_SKIP_BUILD=1，跳过构建与 dist 校验');
      } else {
        await phase('构建与 dist', buildPhase);
      }

      if (SKIP_PREVIEW) {
        log('\n[skip] VERIFY_SKIP_PREVIEW=1，跳过 preview 校验');
      } else {
        await phase('preview', previewPhase);
      }
    }
  } finally {
    await closeBrowser();
    for (const server of [...servers]) await stopServer(server);
    for (const child of [...children]) killTree(child);
    const strayRestore = restoreDataBackup();
    if (strayRestore.restored) log('[cleanup] finally 恢复了遗留的 public/data.__bak 备份');

    const summary = writeReports(env);
    log('');
    log('=== 结果汇总 ===');
    for (const entry of checks) log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`);
    log('');
    log(`通过 ${summary.passed}/${checks.length}，失败 ${summary.failed}`);
    log(`报告：${path.relative(ROOT, summary.reportMd)}`);
    log(`JSON：${path.relative(ROOT, summary.reportJson)}`);
    log(`日志：${path.relative(ROOT, summary.logFile)}`);
    log(`截图：${[SHOT_MAIN, SHOT_GRAPHICS, SHOT_WATER, SHOT_TOUR, SHOT_AUTOGEN, SHOT_TERRAIN_MODE, SHOT_TERRAIN_BEFORE, SHOT_TERRAIN_REALTIME, SHOT_TERRAIN_SETTLED, SHOT_TERRAIN_PERSISTED].map((file) => path.relative(ROOT, file)).join('  ')}`);
    log(`结果：${summary.allPass ? 'PASS' : 'FAIL'}`);
    exitCode = summary.allPass ? 0 : 1;
  }

  await sleep(300);
  process.exit(exitCode);
}

await main();
