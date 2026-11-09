import './style.css';
import { parseWorkbook, composeView, resolveView, applyDatums, HALVES } from './data.js';
import { PitScene, RAMP_CSS, GROUP_CSS } from './scene.js';
import { sheetIdFrom, fetchSheet, sheetUrl } from './sheets.js';

const STORE_KEY = 'pit-viewer:sheet';
const MODE_KEY = 'pit-viewer:valueMode';
const gcss = (i) => GROUP_CSS[i % GROUP_CSS.length];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const $ = (id) => document.getElementById(id);
const pit = new PitScene($('viewport'));
let dataset = null;
let selected = -1;
let source = null; // { kind: 'sheet', id } | { kind: 'file', name }
let lastDiff = null; // 重新讀取同一份試算表時與上次的差異

const store = {
  get: () => {
    try {
      return localStorage.getItem(STORE_KEY);
    } catch {
      return null;
    }
  },
  set: (v) => {
    try {
      if (v) localStorage.setItem(STORE_KEY, v);
      else localStorage.removeItem(STORE_KEY);
    } catch {
      /* 無法使用 localStorage 時略過 */
    }
  },
};

/* ---------------- 載入 ---------------- */
async function loadSheet(input) {
  const id = sheetIdFrom(input);
  if (!id) throw new Error('看不懂這個試算表網址，請貼上 docs.google.com/spreadsheets/d/… 的完整網址');
  setStatus('讀取 Google 試算表中…');
  const buf = await fetchSheet(id);
  const sameSheet = source?.kind === 'sheet' && source.id === id;
  source = { kind: 'sheet', id };
  store.set(id);
  load(buf, sameSheet);
  // 分享連結用 #sheet=：# 之後的內容不會送到網站伺服器
  const url = new URL(location.href);
  url.searchParams.delete('sheet');
  url.hash = `sheet=${id}`;
  history.replaceState(null, '', url);
}

/** 網址中的試算表 ID：#sheet=…（新）或 ?sheet=…（舊連結相容） */
function sheetFromUrl() {
  const hash = new URLSearchParams(location.hash.slice(1)).get('sheet');
  return hash || new URL(location.href).searchParams.get('sheet');
}

/** 忘記試算表：清除瀏覽器記錄與網址，回到空白狀態 */
function forgetSheet() {
  store.set(null);
  location.replace(location.pathname);
}

/** 以 record_id 比對兩次載入的差異 */
function diffRecords(before, after) {
  const sig = (r) => JSON.stringify([r.group, r.raw, r.extra, r.note]);
  const old = new Map(before.records.map((r) => [r.id, sig(r)]));
  const now = new Map(after.records.map((r) => [r.id, sig(r)]));
  let added = 0;
  let changed = 0;
  const changedIds = [];
  for (const [id, s] of now) {
    if (!old.has(id)) added++;
    else if (old.get(id) !== s) {
      changed++;
      changedIds.push(id);
    }
  }
  const removed = [...old.keys()].filter((id) => !now.has(id)).length;
  return { added, changed, removed, changedIds };
}

function load(buf, keepSelection) {
  const prevId = keepSelection && dataset?.records[selected]?.id;
  const before = keepSelection ? dataset : null;
  dataset = parseWorkbook(buf);
  lastDiff = before ? diffRecords(before, dataset) : null;
  pit.setData(dataset);
  document.body.classList.add('has-data');
  const site = dataset.siteName ? `${dataset.siteName} ` : '';
  $('pit-title').textContent = `${site}${dataset.pitName}`;
  $('pit-meta').textContent = `200 × 200 cm · ${dataset.records.length} 筆紀錄 · ${dataset.groups.length} 個基準`;
  renderSource();
  renderWarnings();
  renderGroups();
  updateLegend();
  renderList();
  const k = prevId ? dataset.records.findIndex((r) => r.id === prevId) : -1;
  select(k >= 0 ? k : 0);
  showError(null);
}

function renderSource() {
  const t = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  if (source.kind === 'sheet') {
    let diff = '';
    if (lastDiff) {
      const { added, changed, removed, changedIds } = lastDiff;
      diff =
        added || changed || removed
          ? `<br>與上次相比：新增 ${added}、修改 ${changed}、刪除 ${removed} 筆${changedIds.length ? `（${esc(changedIds.slice(0, 6).join('、'))}${changedIds.length > 6 ? '…' : ''}）` : ''}`
          : '<br>與上次相比：沒有變更';
    }
    $('source-info').innerHTML = `<span class="ok">✓ 已載入 Google 試算表</span> · ${t}<br>${dataset.records.length} 筆紀錄、${dataset.groups.length} 個基準、${Object.values(dataset.points).filter((p) => p.active).length} 個啟用點位${diff}<br><a href="${sheetUrl(source.id)}" target="_blank" rel="noopener">開啟試算表編輯</a>`;
    $('sheet-input').value = sheetUrl(source.id);
  } else {
    $('source-info').textContent = `本機檔案：${source.name}（僅在此瀏覽器檢視，不會上傳）`;
  }
  $('sheet-refresh').hidden = source.kind !== 'sheet';
  $('sheet-forget').hidden = !store.get();
  setStatus(null);
}

