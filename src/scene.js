import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { QUADS, composeView, resolveView, depthAt } from './data.js';

const SEG = 24; // 每個象限的網格細分數
const HALF = 100; // 探坑半寬（cm）

// 淺 → 深 的土色色階
const RAMP = ['#f3dfae', '#d9a55e', '#a86a3a', '#6b3f24', '#3a2216'].map((c) => new THREE.Color(c));

export function rampColor(t, out = new THREE.Color()) {
  t = Math.min(1, Math.max(0, t));
  const f = t * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(f));
  return out.copy(RAMP[i]).lerp(RAMP[i + 1], f - i);
}
export const RAMP_CSS = RAMP.map((c) => '#' + c.getHexString());

// 資料群組（不同基準面）的代表色，避開土色色階與藍色量測標記
export const GROUP_CSS = ['#2a9d8f', '#d1495b', '#8e6cc9', '#e9a23b', '#4c7d2b'];
const GROUP_COLORS = GROUP_CSS.map((c) => new THREE.Color(c));
export const groupColor = (i) => GROUP_COLORS[i % GROUP_COLORS.length];

// 平面座標 (x 東, n 北, depth cm) → three 世界座標（y 向上，北為 -z）
const toWorld = (x, n, depth, exag) => new THREE.Vector3(x, -depth * exag, -n);

function label(text, className) {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return new CSS2DObject(el);
}

