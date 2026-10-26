/**
 * 地形着色器。
 *
 * 核心思想：位移与法线都由“高度场 + 梯度矢量”解析得到，纹理只承担查询，
 * 因此 8bit 量化台阶、最近邻采样、低面数平面着色这三种“像素方块感”来源都被消掉：
 *   - 顶点高度：CPU 端 Catmull-Rom 双三次采样 DEM → 不存在三角插值的折痕
 *   - 片元法线：纹理双三次采样梯度后 normalize(-gx*k, 1, -gz*k) → 与位移严格一致
 *   - 分层/等高线：对连续高度做 fract + fwidth 抗锯齿 → 任何距离都不会闪成麻点
 *
 * uTerrain 打包：R=高度 G=AO B=∂h/∂x A=∂h/∂z（见 heightfield.js）
 */

/** Catmull-Rom 权重（样本位置 -1,0,1,2） */
const CRC = /* glsl */ `
vec4 crWeights(float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return vec4(
    -0.5 * t3 + t2 - 0.5 * t,
     1.5 * t3 - 2.5 * t2 + 1.0,
    -1.5 * t3 + 2.0 * t2 + 0.5 * t,
     0.5 * t3 - 0.5 * t2
  );
}
`;

/** 双三次纹理采样（4x4 = 16 tap），消掉双线性插值的菱形折痕 */
const BICUBIC = /* glsl */ `
vec4 texBicubic(sampler2D tex, vec2 uv, vec2 texSize) {
  vec2 coord = uv * texSize - 0.5;
  vec2 f = fract(coord);
  vec2 base = floor(coord) - 0.5;
  vec4 wx = crWeights(f.x);
  vec4 wy = crWeights(f.y);
  vec2 t = 1.0 / texSize;
  vec2 uv00 = (base + vec2(0.0, 0.0)) * t;
  vec2 uv10 = uv00 + vec2(t.x, 0.0);
  vec2 uv20 = uv00 + vec2(t.x * 2.0, 0.0);
  vec2 uv30 = uv00 + vec2(t.x * 3.0, 0.0);

  vec4 r0 = texture2D(tex, uv00) * wx.x + texture2D(tex, uv10) * wx.y
          + texture2D(tex, uv20) * wx.z + texture2D(tex, uv30) * wx.w;
  vec2 uv01 = uv00 + vec2(0.0, t.y);
  vec4 r1 = texture2D(tex, uv01) * wx.x + texture2D(tex, uv01 + vec2(t.x, 0.0)) * wx.y
          + texture2D(tex, uv01 + vec2(t.x * 2.0, 0.0)) * wx.z
          + texture2D(tex, uv01 + vec2(t.x * 3.0, 0.0)) * wx.w;
  vec2 uv02 = uv00 + vec2(0.0, t.y * 2.0);
  vec4 r2 = texture2D(tex, uv02) * wx.x + texture2D(tex, uv02 + vec2(t.x, 0.0)) * wx.y
          + texture2D(tex, uv02 + vec2(t.x * 2.0, 0.0)) * wx.z
          + texture2D(tex, uv02 + vec2(t.x * 3.0, 0.0)) * wx.w;
  vec2 uv03 = uv00 + vec2(0.0, t.y * 3.0);
  vec4 r3 = texture2D(tex, uv03) * wx.x + texture2D(tex, uv03 + vec2(t.x, 0.0)) * wx.y
          + texture2D(tex, uv03 + vec2(t.x * 2.0, 0.0)) * wx.z
          + texture2D(tex, uv03 + vec2(t.x * 3.0, 0.0)) * wx.w;

  return r0 * wy.x + r1 * wy.y + r2 * wy.z + r3 * wy.w;
}
`;

/**
 * 顶点阶段：地形高度全部在 GPU 上从查询纹理解析 ——
 * position.y 只携带裙边偏移（主网格 0，裙边 -SKIRT），几何本身不含高程数据。
 *
 * uVertexDetail 由每块在绘制前写入：
 *   1 = 双三次采样（近处高精度块，位移平滑无折痕）
 *   0 = 硬件双线性（远处低精度块，只采 1 次，省掉 15 次纹理取样）
 * 远景块每个格子在屏幕上只有几像素，双线性的折痕看不出来，成本却差一个数量级。
 */
