import * as XLSX from 'xlsx';

/* ================================================================
 * 資料模型（兩種來源格式都轉成這個樣子）
 *
 * dataset = {
 *   pitName, siteName, format: 'structured' | 'legacy',
 *   groups:  [{ index, id, name, datumNote, datumHeight, tie }]   // 基準（每次打樁一個）
 *   points:  { key: { key, x, n, side, active, note } }          // 點位，key 如 1、4ab、9+
 *   records: [{ no, id, srcRow, sheetRow, group, raw, values, extra, note }]
 *   warnings: [string]
 * }
 * 一筆 record = 一列 = 所有點位（1…13、4ab/4cd、8ab/8cd、13ab/13cd、9+）的一次量測，代表一個平面。
 * raw = 原始讀值（自基準面向下量，cm），values = 距地表深度 = raw − 基準高於地表的高度。
 * extra = 未啟用（座標未填）點位的讀值，只列出、不參與曲面。
 * 日期、層位（AB-U / CD-U）等欄位不使用。
 * ================================================================ */

// 點位標題，例如 "1"、"4ab"、"13cd"
const POINT_RE = /^(\d{1,2})(ab|cd)?$/i;

/** 依工作表名稱判斷格式並解析 */
export function parseWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const ds = wb.SheetNames.includes('紀錄') ? parseStructured(wb) : parseLegacy(wb);
  applyDatums(ds);
  return ds;
}

/* ---------------- 共用小工具 ---------------- */
const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v == null || v === '' ? null : String(v).trim());
const bool = (v) => v === true || /^(true|1|是|y|yes)$/i.test(String(v ?? '').trim());

/** 「距地表10cm」「地上33.3」→ 10、33.3（基準面高於地表的 cm） */
export function parseDatum(note) {
  const m = String(note ?? '').match(/-?\d+(\.\d+)?/);
  return m ? +m[0] : 0;
}

/** 依各基準 datumHeight 將讀值換算為距地表深度：values = raw − datumHeight */
export function applyDatums(ds) {
  for (const rec of ds.records) {
    const h = ds.groups[rec.group].datumHeight;
    rec.values = Object.fromEntries(Object.entries(rec.raw).map(([k, v]) => [k, +(v - h).toFixed(2)]));
  }
}

/** 標準 13 點版面的點位表 */
function defaultPoints() {
  const pts = {};
  for (const [id, [x, n]] of Object.entries(POINTS)) {
    if (SPLIT.has(id)) {
      pts[id + 'ab'] = { key: id + 'ab', x, n, side: 'AB', active: true, note: '' };
      pts[id + 'cd'] = { key: id + 'cd', x, n, side: 'CD', active: true, note: '' };
    } else {
      pts[id] = { key: id, x, n, side: x > 0 ? 'AB' : 'CD', active: true, note: '' };
    }
  }
  return pts;
}

/** 是否為標準 13 點版面上的點位 */
const isStandardKey = (key) => POINT_RE.test(key) && !!POINTS[key.replace(/(ab|cd)$/i, '')];

/** 點位是否參與曲面：啟用且有座標（標準點位或補充點位如 9+） */
function isSurfacePoint(points, key) {
  return !!points[key]?.active;
}

