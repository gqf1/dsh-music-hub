// 在线音频磁盘缓存：把播过的曲目落到本地，再播同一首直接读盘。
//
// 解决的两个实际问题（用户 2026-10-30 提出）：
//   ① 每次播放都从上游重新下载整首，循环听同一首歌会反复消耗流量；
//   ② 上游取链地址是临时的，重启后无法续播。
//
// 设计要点：
//   · 键 = hash(源 + 歌曲 id + 品质)，与文件名解耦，避免非法字符和超长路径；
//   · 上限默认 2GB，超了按最久未访问淘汰（mtime 近似 LRU）；
//   · 只缓存完整下载成功的文件：先写 .part，成功后 rename，避免半个文件被当成缓存命中；
//   · 缓存只做「读命中就直接回」，未命中仍走原来的实时转发，不改变原有播放路径；
//   · 命中时按 Range 返回 206，保证 seek 行为与直连一致。
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync, createWriteStream, readFileSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;   // 2GB

export const cacheStats = { hits: 0, misses: 0, bytesSaved: 0, enabled: true };

let cacheRoot = "";
let maxBytes = DEFAULT_MAX_BYTES;

/** 缓存目录：%USERPROFILE%\.dsh\music-hub-cache（可由环境变量覆盖，便于测试） */
export function cacheDir() {
  if (!cacheRoot) {
    cacheRoot = process.env.DSH_MUSIC_CACHE_DIR || join(homedir(), ".dsh", "music-hub-cache");
  }
  return cacheRoot;
}

export function configureCache(opts) {
  if (!opts) return;
  if (typeof opts.maxBytes === "number" && opts.maxBytes > 0) maxBytes = opts.maxBytes;
  if (typeof opts.dir === "string" && opts.dir) cacheRoot = opts.dir;
}

/* ===== 跨源共用：按「歌名+歌手」建索引，让 QQ/酷狗/网易云同一首只存一份 =====

/** 规范化歌名：去扩展名、去首尾空白、全角空格转半角、统一小写、去括号内版本后缀 */
export function normName(s) {
  let t = String(s || "").replace(/\.[A-Za-z0-9]{1,6}$/, "").trim();
  t = t.replace(/\u3000/g, " ").replace(/\s+/g, " ");
  // 去掉常见版本后缀，避免「晴天」与「晴天 (Live)」被当成两首
  t = t.replace(/[（(\[【]\s*(live|remaster(ed)?|伴奏|纯音乐|instrumental|demo|现场|翻自|cover)\s*[^）)\]】]*[）)\]】]/gi, "");
  return t.trim().toLowerCase();
}

