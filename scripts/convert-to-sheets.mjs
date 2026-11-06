// 將舊版挖掘紀錄 xlsx 轉成 Google 試算表用的結構化範本（探坑／點位／基準／紀錄／說明）。
// 一列 = 一筆紀錄 = 一個平面；日期、AB-U、CD-U 欄不轉入。
// 數值一律照原表搬移，不換算、不修正；每筆紀錄附原始列號以便回查。
//
// 用法：node scripts/convert-to-sheets.mjs <來源.xlsx> [輸出.xlsx] [遺址名稱]
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { parseWorkbook } from '../src/data.js';

const [src, outArg, siteArg] = process.argv.slice(2);
if (!src) {
  console.error('用法：node scripts/convert-to-sheets.mjs <來源.xlsx> [輸出.xlsx] [遺址名稱]');
  process.exit(1);
}
const out = outArg || src.replace(/\.xlsx?$/i, '') + '_結構化.xlsx';
const site = siteArg || path.basename(src).replace(/(_\d+)?\.xlsx?$/i, '');

const ds = parseWorkbook(fs.readFileSync(src));
if (ds.format !== 'legacy') {
  console.error('來源已是結構化格式，不需轉換');
  process.exit(1);
}
const pit = ds.pitName;

// 點位欄順序（與原表一致）；其他補充點位（如 9+）排在同號點位之後
const BASE = ['1', '2', '3', '4ab', '4cd', '5', '6', '7', '8ab', '8cd', '9', '10', '11', '12', '13ab', '13cd'];
const COLS = [];
const extras = Object.keys(ds.points).filter((k) => !BASE.includes(k));
for (const k of BASE) {
  COLS.push(k);
  for (const e of extras) if (parseInt(e, 10) === +k && !COLS.includes(e)) COLS.push(e);
}
for (const e of extras) if (!COLS.includes(e)) COLS.push(e);

/* ---------- 探坑 ---------- */
const pits = [
  ['pit_id', '遺址', '寬_cm', '長_cm', '備註'],
  [pit, site, 200, 200, `由 ${path.basename(src)} 轉入`],
];

/* ---------- 點位 ---------- */
const points = [['pit_id', 'point', 'x_cm', 'y_cm', '半邊', '啟用', '備註']];
for (const key of COLS) {
  const p = ds.points[key];
  const mid = /^(4|8|13)(ab|cd)$/.test(key) ? `中線，${p.side} 側` : '';
  points.push([pit, p.key, p.x, p.n, p.side, p.active, !p.active ? '座標待補；補上後改為 TRUE' : mid || p.note || '']);
}

/* ---------- 基準 ---------- */
const datums = [['pit_id', 'datum_id', '名稱', '高於地表_cm', '標準高度_原文', '參考量測', '備註']];
for (const g of ds.groups) datums.push([pit, g.id, g.name, g.datumHeight, g.datumNote, g.tie, null]);

/* ---------- 紀錄 ---------- */
const head = ['record_id', 'pit_id', 'datum_id', ...COLS, '原始列', '備註'];
const records = [head];
let moved = 0;
for (const rec of ds.records) {
  const all = { ...rec.raw, ...rec.extra };
  records.push([rec.id, pit, ds.groups[rec.group].id, ...COLS.map((k) => all[k] ?? null), rec.srcRow, rec.note]);
  moved += Object.keys(all).length;
}

/* ---------- 說明 ---------- */
const readme = [
  ['工作表', '欄位', '規則'],
  ['探坑', 'pit_id', '探坑代號，唯一；其他表以此對應'],
  ['點位', 'x_cm / y_cm', '以探坑中心為原點，x 向東、y 向北，單位 cm'],
  ['點位', '半邊', 'AB 或 CD，決定點位屬於哪個半邊的曲面；中線點位分成 4ab／4cd 兩列'],
  ['點位', '啟用', 'FALSE 或座標空白的點位不參與繪圖，數值仍保留在紀錄表；標準 13 點以外的啟用點位（如 9+）會以局部修正納入曲面'],
  ['基準', '高於地表_cm', '基準面高於地表的公分數；換樁就新增一列'],
  ['基準', '參考量測', '新樁設立時的參考讀值，原文保留'],
  ['紀錄', '一列', '一筆紀錄 = 一個平面，包含所有點位的讀值'],
  ['紀錄', 'record_id', '唯一編號，建立後不要更改（網頁以此比對新增／修改）'],
  ['紀錄', '點位欄', '只填數字（讀值，cm，自基準面向下量）；沒量的點位留空；文字說明寫在備註'],
  ['紀錄', '原始列', '轉入時在原 xlsx 的列號，供回查；新增紀錄可留空'],
  ['紀錄', '刪除', '不刪列；有疑慮者於備註註明'],
  ['', '', ''],
  ['轉換來源', path.basename(src), `${records.length - 1} 筆紀錄，共 ${moved} 個讀值，數值未做任何換算；日期、AB-U、CD-U 欄未轉入`],
];

/* ---------- 輸出 ---------- */
const wb = XLSX.utils.book_new();
const add = (name, aoa, widths) => {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = aoa[0].map((h, i) => ({ wch: widths?.[i] ?? Math.max(6, String(h).length * 2 + 2) }));
  XLSX.utils.book_append_sheet(wb, ws, name);
};
add('探坑', pits, [8, 10, 8, 8, 30]);
add('點位', points, [8, 8, 8, 8, 6, 6, 26]);
add('基準', datums, [8, 9, 8, 12, 14, 28, 30]);
add('紀錄', records, head.map((h) => ({ record_id: 10, 原始列: 7, 備註: 30 })[h] ?? 7));
add('說明', readme, [8, 14, 70]);
XLSX.writeFile(wb, out);

// 驗證：直接從原始工作表重新計數讀值（排除「新樁」等參考量測列），與轉出數量比對
const srcWb = XLSX.read(fs.readFileSync(src));
const legacyRows = XLSX.utils.sheet_to_json(srcWb.Sheets[srcWb.SheetNames[0]], { header: 1, raw: true, defval: null });
const isPointHead = (c) => /^\d{1,2}(ab|cd|\+)?$/i.test(String(c ?? '').trim());
const hdr = legacyRows.findIndex((r) => r.filter(isPointHead).length >= 5);
const pcols = legacyRows[hdr].map((c, j) => (isPointHead(c) ? j : -1)).filter((j) => j >= 0);
const srcCount = legacyRows
  .slice(hdr + 1)
  .filter((r) => !r[0] || String(r[0]).trim() === '深度')
  .reduce((s, r) => s + pcols.filter((j) => typeof r[j] === 'number').length, 0);
console.log(`輸出：${out}`);
console.log(`紀錄 ${records.length - 1} 筆；原表讀值 ${srcCount} → 轉出 ${moved}${srcCount === moved ? '（一致）' : '（不一致！）'}`);
