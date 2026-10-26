/**
 * 资源文件夹（public/models）的读写工具：dev server 中间件与 CLI 脚本共用。
 *
 * - listModels()      扫描目录里的 .glb/.gltf，返回前端要的清单
 * - saveModel()       把上传的 glb 落盘（文件名消毒、扩展名白名单、大小上限）
 * - removeModel()     删除某个模型文件
 * - writeModelIndex() 生成 public/models/index.json（生产构建用；dev 走接口不需要）
 */
import { readdir, stat, mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export const MODELS_DIR = path.resolve(import.meta.dirname, '..', 'public', 'models');
export const INDEX_FILE = path.join(MODELS_DIR, 'index.json');
export const MAX_MODEL_BYTES = 256 * 1024 * 1024; // 单个模型上限 256 MB

const ALLOWED_EXT = new Set(['.glb', '.gltf']);
const SAFE_NAME = /^[\w.\-\u4e00-\u9fa5 ()+]+$/;

export async function ensureDir() {
  await mkdir(MODELS_DIR, { recursive: true });
}

/** 文件名消毒：去掉路径分隔符与控制字符，拒绝非法字符与非法扩展名 */
export function sanitizeFilename(raw) {
  const base = path.basename(String(raw ?? '').replace(/\\/g, '/')).trim();
  if (!base) return null;
  if (base.includes('..') || !SAFE_NAME.test(base)) return null;
  const ext = path.extname(base).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return null;
  return base;
}

export async function listModels() {
  await ensureDir();
  const entries = await readdir(MODELS_DIR, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) continue;
    const info = await stat(path.join(MODELS_DIR, entry.name));
    files.push({
      name: entry.name,
      url: `models/${encodeURIComponent(entry.name)}`,
      size: info.size,
      mtime: info.mtimeMs,
    });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return files;
}

export async function saveModel(rawName, buffer) {
  const name = sanitizeFilename(rawName);
  if (!name) throw new Error(`非法文件名：${rawName}（只接受 .glb / .gltf）`);
  if (!buffer?.length) throw new Error('空文件');
  if (buffer.length > MAX_MODEL_BYTES) throw new Error(`文件过大（上限 ${MAX_MODEL_BYTES / 1048576} MB）`);
  await ensureDir();
  const target = path.join(MODELS_DIR, name);
  await writeFile(target, buffer);
  return { name, url: `models/${encodeURIComponent(name)}`, size: buffer.length };
}

export async function removeModel(rawName) {
  const name = sanitizeFilename(rawName);
  if (!name) throw new Error(`非法文件名：${rawName}`);
  await unlink(path.join(MODELS_DIR, name));
  return name;
}

/** 生成静态清单（生产环境没有 dev 中间件，前端靠它列资源） */
export async function writeModelIndex() {
  const files = await listModels();
  const payload = {
    generatedAt: new Date().toISOString(),
    files: files.map(({ name, url, size }) => ({ name, url, size })),
  };
  await ensureDir();
  await writeFile(INDEX_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

/** 读取静态清单（CLI 调试用） */
export async function readModelIndex() {
  try {
    return JSON.parse(await readFile(INDEX_FILE, 'utf8'));
  } catch {
    return null;
  }
}