function renderWarnings() {
  const w = [...dataset.warnings];
  if (dataset.format === 'legacy') w.unshift('此為舊版寬表格式；建議改用結構化範本');
  $('warnings').hidden = !w.length;
  $('warnings').innerHTML = w.map((s) => `<li>${esc(s)}</li>`).join('');
  const inactive = Object.values(dataset.points).filter((p) => !p.active);
  $('skipped-note').hidden = !inactive.length;
  $('skipped-note').textContent = inactive.length
    ? `未啟用的點位：${inactive.map((p) => p.key).join('、')}（座標未填或停用，讀值只列在點位表）`
    : '';
}

function updateLegend() {
  $('legend-min').textContent = `${pit.depthRange[0]} cm`;
  $('legend-max').textContent = `${pit.depthRange[1]} cm`;
}

/* ---------------- 基準群組 ---------------- */
function renderGroups() {
  $('group-list').replaceChildren(
    ...dataset.groups.map((g) => {
      const recs = dataset.records.filter((r) => r.group === g.index);
      const li = document.createElement('li');
      li.style.setProperty('--gc', gcss(g.index));
      li.innerHTML = `
        <span class="swatch"></span>
        <span class="g-body">
          <b>${esc(g.id)} ${esc(g.name)}</b>
          <span class="muted small">${esc(g.datumNote ?? '未註記基準')} · ${recs.length} 筆</span>
          ${g.tie ? `<span class="muted small">參考量測：${esc(g.tie)}</span>` : ''}
        </span>
        <label class="g-datum" title="基準面高於地表（cm），僅供試算，不會寫回試算表">+<input type="number" step="0.1" value="${g.datumHeight}" />cm</label>`;
      li.querySelector('input').addEventListener('change', (e) => {
        const v = parseFloat(e.target.value);
        g.datumHeight = Number.isFinite(v) ? v : 0;
        applyDatums(dataset);
        pit.refresh();
        updateLegend();
        renderList();
        select(selected);
      });
      return li;
    }),
  );
}

/* ---------------- 紀錄清單 ---------------- */
function renderList() {
  const items = [];
  dataset.records.forEach((rec, i) => {
    if (i === 0 || dataset.records[i - 1].group !== rec.group) {
      const g = dataset.groups[rec.group];
      const head = document.createElement('li');
      head.className = 'group-head';
      head.style.setProperty('--gc', gcss(g.index));
      head.textContent = `${g.id} ${g.name}${g.datumNote ? ` · ${g.datumNote}` : ''}`;
      items.push(head);
    }
    items.push(recordItem(rec, i));
  });
  $('record-list').replaceChildren(...items);
}

function recordItem(rec, i) {
  const total = Object.values(dataset.points).filter((p) => p.active).length;
  const li = document.createElement('li');
  li.className = 'rec';
  li.dataset.index = i;
  li.style.setProperty('--gc', gcss(rec.group));
  const btn = document.createElement('button');
  btn.type = 'button';
  const depths = Object.values(rec.values);
  const raws = Object.values(rec.raw);
  const n = depths.length;
  const span = (a) => `${Math.min(...a)}–${Math.max(...a)}`;
  const mode = pit.options.valueMode;
  const range = !n
    ? '無量測值'
    : mode === 'ground'
      ? `距地表 ${span(depths)} cm`
      : mode === 'both'
        ? `讀值 ${span(raws)} → 距地表 ${span(depths)} cm`
        : `讀值 ${span(raws)} cm`;
  btn.innerHTML = `
    <span class="rec-no">${esc(rec.id)}</span>
    <span class="rec-body">
      <span class="muted small">量測 ${n}/${total} 點 · ${range}</span>
      ${rec.note ? `<span class="rec-note">⚠ ${esc(rec.note)}</span>` : ''}
    </span>`;
  btn.addEventListener('click', () => select(i));
  li.appendChild(btn);
  return li;
}

function select(i) {
  if (!dataset || i < 0 || i >= dataset.records.length) return;
  selected = i;
  pit.showRecord(i);
  const lis = [...$('record-list').querySelectorAll('li.rec')];
  lis.forEach((li) => li.classList.toggle('active', +li.dataset.index === i));
  lis[i]?.scrollIntoView({ block: 'nearest' });
  $('hint').hidden = true;
  renderTable(composeView(dataset, i));
}

/* ---------------- 點位表 ---------------- */
/** 點位表儲存格：主要數值依「數值標示」模式，另一種數值以小字附註；沿用上方紀錄的點以 ↑ 標示 */
function cellText(depth, raw, inherited = false) {
  const pre = inherited ? '↑' : '';
  const r = String(raw);
  const g = depth.toFixed(1);
  if (pit.options.valueMode === 'ground') return `${pre}${g}<span class="raw">讀值 ${pre}${r}</span>`;
  return `${pre}${r}<span class="raw">距地表 ${pre}${g}</span>`;
}

