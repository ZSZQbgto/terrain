/**
 * 环境：渐变天空。
 *
 * 水面不再属于环境层：水体改由 `src/water/fluidWater.js` 的 GPU 浅水模拟 +
 * 水面网格渲染（旧的“覆盖全图的水面”已删除）。
 */
import * as THREE from 'three';
import { skyVertex, skyFragment } from './shaders.js';

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
