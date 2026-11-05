/**
 * glb 材质的输出编码补丁。
 *
 * 本项目沿用父项目的地形渲染约定：`renderer.outputColorSpace = LinearSRGBColorSpace`，
 * 场景先渲染到 RGBA8 的 FXAA target —— 也就是说**写进 target 的值必须是 sRGB 编码**，
 * 地形/天空/水面的自定义 shader 都自己做了 linear→sRGB。
 *
 * three 内置材质（glb 的 MeshStandardMaterial 等）在这种情况下会把线性值直接写出，
 * 结果明显偏暗。这里替换 `colorspace_fragment`，让标准材质与地形走同一套编码，
 * 不需要动地形 shader，也不影响 FXAA 链路。
 */
const SRGB_OUTPUT = /* glsl */ `
gl_FragColor.rgb = mix(
  gl_FragColor.rgb * 12.92,
  1.055 * pow(max(gl_FragColor.rgb, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
  step(vec3(0.0031308), gl_FragColor.rgb)
);
`;

/** 单个材质打补丁（幂等；clone 出来的模型共享同一材质对象，因此只需打一次） */
export function patchMaterialOutput(material) {
  if (!material || material.userData?.__srgbOutput) return material;
  material.userData = material.userData ?? {};
  material.userData.__srgbOutput = true;

  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (typeof previous === 'function') previous.call(material, shader, renderer);
    if (shader.fragmentShader.includes('#include <colorspace_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <colorspace_fragment>', SRGB_OUTPUT);
    }
  };
  // onBeforeCompile 改动需要触发重编译
  material.needsUpdate = true;
  return material;
}

/** 给一棵模型树上的所有材质打补丁 */
export function patchModelMaterials(root) {
  if (!root) return;
  root.traverse((object) => {
    if (!object.isMesh && !object.isSkinnedMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) patchMaterialOutput(material);
  });
}
