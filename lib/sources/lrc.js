/**
 * LRC 解析（本插件自有实现）。
 * 输出 [{ t, text }]（t 秒）；支持一行多时间戳、[offset:±ms] 全局偏移；
 * [ti:]/[ar:]/[al:] 等元数据行与空行跳过；乱序按 t 重排。
 */
const TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(text) {
  const out = [];
  let offsetS = 0;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, "");
    const om = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/.exec(line);
    if (om !== null) { offsetS = (parseInt(om[1], 10) || 0) / 1000; continue; }
    const tags = [];
    let m;
    TIME_RE.lastIndex = 0;
    let contentStart = 0;
    // exec 匹配失败会把 lastIndex 归零，所以文本起点必须在循环内记录
    while ((m = TIME_RE.exec(line)) !== null) { tags.push(m); contentStart = TIME_RE.lastIndex; }
    if (tags.length === 0) continue;
    const content = line.slice(contentStart).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (content === "") continue;
    for (const tag of tags) {
      const min = parseInt(tag[1], 10) || 0;
      const sec = parseInt(tag[2], 10) || 0;
      const fracS = tag[3] !== undefined && tag[3] !== "" ? Number("0." + tag[3]) : 0;
      out.push({ t: min * 60 + sec + fracS + offsetS, text: content });
    }
  }
  out.sort((a, b) => a.t - b.t || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  return out;
}

/** 解 HTML 实体（QQ 老歌词端点会把 : . 空格都实体化） */
export function decodeEntities(str) {
  if (typeof str !== "string" || str === "") return str;
  return str
    .replace(/&#(\d+);/g, (m, n) => { const cp = Number(n); return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m; })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { const cp = parseInt(h, 16); return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m; })
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, "\u00a0");
}

/** 去掉 QQ/酷狗搜索高亮标签 <em>…</em> 与零宽字符 */
export function stripHl(s) {
  return String(s || "").replace(/<\/?em>/g, "").replace(/<\/?span[^>]*>/g, "").replace(/[\u200b-\u200f]/g, "").trim();
}