export const terrainVertex = /* glsl */ `
${CRC}
${BICUBIC}
uniform sampler2D uTerrain;
uniform vec2 uTerrainTexel;
uniform float uReliefMeters;
uniform float uExaggeration;
uniform float uVertexDetail;

varying vec2 vUv;
varying vec3 vWorld;
varying float vScaledHeight;
varying float vViewDist;

void main() {
  vUv = uv;
  vec4 t;
  if (uVertexDetail > 0.5) {
    t = texBicubic(uTerrain, uv, 1.0 / uTerrainTexel);
  } else {
    t = texture2D(uTerrain, uv);
  }
  float y = (t.r * uReliefMeters + position.y) * uExaggeration;
  vec3 p = vec3(position.x, y, position.z);
  vScaledHeight = y;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vViewDist = length(wp.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const COMMON = /* glsl */ `
vec3 linearToSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

// 高频细节法线：打散 DEM 规则网格在近景处的“方格纹理感”，只在近处生效
float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.53);
  return fract(p.x * p.y);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// ── 日间薄雾 ────────────────────────────────────────────────────────────────
// 距离雾（指数平方）再叠一层“近地面浓、高处通”的高度衰减：河谷与水面更朦胧，
// 山脊轮廓仍清楚 —— 这是真实日间薄雾与“一层均匀灰膜”的区别所在。
float hazeFactor(float viewDist, float worldY, float density, float heightScale) {
  float d = density * viewDist;
  float dist = 1.0 - exp(-d * d);
  float lowLevel = exp(-max(worldY, 0.0) / max(heightScale, 1.0));
  return clamp(dist * mix(0.6, 1.0, lowLevel), 0.0, 0.94);
}

// 雾色带方向性：朝太阳方向按 Mie 前向散射提亮偏暖（逆光时雾本身发亮），
// 侧逆光偏暖、顺光保持冷调，比单一雾色更像真实的白天大气。
vec3 hazeTint(vec3 fogColor, vec3 sunColor, vec3 sunDir, vec3 toPoint) {
  float s = max(dot(normalize(toPoint), sunDir), 0.0);
  float s2 = s * s;
  float s4 = s2 * s2;
  float s8 = s4 * s4;
  return mix(fogColor, sunColor, s8 * 0.55);
}

// 到地形边界的最近距离（世界坐标，米）；地形是以原点为中心的方区
float edgeDistance(vec2 xz, float halfSize) {
  return min(min(xz.x + halfSize, halfSize - xz.x), min(xz.y + halfSize, halfSize - xz.y));
}
`;

export function buildTerrainFragment({ satellite = false } = {}) {
  return /* glsl */ `
precision highp float;

${CRC}
${BICUBIC}
${COMMON}

uniform sampler2D uTerrain;
uniform vec2 uTerrainTexel;
uniform sampler2D uPalette;
${satellite ? 'uniform sampler2D uSat;' : ''}

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uHazeHeight;      // 薄雾的高度衰减尺度（米）：越低越浓
uniform float uHalfSize;        // 地形半宽（米），用于边界迷雾
uniform float uEdgeFadeStart;   // 边界迷雾：距边界多远开始完全入雾
uniform float uEdgeFadeEnd;     // 边界迷雾：距边界多远恢复完全清晰

uniform float uExaggeration;
uniform float uBands;
uniform float uQuantize;
uniform float uContour;
uniform float uReliefMeters;
uniform float uMinElevation;
uniform float uDetailNormal;
uniform float uTexelWorld;   // 一个纹素对应的世界尺寸（米）
uniform float uBicubicDistance; // 双三次采样距离阈值（米），由实测决定
uniform float uSatExposure;
${satellite ? 'uniform vec2 uChunkOrigin;\nuniform float uChunkCount;' : ''}

varying vec2 vUv;
varying vec3 vWorld;
varying float vScaledHeight;
varying float vViewDist;

