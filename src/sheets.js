// 讀取「知道連結的任何人可檢視」的 Google 試算表。
// 使用 export?format=xlsx：一次取得所有工作表，儲存格型別（數字／日期／文字）完整保留，
// 且 Google 會回傳 CORS 標頭，前端可直接讀取，不需要 API key 或後端。

/** 從完整網址或純 ID 取出試算表 ID */
export function sheetIdFrom(input) {
  const s = String(input ?? '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : null;
}

export const sheetUrl = (id) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

export async function fetchSheet(id) {
  const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx&_=${Date.now()}`;
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    // 未公開的試算表會被導向登入頁，瀏覽器因 CORS 擋下而成為網路錯誤
    throw new Error('無法讀取試算表：請確認共用設定為「知道連結的任何人」可檢視，並檢查網路連線');
  }
  if (res.status === 404) throw new Error('找不到這份試算表，請確認網址是否正確');
  if (res.status === 401 || res.status === 403) {
    throw new Error('試算表未公開：請在試算表右上角「共用」將一般存取權改為「知道連結的任何人」可檢視');
  }
  if (!res.ok) throw new Error(`讀取試算表失敗（HTTP ${res.status}）`);
  const type = res.headers.get('content-type') || '';
  if (type.includes('text/html')) throw new Error('試算表未公開：請將共用設定改為「知道連結的任何人」可檢視');
  return res.arrayBuffer();
}