/** 规范化歌手：多歌手拆分后排序拼接，「A/B」与「B/A」视为同一组 */
export function normArtist(s) {
  const list = (Array.isArray(s) ? s : String(s || "").split(/[,、/&;]/))
    .map((x) => String(x || "").trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return list.join("/");
}

/** 跨源匹配键：歌名+歌手。用户确认按名字判重，不看音质与大小 */
export function matchKey(title, artists) {
  const t = normName(title);
  const a = normArtist(artists);
  if (!t) return "";
  return a ? (t + "\\u0001" + a) : t;
}

/* 索引文件：{ "歌名\\u0001歌手": { file, src, quality, size, at } }
   持久化到缓存目录的 index.json，进程重启后仍然可跨源复用。 */
function indexFile() { return join(cacheDir(), "index.json"); }
let indexCache = null;
export function loadIndex() {
  if (indexCache) return indexCache;
  try {
    const raw = JSON.parse(readFileSync(indexFile(), "utf8"));
    indexCache = (raw && typeof raw === "object") ? raw : {};
  } catch { indexCache = {}; }
  return indexCache;
}
export function saveIndex() {
  try {
    ensureDir();
    writeFileSync(indexFile(), JSON.stringify(indexCache || {}, null, 0), "utf8");
  } catch { }
}
/** 记一条索引（写入缓存成功后调用） */
export function noteIndex(title, artists, entry) {
  const k = matchKey(title, artists);
  if (!k) return;
  const idx = loadIndex();
  idx[k] = entry;
  saveIndex();
}
/** 按歌名+歌手查已有缓存文件（跨源复用就靠它） */
export function lookupByName(title, artists) {
  const k = matchKey(title, artists);
  if (!k) return "";
  const idx = loadIndex();
  const e = idx[k];
  if (!e || !e.file) return "";
  // 文件可能被用户手动删了：存在才算命中
  try { if (statSync(e.file).size > 0) return e.file; } catch { }
  return "";
}

function keyOf(src, id, quality) {
  return createHash("sha1").update(src + "|" + id + "|" + (quality || "")).digest("hex");
}

/* ---- 文件名：让缓存目录能直接看懂是哪首歌 ----
   规则：「歌手 - 歌名.扩展名」，例：G.E.M.邓紫棋 - 桃花诺.flac
   哈希 key 仍然保留，但只写进 index.json 用于精确查找，不再出现在文件名里。 ---- */
function safeName(s) {
  return String(s || "")
    .replace(/[\\\\/:*?"<>|\\r\\n\\t]/g, "_")   // Windows 非法字符
    .replace(/\\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")          // 首尾点和空格 Windows 不接受
    .slice(0, 60);                          // 单段限长，留空间给另一段和扩展名
}
/** 由歌曲信息生成可读文件名（不含扩展名）；信息不全时退回哈希 */
function readNameOf(song, key) {
  if (!song) return key;
  const t = safeName(song.title || song.name || "");
  const a = safeName(Array.isArray(song.artists) ? song.artists.join("、") : (song.artist || song.artists || ""));
  if (!t) return key;
  return (a ? a + " - " : "") + t;   // 有歌手就「歌手 - 歌名」，没有就只歌名
}
/** 从 content-type 推扩展名（缓存文件不再是 .bin，方便直接打开试听） */
function extOfType(ct) {
  const s = String(ct || "").toLowerCase();
  if (s.indexOf("flac") >= 0) return ".flac";
  if (s.indexOf("mpeg") >= 0 || s.indexOf("mp3") >= 0) return ".mp3";
  if (s.indexOf("mp4") >= 0 || s.indexOf("m4a") >= 0 || s.indexOf("aac") >= 0) return ".m4a";
  if (s.indexOf("ogg") >= 0) return ".ogg";
  if (s.indexOf("wav") >= 0) return ".wav";
  return ".bin";
}
/** 按文件头魔数判断真实格式（content-type 不可靠时用，实测酷狗有返回 octet-stream）。
    只读前 12 字节，不加载整个文件。 */
export function extOfMagic(p) {
  let fd = -1;
  try {
    fd = openSync(p, "r");
    const buf = Buffer.alloc(12);
    const n = readSync(fd, buf, 0, 12, 0);
    if (n < 4) return "";
    if (buf.slice(0, 4).toString("ascii") === "fLaC") return ".flac";
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return ".mp3";       // ID3
    if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return ".mp3";                // MPEG 帧同步
    if (buf.slice(4, 8).toString("ascii") === "ftyp") return ".m4a";               // MP4/M4A
    if (buf.slice(0, 4).toString("ascii") === "OggS") return ".ogg";
    if (buf.slice(0, 4).toString("ascii") === "RIFF") return ".wav";
    return "";
  } catch { return ""; }
  finally { if (fd >= 0) { try { closeSync(fd); } catch { } } }
}
/** 缓存文件路径：优先可读名，重名时加哈希前缀保证唯一 */
function fileOf(src, id, quality, ext, song) {
  const key = keyOf(src, id, quality);
  const e = ext || ".bin";
  const nice = readNameOf(song, key);
  if (!nice || nice === key) return join(cacheDir(), key + e);
  const p = join(cacheDir(), nice + e);
  /* 同名不同歌（不同源的翻唱等）：加哈希前缀区分，不能互相覆盖 */
  try { if (existsSync(p) && !isOurFile(p, key)) return join(cacheDir(), key.slice(0, 8) + " - " + nice + e); } catch { }
  return p;
}
/** 判断某个已存在文件是不是这首歌的（靠索引；没有索引就当不是） */
function isOurFile(p, key) {
  try {
    const idx = loadIndex();
    for (const k of Object.keys(idx || {})) {
      const e = idx[k];
      if (e && String(e.file || "") === p) return String(e.key || "") === key;
    }
  } catch { }
  return false;
}
/** 找已存在的缓存：先按索引查文件，再退回按哈希前缀找（兼容旧的 .bin 缓存） */
function findCached(src, id, quality) {
  const dir = cacheDir();
  const key = keyOf(src, id, quality);
  try {
    const idx = loadIndex();
    for (const k of Object.keys(idx || {})) {
      const e = idx[k];
      if (e && String(e.key || "") === key && e.file) {
        if (existsSync(e.file)) return e.file;
      }
    }
  } catch { }
  try {
    for (const name of readdirSync(dir)) {
      if (name.indexOf(key) === 0 && name.charAt(key.length) === "." && name.slice(-5) !== ".part") {
        return join(dir, name);
      }
    }
  } catch { }
  return "";
}

/** 淘汰：按 mtime 最久未用先删，直到总量低于阈值 */
function evictIfNeeded() {
  const dir = cacheDir();
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  const items = [];
  let total = 0;
  for (const n of names) {
    const p = join(dir, n);
    try { const st = statSync(p); items.push({ p, size: st.size, at: st.mtimeMs }); total += st.size; } catch { }
  }
  if (total <= maxBytes) return;
  items.sort((a, b) => a.at - b.at);
  for (const it of items) {
    if (total <= maxBytes) break;
    try { unlinkSync(it.p); total -= it.size; } catch { }
  }
}

function ensureDir() {
  try { mkdirSync(cacheDir(), { recursive: true }); } catch { }
}

/** 触摸缓存文件，让 LRU 判定反映最近访问 */
function touch(p) {
  try { const now = new Date(); import("node:fs").then((fs) => { try { fs.utimesSync(p, now, now); } catch { } }); } catch { }
}

/**
 * 尝试用缓存响应一个 Range 请求。
 * 返回 true 表示已响应；false 表示未命中，调用方继续走上游转发。
 *
 * 只对 GET/HEAD 生效；命中时模拟与直连一致的 206/200 语义。
 */
export function serveFromCache(req, res, src, id, quality, song) {
  if (!cacheStats.enabled) return false;
  /* 查找顺序：
     ① 本源 id 精确命中（最快，同一首在自己的缓存目录）；
     ② 跨源按「歌名+歌手」命中（用户要求：酷狗听过的，QQ 再听直接复用不重下）；
     ③ 都没有 → 未命中，调用方继续走上游。 */
  let p = findCached(src, id, quality);
  let shared = false;
  if (!p && song && (song.title || song.name)) {
    p = lookupByName(song.title || song.name, song.artists || song.artist || "");
    shared = !!p;
  }
  if (!p) { cacheStats.misses++; return false; }
  let size = 0;
  try { size = statSync(p).size; } catch { cacheStats.misses++; return false; }
  if (size <= 0) { cacheStats.misses++; return false; }

  cacheStats.hits++;
  cacheStats.bytesSaved += size;
  if (shared) cacheStats.sharedHits = (cacheStats.sharedHits || 0) + 1;
  touch(p);
  const cacheTag = shared ? "shared" : "hit";
  const range = typeof req.headers.range === "string" ? req.headers.range : "";
  if (req.method === "HEAD") {
    res.writeHead(200, { "Content-Length": String(size), "Accept-Ranges": "bytes", "X-DSH-Cache": cacheTag });
    res.end();
    return true;
  }
  if (!range) {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "X-DSH-Cache": cacheTag,
    });
    /* 不用 .pipe(res)：res 只需要 write/end，不必是 Writable 流（测试与宿主都可复用） */
    (async () => {
      try {
        for await (const chunk of createReadStream(p)) res.write(chunk);
      } catch { }
      try { res.end(); } catch { }
    })();
    return true;
  }
  // Range: bytes=start-end
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = 0;
  let end = size - 1;
  if (m) {
    if (m[1] !== "") start = parseInt(m[1], 10);
    if (m[2] !== "") end = parseInt(m[2], 10);
  }
  if (!Number.isFinite(start) || start >= size) {
    res.writeHead(416, { "Content-Range": "bytes */" + size });
    res.end();
    return true;
  }
  if (!Number.isFinite(end) || end >= size) end = size - 1;
  res.writeHead(206, {
    "Content-Type": "application/octet-stream",
    "Content-Range": "bytes " + start + "-" + end + "/" + size,
    "Content-Length": String(end - start + 1),
    "Accept-Ranges": "bytes",
    "X-DSH-Cache": cacheTag,
  });
  (async () => {
    try {
      for await (const chunk of createReadStream(p, { start, end })) res.write(chunk);
    } catch { }
    try { res.end(); } catch { }
  })();
  return true;
}

/**
 * 把上游流同时「转发给浏览器」和「写入缓存」。
 *
 * 为什么不能简单 tee：上游可能是 206 片段（浏览器带 Range），只有从头开始的整段
 * 才值得缓存；片段不写，避免缓存出一个残缺文件。
 *
 * @param upstream   fetch 的 Response
 * @param res        浏览器响应
 * @param src/id/quality  缓存键
 * @param cacheable  是否允许写入缓存（完整 200 响应才为 true）
 * @param headOnly   HEAD 请求：只回头不写 body
 */
export async function relayAndCache(upstream, res, src, id, quality, cacheable, headOnly, song) {
  const headers = {};
  for (const [k, v] of upstream.headers) headers[k] = v;
  res.writeHead(upstream.status, headers);
  if (headOnly) { res.end(); return; }

  let sink = null;
  let realExt = ".bin";   // 上游 content-type 推出来的真实扩展名
  let partPath = "";
  if (cacheable) {
    ensureDir();
      /* 用可读名 + 占位扩展名先写 .part；落盘时按 content-type 改真实扩展名 */
      const ctHint = upstream.headers && upstream.headers.get ? (upstream.headers.get("content-type") || "") : "";
      partPath = fileOf(src, id, quality, ".part", song);
      realExt = extOfType(ctHint);
    try { sink = createWriteStream(partPath); sink.on("error", () => { sink = null; }); } catch { sink = null; }
  }

  try {
    for await (const chunk of upstream.body) {
      res.write(chunk);
      if (sink) { try { sink.write(chunk); } catch { } }
    }
  } catch (e) {
    if (sink) { try { sink.destroy(); } catch { } if (partPath) { try { unlinkSync(partPath); } catch { } } }
    try { res.end(); } catch { }
    return;
  }
  res.end();
  if (sink) {
    await new Promise((r) => sink.end(r));
    // 只有完整落盘后才 rename，避免半个文件被当成缓存命中
    const finalPath = partPath.replace(/\.part$/, realExt);
    try {
      renameSync(partPath, finalPath);
      evictIfNeeded();
    } catch {
      try { unlinkSync(partPath); } catch { }
    }
  }
}

/* 给 online.js 用的三个薄封装：路径计算、目录、淘汰 */
export function cacheDirOf() { return cacheDir(); }
export function cachePathOf(key) { return join(cacheDir(), key + ".bin"); }
/** 给 online.js 用：按歌曲信息算出可读的缓存路径（含真实扩展名）
    song 为空时退回哈希名；同名不同歌自动加哈希前缀。 */
export function cachePathForSong(src, id, quality, song, contentType) {
  return fileOf(src, id, quality, extOfType(contentType), song);
}
/** 写完后按文件内容把 .bin 纠正成真实扩展名（content-type 不可靠时）。
    返回最终路径；识别不出或不需要改名就原样返回。 */
export function fixExtByMagic(p) {
  try {
    if (!p || p.slice(-4) !== ".bin") return p;
    const real = extOfMagic(p);
    if (!real || real === ".bin") return p;
    const next = p.replace(/\.bin$/, real);
    try { renameSync(p, next); } catch { return p; }
    return next;
  } catch { return p; }
}
/** 启动自愈：把缓存目录里「扩展名与内容不符」的旧文件改成正确扩展名，并同步索引路径。
    只处理 .bin（旧版 content-type 不可靠时写出的），别的一律不动。
    返回 { renamed, entries }，供 /api/cache 报告。 */
export function healCacheNames() {
  const out = { renamed: 0, entries: 0 };
  try {
    const dir = cacheDir();
    if (!existsSync(dir)) return out;
    const files = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".bin"));
    const map = new Map();             // 旧路径 -> 新路径
    for (const n of files) {
      const p = join(dir, n);
      let real = "";
      try { real = extOfMagic(p); } catch { }
      if (!real || real === ".bin") continue;
      const next = p.replace(/\.bin$/i, real);
      try {
        if (existsSync(next)) continue;   // 目标已存在就不动，避免覆盖
        renameSync(p, next);
        map.set(p, next);
        out.renamed++;
      } catch { }
    }
    /* 索引里指向旧路径的条目一并改掉 */
    if (map.size) {
      try {
        const idx = loadIndex();
        let dirty = false;
        for (const k of Object.keys(idx || {})) {
          const e = idx[k];
          if (e && map.has(String(e.file || ""))) { e.file = map.get(String(e.file)); dirty = true; out.entries++; }
        }
        if (dirty) saveIndex();
      } catch { }
    }
  } catch { }
  return out;
}

export function pruneCache() { try { evictIfNeeded(); } catch { } }
/** 由 src/id/quality 直接算缓存路径（online.js 写盘时用） */
export function cacheKeyFor(src, id, quality) { return keyOf(src, id, quality); }

/** 供测试与界面展示：当前缓存占用 */
export function cacheUsage() {
  const dir = cacheDir();
  let total = 0;
  let count = 0;
  try {
    for (const n of readdirSync(dir)) {
      if (n.slice(-5) === ".part") continue;
      try { total += statSync(join(dir, n)).size; count++; } catch { }
    }
  } catch { }
  return { dir, total, count, max: maxBytes, ...cacheStats };
}

/** 清空缓存（用户可能要手动清理） */
export function clearCache() {
  const dir = cacheDir();
  let removed = 0;
  try {
    for (const n of readdirSync(dir)) {
      try { unlinkSync(join(dir, n)); removed++; } catch { }
    }
  } catch { }
  return { removed };
}