/* ---------------- 結構化格式（Google 試算表範本） ---------------- */
function parseStructured(wb) {
  const table = (name) => {
    const ws = wb.Sheets[name];
    if (!ws) return [];
    return XLSX.utils.sheet_to_json(ws, { raw: true, defval: null }).map((row) => {
      const o = {};
      for (const [k, v] of Object.entries(row)) o[String(k).trim()] = v;
      return o;
    });
  };
  const warnings = [];

  const pits = table('探坑');
  const allRecs = table('紀錄').filter((r) => Object.values(r).some((v) => v != null && v !== ''));
  const pitIds = [...new Set([...pits.map((p) => str(p.pit_id)), ...allRecs.map((r) => str(r.pit_id))].filter(Boolean))];
  const pitName = pitIds[0] ?? '探坑';
  if (pitIds.length > 1) warnings.push(`試算表含多個探坑（${pitIds.join('、')}），目前只顯示 ${pitName}`);
  const pitRow = pits.find((p) => str(p.pit_id) === pitName) ?? {};
  const samePit = (r) => !str(r.pit_id) || str(r.pit_id) === pitName;

  // 點位
  const points = {};
  for (const r of table('點位').filter(samePit)) {
    const key = str(r.point);
    if (!key) continue;
    const x = num(r.x_cm);
    const n = num(r.y_cm);
    const active = bool(r['啟用']) && x != null && n != null;
    let side = (str(r['半邊']) ?? '').toUpperCase();
    if (side !== 'AB' && side !== 'CD') side = x != null && x < 0 ? 'CD' : 'AB';
    points[key.toLowerCase()] = { key, x, n, side, active, note: str(r['備註']) ?? '' };
  }
  if (!Object.keys(points).length) {
    warnings.push('找不到「點位」工作表，改用標準 13 點版面');
    Object.assign(points, defaultPoints());
  }
  for (const p of Object.values(points)) {
    const id = p.key.replace(/(ab|cd)$/i, '');
    const std = POINTS[id];
    if (p.active && std && POINT_RE.test(p.key) && (std[0] !== p.x || std[1] !== p.n)) {
      warnings.push(`點位 ${p.key} 的座標 (${p.x}, ${p.n}) 與標準版面 (${std[0]}, ${std[1]}) 不同；曲面仍依標準版面繪製`);
    }
  }

  // 基準
  const groups = [];
  const byId = {};
  for (const r of table('基準').filter(samePit)) {
    const id = str(r.datum_id);
    if (!id) continue;
    const height = num(r['高於地表_cm']);
    const g = {
      index: groups.length,
      id,
      name: str(r['名稱']) ?? id,
      datumNote: str(r['標準高度_原文']) ?? (height != null ? `高於地表 ${height} cm` : null),
      datumHeight: height ?? 0,
      tie: str(r['參考量測']),
    };
    if (height == null) warnings.push(`基準 ${id} 未填「高於地表_cm」，以 0 計`);
    groups.push(g);
    byId[id] = g;
  }
  const groupFor = (id) => {
    if (id && byId[id]) return byId[id];
    const key = id ?? '(未指定)';
    if (!byId[key]) {
      warnings.push(`紀錄使用了未定義的基準「${key}」，以 0 cm 計`);
      byId[key] = { index: groups.length, id: key, name: key, datumNote: null, datumHeight: 0, tie: null };
      groups.push(byId[key]);
    }
    return byId[key];
  };

  // 紀錄：一列一個平面。點位欄以「點位」表為準；看起來像點位但未定義的欄位列為 extra 並警告；
  // 其他欄位（例如日期、層位）一律忽略。
  const looksLikePoint = (k) => POINT_RE.test(k) || /^\d{1,2}\s*[+＋]$/.test(k);
  const undefinedCols = new Set();
  const records = [];
  allRecs.filter(samePit).forEach((r, i) => {
    const raw = {};
    const extra = {};
    const nonNumeric = [];
    for (const [k, v] of Object.entries(r)) {
      const key = k.toLowerCase();
      const known = !!points[key];
      if (!known && !looksLikePoint(k)) continue;
      if (v == null || v === '') continue;
      const val = num(v);
      if (val == null || typeof v !== 'number') nonNumeric.push(`${k}=${v}`);
      if (val == null) continue;
      if (!known) undefinedCols.add(k);
      if (isSurfacePoint(points, key)) raw[key] = val;
      else extra[k] = val;
    }
    if (!Object.keys(raw).length && !Object.keys(extra).length) return;
    const g = groupFor(str(r.datum_id));
    const notes = [str(r['備註'])];
    if (nonNumeric.length) notes.push(`非數字讀值：${nonNumeric.join('、')}`);
    records.push({
      no: records.length + 1,
      id: str(r.record_id) ?? `#${i + 2}`,
      srcRow: num(r['原始列']),
      sheetRow: i + 2,
      group: g.index,
      raw,
      values: {},
      extra,
      note: notes.filter(Boolean).join('；') || null,
    });
  });
  if (allRecs.some((r) => '半邊' in r)) {
    warnings.push('「紀錄」表仍是依半邊拆列的舊格式（有「半邊」欄），每列只會畫出一半；請改用一列一平面的新範本');
  }
  if (undefinedCols.size) warnings.push(`紀錄表有未在「點位」表定義的欄位：${[...undefinedCols].join('、')}（只列出讀值，不參與繪圖）`);

  return {
    format: 'structured',
    pitName,
    siteName: str(pitRow['遺址']),
    groups,
    points,
    records,
    warnings,
  };
}

