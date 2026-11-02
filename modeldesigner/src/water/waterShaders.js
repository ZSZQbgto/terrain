/**
 * 水体模拟 & 水面着色器（移植并适配自 D:\Proj\test\pilo.js 的 Cesium GPU 流体）。
 *
 * 模拟部分（4 个 ping-pong pass，和原实现一一对应）：
 *   A：写“地形高度 + 水深”第 1 段（读 C/D，含水源注水）
 *   B：写 4 向流出量第 1 段（读 A/D）
 *   C：写“地形高度 + 水深”第 2 段（读 A/B）
 *   D：写 4 向流出量第 2 段（读 C/B）
 *   display：把 C/D 合成渲染用纹理（水面高程、水深、净流速），带 LinearFilter
 *
 * 与原实现的差异（适配本项目地形渲染）：
 *   - 不再用正交相机把地形渲成高度图；模拟域 = 整个 8 km 地形，直接采样现有
 *     heightField.texture（R16F，R = 归一化高程 0..1，与地形顶点着色器同一份数据），
 *     所以“模拟区域”天然覆盖全图，无需手动取高度图/调范围。
 *   - 用 uv 采样代替 texelFetch（WebGL2/GLSL1 通用），片元中心 uv 与纹素一一对应。
 *   - 支持最多 8 个水源（uniform 数组），每个水源可独立半径 / 每次注水量 / 目标水位。
 *
 * 单位：纹理里的高程、水深都是「归一化」的（1.0 = reliefMeters），与地形顶点
 * 着色器的 hNorm 完全一致；UI/参数侧全部是米，由 fluidWater.js 换算。
 */

const SIM_COMMON = /* glsl */ `
precision highp float;

uniform sampler2D uHeightMap;
uniform sampler2D uDepth;   // rg = (归一化地形高度, 归一化水深, 水面高程, 1)
uniform sampler2D uFlow;    // 4 向流出量 (right, +z, left, -z)，归一化水深单位
uniform vec2  uSimTexel;    // 1 / 模拟分辨率
uniform float uSimRes;      // 模拟分辨率（边长，纹素数）
uniform vec4  uFluidParam;  // x=衰减 y=强度 z=最小流量 w=注水间隔(步)
uniform float uFrame;       // 当前子步序号（0 = 首步，用于初始化）
uniform float uPlayStep;    // 已执行的子步数（浮点，用于注水节拍）
uniform float uSizeMeters;  // 模拟域边长（米）
uniform float uReliefMeters; // 高程区间（米）：归一化 ↔ 米
uniform float uMinElevation; // 地形最低高程（米）
uniform float uTargetCap;    // 全局目标水面高程（米）；< 0 表示不限制
uniform float uWaterAmount; // 全局每次注水水深（归一化）
uniform int   uSourceCount;
uniform vec4  uSources[8];  // xy = 水源 uv, z = 半径（米）, w = 每次注水水深（归一化）
uniform vec4  uTargets[8];  // x = 目标水深（归一化，-1 = 不限制）, y = 是否启用

varying vec2 vUv;

// 模拟域边界当作封闭的墙：朝域外的流量一律记 0，采样邻居时也不跨出边界。
// 早期版本直接用 clamp-to-edge 采样（边界纹素等于自身），会把“自己的出流”当成
// “来自域外的入流”再加一次 —— 结果每步凭空多出一点水（实测体积会指数增长）。
//
// 注意用「像素序号」而不是 uv 做边界判断：uv 是插值出来的，恰好落在 0.5 纹素处时
// 浮点误差会让边界比较时真时假，边界那一圈就会随机漏掉/多算。
vec4 clampDomainFlow(vec4 f, vec2 uv) {
  float px = uv.x * uSimRes;
  float py = uv.y * uSimRes;
  if (px < 1.0) f.z = 0.0;
  if (px > uSimRes - 1.0) f.x = 0.0;
  if (py < 1.0) f.w = 0.0;
  if (py > uSimRes - 1.0) f.y = 0.0;
  return f;
}

float outflowSum(vec2 uv) {
  vec4 o = clampDomainFlow(texture2D(uFlow, uv), uv);
  return o.x + o.y + o.z + o.w;
}

float inflowSum(vec2 uv) {
  float px = uv.x * uSimRes;
  float py = uv.y * uSimRes;
  float f = 0.0;
  if (px < uSimRes - 1.0) f += texture2D(uFlow, uv + vec2(uSimTexel.x, 0.0)).z;
  if (py < uSimRes - 1.0) f += texture2D(uFlow, uv + vec2(0.0, uSimTexel.y)).w;
  if (px > 1.0) f += texture2D(uFlow, uv - vec2(uSimTexel.x, 0.0)).x;
  if (py > 1.0) f += texture2D(uFlow, uv - vec2(0.0, uSimTexel.y)).y;
  return f;
}

float sumHeight(vec2 uv) {
  vec2 d = texture2D(uDepth, uv).rg;
  return d.r + d.g;
}

// 全局目标水位（相当于溢洪道）：水面一旦高出目标高程，多出来的水直接排掉，
// 所以多个水源同时注水也不会把整张地图无限灌高。
float capDepth(float hNorm, float depth) {
  if (uTargetCap < 0.0) return depth;
  float terrainMeters = hNorm * uReliefMeters + uMinElevation;
  float limit = max((uTargetCap - terrainMeters) / max(uReliefMeters, 1.0), 0.0);
  return min(depth, limit);
}
`;