export class PitScene {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    container.appendChild(this.labelRenderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
    this.camera.position.set(200, 150, 245);
    this.controls = new OrbitControls(this.camera, this.labelRenderer.domElement);
    this.controls.target.set(0, -35, 0);
    this.controls.enableDamping = true;
    this.controls.update();

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x6b5a48, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(150, 300, 120);
    this.scene.add(sun);

    this.datumGroup = new THREE.Group();
    this.layerGroup = new THREE.Group();
    this.ghostGroup = new THREE.Group();
    this.scene.add(this.datumGroup, this.ghostGroup, this.layerGroup);

    this.options = { exag: 1, labels: true, ghosts: false, datum: true, colorMode: 'depth', valueMode: 'raw' };
    this.depthRange = [0, 80];

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer.render(this.scene, this.camera);
    });
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    // 視窗較窄時加大視角，讓整個探坑留在畫面內
    this.camera.fov = Math.min(70, 40 * Math.max(1, 1.2 / this.camera.aspect));
    this.camera.updateProjectionMatrix();
  }

  setData(dataset) {
    this.dataset = dataset;
    this.currentIndex = -1;
    this.refresh();
  }

  /** 基準面換算改變後重算深度範圍並重繪 */
  refresh() {
    const all = this.dataset.records.flatMap((r) => Object.values(r.values));
    if (!all.length) all.push(0);
    this.depthRange = [Math.min(0, Math.floor(Math.min(...all) / 10) * 10), Math.ceil(Math.max(...all) / 10) * 10];
    this.rebuild();
  }

  /** 顯示第 i 筆紀錄（另一半邊沿用前一筆） */
  showRecord(i) {
    this.currentIndex = i;
    this.rebuild();
  }

  setOptions(opts) {
    Object.assign(this.options, opts);
    this.rebuild();
  }

  rebuild() {
    for (const g of [this.datumGroup, this.layerGroup, this.ghostGroup]) clear(g);
    const ds = this.dataset;
    this.current = ds && this.currentIndex >= 0 ? composeView(ds, this.currentIndex) : null;
    this.buildDatum();
    if (!ds) return;
    if (this.options.ghosts) {
      ds.records.forEach((rec, k) => {
        if (k === this.currentIndex || !Object.keys(rec.values).length) return;
        this.ghostGroup.add(this.buildSurface(resolveView(composeView(ds, k)), { ghost: true, group: rec.group }));
      });
    }
    if (this.current) {
      const resolved = resolveView(this.current);
      this.layerGroup.add(this.buildSurface(resolved, { group: this.current.group }));
      this.layerGroup.add(this.buildWalls(resolved));
      this.layerGroup.add(this.buildMarkers(resolved));
      this.layerGroup.add(this.buildExtraMarkers(resolved));
      for (const half of ['ab', 'cd']) {
        if (resolved[half].knownCount) continue;
        const nodes = resolved[half].nodes;
        const l = label('此半邊無量測（推估）', 'lbl lbl-warn');
        l.position.copy(toWorld(half === 'ab' ? 50 : -50, 0, nodes['13'].v, this.options.exag));
        this.layerGroup.add(l);
      }
    }
  }

  /* ---------- 基準面 ---------- */
  buildDatum() {
    const g = this.datumGroup;
    g.visible = this.options.datum;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF * 2, HALF * 2),
      new THREE.MeshBasicMaterial({ color: 0x3d8bfd, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.renderOrder = 2;
    g.add(plane);

    const lineMat = new THREE.LineBasicMaterial({ color: 0x3d8bfd });
    const sq = [
      [-HALF, -HALF], [HALF, -HALF], [HALF, HALF], [-HALF, HALF], [-HALF, -HALF],
    ].map(([x, n]) => toWorld(x, n, 0, 1));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(sq), lineMat));
    const dashed = new THREE.LineDashedMaterial({ color: 0x3d8bfd, dashSize: 6, gapSize: 4, transparent: true, opacity: 0.7 });
    for (const seg of [
      [[0, -HALF], [0, HALF]],
      [[-HALF, 0], [HALF, 0]],
    ]) {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(seg.map(([x, n]) => toWorld(x, n, 0, 1))), dashed);
      l.computeLineDistances();
      g.add(l);
    }

    const multi = (this.dataset?.groups.length ?? 0) > 1;
    const lbl = label(multi ? '地表 0 cm（各群基準面已換算）' : '地表 0 cm', 'lbl lbl-datum');
    lbl.position.copy(toWorld(-HALF, HALF, 0, 1)).add(new THREE.Vector3(0, 6, 0));
    lbl.center.set(0, 1);
    g.add(lbl);

    // 目前紀錄所屬群組的基準面（高於地表 datumHeight cm）
    const grp = this.current && this.dataset.groups[this.current.group];
    if (grp && grp.datumHeight) {
      const ex0 = this.options.exag;
      const col = groupColor(grp.index);
      const ring = [[-HALF, -HALF], [HALF, -HALF], [HALF, HALF], [-HALF, HALF], [-HALF, -HALF]].map(([x, n]) => toWorld(x, n, -grp.datumHeight, ex0));
      const dl = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), new THREE.LineDashedMaterial({ color: col, dashSize: 5, gapSize: 4 }));
      dl.computeLineDistances();
      g.add(dl);
      const gl = label(`${grp.name} 基準面 +${grp.datumHeight} cm`, 'lbl lbl-group');
      gl.element.style.color = '#' + col.getHexString();
      gl.position.copy(toWorld(HALF, HALF, -grp.datumHeight, ex0)).add(new THREE.Vector3(0, 4, 0));
      gl.center.set(1, 1);
      g.add(gl);
    }

    // 方位與象限標示
    for (const [t, x, n] of [
      ['A', 50, 50], ['B', 50, -50], ['C', -50, -50], ['D', -50, 50],
    ]) {
      const q = label(t, 'lbl lbl-quad');
      q.position.copy(toWorld(x, n, 0, 1));
      g.add(q);
    }

    // 深度量尺（放在 5 號角外側）
    // 距地表量尺：刻度 = 距地表深度；原始讀值量尺：刻度 = 目前紀錄所屬基準的讀值（位置 = 讀值 − 基準高度）
    const mode = this.options.valueMode;
    const rn = -HALF - 14;
    if (mode !== 'raw') this.buildRuler(g, -HALF - 14, rn, 0, '距地表 cm', null);
    if (mode !== 'ground' && grp) {
      const col = '#' + groupColor(grp.index).getHexString();
      this.buildRuler(g, mode === 'both' ? -HALF - 44 : -HALF - 14, rn, grp.datumHeight, `讀值 cm（${grp.id}）`, col);
    }
  }

  /** 垂直量尺：offset = 刻度值與距地表深度的差（刻度值 v 畫在深度 v − offset） */
  buildRuler(g, rx, rn, offset, title, color) {
    const [minD, maxD] = this.depthRange;
    const ex = this.options.exag;
    const lo = Math.floor((minD + offset) / 10) * 10;
    const hi = Math.ceil((maxD + offset) / 10) * 10;
    const tickMat = new THREE.LineBasicMaterial({ color: color ?? 0x8a8f98 });
    const ticks = [toWorld(rx, rn, lo - offset, ex), toWorld(rx, rn, hi - offset, ex)];
    for (let v = lo; v <= hi; v += 10) {
      ticks.push(toWorld(rx, rn, v - offset, ex), toWorld(rx + 5, rn, v - offset, ex));
      const t = label(`${v}`, 'lbl lbl-tick');
      if (color) t.element.style.color = color;
      t.position.copy(toWorld(rx - 3, rn, v - offset, ex));
      t.center.set(1, 0.5);
      g.add(t);
    }
    g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ticks), tickMat));
    const unit = label(title, 'lbl lbl-tick');
    if (color) unit.element.style.color = color;
    unit.position.copy(toWorld(rx, rn, hi - offset, ex)).add(new THREE.Vector3(0, -8, 0));
    g.add(unit);
  }

  /* ---------- 地面 ---------- */
  buildSurface(resolved, { ghost, group = 0 }) {
    const ex = this.options.exag;
    const [d0, d1] = this.depthRange;
    const positions = [];
    const colors = [];
    const index = [];
    const c = new THREE.Color();
    const seg = ghost ? 8 : SEG;

    const gray = new THREE.Color(0xc9cdd2);
    const byGroup = this.options.colorMode === 'group';
    const gc = groupColor(group);
    const black = new THREE.Color(0x000000);
    const white = new THREE.Color(0xffffff);
    // 依群組著色時，以群組色為底、深淺表示深度，仍保留起伏的可讀性
    const tint = (t, out) =>
      byGroup ? out.copy(gc).lerp(t < 0.5 ? white : black, Math.abs(t - 0.5) * 0.9) : rampColor(t, out);
    for (const quad of QUADS) {
      const nodes = resolved[quad.half].nodes;
      // 整個半邊都沒有量測值時，以灰階呈現（僅為推估）
      const unmeasured = !ghost && resolved[quad.half].knownCount === 0;
      const base = positions.length / 3;
      for (let j = 0; j <= seg; j++) {
        for (let i = 0; i <= seg; i++) {
          const s = i / seg;
          const t = j / seg;
          const depth = depthAt(resolved[quad.half], quad, s, t);
          const x = quad.x[0] + (quad.x[1] - quad.x[0]) * s;
          const n = quad.n[0] + (quad.n[1] - quad.n[0]) * t;
          const p = toWorld(x, n, depth, ex);
          positions.push(p.x, p.y, p.z);
          tint((depth - d0) / (d1 - d0), c);
          if (unmeasured) c.lerp(gray, 0.75);
          colors.push(c.r, c.g, c.b);
        }
      }
      for (let j = 0; j < seg; j++) {
        for (let i = 0; i < seg; i++) {
          const a = base + j * (seg + 1) + i;
          const b = a + 1;
          const d = a + seg + 1;
          const e = d + 1;
          index.push(a, d, b, b, d, e);
        }
      }
    }

    // 中線 x=0 上 ab 與 cd 之間的高低差立面
    if (!ghost) {
      const edge = (half, n) => {
        const quad = QUADS.find((q) => q.half === half && n >= q.n[0] && n <= q.n[1]);
        const s = half === 'ab' ? 0 : 1;
        const t = (n - quad.n[0]) / (quad.n[1] - quad.n[0]);
        return depthAt(resolved[half], quad, s, t);
      };
      const steps = SEG * 2;
      const base = positions.length / 3;
      for (let k = 0; k <= steps; k++) {
        const n = -HALF + (2 * HALF * k) / steps;
        for (const half of ['ab', 'cd']) {
          const depth = edge(half, n);
          const p = toWorld(0, n, depth, ex);
          positions.push(p.x, p.y, p.z);
          tint((depth - d0) / (d1 - d0), c).multiplyScalar(0.7);
          colors.push(c.r, c.g, c.b);
        }
      }
      for (let k = 0; k < steps; k++) {
        const a = base + k * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();

    if (ghost) {
      return new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: gc, wireframe: true, transparent: true, opacity: 0.22, depthWrite: false }),
      );
    }
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 }),
    );
    // 疊上細網格線
    const wire = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0x000000, wireframe: true, transparent: true, opacity: 0.06, depthWrite: false }),
    );
    const g = new THREE.Group();
    g.add(mesh, wire);
    return g;
  }

  /* ---------- 坑壁：基準面至地面 ---------- */
  buildWalls(resolved) {
    const ex = this.options.exag;
    const positions = [];
    const index = [];
    // 每段外框邊：所在象限、沿邊參數化
    const edges = [];
    for (const quad of QUADS) {
      if (Math.abs(quad.n[1]) === HALF) edges.push({ quad, fixed: 't', val: 1 });
      if (Math.abs(quad.n[0]) === HALF) edges.push({ quad, fixed: 't', val: 0 });
      if (Math.abs(quad.x[1]) === HALF) edges.push({ quad, fixed: 's', val: 1 });
      if (Math.abs(quad.x[0]) === HALF) edges.push({ quad, fixed: 's', val: 0 });
    }
    for (const { quad, fixed, val } of edges) {
      const nodes = resolved[quad.half].nodes;
      const base = positions.length / 3;
      for (let k = 0; k <= SEG; k++) {
        const u = k / SEG;
        const s = fixed === 's' ? val : u;
        const t = fixed === 't' ? val : u;
        const x = quad.x[0] + (quad.x[1] - quad.x[0]) * s;
        const n = quad.n[0] + (quad.n[1] - quad.n[0]) * t;
        const top = toWorld(x, n, 0, ex);
        const bot = toWorld(x, n, depthAt(resolved[quad.half], quad, s, t), ex);
        positions.push(top.x, top.y, top.z, bot.x, bot.y, bot.z);
      }
      for (let k = 0; k < SEG; k++) {
        const a = base + k * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(index);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0x8b6a4f, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }),
    );
    mesh.renderOrder = 1;
    return mesh;
  }

  /* ---------- 點位標記 ---------- */
  /**
   * 點位數值標示文字。depth = 距地表深度；raw = 原始讀值（量測點才有，原樣顯示以便對照原表）。
   * 推估點沒有讀值，以 ≈ 標示，讀值模式下為「推估深度 + 基準高度」。
   */
  valueText(depth, raw) {
    const h = this.dataset.groups[this.current.group].datumHeight;
    const est = raw == null;
    const g = depth.toFixed(1);
    const r = est ? (depth + h).toFixed(1) : String(raw);
    const pre = est ? '≈' : '';
    if (this.options.valueMode === 'ground') return pre + g;
    if (this.options.valueMode === 'both') return `${pre}${r} → ${g}`;
    return pre + r;
  }

  buildMarkers(resolved) {
    const rec = this.current.rec;
    const ex = this.options.exag;
    const g = new THREE.Group();
    const sphere = new THREE.SphereGeometry(2.4, 16, 12);
    const measuredMat = new THREE.MeshStandardMaterial({ color: 0x1f6feb, roughness: 0.4 });
    const interpMat = new THREE.MeshBasicMaterial({ color: 0x9aa3ad, wireframe: true });
    const stemMat = new THREE.LineBasicMaterial({ color: 0x1f6feb, transparent: true, opacity: 0.35 });

    for (const half of ['ab', 'cd']) {
      for (const node of Object.values(resolved[half].nodes)) {
        // 分裂點位稍微往各自半邊偏移，讓兩個標記可分辨
        const off = node.key !== node.id ? (half === 'ab' ? 3 : -3) : 0;
        const p = toWorld(node.x + off, node.n, node.v, ex);
        const m = new THREE.Mesh(sphere, node.measured ? measuredMat : interpMat);
        m.position.copy(p);
        g.add(m);
        if (node.measured) {
          g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([toWorld(node.x + off, node.n, 0, ex), p]), stemMat));
        }
        if (this.options.labels) {
          const text = `${node.key}  ${this.valueText(node.v, node.measured ? rec.raw[node.key] ?? rec.raw[node.id] : null)}`;
          const l = label(text, `lbl lbl-pt ${node.measured ? '' : 'interp'} ${off > 0 ? 'right' : off < 0 ? 'left' : ''}`);
          l.position.copy(p);
          l.center.set(off < 0 ? 1.05 : off > 0 ? -0.05 : 0.5, 1.3);
          g.add(l);
        }
      }
    }
    return g;
  }

  /* ---------- 補充點位（例如 9+）：菱形標記，只在有讀值時顯示 ---------- */
  buildExtraMarkers(resolved) {
    const rec = this.current.rec;
    const ex = this.options.exag;
    const g = new THREE.Group();
    const geo = new THREE.OctahedronGeometry(3.2);
    const measuredMat = new THREE.MeshStandardMaterial({ color: 0x1f6feb, roughness: 0.4 });
    const stemMat = new THREE.LineBasicMaterial({ color: 0x1f6feb, transparent: true, opacity: 0.35 });
    for (const half of ['ab', 'cd']) {
      for (const e of resolved[half].extras) {
        if (e.v == null) continue;
        const p = toWorld(e.x, e.n, e.v, ex);
        const m = new THREE.Mesh(geo, measuredMat);
        m.position.copy(p);
        g.add(m);
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([toWorld(e.x, e.n, 0, ex), p]), stemMat));
        if (this.options.labels) {
          const l = label(`${e.key}  ${this.valueText(e.v, rec.raw[e.key.toLowerCase()])}`, 'lbl lbl-pt extra');
          l.position.copy(p);
          l.center.set(0.5, 1.3);
          g.add(l);
        }
      }
    }
    return g;
  }

  resetView() {
    this.camera.position.set(200, 150, 245);
    this.controls.target.set(0, -35, 0);
  }
}

function clear(group) {
  for (const child of [...group.children]) {
    child.traverse((o) => {
      if (o.isCSS2DObject) o.element.remove();
      o.geometry?.dispose();
    });
    group.remove(child);
  }
}
