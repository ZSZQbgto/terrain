/**
 * 模型资源库：统一「资源文件夹（public/models）」与「网页导入」两个来源。
 *
 * 优先路径（dev server）：
 *   - GET  /__models/list   → 实时扫描 public/models，列表永远反映文件夹真实内容
 *   - POST /__models/upload → 网页导入的 glb **直接落盘**到 public/models
 * 静态托管（构建产物）没有写盘能力：
 *   - 列表改读 public/models/index.json（构建时生成）
 *   - 网页导入落到 IndexedDB，界面上提供「移入资源文件夹」导出按钮
 *
 * 资源引用（写进工程 JSON）：
 *   { source: 'dir',   url,  name }   —— 资源文件夹里的文件
 *   { source: 'local', id,   name }   —— IndexedDB 里的本地暂存
 */
import { getAsset, listAssets, putAsset, deleteAsset } from './store.js';
import { uid } from './project.js';

const DEV_LIST = '/__models/list';
const DEV_UPLOAD = '/__models/upload';
const DEV_DELETE = '/__models/delete';
const MODEL_EXT = /\.(glb|gltf)$/i;

export class AssetLibrary {
  constructor() {
    this.dirFiles = []; // 资源文件夹里的模型
    this.localAssets = []; // IndexedDB 暂存的导入结果
    this.canWriteDir = false; // dev 接口可用（能写盘）
    this.lastError = '';
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }

  /** 资源列表 = 文件夹内容 + 本地暂存（文件夹排在前面，始终可见） */
  get all() {
    return [
      ...this.dirFiles.map((f) => ({
        key: `dir:${f.name}`,
        source: 'dir',
        name: f.name,
        size: f.size,
        // 工程里存相对路径（换端口/域名后依然可用）
        url: f.rel,
      })),
      ...this.localAssets.map((a) => ({
        key: `local:${a.id}`,
        source: 'local',
        name: a.name,
        size: a.size,
        id: a.id,
      })),
    ];
  }

  async refresh() {
    this.dirFiles = await this.loadDirFiles();
    this.localAssets = await listAssets();
    this.emit();
    return this.all;
  }

  async loadDirFiles() {
    // 1) dev 中间件：实时目录扫描
    try {
      const res = await fetch(DEV_LIST, { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        this.canWriteDir = true;
        return (json.files ?? []).map((f) => ({ ...f, rel: f.url, url: this.resolveUrl(f.url) }));
      }
    } catch {
      /* 静态托管：接口不存在 */
    }
    this.canWriteDir = false;

    // 2) 静态清单（构建时由 vite 插件生成）
    try {
      const res = await fetch(this.resolveUrl('models/index.json'), { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        return (json.files ?? []).map((f) => ({ ...f, rel: f.url, url: this.resolveUrl(f.url) }));
      }
    } catch {
      /* 没有清单就当空目录 */
    }
    return [];
  }

  resolveUrl(rel) {
    try {
      return new URL(rel, document.baseURI).href;
    } catch {
      return rel;
    }
  }

  /**
   * 导入一个文件：优先写进资源文件夹；写不了就落到 IndexedDB。
   * @param {File} file
   * @returns {Promise<{source: 'dir'|'local', asset: object|null, error?: string}>}
   */
  async importFile(file) {
    if (!MODEL_EXT.test(file.name)) {
      return { source: 'dir', asset: null, error: `${file.name}：只支持 .glb / .gltf` };
    }
    const buffer = await file.arrayBuffer();

    // 1) 尝试落盘到 public/models（dev server）
    try {
      const res = await fetch(`${DEV_UPLOAD}?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buffer,
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        this.canWriteDir = true;
        await this.refresh();
        const saved = this.dirFiles.find((f) => f.name === json.file?.name) ?? null;
        // 工程里存相对路径（f.rel），避免换端口/域名后引用失效
        return {
          source: 'dir',
          asset: saved ? { source: 'dir', url: saved.rel ?? saved.url, name: saved.name } : null,
        };
      }
      this.lastError = json.error ?? `上传失败（HTTP ${res.status}）`;
    } catch (err) {
      this.lastError = err?.message ?? String(err);
    }

    // 2) 回退：存 IndexedDB
    this.canWriteDir = false;
    const id = uid('asset');
    await putAsset({ id, name: file.name, type: file.type, buffer });
    await this.refresh();
    return { source: 'local', asset: { source: 'local', id, name: file.name } };
  }

  /** 把 IndexedDB 里的资源搬进资源文件夹（静态托管时用来导出） */
  async moveLocalToDir(localId) {
    const record = await getAsset(localId);
    if (!record) return { ok: false, error: '本地资源已丢失' };
    try {
      const res = await fetch(`${DEV_UPLOAD}?name=${encodeURIComponent(record.name ?? 'model.glb')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: record.buffer,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
      await deleteAsset(localId);
      await this.refresh();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  async removeDirFile(name) {
    try {
      const res = await fetch(`${DEV_DELETE}?name=${encodeURIComponent(name)}`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
      await this.refresh();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  async removeLocalAsset(id) {
    await deleteAsset(id);
    await this.refresh();
  }

  /** 读出资源字节（dir 走 fetch，local 走 IndexedDB） */
  async readAsset(asset) {
    if (!asset) throw new Error('缺少资源引用');
    if (asset.source === 'local') {
      const record = await getAsset(asset.id);
      if (!record) throw new Error(`本地资源已丢失：${asset.name}`);
      return record.buffer;
    }
    const res = await fetch(this.resolveUrl(asset.url));
    if (!res.ok) throw new Error(`读取 ${asset.name} 失败（HTTP ${res.status}）`);
    return res.arrayBuffer();
  }

  /** 下载本地资源到磁盘（浏览器下载，用户自己放进 public/models） */
  async downloadLocal(localId) {
    const record = await getAsset(localId);
    if (!record) return false;
    const blob = new Blob([record.buffer], { type: 'model/gltf-binary' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = record.name ?? 'model.glb';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return true;
  }
}
