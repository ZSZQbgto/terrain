/**
 * 生成一个示例模型 public/models/sample-tower.glb
 *
 * 结构刻意做成「三个独立部件」，方便演示部件级编辑与标签：
 *   Base  底座（扁平方块）
 *   Tower 塔身
 *   Arm   转臂（适合标成「动态结构」）
 *
 * 手写最小 GLB：12 字节头 + JSON chunk + BIN chunk，单位立方体共用一份几何，
 * 通过 node 的 scale/translation 拼出三个部件。
 *
 * 用法：npm run models:sample
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT_DIR = path.resolve(import.meta.dirname, '..', 'public', 'models');
const OUT_FILE = path.join(OUT_DIR, 'sample-tower.glb');

// ── 单位立方体（24 顶点 / 36 索引，逐面法线）───────────────────────────────
const FACES = [
  { n: [0, 0, 1], v: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
  { n: [0, 0, -1], v: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] },
  { n: [1, 0, 0], v: [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]] },
  { n: [-1, 0, 0], v: [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]] },
  { n: [0, 1, 0], v: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
  { n: [0, -1, 0], v: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
];

const positions = [];
const normals = [];
const indices = [];
for (const face of FACES) {
  const base = positions.length / 3;
  for (const v of face.v) {
    positions.push(...v);
    normals.push(...face.n);
  }
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

const posF32 = new Float32Array(positions);
const nrmF32 = new Float32Array(normals);
const idxU16 = new Uint16Array(indices);

const posBytes = Buffer.from(posF32.buffer);
const nrmBytes = Buffer.from(nrmF32.buffer);
const idxBytes = Buffer.from(idxU16.buffer);
const padded = (n) => (n + 3) & ~3;

const bin = Buffer.concat([posBytes, nrmBytes, idxBytes]);
const binPadded = Buffer.concat([bin, Buffer.alloc(padded(bin.length) - bin.length)]);

const gltf = {
  asset: { version: '2.0', generator: 'modeldesigner/make-sample-glb' },
  scene: 0,
  scenes: [{ name: 'SampleTower', nodes: [0, 1, 2] }],
  nodes: [
    { name: 'Base', mesh: 0, translation: [0, 0.4, 0], scale: [7, 0.8, 7] },
    { name: 'Tower', mesh: 0, translation: [0, 2.6, 0], scale: [1.8, 3.6, 1.8] },
    { name: 'Arm', mesh: 0, translation: [1.7, 4.7, 0], scale: [4.6, 0.5, 0.5] },
  ],
  meshes: [
    {
      name: 'Cube',
      primitives: [
        {
          attributes: { POSITION: 0, NORMAL: 1 },
          indices: 2,
          material: 0,
        },
      ],
    },
  ],
  materials: [
    {
      name: 'Concrete',
      pbrMetallicRoughness: {
        baseColorFactor: [0.72, 0.74, 0.76, 1],
        metallicFactor: 0.05,
        roughnessFactor: 0.85,
      },
    },
    {
      name: 'Steel',
      pbrMetallicRoughness: {
        baseColorFactor: [0.42, 0.55, 0.62, 1],
        metallicFactor: 0.6,
        roughnessFactor: 0.45,
      },
    },
  ],
  buffers: [{ byteLength: binPadded.length }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 },
    { buffer: 0, byteOffset: posBytes.length, byteLength: nrmBytes.length, target: 34962 },
    { buffer: 0, byteOffset: posBytes.length + nrmBytes.length, byteLength: idxBytes.length, target: 34963 },
  ],
  accessors: [
    {
      bufferView: 0,
      componentType: 5126,
      count: posF32.length / 3,
      type: 'VEC3',
      min: [-0.5, -0.5, -0.5],
      max: [0.5, 0.5, 0.5],
    },
    {
      bufferView: 1,
      componentType: 5126,
      count: nrmF32.length / 3,
      type: 'VEC3',
    },
    {
      bufferView: 2,
      componentType: 5123,
      count: idxU16.length,
      type: 'SCALAR',
    },
  ],
};

// 第二个 mesh（给 Arm 用钢材质，顺便让部件类型更丰富）
gltf.meshes.push({
  name: 'SteelCube',
  primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 1 }],
});
gltf.nodes[2].mesh = 1;

// ── 打包 GLB ────────────────────────────────────────────────────────────────
const jsonText = JSON.stringify(gltf);
const jsonBuf = Buffer.from(jsonText, 'utf8');
const jsonPadded = Buffer.concat([jsonBuf, Buffer.alloc(padded(jsonBuf.length) - jsonBuf.length, 0x20)]);

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); // 'glTF'
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8);

const jsonChunkHeader = Buffer.alloc(8);
jsonChunkHeader.writeUInt32LE(jsonPadded.length, 0);
jsonChunkHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'

const binChunkHeader = Buffer.alloc(8);
binChunkHeader.writeUInt32LE(binPadded.length, 0);
binChunkHeader.writeUInt32LE(0x004e4942, 4); // 'BIN'

const glb = Buffer.concat([header, jsonChunkHeader, jsonPadded, binChunkHeader, binPadded]);

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT_FILE, glb);
console.log(`[sample] 写入 ${OUT_FILE}（${(glb.length / 1024).toFixed(1)} KB）`);
console.log('[sample] 部件：Base / Tower / Arm —— 可把 Arm 标成「动态结构」试试');
