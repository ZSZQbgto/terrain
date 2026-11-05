# AGENTS.md — 给编码代理的项目说明

## 项目概览

8 km DEM 三维地形沙盘（Three.js + Vite，**单一前端，仓库根目录**）：地形渲染 + glb 模型编辑 +
标签 + GPU 浅水模拟 + **地形编辑（DEM 笔刷 / 16-bit 灰度导出）** + 游览 + 工程导入导出。
开发用 `http://127.0.0.1:5173`，构建产物 `dist/` 直接部署到 GitHub Pages 站点根。
**不要**重新引入独立子项目或 `/modeldesigner/` 子路径部署。

## 开工前必做：地形瓦片自检

`public/data/` 与 `dist/data/` 是派生产物（`.gitignore` 忽略），干净检出时不存在。
每次进入项目、运行 dev/build 前先确认瓦片齐全：

```powershell
Test-Path public/data/height.f16          # 必须 True
Test-Path public/data/terrain.json        # 必须 True
(Get-ChildItem public/data/sat -Filter *.jpg -ErrorAction SilentlyContinue).Count   # 期望 192
```

- 缺失时执行 **`npm run assets`**（完整管线：高度场 + 卫星瓦片）。**不要**擅自改用
  `npm run assets -- --height-only`（会让站点缺卫星影像），除非用户明确要求只做高度场。
- 也可以直接跑 `npm run assets:check`（= `node scripts/ensure-assets.mjs`）：自检并在缺失时自动跑管线。
- 源图已跟踪在 `resourses/`：`heightmap64.png`（必需）与 `尚庄炉水库卫星影像64.png`（卫星瓦片）。
  不要删除/移动；管线在 `resourses/` 与仓库根目录两处查找。
- `npm run dev` / `npm run build` 也会通过 `scripts/vite-plugin-terrain-assets.mjs` 自动检测并补齐，
  失败只告警不中断；卫星瓦片生成本机约 20 秒（更慢机器可能数分钟），先自检可避免误判"卡住"。

## 构建后检查

- `npm run build` 的 `postbuild` 会自动执行 `node scripts/ensure-assets.mjs --dist` 补齐 `dist/data`。
- 构建后确认：`dist/index.html`、`dist/data/height.f16`、`dist/data/terrain.json`、
  192 张 `dist/data/sat/*.jpg`、`dist/models/index.json`。
- 缺瓦片时手动修复：`node scripts/ensure-assets.mjs --dist`。

## 验证命令

```bash
node tests/height-png.test.mjs   # 16-bit 灰度 PNG 往返（改 heightPng.js 后必跑）
node tests/verify-merged.mjs     # 端到端（含地形编辑 H 段）
```

端到端验证（headless Chrome + CDP，无第三方依赖）：自动起 dev server（固定 **127.0.0.1:5199**），
检查 HTTP 内容类型、页面启动无控制台错误、编辑器 UI / 图形选项 / 模式切换 / 游览、
地形编辑（笔刷 / 实时高度 / 撤销 / 导出灰度 PNG / 刷新持久化）、资产守卫与 `dist` 产物完整性；
截图与 PASS/FAIL 输出到 `tests/out/`，失败以非零退出码结束。可设 `VERIFY_SKIP_TERRAIN=1` 跳过地形段。
使用 5199（必要时 5198）；**只结束自己启动的进程**，绝不按名字杀 node，也不要动 DSH 的
Web 服务器（`127.0.0.1:53831`）。

## 仓库约定

- **单前端**：`index.html`、`vite.config.js`、`package.json` 都在根目录；`src/{editor,water,terrain,viewer}`。
- **地形资产**：`scripts/prepare-assets.mjs` 生成 `public/data`；`scripts/ensure-assets.mjs` +
  `scripts/vite-plugin-terrain-assets.mjs` 负责检测/补齐；`public/data/` 与 `dist/` 不入库。
- **模型资源**：`public/models/` 是资源文件夹（glb 放这里）；`scripts/models-lib.mjs`、
  `scripts/vite-plugin-models.mjs`（dev 的 `/__models/*` + 构建期 `index.json`）、
  `scripts/build-model-index.mjs`、`scripts/make-sample-glb.mjs`。
- **UI**：顶栏固定为 项目管理 / 模型编辑 / 水体编辑 / 地形编辑 / 图形选项 / 游览；显示类控件
  （贴图、碰撞、水面、标签显示、薄雾强度、垂直夸张、分层数、等高线、近景高清块数、GPU 名）
  放在「图形选项」，由 `src/editor/ui.js` + `src/main.js` 接线。相机手势以 `src/viewer/controls.js` 为唯一来源（左键平移 / 中键旋转 / 右键旋转+缩放 / 滚轮朝光标缩放 / WASD 平移 + Q/E 升降、Shift 加速 3.2× / Ctrl 缓动 0.25×；修饰键不改变鼠标语义）。
- **地形编辑**：`src/editor/terrainEditor.js`、`src/editor/brushIndicator.js`（落点指示圈）、`src/terrain/heightPng.js`、`src/terrain/heightfield.js`
  （编辑态 / 原始 half / sourceRange）；结果**不进工程 JSON**，保存/分享：导出灰度 PNG → 重命名 `heightmap64.png` 放回 `resourses/` → `npm run assets`。
- **文档**：改工程 JSON 字段/单位/坐标约定时同步更新 `docs/EXPORT-FORMAT.md`；
  改命令、路径、行为时同步更新 `README.md`。
- 文本统一 **UTF-8**（含中文），不要引入 GBK 编码。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm install` | 安装依赖（three / vite / sharp） |
| `npm run dev` | dev server `127.0.0.1:5173`（启动前自动资产守卫） |
| `npm run build` | 生产构建到 `dist/`（postbuild 自动补 `dist/data`） |
| `npm run preview` | 预览构建产物（没有模型写入接口） |
| `npm run assets` | 完整资产管线（高度场 + 192 张卫星瓦片） |
| `npm run assets -- --height-only` | 只生成高度场（仅用户明确要求时） |
| `npm run assets:check` | 资产自检 / 缺失即自动补齐 |
| `node scripts/ensure-assets.mjs --dist` | 修复构建产物的 `dist/data` |
| `node tests/height-png.test.mjs` | 16-bit 灰度 PNG 编码 / 解码单元测试 |
| `node tests/verify-merged.mjs` | 端到端验证（端口 5199） |