/* ---------------- 舊版寬表（原始 xlsx） ----------------
 * 某一列為點位標題（1, 2, 3, 4ab, 4cd ...），其下每一列為一筆紀錄（一個平面）；日期、AB-U、CD-U 欄不使用。
 * 第一欄出現「深度」以外的文字（如「新樁」）或「標準高度」改變時，開始新的基準群組；
 * 「新樁」該列數值為參考量測，不列入紀錄。
 */
function parseLegacy(wb) {
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });

  let headerIdx = -1;
  let best = 0;
  rows.forEach((r, i) => {
    const n = r.filter((c) => c != null && POINT_RE.test(String(c).trim())).length;
    if (n > best) {
      best = n;
      headerIdx = i;
    }
  });
  if (best < 5) throw new Error('找不到點位標題列（需包含 1、2、3、4ab… 等欄位），或缺少「紀錄」工作表');

  const points = defaultPoints();
  const header = rows[headerIdx].map((c) => (c == null ? '' : String(c).trim()));
  const pointCols = [];
  header.forEach((t, j) => {
    const m = t.match(POINT_RE);
    if (m && +m[1] >= 1 && +m[1] <= 13) pointCols.push({ j, key: m[1] + (m[2] || '').toLowerCase() });
    else if (/^\d{1,2}\s*[+＋]/.test(t)) {
      pointCols.push({ j, key: t });
      const known = EXTRA_POINTS[t];
      points[t] = known
        ? { key: t, x: known.x, n: known.n, side: known.x < 0 ? 'CD' : 'AB', active: true, note: known.note }
        : { key: t, x: null, n: null, side: 'AB', active: false, note: '座標待補' };
    }
  });

  const datumCol = header.findIndex((t) => t.includes('標準'));

  const groups = [];
  const newGroup = (name) => {
    const g = { index: groups.length, id: `D${groups.length + 1}`, name, datumNote: null, datumHeight: 0, tie: null, count: 0 };
    groups.push(g);
    return g;
  };
  const setDatum = (g, note) => {
    g.datumNote = note;
    g.datumHeight = parseDatum(note);
  };

  let group = null;
  const records = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const tag = str(r[0]);
    const note = datumCol >= 0 ? str(r[datumCol]) : null;
    const vals = {};
    for (const { j, key } of pointCols) {
      const v = num(r[j]);
      if (v != null) vals[key] = v;
    }
    const hasValues = Object.keys(vals).length > 0;

    if (tag && tag !== '深度') {
      group = newGroup(tag);
      if (hasValues) group.tie = Object.entries(vals).map(([k, v]) => `${k}=${v}`).join('; ');
      if (note) setDatum(group, note);
      continue;
    }
    if (note) {
      if (!group || (group.count > 0 && group.datumNote && parseDatum(note) !== group.datumHeight)) group = newGroup(null);
      if (!group.datumNote) setDatum(group, note);
    }
    if (!hasValues) continue;
    if (!group) group = newGroup(null);

    const raw = {};
    const extra = {};
    for (const [k, v] of Object.entries(vals)) {
      if (points[k]?.active !== false) raw[k] = v;
      else extra[k] = v;
    }
    group.count++;
    records.push({
      no: records.length + 1,
      id: `R${String(i + 1).padStart(3, '0')}`,
      srcRow: i + 1,
      group: group.index,
      raw,
      values: {},
      extra,
      note: null,
    });
  }
  groups.forEach((g, k) => {
    if (!g.name) g.name = `第 ${k + 1} 群`;
  });

  return {
    format: 'legacy',
    pitName: (str(rows[0]?.[0]) || sheetName).split(/[/／]/)[0].trim() || sheetName,
    siteName: null,
    groups,
    points,
    records,
    warnings: [],
  };
}