void main() {
  // 近处用双三次采样（消掉双线性折痕），远处退化为双线性，省掉 12 次纹理取样。
  // 阈值由 uniform 控制，方便按设备实测取舍（分支边界落在画面里会造成 warp 发散，
  // 所以不是越近越好，2024 核显上实测 3000 m 左右最划算）。
  vec4 terr;
  if (vViewDist < uBicubicDistance) {
    terr = texBicubic(uTerrain, vUv, 1.0 / uTerrainTexel);
  } else {
    terr = texture2D(uTerrain, vUv);
  }

  float height = clamp(terr.r, 0.0, 1.0);
  float ao = clamp(terr.g, 0.0, 1.0);

  // ── 由梯度矢量解析法线（垂直夸张直接作用于梯度，几何与光照永远一致）────────
  vec2 g = terr.ba;
  // 远处观测时衰减高频坡度，避免法线采样走样成噪声（等效于法线 LOD）
  float slopeLod = smoothstep(2500.0, 12000.0, vViewDist);
  g *= 1.0 - slopeLod * 0.55;

  // 近景细节法线：有机地打散 DEM 网格感（只在近处算，远处省掉两次 value noise）
  if (vViewDist < uBicubicDistance) {
    float detail = uDetailNormal * (1.0 - slopeLod);
    vec2 q = vWorld.xz / (uTexelWorld * 3.0);
    float n1 = valueNoise(q * 6.0);
    float n2 = valueNoise(q * 17.0 + 31.7);
    g += vec2(n1 - 0.5, n2 - 0.5) * detail * 0.35;
  }

  vec3 n = normalize(vec3(-g.x * uExaggeration, 1.0, -g.y * uExaggeration));

  // ── 光照 ────────────────────────────────────────────────────────────────
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 sky = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);
  vec3 lighting = sky * (0.55 + 0.45 * ao) + uSunColor * ndl;

  vec3 albedo;

#if ${satellite ? 1 : 0}
  // 每块绑定自己的一块瓦片纹理：把全局 uv 换算成该块内的 0..1 局部 uv
  vec2 satUv = (vUv - uChunkOrigin) * uChunkCount;
  albedo = texture2D(uSat, satUv).rgb * uSatExposure;
  // 影像自带明暗，因此让地形光照只作弱化叠加，避免二次打光过曝
  lighting = sky * (0.62 + 0.38 * ao) + uSunColor * (0.35 + 0.45 * ndl);
  vec3 color = albedo * lighting;
  // 极陡坡露出岩土色，缓和影像在断崖处的拉伸
  float steep = smoothstep(0.72, 0.96, 1.0 - n.y);
  color = mix(color, vec3(0.28, 0.24, 0.20) * lighting, steep * 0.55);
#else
  // ── 高程分层着色 ─────────────────────────────────────────────────────────
  float s = height * uBands;
  float f = fract(s);
  float odist = min(f, 1.0 - f);           // 到层边界的层内距离

  // 色带取分层中值 → 层内近乎纯色，得到干净的分层地图观感
  float banded = (floor(s) + 0.5) / uBands;
  float shadeHeight = mix(height, banded, uQuantize);
  albedo = texture2D(uPalette, vec2(clamp(shadeHeight, 0.0, 1.0), 0.5)).rgb;

  // 矢量等高线：用屏幕导数换算线宽，任何距离、任何倾角都保持 1px 级稳定
  float aa = fwidth(s) * 1.35;
  float lineWidth = max(aa, 0.035);
  float contour = 1.0 - smoothstep(0.0, lineWidth, odist);
  contour *= uContour * (1.0 - slopeLod * 0.8);
  albedo *= 1.0 - 0.42 * contour;

  // 层内保留一点连续渐变，山脊起伏不至于被色阶吃掉
  float reliefTint = (height - shadeHeight) * 2.2;
  albedo *= 1.0 + reliefTint;

  vec3 color = albedo * lighting;
