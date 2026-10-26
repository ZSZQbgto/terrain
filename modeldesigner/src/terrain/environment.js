/**
 * 环境：渐变天空 + 太阳 + 水面。
 */
import * as THREE from 'three';
import { skyVertex, skyFragment, waterVertex, waterFragment } from './shaders.js';

export function createSky(env, palette) {
  const geometry = new THREE.SphereGeometry(1, 32, 16);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: palette.zenith },
      uHorizon: { value: palette.horizon },
      uSunColor: { value: env.uSunColor.value },
      uSunDir: { value: env.uSunDir.value },
      uFogColor: { value: env.uFogColor.value },
    },
    vertexShader: skyVertex,
    fragmentShader: skyFragment,
    side: THREE.BackSide,
    depthWrite: false,
    // 顶点着色器把天空压到远平面（z = w），这里打开深度测试让地被地形遮住的像素
    // 在 early-z 阶段就被剔除 —— 全景时天空的着色开销基本归零
    depthTest: true,
    fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1000; // 最后画（三个不透明物体里）
  mesh.name = 'sky';
  return mesh;
}

export class Water {
  /**
   * @param {object} env
   * @param {number} sizeMeters 地形边长
   */
  constructor(env, sizeMeters) {
    this.uniforms = {
      uTime: { value: 0 },
      uWaterColor: { value: new THREE.Color(0x123240) },
      uSkyColor: { value: env.uSkyColor.value },
      uSunDir: { value: env.uSunDir.value },
      uSunColor: { value: env.uSunColor.value },
      uFogColor: { value: env.uFogColor.value },
      uFogDensity: { value: env.uFogDensity.value },
      uHazeHeight: { value: env.uHazeHeight.value },
      uHalfSize: { value: env.uHalfSize.value },
      uEdgeFadeStart: { value: env.uEdgeFadeStart.value },
      uEdgeFadeEnd: { value: env.uEdgeFadeEnd.value },
      uOpacity: { value: 0.82 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: waterVertex,
      fragmentShader: waterFragment,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const geometry = new THREE.PlaneGeometry(sizeMeters, sizeMeters, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.renderOrder = 10;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'water';
    this.sizeMeters = sizeMeters;
  }

  /** @param {number} y 世界坐标高度 */
  setLevel(y) {
    this.mesh.position.y = y;
  }

  update(time) {
    this.uniforms.uTime.value = time;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