/** 第 i 筆紀錄的繪圖資料（一列即一個完整平面） */
export function composeView(ds, i) {
  const rec = ds.records[i];
  return { rec, values: rec.values, group: rec.group, points: ds.points, records: ds.records, index: i };
}

/* ---------------- 幾何 ----------------
 * 平面座標：x 向右（東）、n 向上（北），單位 cm，探坑中心為原點，範圍 -100 ~ 100。
 *
 *   7----8----1
 *   | 12 |  9 |
 *   6    13   2
 *   | 11 | 10 |
 *   5----4----3
 *
 * 4、8、13 位於中線上，向右（ab，A/B 象限）與向左（cd，C/D 象限）各有一個深度。
 */
export const POINTS = {
  1: [100, 100],
  2: [100, 0],
  3: [100, -100],
  4: [0, -100],
  5: [-100, -100],
  6: [-100, 0],
  7: [-100, 100],
  8: [0, 100],
  9: [50, 50],
  10: [50, -50],
  11: [-50, -50],
  12: [-50, 50],
  13: [0, 0],
};
export const SPLIT = new Set(['4', '8', '13']);

// 舊版寬表中已確認座標的補充點位（結構化格式則以「點位」工作表為準）
export const EXTRA_POINTS = {
  '9+': { x: 50, n: 0, note: '位於 9 與 10 中間' },
};

export const HALVES = {
  ab: { label: '右半（AB）', side: 'AB', ids: ['1', '2', '3', '4', '8', '13', '9', '10'] },
  cd: { label: '左半（CD）', side: 'CD', ids: ['5', '6', '7', '4', '8', '13', '11', '12'] },
};

// 象限：x/n 範圍、四角點位（依 (x0,n0) (x1,n0) (x0,n1) (x1,n1) 順序）與中心點
export const QUADS = [
  { name: 'A', half: 'ab', x: [0, 100], n: [0, 100], corners: ['13', '2', '8', '1'], center: '9' },
  { name: 'B', half: 'ab', x: [0, 100], n: [-100, 0], corners: ['4', '3', '13', '2'], center: '10' },
  { name: 'C', half: 'cd', x: [-100, 0], n: [-100, 0], corners: ['5', '4', '6', '13'], center: '11' },
  { name: 'D', half: 'cd', x: [-100, 0], n: [0, 100], corners: ['6', '13', '7', '8'], center: '12' },
];

export function nodeKey(id, half) {
  return SPLIT.has(id) ? id + half : id;
}

/** 某半邊上某點位對應的欄位鍵；分裂點位用 4ab/4cd，若只有 "4" 則退回 "4" */
function lookupKey(values, id, half) {
  if (SPLIT.has(id)) return values[id + half] != null ? id + half : values[id] != null ? id : null;
  return values[id] != null ? id : null;
}

/** 往上找此點位最後一筆有紀錄的值；找不到回傳 null */
function inheritedValue(view, id, half) {
  for (let j = view.index - 1; j >= 0; j--) {
    const rec = view.records[j];
    const key = lookupKey(rec.values, id, half);
    if (key) return { v: rec.values[key], raw: rec.raw[key], from: rec.id };
  }
  return null;
}

/** 象限的四角與中心是否都有高度（本筆或沿用）；缺任一點就不繪製該象限 */
export function hasSurface(halfRes, quad) {
  return [...quad.corners, quad.center].every((id) => halfRes.nodes[id].v != null);
}

