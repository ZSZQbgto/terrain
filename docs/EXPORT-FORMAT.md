# 导出格式说明（工程 JSON v1）

本文档描述**当前实现**（`src/editor/project.js` + `src/editor/editor.js` + `src/water/waterState.js`）
导出的工程文件结构，以及每个字段如何映射到 3D 场景。改字段时请同步更新这里。

## 1. 导出的两种模式

| 模式 | 体积 | 依赖 | 适用 |
| --- | --- | --- | --- |
| **引用模式**（默认） | 小（KB 级） | 目标机器要有 `public/models/` 里的同名 glb | 本机迭代、随仓库提交 |
| **内嵌模式**（导出时确认弹窗点「确定」） | 大（含 base64 glb，可能几十 MB） | 无 | 换机器、交付单个文件 |

两种模式字段相同，内嵌模式多一个 `embeddedAssets`。

## 2. 顶层结构

```json
{
  "version": 1,
  "savedAt": 1730000000000,
  "water": { /* 见第 9 节 */ },
  "models": [ /* 见第 3 节 */ ],
  "embeddedAssets": {
    "models/pump.glb": { "name": "pump.glb", "base64": "Z2xURgIAAAA..." }
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `version` | number | 当前恒为 `1`。导入时不做版本升级变换，未知字段忽略 |
| `savedAt` | number | 导出时刻（`Date.now()`） |
| `water` | object | 水体模拟状态（水源 + 模拟/外观参数），见第 9 节 |
| `models` | array | 场景里的模型实例，顺序无意义（渲染按 `id` 匹配） |
| `embeddedAssets` | object | **仅内嵌模式**。键 = `asset.url`（文件夹资源）或 `asset.id`（本地暂存）；`water` 与它无关 |

> **地形高度编辑不属于本工程文件**（见第 6 节）：它单独保存在浏览器 IndexedDB 的世界状态里，
> 导入 / 导出工程都不会改变地形形状；要持久化或分享地形，请用「地形与导出」导出 16-bit 灰度 PNG。

## 3. 模型实例 `models[]`

```json
{
  "id": "model_m3k2_1_a91xz",
  "name": "泵站",
  "asset": { "source": "dir", "url": "models/pump.glb", "name": "pump.glb" },
  "visible": true,
  "transform": {
    "position": [320.5, 118.42, -480.0],
    "rotation": [0, 37.5, 0],
    "scale": [1.0, 1.0, 1.0]
  },
  "partTransforms": [
    {
      "path": [0, 2],
      "transform": {
        "position": [0, 0.35, 0],
        "rotation": [0, 0, 24],
        "scale": [1, 1, 1]
      }
    }
  ],
  "labels": [ /* 见第 5 节 */ ]
}
```

### 3.1 `asset` —— 资源引用

| `source` | 字段 | 含义 |
| --- | --- | --- |
| `"dir"` | `url`、`name` | 资源文件夹里的文件；`url` 是**相对路径** `models/<文件名>`（换端口/域名仍可用） |
| `"local"` | `id`、`name` | dev server 不可写盘时的退路：glb 存在浏览器 IndexedDB（库 `terrain-modeldesigner`，store `assets`），`id` 是键 |

> 同名 glb 覆盖后，所有引用该 `url` 的实例一起更新（引用的是路径而不是快照）。

### 3.2 `transform` —— 模型根节点变换

作用对象是场景里的 `model.root`（`THREE.Group`），glb 场景作为它的子节点 `model.content`。

| 字段 | 单位 | 说明 |
| --- | --- | --- |
| `position` | 米 | 右手坐标系（Y-up），地形**中心为原点**，X 向东、Z 向南（北 = −Z），范围约 ±`sizeMeters/2` = ±4000 |
| `rotation` | **度** | three.js 欧拉角，默认 `XYZ` 顺序（与 `Object3D.rotation` 一致，仅存三个分量） |
| `scale` | 倍率 | 1 = glb 原始尺寸；「适应尺寸」按钮改的就是它 |

`position.y` 是**贴地后的绝对世界高度**，与地形高程的换算关系：

```
normalized = heightField.sampleWorld(x, z)        // 0..1，双三次采样 DEM
worldY     = normalized × reliefMeters × exaggeration
```

默认 `reliefMeters = 255`（`terrain.json` 的 310 − 55），`exaggeration = 1.8`（垂直夸张）。
即：模型底座落在地表时 `position.y ≈ 地表世界高度`（贴地按包围盒最低点计算，见第 6 节）。

### 3.3 `partTransforms` —— 部件级局部变换

只记录被手动改过的部件（拖动 gizmo 或改数值时写入），没改过的部件不占空间。

| 字段 | 说明 |
| --- | --- |
| `path` | 从 `gltf.scene`（即 `model.content`）出发的 **child 索引路径**，如 `[0, 2]` = `scene.children[0].children[2]` |
| `transform` | 与 3.2 同构，但这里是该节点的**局部**变换（父节点坐标系），`rotation` 同样是度 |

用索引路径而不是节点名：glb 里同名节点很常见（多个 `Node_Mesh`），索引在同一个 glb 内稳定。

### 3.4 `partNames` —— 部件改名

```json
[{ "path": [0, 2], "name": "转臂" }]
```

只记录被改过名的部件；`path` 规则同 3.3。导入时会把名字写回对应节点，
所以部件栏里显示的一直是你起的名字（glb 原始名只在没改过时显示）。

## 4. 标签 `labels[]`

标签只承载三件事：**名称**、**类型**、**挂在哪**（整个模型 / 某个部件）。
没有备注、没有运动参数、没有任何其他用途的字段。

```json
{
  "id": "label_m3k2_7_qz1",
  "kind": "dynamic",
  "title": "闸门",
  "nodePath": [0, 2]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `kind` | `"static"` \| `"dynamic"` \| `"unset"` | 新建时默认 `static`（静态标注）；可切到 `dynamic`（动态结构）；`unset` 仅为兼容手写/旧数据保留（灰色胶囊） |
| `title` | string | 标签名称，也是场景里 CSS2D 小胶囊上显示的文字 |
| `nodePath` | `number[]` \| `null` | `null` = 挂在**整个模型**上；数组 = 挂在某个部件（索引路径同 3.3） |

创建时只填名称，`kind` 默认就是 `static`，随后可在标签卡上改成 `dynamic`，双向可切。

> 历史工程里的 `note` / `motion` 等字段在导入时会被丢弃（`normalizeLabel` 只保留上面三个字段）。

渲染上只体现为标签颜色区分：动态＝青色、静态＝琥珀色、未分类＝灰色。

## 5. 与 3D 实现的对应关系

```
THREE.Scene
├── terrain.group       地形分块 LOD（自定义 ShaderMaterial，含日间薄雾/边界雾）
├── sky                 天空球
├── water.group         水体模拟：覆盖全域的水面网格（水源标记仅水体编辑模式显示，不进工程）
└── model.root          ← transform（第 3.2 节）作用于这里
    └── model.content   ← gltf.scene 克隆；partTransforms / labels.nodePath 相对它定位
        ├── children[0] …       ← path[0]
        │    └── children[2] …  ← path[1]
        └── …
```

- **选中与拾取**：射线检测打到最内层 mesh，再向上回溯到 `model.root` 得到实例；同时用
  `pathOfPart()` 反推索引路径，供部件编辑/标签使用
- **复制模型**：`SkeletonUtils.clone(model.content)`（骨骼模型也能正确复制），
  几何/材质共享以省显存；`labels` 重新生成 id，`partTransforms` 按路径重新应用
- **贴地** `snapToGround()`：取 `Box3.setFromObject(content)` 的**世界**最低点，
  平移 `root.position.y` 使 `box.min.y` 落在地表高度
- **雾/光照**：模型用 three 标准 PBR 材质，`scene.fog = FogExp2(uFogColor, uFogDensity)`，
  颜色与密度取自地形的 `createEnvUniforms()`，因此远处模型与地形同色淡化
- **水体渲染**：`FluidWater`（`src/water/fluidWater.js`）读取同一份 `heightField.texture` 做
  GPU 浅水模拟；水面网格按模拟水位位移，雾 / 天空 / 太阳 uniform 与地形共用。工程里只存
  水源与参数，**不存当前水位**
- **地形高度编辑**：地形顶点着色器直接采样 `heightField.texture`（R16F 高度图），笔刷修改后
  下一帧几何即更新（AO / 梯度查询纹理延迟重建）。地形编辑器独立于模型工程，见第 6 节
- **标签渲染**：每个标签一个 `CSS2DObject`，挂在目标节点（或 `content` 根）上，
  由 `CSS2DRenderer` 叠加在 canvas 之上

## 6. 持久化（自动保存）

| 存储 | 内容 | 键 |
| --- | --- | --- |
| `localStorage` | 引用模式工程 JSON（不含 glb；含 `water`） | `modeldesigner.project.v1` |
| `localStorage` | 视图设置（贴图 / 碰撞 / 水体开关 / 标签显示 / 薄雾强度 / 垂直夸张 / 分层数 / 等高线 / 近景高清块数 / 界面模式，不属于工程） | `modeldesigner.settings.v1` |
| IndexedDB | glb 字节（`source: "local"` 的资源） | 库 `terrain-modeldesigner` / store `assets`、`meta` |
| IndexedDB | 地形高度编辑后的归一化高度场（**世界状态，不属于本工程**） | 库 `terrain-modeldesigner` / store `world` / 键 `terrain-edit-v1` |

全局贴图开关（地形卫星瓦片 / 模型自带 `map`）属于视图状态，不写进工程 JSON，
所以换一份工程时不会被它影响；它只影响渲染，不改变任何 transform 或标签数据。

任何编辑（变换、改名、增删模型/标签、增删水源、调水体参数）都会在 400 ms 后自动保存；刷新页面时：
读 `localStorage` → 逐个按 `asset` 取字节 → `GLTFLoader.parseAsync` → 先应用 `partTransforms`
再应用 `transform`，最后把 `water` 交给 `FluidWater.load()`（按保存的水源与参数重新开始模拟）。
资源取不到的模型会被跳过，并在界面提示「N 个资源缺失」。

地形高度编辑另走一套：一次笔画结束后约 900 ms 写入 `world` store，刷新页面时在构建 GPU
查询纹理之前恢复，所以地形与光照都是编辑后的状态；它**不写入** `modeldesigner.project.v1`，
因此导入 / 清空工程都不会改变地形。要在机器之间保留地形形状，用「地形与导出 →
导出灰度图（16-bit PNG）」生成与 `resourses/heightmap64.png` 同格式的文件，放回源图目录后
重新 `npm run assets` 即可重建 `height.f16` 与卫星瓦片。

## 7. 导入工程的容错

`normalizeProject()` 会：丢弃缺少 `asset` 的条目、补齐缺失的 `transform`/`labels` 成分、
把缺失/非法的 `kind` 归到默认的 `static`、把非数组 `nodePath` 归到 `null`、
丢弃标签上的非标准字段（如旧的 `note` / `motion`）、为缺失 id 生成新 id。
`water` 由 `normalizeWaterState()` 归一化：缺失字段补默认、非法坐标的水源丢弃、
`targetLevel` / `amount` 非法值归 `null`、数值夹到合法范围。
因此手写或旧版本 JSON 一般也能导入。

## 8. 尚未包含（避免误用）

- **不导出 glb**：编辑结果（缩放/旋转/部件微调）只存在于工程 JSON，没有把变换烘回模型文件
- **不导出图片/缩略图**：工程 JSON 不含截图 / 缩略图；地形编辑的 DEM 灰度 PNG 是独立导出，不属于工程
- **不保存当前水位/流量**：`water` 只存水源与模拟参数，导入后从干地重新模拟
- **不包含地形高度编辑**：DEM 笔刷结果只存在浏览器 IndexedDB（世界状态），不在工程 JSON 里；
  分享地形形状要导出 16-bit 灰度 PNG 并用资产管线重建（不是 glTF / OBJ 网格）
- **标签不驱动任何逻辑**：它只是名称 + 类型 + 挂载点，不做动画、条件或业务联动
- **`.gltf`（文本）** 若引用外部 `.bin` / 贴图，单独导入会缺资源；请优先用单文件 `.glb`

## 9. 水体 `water`

水体由 GPU 浅水模拟生成（`src/water/fluidWater.js`），没有可圈定的水面对象；
`water` 的形状与运行时 `FluidWater.state`、`waterState.js` 的归一化结果完全一致：

```json
{
  "enabled": true,
  "sim": { "speed": 1, "waterAmount": 15, "resolution": 768, "paused": false },
  "visual": { "shimmer": 1, "ripple": 1, "clarity": 0.62 },
  "sources": [
    {
      "id": "wsrc_m4x2k_1_ab3cd",
      "name": "水源 1",
      "x": -820.4,
      "z": 640.2,
      "radius": 150,
      "targetLevel": 86.4,
      "amount": null,
      "enabled": true
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `enabled` | 水体总开关（工具栏「水面：开 / 关」，同时也写视图设置）。关闭后不渲染水面、也不推进模拟 |
| `sim.speed` | 模拟速度倍率 0.1–4，默认 1（1× = 60 Hz 下每帧 1 个子步；单帧最多 4 步） |
| `sim.waterAmount` | 每次注水量（米），1–300，默认 15；单个水源可用 `sources[].amount` 覆盖 |
| `sim.resolution` | 模拟分辨率 256 / 512 / 768 / 1024，默认 768；非这四档的值归到最接近的一档 |
| `sim.paused` | 是否暂停模拟，默认 `false`（暂停时仍显示当前水面） |
| `visual.shimmer` | 太阳高光强度 0–3，默认 1 |
| `visual.ripple` | 波纹强度 0–2，默认 1 |
| `visual.clarity` | 水体清澈度 0–1，默认 0.62（0 浑浊、1 通透） |
| `sources` | 水源数组，最多 8 个；缺省为空数组（没有水源时模拟保持干地） |
| `sources[].id` | 水源 id（`wsrc_…`）；缺失时自动生成 |
| `sources[].name` | 名称，默认「水源 N」；也显示在场景的 CSS2D 名称里 |
| `sources[].x` / `.z` | 世界坐标（米，地形中心为原点）。坐标非数字的水源在导入时被丢弃 |
| `sources[].radius` | 注水半径（米），默认 150。数据层接受 20–3000（面板滑块 20–2000） |
| `sources[].targetLevel` | 目标水面**绝对高程**（米）；`null` = 不限制。面板上 0 或留空会写成 `null` |
| `sources[].amount` | 该水源每次注水的水深（米，0.5–300）；`null` = 跟随 `sim.waterAmount` |
| `sources[].enabled` | 是否启用，默认 `true`；停用的水源不注水、也不参与全局水位上限 |

### 9.1 运行时推导：全局水位上限

`uTargetCap` 不写进 JSON，而是每次状态变化时由 `sources` 推导：

- 取所有**启用**且 `targetLevel != null` 的水源的**最高** `targetLevel`
- 只要有任一启用水源 `targetLevel == null`（不限制），就没有上限
- 水面超过上限的水被排掉（相当于溢洪道），避免多水源把整张地图无限灌高

### 9.2 坐标与恢复行为

- 数据里一律用「米」/ 世界坐标，与模型一致；渲染时换算世界高度：
  `worldY = (meters − elevation.minMeters) × 垂直夸张`
- 恢复工程时 `FluidWater.load()` 会复位模拟：**不保存当前水位**，
  而是按保存的水源与参数从干地重新注水；`resolution` 变化会重建全部模拟缓冲
- 导入旧工程（没有 `water` 字段）按默认水体处理（`enabled: true`、无水源）；
  旧的 `areas` / `flows` 字段直接丢弃，不迁移
