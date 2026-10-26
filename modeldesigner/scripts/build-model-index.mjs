// 生成 public/models/index.json：静态托管时前端靠它列出资源文件夹里的模型。
// 用法：npm run models:index（dev server 启动 / npm run build 时也会自动重建）
import { writeModelIndex, MODELS_DIR } from './models-lib.mjs';

const payload = await writeModelIndex();
console.log(`[models] ${MODELS_DIR}`);
console.log(`[models] 写入 index.json：${payload.files.length} 个模型`);
for (const f of payload.files) console.log(`  · ${f.name}  ${(f.size / 1048576).toFixed(2)} MiB`);
