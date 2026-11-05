/**
 * 部件遍历与场景内标签（CSS2D）。
 *
 * 标签可以挂在「整个模型」或「glb 的任意部件」上。部件用**索引路径**标识
 * （从模型内容根开始逐层 childIndex），比节点名稳定 —— glb 里同名节点很常见。
 *
 * 重要：CSS2DObject 一律挂在 `model.root` 下（而不是 content / 部件节点）。
 * 因为部件路径依赖 content 的 children 索引，往里面塞标签对象会让路径漂移。
 * 部件标签的位置每帧由 update() 跟随目标部件的世界坐标换算到 root 局部。
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { LABEL_KINDS } from './project.js';

const MAX_PARTS = 400;

/**
 * 收集可标注部件（Mesh / Group / 带名字的节点）。
 * 返回扁平列表，depth 用于 UI 缩进；path 是索引路径。
 */
export function collectParts(root, { maxParts = MAX_PARTS } = {}) {
  const out = [];
  const walk = (node, path, depth) => {
    if (out.length >= maxParts) return;
    if (node !== root) {
      out.push({
        node,
        path,
        depth,
        name: node.name || defaultName(node),
        type: node.type,
        mesh: Boolean(node.isMesh),
        childCount: node.children?.length ?? 0,
      });
    }
    const children = node.children ?? [];
    for (let i = 0; i < children.length && out.length < maxParts; i++) {
      walk(children[i], [...path, i], depth + 1);
    }
  };
  if (root) walk(root, [], 0);
  return out;
}

function defaultName(node) {
  if (node.isMesh) return `网格 ${node.id}`;
  if (node.isGroup) return `分组 ${node.id}`;
  return `${node.type} ${node.id}`;
}

/** 按索引路径取节点；路径失效时返回 null */
export function resolvePath(root, path) {
  if (!root) return null;
  if (!Array.isArray(path) || !path.length) return root;
  let node = root;
  for (const i of path) {
    node = node?.children?.[i];
    if (!node) return null;
  }
  return node;
}

export function findPart(root, path) {
  const node = resolvePath(root, path);
  if (!node) return null;
  return collectParts(root).find((p) => p.node === node) ?? null;
}

/** 人类可读的部件路径：子节点名 / 子节点名 … */
export function pathToLabel(root, path) {
  if (!Array.isArray(path) || !path.length) return '整个模型';
  const names = [];
  let node = root;
  for (const i of path) {
    node = node?.children?.[i];
    if (!node) {
      names.push(`#${i}（已失效）`);
      break;
    }
    names.push(node.name || defaultName(node));
  }
  return names.join(' / ');
}

/** 部件的世界位置（用于提示） */
export function partWorldPosition(node, target = new THREE.Vector3()) {
  return node.getWorldPosition(target);
}

/**
 * 场景内标签层：把每个标签渲染成跟随部件的 CSS2D 小胶囊。
 * 只负责显示；数据仍由 editor 里的 model.labels 持有。
 */
export class TagLayer {
  constructor({ visible = true } = {}) {
    this.visible = visible;
    this.entries = new Map(); // `${modelId}:${labelId}` -> entry
    this.active = { modelId: null, labelId: null };
    this._tmp = new THREE.Vector3();
  }

  setVisible(visible) {
    this.visible = visible;
    for (const entry of this.entries.values()) {
      entry.element.classList.toggle('hidden', !visible);
      entry.object.visible = visible;
    }
  }

  setActive(modelId, labelId) {
    this.active = { modelId, labelId };
    for (const [key, entry] of this.entries) {
      entry.element.classList.toggle('active', key === `${modelId}:${labelId}`);
    }
  }

  /**
   * 让场景标签与 model.labels 对齐：新增缺的、删除多余的、更新文案与目标。
   * 幂等，可在每次数据变更后调用。
   */
  sync(model) {
    const seen = new Set();
    let stackIndex = 0;
    // 模型级标签的锚点：content 包围盒顶部，换算到 root 局部坐标
    let anchor = null;
    const getAnchor = () => {
      if (anchor) return anchor;
      model.root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model.content);
      const corner = box.isEmpty() ? new THREE.Vector3(0, 1, 0) : box.max.clone();
      anchor = model.root.worldToLocal(corner);
      return anchor;
    };

    for (const label of model.labels) {
      const key = `${model.id}:${label.id}`;
      seen.add(key);
      const target = label.nodePath ? resolvePath(model.content, label.nodePath) : null;
      const offsetY = label.nodePath ? 6 : 12 + stackIndex++ * 16;

      let entry = this.entries.get(key);
      if (!entry) {
        const element = document.createElement('div');
        element.className = `scene-tag ${label.kind}`;
        const dot = document.createElement('span');
        dot.className = 'lead';
        const text = document.createElement('span');
        text.className = 'txt';
        element.append(dot, text);
        const object = new CSS2DObject(element);
        model.root.add(object); // 挂 root：不污染 content 的 children 索引
        entry = {
          object,
          element,
          text,
          host: model.root,
          targetNode: null,
          anchor: null,
          offsetY,
          labelId: label.id,
        };
        this.entries.set(key, entry);
      } else if (entry.host !== model.root) {
        // 兼容旧状态：早期版本把标签挂到了 content 下，这里迁回 root
        entry.host.remove(entry.object);
        model.root.add(entry.object);
        entry.host = model.root;
      }

      entry.targetNode = target;
      entry.offsetY = offsetY;
      entry.anchor = target ? null : getAnchor();
      entry.text.textContent = label.title;
      entry.element.className = `scene-tag ${label.kind}${this.visible ? '' : ' hidden'}`;
      entry.object.visible = this.visible;
      entry.label = label;
      this._place(entry);
    }

    for (const [key, entry] of [...this.entries]) {
      if (!key.startsWith(`${model.id}:`)) continue;
      if (seen.has(key)) continue;
      entry.host.remove(entry.object);
      entry.element.remove();
      this.entries.delete(key);
    }
  }

  /** 单个标签的定位：部件用世界坐标换算，模型级用包围盒锚点 */
  _place(entry) {
    if (!entry.object.parent) return;
    if (entry.targetNode) {
      entry.targetNode.getWorldPosition(this._tmp);
      entry.object.position.copy(entry.object.parent.worldToLocal(this._tmp.clone()));
    } else if (entry.anchor) {
      entry.object.position.copy(entry.anchor);
    } else {
      entry.object.position.set(0, 1, 0);
    }
    entry.object.position.y += entry.offsetY;
  }

  /** 每帧调用：拖 gizmo 或改部件变换时，部件标签跟着走 */
  update() {
    for (const entry of this.entries.values()) {
      if (!entry.targetNode || !entry.object.parent) continue;
      this._place(entry);
    }
  }

  removeModel(modelId) {
    for (const [key, entry] of [...this.entries]) {
      if (!key.startsWith(`${modelId}:`)) continue;
      entry.host.remove(entry.object);
      entry.element.remove();
      this.entries.delete(key);
    }
  }

  clear() {
    for (const entry of this.entries.values()) {
      entry.host.remove(entry.object);
      entry.element.remove();
    }
    this.entries.clear();
  }

  kindLabel(kind) {
    return LABEL_KINDS[kind]?.label ?? kind;
  }
}
