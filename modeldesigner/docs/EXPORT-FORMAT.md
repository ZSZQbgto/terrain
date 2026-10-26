# 导出格式说明（工程 JSON v1）

本文档描述**当前实现**（`src/editor/project.js` + `src/editor/editor.js`）导出的工程文件结构，
以及每个字段如何映射到 3D 场景。改字段时请同步更新这里。

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
| `models` | array | 场景里的模型实例，顺序无意义（渲染按 `id` 匹配） |
| `embeddedAssets` | object | **仅内嵌模式**。键 = `asset.url`（文件夹资源）或 `asset.id`（本地暂存） |

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
├── sky / water         天空球、水面
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
- **标签渲染**：每个标签一个 `CSS2DObject`，挂在目标节点（或 `content` 根）上，
  由 `CSS2DRenderer` 叠加在 canvas 之上

## 6. 持久化（自动保存）

| 存储 | 内容 | 键 |
| --- | --- | --- |
| `localStorage` | 引用模式工程 JSON（不含 glb） | `modeldesigner.project.v1` |
| `localStorage` | 视图设置（贴图 / 碰撞 / 水面 / 标签显示 / 薄雾强度 / 界面模式，不属于工程） | `modeldesigner.settings.v1` |
| IndexedDB | glb 字节（`source: "local"` 的资源） | 库 `terrain-modeldesigner` / store `assets`、`meta` |

全局贴图开关（地形卫星瓦片 / 模型自带 `map`）属于视图状态，不写进工程 JSON，
所以换一份工程时不会被它影响；它只影响渲染，不改变任何 transform 或标签数据。

任何编辑（变换、改名、增删模型/标签）都会在 400 ms 后自动保存；刷新页面时：
读 `localStorage` → 逐个按 `asset` 取字节 → `GLTFLoader.parseAsync` → 先应用 `partTransforms`
再应用 `transform`。资源取不到的模型会被跳过，并在界面提示「N 个资源缺失」。

## 7. 导入工程的容错

`normalizeProject()` 会：丢弃缺少 `asset` 的条目、补齐缺失的 `transform`/`labels` 成分、
把缺失/非法的 `kind` 归到默认的 `static`、把非数组 `nodePath` 归到 `null`、
丢弃标签上的非标准字段（如旧的 `note` / `motion`）、为缺失 id 生成新 id。
因此手写或旧版本 JSON 一般也能导入。

## 8. 尚未包含（避免误用）

- **不导出 glb**：编辑结果（缩放/旋转/部件微调）只存在于工程 JSON，没有把变换烘回模型文件
- **不导出图片/缩略图**
- **标签不驱动任何逻辑**：它只是名称 + 类型 + 挂载点，不做动画、条件或业务联动
- **`.gltf`（文本）** 若引用外部 `.bin` / 贴图，单独导入会缺资源；请优先用单文件 `.glb`

## 9. 水面 `water`

水面没有"统一大平面"，只有圈定区域与流动水：

```json
{
  "enabled": true,
  "level": 69,
  "areas": [
    {
      "id": "area_xxx",
      "name": "水面区域 1",
      "level": 86.38,
      "points": [[-800, -620], [620, -520], [840, 180], [320, 780], [-720, 660]],
      "labels": [{ "id": "wlabel_xxx", "title": "库区水面" }]
    }
  ],
  "flows": [
    {
      "id": "flow_xxx",
      "name": "流动水 1",
      "speed": 1.6,
      "width": 26,
      "points": [
        { "x": -300, "y": 120.5, "z": -1600, "width": 70, "dir": 0 },
        { "x": -260, "y": 118.2, "z": -1200, "width": null, "dir": null },
        { "x": -190, "y": 112.0, "z": -900, "width": 4, "dir": 15 }
      ],
      "labels": []
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `enabled` | 水面总开关（工具栏按钮，同时也写视图设置） |
| `level` | **新建区域**的默认水面高程（米），默认 69 |
| `areas[].points` | 世界 **x/z**（米），只存平面坐标；≥3 点 |
| `areas[].level` | 该区域水平面高程（米）—— 绘制时取各选点地表高程的平均值，之后可手动微调 |
| `flows[].points` | 关键点数组，≥2 点，用 Catmull-Rom 平滑成曲线。每点 `{ x, y, z, width, dir }`（也兼容旧的 `[x, y, z]`）：`width` 为该点水带宽度（`null` = 跟随 `flows[].width`），`dir` 为该点横向朝向角度（`null` = 自动，按「切线 × 表面法线」） |
| `flows[].points[].width / dir` | 逐点宽度（米）/ 横向朝向（度）；生成几何时沿曲线在相邻关键点之间线性插值 |
| 水带贴合 | 采样点先投射到模型几何（raycast），未命中再用地形 CPU 高度；因此水贴图覆盖在物体贴图之上 |
| `flows[].speed` | 水贴图沿路径滚动的速度倍率（`update` 里驱动 `uSpeed`） |
| `flows[].width` | 水带宽度（米） |
| `areas[].labels` / `flows[].labels` | **水体标签**：只有 `title`，不进场景 CSS2D，与物体标签分离 |

高程换算与模型一致：`worldY = (meters − elevation.minMeters) × 垂直夸张`。

> 导入旧工程（没有 `water` 字段）时按空水面处理；非法点（数量不足/坐标非数字）会被丢弃。