/** 全屏 quad（模拟 pass）顶点着色器 */
export const simVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** pass A：地形高度 + 水深（含水源注水） */
export const simFragmentA = /* glsl */ `
${SIM_COMMON}

void main() {
  vec2 uv = vUv;
  float h = texture2D(uHeightMap, uv).r;
  float depth = 0.0;

  if (uFrame > 0.5) {
    depth = max(texture2D(uDepth, uv).g - outflowSum(uv) + inflowSum(uv), 0.0);

    // 水源注水：每 uFluidParam.w 个子步注入一次，注到目标水位就停
    if (mod(uPlayStep, max(uFluidParam.w, 1.0)) < 0.5) {
      for (int i = 0; i < 8; i++) {
        if (i < uSourceCount) {
          vec4 s = uSources[i];
          vec4 t = uTargets[i];
          if (t.y > 0.5 && s.z > 0.0) {
            float dist = length((uv - s.xy) * uSizeMeters);
            if (dist < s.z) {
              float add = s.w;
              if (t.x >= 0.0) add = min(add, max(t.x - depth, 0.0));
              depth += add;
            }
          }
        }
      }
    }
  }

  float capped = capDepth(h, depth);
  gl_FragColor = vec4(h, capped, h + capped, 1.0);
}
`;

/** pass B：4 向流出量（第 1 段） */
export const simFragmentB = /* glsl */ `
${SIM_COMMON}

void main() {
  // 首步先把流出量清零，保证缓冲区被完整初始化
  if (uFrame < 0.5) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec2 uv = vUv;
  vec2 h = texture2D(uDepth, uv).rg;
  vec4 o = texture2D(uFlow, uv);
  float c = h.r + h.g;

  vec4 n;
  n.x = max(0.0, c - sumHeight(uv + vec2(uSimTexel.x, 0.0)));
  n.y = max(0.0, c - sumHeight(uv + vec2(0.0, uSimTexel.y)));
  n.z = max(0.0, c - sumHeight(uv - vec2(uSimTexel.x, 0.0)));
  n.w = max(0.0, c - sumHeight(uv - vec2(0.0, uSimTexel.y)));

  n = uFluidParam.x * o + uFluidParam.y * n;
  float total = n.x + n.y + n.z + n.w;
  if (total > uFluidParam.z) {
    if (h.g < total) n *= h.g / total;
  } else {
    n = vec4(0.0);
  }
  // 边界当墙：朝域外的残余流量清零（旧值靠衰减残留时也不会计入进出账）
  n = clampDomainFlow(n, uv);
  gl_FragColor = n;
}
`;

