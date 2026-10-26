/**
 * 水面着色器（静止水面区域 + 流动水**共用同一套**）。
 *
 * 之前静止水面用的是地形模块里那套「铺满全图的水面」片段着色器，它依赖
 * uHalfSize / uEdgeFadeStart / uEdgeFadeEnd 做边界淡出；区域网格没传这三个
 * uniform，edgeFade 恒为 1，最终 alpha 恒为 0 —— 所以静止水面一直是透明的、
 * 完全看不到。这里统一成一套材质：
 *
 *   - 同一份程序化水纹（3 层 valueNoise）与同一套法线扰动
 *   - 同一套光照：菲涅尔天空反射 + **日光镜面反光**（Blinn-Phong + 太阳辉光）
 *   - 同一套日间薄雾（与地形一致的 hazeFactor / hazeTint）
 *
 * 区别只有 uniform：流动水 uFlow = 1，纹理沿路径 v 方向滚动、横向收边；
 * 静止水面 uFlow = 0，波纹随时间缓慢起伏，没有收边（靠多边形边界裁切）。
 *
 * 输出约定与地形一致：自己把 linear 值编码成 sRGB 写进 FXAA 的 RGBA8 target。
 */
import * as THREE from 'three';

const COMMON = /* glsl */ `
vec3 linearToSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

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

// 与地形 shader 完全一致的日间薄雾：近地面更浓，高处更通透
float hazeFactor(float viewDist, float worldY, float density, float heightScale) {
  float d = density * viewDist;
  float heightFalloff = exp(-max(worldY, 0.0) / max(heightScale, 1.0));
  return 1.0 - exp(-d * d * (0.55 + 0.85 * heightFalloff));
}

vec3 hazeTint(vec3 fogColor, vec3 sunColor, vec3 sunDir, vec3 toPoint) {
  vec3 dir = normalize(toPoint);
  float s = max(dot(dir, normalize(sunDir)), 0.0);
  float s8 = pow(s, 8.0);
  return mix(fogColor, sunColor, s8 * 0.55);
}
`;

export const waterVertex = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
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
uniform float uSpeed;
uniform float uFlow;       // 0 = 静止水面区域，1 = 流动水
uniform vec3  uWaterColor;
uniform vec3  uSkyColor;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform float uHazeHeight;
uniform float uOpacity;

varying vec2 vUv;
varying vec3 vWorld;
varying float vViewDist;

void main() {
  bool isFlow = uFlow > 0.5;
  float t = uTime;

  // 静止水面：世界坐标上的缓慢起伏；流动水：沿路径 v 方向滚动
  float scroll = isFlow ? (vUv.y - t * uSpeed * 1.6) : (t * uSpeed);
  vec2 p = vWorld.xz * 0.045;

  float w1 = valueNoise(p * 1.0 + vec2(scroll * 0.55, scroll * 0.35));
  float w2 = valueNoise(p * 2.7 - vec2(scroll * 0.9, scroll * 0.7));
  float w3 = valueNoise(p * 6.3 + vec2(scroll * 1.4, -scroll * 1.1));

  // 三层噪声扰动法线：波纹细节一致，静止/流动只是相位推进方式不同
  vec3 n = normalize(vec3(
    (w2 - 0.5) * 0.22 + (w3 - 0.5) * 0.09,
    1.0,
    (w3 - 0.5) * 0.20 + (w1 - 0.5) * 0.08
  ));

  vec3 viewDir = normalize(cameraPosition - vWorld);
  vec3 lightDir = normalize(uSunDir);
  vec3 halfDir = normalize(lightDir + viewDir);

  // 菲涅尔：正视偏水体色，掠视偏天空色
  float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 5.0);
  vec3 col = mix(uWaterColor, uSkyColor, clamp(0.08 + fres * 0.72, 0.0, 0.86));

  // 日光反光：一层锐利的镜面 + 一层随波纹闪动的太阳辉光
  float ndh = max(dot(n, halfDir), 0.0);
  float specular = pow(ndh, 260.0);
  float glitter = pow(ndh, 26.0) * clamp(w1 * 1.4, 0.0, 1.0);
  col += uSunColor * (specular * 2.2 + glitter * 0.32);

  // 流动水横向收边（区域恒为 1，靠多边形裁切）
  float edge = isFlow
    ? smoothstep(0.0, 0.14, vUv.x) * smoothstep(1.0, 0.86, vUv.x)
    : 1.0;

  // 与地形同一套日间薄雾
  vec3 toPoint = vWorld - cameraPosition;
  float haze = hazeFactor(vViewDist, vWorld.y, uFogDensity, uHazeHeight);
  col = mix(col, hazeTint(uFogColor, uSunColor, uSunDir, toPoint), haze);

  gl_FragColor = vec4(linearToSRGB(col), uOpacity * edge * (1.0 - haze * 0.6));
}
`;

/**
 * 生成一个水面材质。区域与流动水共用这里，只有 uFlow / uSpeed / 基色不同，
 * 因此两者的贴图与光照表现完全一致。
 *
 * 所有环境 uniform 都直接引用 env 里的对象 —— 改 env.uFogDensity.value
 * （图形选项里的薄雾滑块）会同时作用到地形与水面。
 */
export function makeWaterMaterial(env, { flow = false, opacity = 0.86, speed = 0.35, color } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSpeed: { value: speed },
      uFlow: { value: flow ? 1 : 0 },
      uWaterColor: { value: new THREE.Color(color ?? (flow ? 0x17414f : 0x14404f)) },
      uSkyColor: env.uSkyColor,
      uSunDir: env.uSunDir,
      uSunColor: env.uSunColor,
      uFogColor: env.uFogColor,
      uFogDensity: env.uFogDensity,
      uHazeHeight: env.uHazeHeight,
      uOpacity: { value: opacity },
    },
    vertexShader: waterVertex,
    fragmentShader: waterFragment,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