/**
 * 解出一個畫面（composeView 的結果）在兩個半邊的節點深度。
 * measured = 本筆量測；否則逐點往上沿用最後一筆有紀錄的值（from = 來源 record_id），一律不推估。
 * 沿用的是距地表深度，因此跨基準時位置仍正確；上方都沒有紀錄時 v = null。
 * 補充點位（例如 9+）只用本筆讀值，有值時以局部隆起修正曲面，使曲面通過該點，且不影響其他點位。
 */
export function resolveView(view) {
  const points = view.points ?? {};
  const extraPts = Object.values(points).filter((p) => p.active && !isStandardKey(p.key.toLowerCase()));

  const result = {};
  for (const half of ['ab', 'cd']) {
    const nodes = {};
    let knownCount = 0;
    for (const id of HALVES[half].ids) {
      const key = lookupKey(view.values, id, half);
      const own = key ? { v: view.values[key], raw: view.rec.raw[key], from: null } : null;
      const src = own ?? inheritedValue(view, id, half);
      const [x, n] = POINTS[id];
      if (own) knownCount++;
      nodes[id] = {
        id,
        key: nodeKey(id, half),
        x,
        n,
        v: src?.v ?? null,
        raw: src?.raw ?? null,
        from: src?.from ?? null,
        measured: !!own,
      };
    }
    // 本半邊的補充點位
    const extras = [];
    for (const p of extraPts) {
      if (p.side !== HALVES[half].side) continue;
      const k = p.key.toLowerCase();
      const v = view.values[k];
      if (v != null) knownCount++;
      extras.push({ key: p.key, x: p.x, n: p.n, v, measured: v != null });
    }

    // 補充點位的局部修正：半徑取到最近的其他點位與中線的距離，因此在其他點位上修正量為 0
    const res = { nodes, knownCount, extras, bumps: [] };
    for (const e of extras) {
      if (e.v == null) continue;
      const quad = QUADS.find((q) => q.half === half && e.x >= q.x[0] && e.x <= q.x[1] && e.n >= q.n[0] && e.n <= q.n[1]);
      if (!quad || !hasSurface(res, quad)) continue;
      let R = Math.abs(e.x);
      for (const [x, n] of Object.values(POINTS)) R = Math.min(R, Math.hypot(x - e.x, n - e.n));
      for (const o of extras) if (o !== e) R = Math.min(R, Math.hypot(o.x - e.x, o.n - e.n));
      if (R < 1) continue;
      const base = depthAt(res, quad, (e.x - quad.x[0]) / (quad.x[1] - quad.x[0]), (e.n - quad.n[0]) / (quad.n[1] - quad.n[0]));
      res.bumps.push({ x: e.x, n: e.n, R, delta: e.v - base });
    }
    result[half] = res;
  }
  return result;
}

/** 某半邊在象限內 (s,t) 的曲面深度：標準曲面 + 補充點位修正 */
export function depthAt(halfRes, quad, s, t) {
  let d = quadDepth(quad, halfRes.nodes, s, t);
  if (!halfRes.bumps?.length) return d;
  const x = quad.x[0] + (quad.x[1] - quad.x[0]) * s;
  const n = quad.n[0] + (quad.n[1] - quad.n[0]) * t;
  for (const b of halfRes.bumps) {
    const r2 = ((x - b.x) ** 2 + (n - b.n) ** 2) / (b.R * b.R);
    if (r2 < 1) d += b.delta * (1 - r2) ** 2;
  }
  return d;
}

/** 在象限內 (s,t ∈ [0,1]) 的深度：四角雙線性 + 中心點修正（泡泡函數，邊上為 0） */
export function quadDepth(quad, nodes, s, t) {
  const [a, b, c, d] = quad.corners.map((id) => nodes[id].v);
  const bil = (ss, tt) => a * (1 - ss) * (1 - tt) + b * ss * (1 - tt) + c * (1 - ss) * tt + d * ss * tt;
  const bubble = 16 * s * (1 - s) * t * (1 - t);
  return bil(s, t) + (nodes[quad.center].v - bil(0.5, 0.5)) * bubble;
}