/** pass C：地形高度 + 水深（第 2 段，不含注水） */
export const simFragmentC = /* glsl */ `
${SIM_COMMON}

void main() {
  vec2 uv = vUv;
  vec2 d = texture2D(uDepth, uv).rg;
  float depth = max(d.g - outflowSum(uv) + inflowSum(uv), 0.0);
  float capped = capDepth(d.r, depth);
  gl_FragColor = vec4(d.r, capped, d.r + capped, 1.0);
}
`;

/** pass D：4 向流出量（第 2 段） */
export const simFragmentD = /* glsl */ `
${SIM_COMMON}

void main() {
  vec2 uv = vUv;
  vec2 h = texture2D(uDepth, uv).rg;
  vec4 o = texture2D(uFlow, uv);
  float c = h.r + h.g;

  vec4 n;
  n.x = max(0.0, c - sumHeight(uv + vec2(uSimTexel.x, 0.0)));
  n.y = max(0.0, c - sumHeight(uv + vec2(0.0, uSimTexel.y)));
  n.z = max(0.0, c - sumHeight(uv - vec2(uSimTexel.x, 0.0)));
  n.w = max(0.0, c - sumHeight(uv - vec2(0.0, uSimTexel.y)));

  n = uFluidParam.x * o + uFluidParam.y * n;
  float total = n.x + n.y + n.z + n.w;
  if (total > uFluidParam.z) {
    if (h.g < total) n *= h.g / total;
  } else {
    n = vec4(0.0);
  }
  // 边界当墙：朝域外的残余流量清零（旧值靠衰减残留时也不会计入进出账）
  n = clampDomainFlow(n, uv);
  gl_FragColor = n;
}
`;

/** display：合成渲染用纹理（R=水面高程, G=水深, BA=净流速） */
export const simFragmentDisplay = /* glsl */ `
precision highp float;
uniform sampler2D uDepth;
uniform sampler2D uFlow;
varying vec2 vUv;

void main() {
  vec4 d = texture2D(uDepth, vUv);
  vec4 f = texture2D(uFlow, vUv);
  // 净流出方向 = 右 - 左 / 后 - 前，仅仅用于水面细节的平流与急流泡沫
  vec2 vel = vec2(f.x - f.z, f.y - f.w);
  gl_FragColor = vec4(d.b, d.g, vel.x, vel.y);
}
`;

/* ────────────────────────── 水面网格 ────────────────────────── */

const WATER_COMMON = /* glsl */ `
vec3 linearToSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

// 与地形完全一致的日间薄雾：近地面更浓，高处更通透
float hazeFactor(float viewDist, float worldY, float density, float heightScale) {
  float d = density * viewDist;
  float dist = 1.0 - exp(-d * d);
  float lowLevel = exp(-max(worldY, 0.0) / max(heightScale, 1.0));
  return clamp(dist * mix(0.6, 1.0, lowLevel), 0.0, 0.94);
}

vec3 hazeTint(vec3 fogColor, vec3 sunColor, vec3 sunDir, vec3 toPoint) {
  float s = max(dot(normalize(toPoint), sunDir), 0.0);
  float s2 = s * s;
  float s4 = s2 * s2;
  float s8 = s4 * s4;
  return mix(fogColor, sunColor, s8 * 0.55);
}

float edgeDistance(vec2 xz, float halfSize) {
  return min(min(xz.x + halfSize, halfSize - xz.x), min(xz.y + halfSize, halfSize - xz.y));
}
`;