function renderTable(view) {
  const { rec } = view;
  const resolved = resolveView(view);
  const rows = [];
  for (const half of ['ab', 'cd']) {
    const { nodes, knownCount, extras } = resolved[half];
    const cells = Object.values(nodes)
      .sort((a, b) => +a.id - +b.id)
      .map((n) => {
        if (n.measured) return `<td class="m"><b>${n.key}</b>${cellText(n.v, n.raw)}</td>`;
        if (n.v == null) return `<td class="i"><b>${n.key}</b>—</td>`;
        return `<td class="i"><b>${n.key}</b>${cellText(n.v, n.raw, true)}<span class="raw">沿用 ${esc(n.from)}</span></td>`;
      });
    // 補充點位（如 9+）：只看本筆讀值，沒有時顯示「—」
    for (const e of extras) {
      const k = e.key.toLowerCase();
      if (e.measured) cells.push(`<td class="m x"><b>${esc(e.key)}</b>${cellText(e.v, rec.raw[k])}</td>`);
      else cells.push(`<td class="i x"><b>${esc(e.key)}</b>—</td>`);
    }
    const sub = knownCount ? '' : ' <span class="warn">此半邊無量測，沿用上方紀錄</span>';
    rows.push(`<tr><th colspan="4">${HALVES[half].label}${sub}</th></tr>`);
    for (let k = 0; k < cells.length; k += 4) rows.push(`<tr>${cells.slice(k, k + 4).join('')}</tr>`);
  }
  $('point-table').innerHTML = rows.join('');

  const info = [];
  const ex = Object.entries(rec.extra);
  if (ex.length) info.push(`其他點位讀值：${ex.map(([k, v]) => `${k} = ${v}`).join('、')}`);
  if (rec.note) info.push(`備註：${rec.note}`);
  const src = [rec.srcRow ? `原 xlsx 第 ${rec.srcRow} 列` : null, rec.sheetRow ? `試算表第 ${rec.sheetRow} 列` : null].filter(Boolean);
  if (src.length) info.push(src.join(' · '));
  $('record-info').hidden = !info.length;
  $('record-info').innerHTML = info.map((s) => `<div>${esc(s)}</div>`).join('');
  $('detail').hidden = false;
}

/* ---------------- 控制項 ---------------- */
$('legend-bar').style.background = `linear-gradient(to right, ${RAMP_CSS.join(',')})`;
$('opt-datum').addEventListener('change', (e) => pit.setOptions({ datum: e.target.checked }));
$('opt-labels').addEventListener('change', (e) => pit.setOptions({ labels: e.target.checked }));
/* 數值標示：原始讀值（對照原表）／距地表／兩者 */
function setValueMode(mode) {
  pit.setOptions({ valueMode: mode });
  $('opt-value').value = mode;
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* 無法使用 localStorage 時略過 */
  }
  if (dataset) {
    renderList();
    select(selected);
  }
}
$('opt-value').addEventListener('change', (e) => setValueMode(e.target.value));
try {
  const saved = localStorage.getItem(MODE_KEY);
  if (['raw', 'ground', 'both'].includes(saved)) setValueMode(saved);
} catch {
  /* 無法使用 localStorage 時略過 */
}
$('opt-color').addEventListener('change', (e) => {
  pit.setOptions({ colorMode: e.target.value });
  $('legend-depth').hidden = e.target.value !== 'depth';
});
$('opt-ghosts').addEventListener('change', (e) => pit.setOptions({ ghosts: e.target.checked }));
$('opt-exag').addEventListener('input', (e) => {
  $('exag-val').textContent = `${e.target.value}×`;
  pit.setOptions({ exag: +e.target.value });
});
$('reset-view').addEventListener('click', () => pit.resetView());

$('sheet-form').addEventListener('submit', (e) => {
  e.preventDefault();
  run(() => loadSheet($('sheet-input').value.trim()));
});
$('sheet-refresh').addEventListener('click', () => run(() => loadSheet(source.id)));
$('sheet-forget').addEventListener('click', forgetSheet);
$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await run(async () => {
    source = { kind: 'file', name: file.name };
    load(await file.arrayBuffer(), false);
  });
  e.target.value = '';
});
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT'].includes(e.target.tagName)) return;
  if (e.key === 'ArrowDown') select(selected + 1);
  if (e.key === 'ArrowUp') select(selected - 1);
});

async function run(fn) {
  try {
    await fn();
  } catch (err) {
    setStatus(null);
    showError(err.message);
  }
}
function setStatus(msg) {
  $('source-status').hidden = !msg;
  $('source-status').textContent = msg || '';
}
function showError(msg) {
  $('error').hidden = !msg;
  $('error').textContent = msg || '';
}

// 啟動：網址 #sheet= → 此瀏覽器上次使用的試算表 → 空白（等待貼上網址）
// 網頁本身不含任何資料
const initial = sheetFromUrl() || store.get();
$('sheet-forget').hidden = !store.get();
if (initial) run(() => loadSheet(initial));
else $('sheet-input').focus();

// 在已開啟的頁面上改貼 #sheet= 連結時（只變更 hash、不重新載入頁面）
window.addEventListener('hashchange', () => {
  const id = sheetIdFrom(sheetFromUrl());
  if (id && !(source?.kind === 'sheet' && source.id === id)) run(() => loadSheet(id));
});
