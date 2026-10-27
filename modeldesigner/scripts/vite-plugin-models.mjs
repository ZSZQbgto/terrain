/**
 * Vite 插件：模型资源文件夹（public/models）的 dev 接口 + 构建期静态清单。
 *
 * dev：
 *   GET  /__models/list             目录扫描结果（前端资源列表用它，始终反映真实目录）
 *   POST /__models/upload?name=x.glb 把网页导入的 glb 落盘到 public/models
 *   POST /__models/delete?name=x.glb 删除目录里的模型
 * build：
 *   生成 public/models/index.json，供静态托管时列资源
 *
 * 只接受 .glb/.gltf，文件名经 models-lib 消毒，杜绝目录穿越。
 */
import { listModels, saveModel, removeModel, writeModelIndex } from './models-lib.mjs';

const PREFIX = '/__models';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 300 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default function modelLibraryPlugin() {
  return {
    name: 'model-library',

    configureServer(server) {
      server.middlewares.use(PREFIX, async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const route = url.pathname; // '/list' | '/upload' | '/delete'

        try {
          if (route === '/list' && req.method === 'GET') {
            sendJson(res, 200, { ok: true, files: await listModels() });
            return;
          }

          if (route === '/upload' && req.method === 'POST') {
            const name = url.searchParams.get('name') ?? '';
            const buffer = await readBody(req);
            const saved = await saveModel(name, buffer);
            server.config.logger.info(`[models] 已写入 public/models/${saved.name} (${(saved.size / 1048576).toFixed(2)} MiB)`);
            sendJson(res, 200, { ok: true, file: saved, files: await listModels() });
            return;
          }

          if (route === '/delete' && req.method === 'POST') {
            const name = url.searchParams.get('name') ?? '';
            await removeModel(name);
            sendJson(res, 200, { ok: true, files: await listModels() });
            return;
          }

          sendJson(res, 404, { ok: false, error: `未知接口 ${req.method} ${route}` });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: err?.message ?? String(err) });
        }
      });
    },

    async buildStart() {
      // 写索引失败（Windows 文件锁 / 只读磁盘）不应该让 dev 或构建整体失败：
      // 资源列表在运行时会退回扫描 public/models。
      try {
        const payload = await writeModelIndex();
        this.info?.(`[models] 生成 public/models/index.json（${payload.files.length} 个模型）`);
      } catch (err) {
        this.warn?.(`[models] 写 index.json 失败，已跳过：${err?.message ?? err}`);
      }
    },
  };
}
