/**
 * GPU 预计算 pass：一张 R16F 高度图 → 一张 RGBA16F 查询纹理
 *   R = 高度, G = 天空光遮蔽, B = ∂h/∂x, A = ∂h/∂z
 *
 * 全部在 GPU 上完成：主线程不再做百万像素的 JS 循环，
 * 而且 AO 可以直接全分辨率计算（JS 版本为了省时间只能半分辨率再放大）。
 */
import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uHeight;
uniform vec2 uTexel;
uniform float uGradScale;   // relief / (2 * pxMeters)
uniform float uHeightWorld; // relief * 参考夸张（米）
uniform float uPxMeters;
uniform float uAoStrength;
varying vec2 vUv;

void main() {
  float h = texture2D(uHeight, vUv).r;

  // 中心差分 → 归一化梯度（米/米，不含垂直夸张）
  float hxp = texture2D(uHeight, vUv + vec2(uTexel.x, 0.0)).r;
  float hxm = texture2D(uHeight, vUv - vec2(uTexel.x, 0.0)).r;
  float hzp = texture2D(uHeight, vUv + vec2(0.0, uTexel.y)).r;
  float hzm = texture2D(uHeight, vUv - vec2(0.0, uTexel.y)).r;
  float gx = (hxp - hxm) * uGradScale;
  float gz = (hzp - hzm) * uGradScale;

  // 天空光遮蔽：8 个方位 × 4 个半径上的最大仰角，平均值即遮挡量
  float hc = h * uHeightWorld;
  float sum = 0.0;
  for (int d = 0; d < 8; d++) {
    float ang = float(d) * 0.7853981634;
    vec2 dir = vec2(cos(ang), sin(ang));
    float maxTan = 0.0;
    for (int k = 0; k < 4; k++) {
      float r = k < 1 ? 2.0 : (k < 2 ? 5.0 : (k < 3 ? 12.0 : 26.0));
      float hn = texture2D(uHeight, vUv + dir * r * uTexel).r;
      float tanv = (hn * uHeightWorld - hc) / (r * uPxMeters);
      maxTan = max(maxTan, tanv);
    }
    sum += maxTan;
  }
  float occlusion = clamp(sum / 8.0, 0.0, 1.0);
  float ao = 1.0 - clamp(occlusion * 0.55 * uAoStrength, 0.0, 1.0);

  gl_FragColor = vec4(h, ao, gx, gz);
}
`;

/**
 * 可复用的查询纹理更新器：地形编辑时高度纹理会频繁变化，
 * 每次重建都 new 一张 1081² RGBA16F render target 会反复分配显存并产生 GC 抖动，
 * 这里复用一个 target / material / quad，只重新渲染内容。
 *
 *   const updater = createLookupUpdater(renderer, opts);
 *   updater.update(heightField.texture);   // 首次 + 每次高度变化后调用
 *   terrainTexture = updater.texture;      // 内容原地更新，引用不变
 */
export function createLookupUpdater(renderer, opts) {
  const { width, height, reliefMeters, pxMeters, aoStrength = 1, exagRef = 4 } = opts;

  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uHeight: { value: null },
      uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
      uGradScale: { value: reliefMeters / (2 * pxMeters) },
      uHeightWorld: { value: reliefMeters * exagRef },
      uPxMeters: { value: pxMeters },
      uAoStrength: { value: aoStrength },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    depthTest: false,
    depthWrite: false,
  });

  const geometry = new THREE.PlaneGeometry(2, 2);
  const quad = new THREE.Mesh(geometry, material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const texture = target.texture;
  texture.flipY = false;
  texture.generateMipmaps = false;

  const update = (heightTexture) => {
    material.uniforms.uHeight.value = heightTexture;
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearAlpha();
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearAlpha(prevClear);
  };

  const dispose = () => {
    target.dispose();
    material.dispose();
    geometry.dispose();
  };

  return { texture, update, dispose, target };
}

/**
 * 一次性构建查询纹理（首次创建）。需要反复重建时用 createLookupUpdater 复用资源。
 * @param {import('three').WebGLRenderer} renderer
 * @param {THREE.Texture} heightTexture R16F 高度图
 * @param {{width:number,height:number,reliefMeters:number,pxMeters:number,aoStrength?:number,exagRef?:number}} opts
 * @returns {THREE.Texture} RGBA16F 查询纹理
 */
export function buildLookupTexture(renderer, heightTexture, opts) {
  const { width, height, reliefMeters, pxMeters, aoStrength = 1, exagRef = 4 } = opts;

  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uHeight: { value: heightTexture },
      uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
      uGradScale: { value: reliefMeters / (2 * pxMeters) },
      uHeightWorld: { value: reliefMeters * exagRef },
      uPxMeters: { value: pxMeters },
      uAoStrength: { value: aoStrength },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    depthTest: false,
    depthWrite: false,
  });

  const geometry = new THREE.PlaneGeometry(2, 2);
  const quad = new THREE.Mesh(geometry, material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearAlpha();
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearAlpha(prevClear);

  material.dispose();
  geometry.dispose();

  const texture = target.texture;
  texture.flipY = false;
  texture.generateMipmaps = false;
  return texture;
}
