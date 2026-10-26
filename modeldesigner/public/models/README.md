# 模型资源文件夹

把 `.glb`（或内嵌资源的 `.gltf`）直接放到这个目录，刷新页面即可在左侧「资源库」里看到。

- `npm run dev` 时资源列表是**实时扫描本目录**的，新增/删除文件刷新即可生效
- 通过网页「导入模型」上传的 glb 也会被 dev server **写回本目录**（`POST /__models/upload`）
- 静态托管（`npm run build` 产物）没有写盘能力：部署前需要本目录里有模型，
  构建会自动生成 `index.json` 清单（也可手动 `npm run models:index`）

只接受 `.glb` / `.gltf`，单文件上限 256 MB；文件名请避免 `/ \ : * ? " < > |` 等字符。
`index.json` 由工具生成，不用手改。