export const waterSurfaceVertex = /* glsl */ `
uniform sampler2D uSurface;   // display 纹理：R=归一化水面高程, G=归一化水深, BA=净流速
uniform float uSizeMeters;
uniform float uReliefMeters;
uniform float uExaggeration;
uniform float uHalfSize;

varying vec2  vSimUv;
varying vec3  vWorld;
varying float vDepthNorm;
varying vec2  vFlow;
varying float vViewDist;

void main() {
  // 水面网格是整个世界地形大小的平面：世界 xz → 模拟 uv，与高度场/地形 uv 完全一致
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 uv = wp.xz / uSizeMeters + 0.5;
  vec4 s = texture2D(uSurface, uv);

  float surfaceNorm = s.r;
  float depthNorm = max(s.g, 0.0);

  // 与地形顶点着色器同一套换算：y = hNorm * relief * 垂直夸张
  wp.y = surfaceNorm * uReliefMeters * uExaggeration;

  vSimUv = uv;
  vWorld = wp.xyz;
  vDepthNorm = depthNorm;
  vFlow = s.ba;
  vViewDist = length(wp.xyz - cameraPosition);

  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const waterSurfaceFragment = /* glsl */ `
precision highp float;

${WATER_COMMON}

uniform sampler2D uSurface;
uniform sampler2D uNormalMap;
uniform sampler2D uFoamMap;

uniform vec2  uSimTexel;
uniform float uCellMeters;
uniform float uSizeMeters;
uniform float uReliefMeters;
uniform float uExaggeration;
uniform float uTime;

uniform vec3  uShallowColor;
uniform vec3  uDeepColor;
uniform vec3  uSkyColor;
uniform vec3  uSkyZenith;
uniform vec3  uSkyHorizon;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform float uHazeHeight;
uniform float uHalfSize;
uniform float uEdgeFadeStart;
uniform float uEdgeFadeEnd;

uniform float uShimmer;   // 太阳高光强度
uniform float uRipple;    // 波纹法线强度
uniform float uClarity;   // 水体清澈度（越小越深、吸收越强）

varying vec2  vSimUv;
varying vec3  vWorld;
varying float vDepthNorm;
varying vec2  vFlow;
varying float vViewDist;

