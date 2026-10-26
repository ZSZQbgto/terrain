/**
 * FXAA 后处理。
 *
 * 核显上 MSAA 4x 会把地形着色成本翻倍（贴地场景 6.65 ms → 12.38 ms），
 * 而 FXAA 只多一次全屏 pass（约 1–1.5 ms），抗锯齿效果对地形轮廓与等高线足够。
 *
 * 场景先渲染到一张 RGBA8 的 render target（我们的着色器已手动输出 sRGB 值，
 * 存在 gamma 空间正好是 FXAA 期望的工作空间），再用 FXAA 拉到屏幕。
 */
import * as THREE from 'three';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export class FxaaPass {
  constructor(renderer) {
    this.renderer = renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.width = size.x;
    this.height = size.y;

    this.target = new THREE.WebGLRenderTarget(size.x, size.y, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.target.texture },
        resolution: { value: new THREE.Vector2(1 / size.x, 1 / size.y) },
      },
      vertexShader: VERT,
      fragmentShader: FXAAShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geometry = new THREE.PlaneGeometry(2, 2);
    const quad = new THREE.Mesh(geometry, this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
    this.geometry = geometry;
  }

  /** 画布尺寸或 pixelRatio 变化时同步（每帧调用开销可忽略） */
  _syncSize() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (size.x === this.width && size.y === this.height) return;
    this.width = size.x;
    this.height = size.y;
    this.target.setSize(size.x, size.y);
    this.material.uniforms.resolution.value.set(1 / size.x, 1 / size.y);
  }

  render(scene, camera) {
    this._syncSize();
    const renderer = this.renderer;
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this.geometry.dispose();
  }
}