#endif

  // ── 日间薄雾 + 边界迷雾 ────────────────────────────────────────────────
  // 距离雾叠高度衰减（河谷浓、山脊透），雾色随太阳方向做前向散射提亮；
  // 地形边缘 100→200 m 逐渐化入雾中，避免出现一刀切的方形断崖。
  vec3 toPoint = vWorld - cameraPosition;
  float haze = hazeFactor(vViewDist, vWorld.y, uFogDensity, uHazeHeight);
  color = mix(color, hazeTint(uFogColor, uSunColor, uSunDir, toPoint), haze);

  // 边界再压一层纯环境雾色（与天空地平线同色），地形像是被地面薄雾吞没
  float edgeFade = 1.0 - smoothstep(uEdgeFadeStart, uEdgeFadeEnd, edgeDistance(vWorld.xz, uHalfSize));
  color = mix(color, uFogColor, edgeFade);

  gl_FragColor = vec4(linearToSRGB(color), 1.0);
}
`;
}

export const skyVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w; // 永远在最远处
}
`;

export const skyFragment = /* glsl */ `
precision highp float;
${COMMON}
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uFogColor;
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, 0.0, 1.0);
  // sqrt 近似 pow(up, 0.55)：全屏逐像素，省掉一次 pow
  vec3 col = mix(uHorizon, uZenith, sqrt(up) * (1.25 - 0.25 * up));

  float s = max(dot(d, uSunDir), 0.0);
  float s2 = s * s;
  float s4 = s2 * s2;
  float s8 = s4 * s4;
  col += uSunColor * smoothstep(0.9993, 0.99975, s) * 6.0; // 日面：阈值代替 pow(s,1200)
  col += uSunColor * s8 * (0.10 + 0.10 * s8);              // 近日光晕：s^8 代替 pow(s,14)
  col += uSunColor * s4 * 0.035;                           // 宽域前向散射：日间薄雾的亮底
  // 地平线薄雾带：与地形边界雾同色，边缘淡出后与天空无缝衔接（max 省一次 mix 分支）
  col = mix(col, uFogColor, max(exp(-abs(d.y) * 7.0) * 0.55, smoothstep(0.06, -0.25, d.y)));

  gl_FragColor = vec4(linearToSRGB(col), 1.0);
}
`;

export const waterVertex = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
varying vec2 vUv;
varying float vViewDist;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vViewDist = length(wp.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const waterFragment = /* glsl */ `
precision highp float;
${COMMON}
uniform float uTime;
uniform vec3 uWaterColor;
uniform vec3 uSkyColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uHazeHeight;
uniform float uHalfSize;
uniform float uEdgeFadeStart;
uniform float uEdgeFadeEnd;
uniform float uOpacity;
varying vec3 vWorld;
varying vec2 vUv;
varying float vViewDist;

void main() {
  vec2 p = vWorld.xz;
  // 两组交叉微波纹，纯矢量求导得到扰动法线
  float t = uTime * 0.35;
  float w1 = valueNoise(p * 0.02 + vec2(t, t * 0.7));
  float w2 = valueNoise(p * 0.055 - vec2(t * 0.8, t));
  vec3 n = normalize(vec3((w1 - 0.5) * 0.09 + (w2 - 0.5) * 0.05, 1.0,
                          (w2 - 0.5) * 0.09 + (w1 - 0.5) * 0.05));

  float fres = pow(1.0 - max(dot(n, normalize(cameraPosition - vWorld)), 0.0), 4.0);
  vec3 col = mix(uWaterColor, uSkyColor, clamp(fres * 0.85, 0.0, 0.7));
  float spec = pow(max(dot(reflect(-uSunDir, n), normalize(cameraPosition - vWorld)), 0.0), 180.0);
  col += uSunColor * spec * 1.6;

  // 与地形同一套日间薄雾：水面比山脊更朦胧，边界处淡出到完全透明
  vec3 toPoint = vWorld - cameraPosition;
  float haze = hazeFactor(vViewDist, vWorld.y, uFogDensity, uHazeHeight);
  float edgeFade = 1.0 - smoothstep(uEdgeFadeStart, uEdgeFadeEnd, edgeDistance(vWorld.xz, uHalfSize));
  col = mix(col, hazeTint(uFogColor, uSunColor, uSunDir, toPoint), haze);
  col = mix(col, uFogColor, edgeFade);

  gl_FragColor = vec4(linearToSRGB(col), uOpacity * (1.0 - haze * 0.7) * (1.0 - edgeFade));
}
`;