void main() {
  float depthMeters = vDepthNorm * uReliefMeters;
  if (depthMeters < 0.02) discard;   // 干地：不画水面

  // ── 由模拟水位求几何法线（中央差分；水面高程已含垂直夸张）───────────────
  vec2 texel = uSimTexel;
  float hL = texture2D(uSurface, vSimUv - vec2(texel.x, 0.0)).r;
  float hR = texture2D(uSurface, vSimUv + vec2(texel.x, 0.0)).r;
  float hD = texture2D(uSurface, vSimUv - vec2(0.0, texel.y)).r;
  float hU = texture2D(uSurface, vSimUv + vec2(0.0, texel.y)).r;
  float gradientScale = uReliefMeters * uExaggeration / (2.0 * max(uCellMeters, 0.001));
  vec3 n = normalize(vec3(-(hR - hL) * gradientScale, 1.0, -(hU - hD) * gradientScale));

  // ── 细节波纹：两层不同尺度、不同朝向的法线贴图，沿净流速方向平流 ─────────
  float flowMag = length(vFlow);
  vec2 flowDir = flowMag > 1e-6 ? vFlow / flowMag : vec2(0.0);
  float t = uTime;
  float depthFade = 1.0 - smoothstep(1800.0, 6500.0, vViewDist);
  float bump = uRipple * mix(0.28, 1.0, depthFade);

  // 第二层旋转约 52°，避免两层同向叠加出规则的斜条纹
  float ca = 0.616; // cos(52°)
  float sa = 0.788; // sin(52°)
  vec2 pB = vec2(ca * vWorld.x - sa * vWorld.z, sa * vWorld.x + ca * vWorld.z);
  vec2 advect = flowDir * (t * 0.055 + depthMeters * 0.012);
  vec2 baseA = vWorld.xz * 0.012 + advect;
  vec2 baseB = pB * 0.027 - flowDir.yx * (t * 0.04);
  vec2 nA = texture2D(uNormalMap, baseA).xy * 2.0 - 1.0;
  vec2 nB = texture2D(uNormalMap, baseB).xy * 2.0 - 1.0;
  vec2 rippleXZ = (nA + nB * 0.75) * bump * 0.6;
  n = normalize(vec3(n.x + rippleXZ.x, n.y, n.z + rippleXZ.y));

  // ── 光照 ────────────────────────────────────────────────────────────────
  vec3 viewDir = normalize(cameraPosition - vWorld);
  float NdV = clamp(dot(n, viewDir), 0.0, 1.0);

  // Schlick 菲涅尔：正视看到水体色，掠视几乎全是天空/日光反射
  float fresnel = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  // 天空反射：与天空着色器同一套渐变 + 太阳方向的前向散射亮斑
  vec3 reflDir = reflect(-viewDir, n);
  float up = clamp(reflDir.y, 0.0, 1.0);
  vec3 skyCol = mix(uSkyHorizon, uSkyZenith, sqrt(up) * (1.25 - 0.25 * up));
  float sunAlign = max(dot(reflDir, normalize(uSunDir)), 0.0);
  skyCol += uSunColor * pow(sunAlign, 6.0) * 0.28;

  // 深度吸收（Beer-Lambert 近似）：浅水透出水下地形色，深水是深青/墨蓝
  float absorb = 1.0 - exp(-depthMeters * (0.18 + (1.0 - uClarity) * 0.9));
  vec3 body = mix(uShallowColor, uDeepColor, clamp(absorb, 0.0, 1.0));
  // 一点天光散射，避免深水在背光面死黑
  body += uSkyColor * 0.05 * (0.35 + 0.65 * NdV);
  vec3 col = mix(body, skyCol, fresnel);

  // 太阳镜面：一个锐利的太阳高光 + 一层较宽泛光
  vec3 halfDir = normalize(normalize(uSunDir) + viewDir);
  float ndh = max(dot(n, halfDir), 0.0);
  float specTight = pow(ndh, 900.0);
  float specBroad = pow(ndh, 70.0);
  col += uSunColor * uShimmer * (specTight * 7.0 + specBroad * 0.3);

  // 掠射角细碎波光（高频、只在高光方向附近出现，避免满屏噪点）
  float sparkle = pow(ndh, 4000.0) * 2.6;
  col += uSunColor * sparkle * uShimmer * smoothstep(0.5, 0.95, fresnel);

  // ── 泡沫：岸边（细碎拍岸）+ 急流（顺流白浪）──────────────────────────────
  float shoreMask = 1.0 - smoothstep(0.0, 1.4, depthMeters);
  float foamLow = texture2D(uFoamMap, vWorld.xz * 0.016 + flowDir * t * 0.012).r;
  float foamHigh = texture2D(uFoamMap, vWorld.xz * 0.055 - flowDir * t * 0.03).r;
  float rapidMask = smoothstep(0.02, 0.22, flowMag) * smoothstep(0.08, 1.2, depthMeters);
  float foam = clamp(
    shoreMask * (foamLow * 0.55 + foamHigh * 0.45) * 0.62 +
    rapidMask * foamHigh * 0.5,
    0.0, 0.9
  );
  col = mix(col, vec3(0.90, 0.95, 1.0), foam * 0.9);

  // ── 与地形一致的日间薄雾 + 地形边界淡出 ─────────────────────────────────
  vec3 toPoint = vWorld - cameraPosition;
  float haze = hazeFactor(vViewDist, vWorld.y, uFogDensity, uHazeHeight);
  col = mix(col, hazeTint(uFogColor, uSunColor, uSunDir, toPoint), haze);
  // edgeFade：地形边界处为 1（完全入雾），中心为 0。水面在边界处淡出到透明。
  float edgeFade = 1.0 - smoothstep(uEdgeFadeStart, uEdgeFadeEnd, edgeDistance(vWorld.xz, uHalfSize));

  // ── 透明度：极浅的水几乎是湿地面，深水接近不透明（水下地形不再透出）────
  float shoreFade = smoothstep(0.0, 0.28, depthMeters);
  float deepFade = smoothstep(0.12, 2.6, depthMeters);
  float alpha = shoreFade * mix(0.22, 0.985, deepFade);
  alpha = max(alpha, foam * 0.6);
  alpha *= (1.0 - haze * 0.5) * (1.0 - edgeFade);
  alpha = clamp(alpha, 0.0, 1.0);

  gl_FragColor = vec4(linearToSRGB(col), alpha);
}
`;
