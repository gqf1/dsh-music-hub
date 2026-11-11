/**
 * 在线音源（QQ / 酷狗 / 网易云）宿主路由层。
 *
 * 协议实现来自 lib/sources/*（移植自 kendu76/dsh-music-player，MIT），本文件只做：
 *   ① 登录态持久化（3 个 cookie 文件，0600）
 *   ② 统一路由 /dsh-music/<src>/...（搜/播/歌词/歌单/榜单/我的歌单）
 *   ③ 播放流代理（取链 → 上游 Range 透传 → 浏览器 <audio>）
 *
 * 三源共用一个路由工厂，差异只在适配器（adapter）里，避免三份几乎相同的代码分叉。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as QQ from "./sources/qq.js";
import * as KG from "./sources/kugou.js";
import { serveFromCache, cacheKeyFor, cacheDirOf, cachePathOf, cachePathForSong, fixExtByMagic, pruneCache, cacheUsage, clearCache, configureCache, noteIndex } from "./cache.js";
import { createWriteStream, renameSync, unlinkSync } from "node:fs";
import * as NC from "./sources/netease.js";
import { parseLrc, decodeEntities } from "./sources/lrc.js";

// 与 lib/index.js 同一约定：DSH_HOME 优先，便于多实例/测试隔离（否则测试会污染真实登录态）
const DSH_DIR = process.env.DSH_HOME ? process.env.DSH_HOME : join(homedir(), ".dsh");
const COOKIE_FILES = {
  qq: join(DSH_DIR, "music-hub-qq-cookie.json"),
  kg: join(DSH_DIR, "music-hub-kg-cookie.json"),
  nc: join(DSH_DIR, "music-hub-nc-cookie.json"),
};

/** 每源的内存状态：{loggedIn, cookie, nickname, session(酷狗设备身份), isVip} */
export const sources = {
  qq: { loggedIn: false, cookie: "", nickname: "", isVip: null },
  kg: { loggedIn: false, session: {}, cookie: "", nickname: "", isVip: null },
  nc: { loggedIn: false, cookie: "", nickname: "", isVip: null },
};
const loginPending = { qq: null, kg: null, nc: null };
let loaded = false;

/* ---------------- 持久化 ---------------- */
function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
function writeSecure(p, obj) {
  try {
    mkdirSync(DSH_DIR, { recursive: true });
    writeFileSync(p, JSON.stringify(obj, null, 2), { encoding: "utf8", mode: 0o600 });
    try { chmodSync(p, 0o600); } catch { }
  } catch { /* 写失败不影响本次会话 */ }
}
export function loadAll() {
  if (loaded) return;
  loaded = true;
  const q = readJsonSafe(COOKIE_FILES.qq);
  if (q && q.cookie) { sources.qq.cookie = q.cookie; sources.qq.loggedIn = true; sources.qq.nickname = q.nickname || ""; }
  const k = readJsonSafe(COOKIE_FILES.kg);
  if (k) {
    sources.kg.session = k.session || {};
    sources.kg.nickname = k.nickname || "";
    sources.kg.loggedIn = !!(sources.kg.session.token && sources.kg.session.userid);
    sources.kg.cookie = k.cookie || "";
  }
  const n = readJsonSafe(COOKIE_FILES.nc);
  if (n && n.cookie) { sources.nc.cookie = n.cookie; sources.nc.loggedIn = true; sources.nc.nickname = n.nickname || ""; }
}
function saveQQ() { writeSecure(COOKIE_FILES.qq, { cookie: sources.qq.cookie, nickname: sources.qq.nickname }); }
function saveKG() { writeSecure(COOKIE_FILES.kg, { session: sources.kg.session, nickname: sources.kg.nickname, cookie: sources.kg.cookie }); }
function saveNC() { writeSecure(COOKIE_FILES.nc, { cookie: sources.nc.cookie, nickname: sources.nc.nickname }); }

/* ---------------- 登录态摘要 ---------------- */
export function loginFlags() {
  loadAll();
  return { qq: !!sources.qq.loggedIn, kg: !!sources.kg.loggedIn, nc: !!sources.nc.loggedIn };
}
export function statusOf(src) {
  loadAll();
  if (src === "qq") return { loggedIn: !!sources.qq.loggedIn, nickname: sources.qq.nickname, uin: "" };
  if (src === "kg") return { loggedIn: !!sources.kg.loggedIn, nickname: sources.kg.nickname, userid: String(sources.kg.session.userid || "") };
  return { loggedIn: !!sources.nc.loggedIn, nickname: sources.nc.nickname };
}

/* ---------------- 播放流代理 ---------------- */
const STREAM_UA = {
  qq: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  kg: "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi",
  nc: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
};
const STREAM_REFERER = { qq: "http://y.qq.com", kg: "", nc: "https://music.163.com/" };
export async function proxyStream(req, res, src, url, qualityLabel, cacheKeyIn, song) {
  /* 缓存键由调用方算好传入（src|id|quality 的 sha1）；没传就不缓存 */
  const cacheKey = cacheKeyIn || "";
  const upHeaders = { "User-Agent": STREAM_UA[src] };
  if (STREAM_REFERER[src]) upHeaders["Referer"] = STREAM_REFERER[src];
  if (typeof req.headers.range === "string") upHeaders["Range"] = req.headers.range;
  const upstream = await fetch(url, { headers: upHeaders });
  if (!upstream.ok && upstream.status !== 206) {
    res.writeHead(upstream.status === 404 ? 404 : 502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("上游音频流失败：HTTP " + upstream.status);
    return;
  }
  const headers = {
    "Content-Type": upstream.headers.get("content-type") || "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  // Node 的 writeHead 拒绝非 ASCII 头值：中文品质标签必须 percent-encode，客户端再 decode
  if (qualityLabel) headers["X-DSH-Quality"] = encodeURIComponent(qualityLabel);
  const cr = upstream.headers.get("content-range"); if (cr) headers["Content-Range"] = cr;
  const cl = upstream.headers.get("content-length"); if (cl) headers["Content-Length"] = cl;
  /* ★ 上游若对 Range 请求回 200（而不是 206），浏览器会把这条流当作「直播流」，
     于是 seekable=[0,0]、seek 全部失效（实测：d 已知、缓冲正常、sk=0，
     另建一个独立 audio 元素同样是 sk=0 —— 说明是响应头问题）。
     正确做法：代理自己切出这一段并回 206 + Content-Range，绝不能把 200 透传出去。*/
  let status = upstream.status;
  let sliceFrom = -1;
  let sliceLen = -1;
  const reqRange = typeof req.headers.range === "string" ? req.headers.range.trim() : "";
  if (upstream.status === 200 && reqRange) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(reqRange);
    if (m !== null && (m[1] !== "" || m[2] !== "")) {
      const total = Number(upstream.headers.get("content-length")) || 0;
      let start;
      let end;
      if (m[1] === "") {                       // bytes=-N：末尾 N 字节
        const n = Number(m[2]) || 0;
        start = total > 0 ? Math.max(0, total - n) : 0;
        end = total > 0 ? total - 1 : n - 1;
      } else {
        start = Number(m[1]) || 0;
        end = m[2] === "" ? (total > 0 ? total - 1 : start) : Math.min(Number(m[2]), total > 0 ? total - 1 : Number(m[2]));
      }
      if (total > 0 && start > end) { start = 0; end = 0; }
      sliceFrom = start;
      sliceLen = end - start + 1;
      headers["Content-Range"] = "bytes " + start + "-" + end + "/" + (total > 0 ? total : "*");
      headers["Content-Length"] = String(sliceLen);
      status = 206;
    }
  }
  res.writeHead(status, headers);
  if (req.method === "HEAD") { res.end(); return; }
  if (upstream.body) {
    if (sliceFrom >= 0 && sliceLen > 0) {
      let pos = 0;
      let sent = 0;
      for await (const chunk of upstream.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const chunkStart = pos;
        pos += buf.length;
        if (pos <= sliceFrom) continue;                        // 整块在起点之前：丢弃
        const from = Math.max(0, sliceFrom - chunkStart);
        const avail = buf.length - from;
        const take = Math.min(avail, sliceLen - sent);
        if (take > 0) { res.write(buf.subarray(from, from + take)); sent += take; }
        if (sent >= sliceLen) break;                           // 够了就停，别再往下读
      }
      res.end();
      return;
    }
    /* 写盘缓存：只缓存「完整 200 响应」，Range 片段与 206 不写（避免存出残文件）。
       写盘失败一律忽略，不影响正在播放的这一路。 */
    const canCache = cacheKey && status === 200 && !req.headers.range;
    let sink = null;
    let sinkPath = "";
    if (canCache) {
      try {
        mkdirSync(cacheDirOf(), { recursive: true });
        /* 可读文件名（歌手 - 歌名.扩展名），依托 content-type 决定扩展名 */
        const ct0 = upstream.headers && upstream.headers.get ? (upstream.headers.get("content-type") || "") : "";
        /* ★ 这里不能写 id —— proxyStream 的入参是 (req,res,src,url,qualityLabel,cacheKeyIn,song)，
           根本没有 id 变量。之前写成 id 会抛 ReferenceError，被下面的 catch 吞掉，
           表现为「缓存永远写不进去」（count 一直是 0）。用 cacheKeyIn 当唯一标识即可。 */
        sinkPath = cachePathForSong(src, cacheKeyIn || url, qualityLabel, song, ct0);
        sink = createWriteStream(sinkPath + ".part");
        sink.on("error", () => { sink = null; });
      } catch { sink = null; }
    }
    for await (const chunk of upstream.body) {
      res.write(chunk);
      if (sink) { try { sink.write(chunk); } catch { } }
    }
    if (sink) {
      const s = sink;
      await new Promise((r) => s.end(r));
      try {
        renameSync(sinkPath + ".part", sinkPath);
        /* content-type 不可靠时（实测有源返回 octet-stream），按文件头魔数纠正扩展名，
           避免缓存里出现一堆看不出格式的 .bin */
        try { sinkPath = fixExtByMagic(sinkPath); } catch { }
        /* 记入跨源索引：下次任何源播同一首歌（歌名+歌手一致）都可直接复用 */
        if (song && (song.title || song.name)) {
          try { noteIndex(song.title || song.name, song.artists || song.artist || "", { file: sinkPath, src: src, key: cacheKey }); } catch { }
        }
      } catch { try { unlinkSync(sinkPath + ".part"); } catch { } }
    }
  }
  res.end();
}

/* ---------------- 各源适配器 ---------------- */
/**
 * 适配器契约（每个源实现这几个）：
 *   startLogin(body) → { key, image, expiresAt, mode? }
 *   checkLogin(key)  → { status, message, ... }，成功时写回 sources[src] 并返回 { ok:true, status:'success', nickname }
 *   logout()         → void
 *   search(w, page)  → { results, total, page }（results 至少含 id/title/artists/album）
 *   play(id)         → { url, quality }（取不到抛错）
 *   lyric(q)         → { lrc:[{t,text}] } 或 { wordLines:[{t,end,text}] }
 *   playlists(kind, ...) → 由 handler 直接分派
 */
const ADAPTERS = {
  /* ======================= QQ ======================= */
  qq: {
    async startLogin(body) {
      loadAll();
      const mode = body && body.mode === "qq" ? "qq" : "wx";
      const s = mode === "qq" ? await QQ.createQRLogin() : await QQ.createWXQRLogin();
      loginPending.qq = { key: s.key, mode, expiresAt: s.expiresAt };
      return { key: s.key, image: s.imageDataUrl, expiresAt: s.expiresAt, mode };
    },
    async checkLogin(key) {
      if (!key) throw new Error("missing key");
      const isWx = /(?:^|&)type=wx(?:&|$)/.test(key) || (loginPending.qq && loginPending.qq.mode === "wx");
      const r = isWx ? await QQ.checkWXQRLogin(key) : await QQ.checkQRLogin(key);
      if (r.status === "success") {
        sources.qq.cookie = r.cookie || "";
        sources.qq.loggedIn = !!sources.qq.cookie;
        sources.qq.isVip = null;
        sources.qq.nickname = (r.extra && r.extra.nickname) || sources.qq.nickname || "";
        saveQQ();
        return { ok: true, status: "success", loggedIn: sources.qq.loggedIn, nickname: sources.qq.nickname, loginFrom: isWx ? "wx" : "qq", message: r.message };
      }
      return { ok: true, status: r.status, message: r.message, extra: r.extra };
    },
    logout() { sources.qq.cookie = ""; sources.qq.loggedIn = false; sources.qq.nickname = ""; sources.qq.isVip = null; saveQQ(); },
    async search(w, page) {
      loadAll();
      // VIP 探测失败不影响搜索（探测只决定能否取无损档）
      let isVip = false;
      try { isVip = sources.qq.cookie ? await QQ.detectVip(sources.qq.cookie) : false; } catch { isVip = false; }
      sources.qq.isVip = isVip;
      return await QQ.search(w, sources.qq.cookie, page);
    },
    async play(id) {
      loadAll();
      const isVip = sources.qq.isVip === true;
      const dl = await QQ.getDownloadURL(id, sources.qq.cookie, isVip);
      if (!dl.url) throw new Error("无法获取播放地址（可能是 VIP/版权限制，或登录已失效）");
      // filename 前缀 → 通俗品质标签（与参考实现一致）
      const f = String(dl.filename || "");
      let q = "";
      if (/\.flac$/i.test(f)) q = "无损";
      else if (/\.ogg$/i.test(f)) q = "高音质";
      else if (/^M800/i.test(f)) q = "高音质";
      else if (/^M500/i.test(f)) q = "标准";
      return { url: dl.url, quality: q };
    },
    async lyric(q) {
      loadAll();
      const r = await QQ.getLyric(q.id, sources.qq.cookie);
      const text = decodeEntities(String(r.lyric || ""));
      return { lrc: parseLrc(text), trans: parseLrc(decodeEntities(String(r.trans || ""))) };
    },
  },

  /* ======================= 酷狗 ======================= */
  kg: {
    async startLogin() {
      loadAll();
      // 设备指纹必须真实注册：伪造 dfid 出码的 token 会在取链(20028)/云歌单(20017)被风控拦
      let warning = "";
      if (!sources.kg.session.mid || !sources.kg.session.dfid || sources.kg.session.dfid === "-") {
        const fresh = KG.createDeviceIdentity();
        Object.assign(sources.kg.session, fresh);
        try {
          const reg = await KG.registerDevice(sources.kg.session);
          sources.kg.session.dfid = reg.dfid;
        } catch (e) {
          warning = "设备注册失败，已用临时身份继续：" + String((e && e.message) || e);
        }
        saveKG();
      }
      const s = await KG.createQRLogin(sources.kg.session);
      loginPending.kg = { key: s.key, expiresAt: s.expiresAt };
      return { key: s.key, image: s.imageDataUrl, expiresAt: s.expiresAt, warning };
    },
    async checkLogin(key) {
      loadAll();
      if (!key) throw new Error("missing key");
      const r = await KG.checkQRLogin(key, sources.kg.session);
      if (r.status === "success" && r.tokenInfo) {
        sources.kg.session.token = r.tokenInfo.token;
        sources.kg.session.userid = r.tokenInfo.userid;
        sources.kg.session.vip_type = r.tokenInfo.vip_type || "";
        sources.kg.session.vip_token = r.tokenInfo.vip_token || "";
        sources.kg.loggedIn = !!(sources.kg.session.token && sources.kg.session.userid);
        sources.kg.isVip = null;
        saveKG();
        try {
          const ui = await KG.getMyUserInfo(sources.kg.session);
          if (ui.nickname) { sources.kg.nickname = ui.nickname; saveKG(); }
        } catch { /* 抓昵称失败不阻断登录 */ }
        return { ok: true, status: "success", loggedIn: sources.kg.loggedIn, userid: sources.kg.session.userid, nickname: sources.kg.nickname, message: r.message };
      }
      return { ok: true, status: r.status, message: r.message, extra: r.extra };
    },
    logout() {
      // 设备指纹保留（重扫 = 老设备回归，风控更友好），只清登录凭据
      sources.kg.session.token = "";
      sources.kg.session.userid = "";
      sources.kg.loggedIn = false;
      sources.kg.nickname = "";
      sources.kg.isVip = null;
      saveKG();
    },
    async search(w, page) { return await KG.search(w, "", page); },
    async play(hash) {
      loadAll();
      if (!sources.kg.loggedIn) throw new Error("酷狗取播需要登录（匿名取链已失效），请先扫码登录");
      const dl = await KG.getDownloadURL({ hash }, sources.kg.session, ["flac", "320", "128"]);
      if (!dl.url) throw new Error("无法获取播放地址（VIP/版权限制或登录态需刷新）");
      return { url: dl.url, quality: dl.quality || "" };
    },
    async lyric(q) {
      const args = { hash: q.id || "", keyword: [q.title, (q.artists || []).join(" ")].filter(Boolean).join(" "), title: q.title || "", artist: (q.artists || []).join(" ") || "", durationSec: Number(q.duration) || 0 };
      try {
        const w = await KG.getWordLines(args);
        if (w && Array.isArray(w.lines) && w.lines.length) {
          const trans = Array.isArray(w.translations)
            ? w.translations.map((text, i) => ({ t: (w.lines[i] && w.lines[i].t) || i * 5, text })).filter((x) => x.text)
            : [];
          return { wordLines: w.lines, trans };
        }
      } catch { /* KRC 失败 → LRC 兜底 */ }
      const g = await KG.getLyric(args);
      return { lrc: parseLrc(g.lyric) };
    },
  },

  /* ======================= 网易云 ======================= */
  nc: {
    async startLogin() {
      const s = await NC.createQRLogin();
      loginPending.nc = { key: s.key, expiresAt: s.expiresAt };
      return { key: s.key, image: s.imageDataUrl, url: s.url, expiresAt: s.expiresAt };
    },
    async checkLogin(key) {
      if (!key) throw new Error("missing key");
      const r = await NC.checkQRLogin(key);
      if (r.status === "success" && r.cookie) {
        sources.nc.cookie = r.cookie;
        sources.nc.loggedIn = true;
        saveNC();
        try {
          const acc = await NC.getAccount(sources.nc.cookie);
          const nick = (acc && (acc.nickname || (acc.profile && acc.profile.nickname))) || "";
          if (nick) { sources.nc.nickname = nick; saveNC(); }
        } catch { /* 抓昵称失败不阻断 */ }
        return { ok: true, status: "success", loggedIn: true, nickname: sources.nc.nickname, message: r.message };
      }
      return { ok: true, status: r.status, message: r.message, extra: r.extra };
    },
    logout() { sources.nc.cookie = ""; sources.nc.loggedIn = false; sources.nc.nickname = ""; saveNC(); },
    async search(w, page) { loadAll(); return await NC.search(w, sources.nc.cookie, page); },
    async play(id) {
      loadAll();
      const dl = await NC.getDownloadURL(id, sources.nc.cookie);
      if (!dl.url) throw new Error("无法获取播放地址（可能需登录或版权限制）");
      return { url: dl.url, quality: dl.quality || "" };
    },
    async lyric(q) {
      loadAll();
      const r = await NC.getLyric(q.id, sources.nc.cookie);
      return { lrc: parseLrc(r.lyric), trans: parseLrc(r.trans || "") };
    },
  },
};

/* ---------------- 歌单/榜单（三源形状不同，统一在 handler 里分派） ---------------- */
async function handlePlaylists(src, kind, url) {
  const q = (k, d) => url.searchParams.get(k) || d;
  const page = Math.max(1, parseInt(q("page", "1"), 10) || 1);
  loadAll();

  if (kind === "playlists") {
    if (src === "qq") {
      const cat = q("category", "");
      if (!cat) return { playlists: await QQ.getRecommendedPlaylists(sources.qq.cookie) };
      return { playlists: await QQ.getCategoryPlaylists(cat, page, 20, sources.qq.cookie) };
    }
    if (src === "kg") {
      const cat = q("category", "");
      if (!cat) return await KG.getRecommendedPlaylists(sources.kg.session, page);
      return { playlists: await KG.getCategoryPlaylists(cat, page, 20, sources.kg.session) };
    }
    const cat = q("category", "");
    if (!cat) return { playlists: await NC.getRecommendedPlaylists(sources.nc.cookie, page) };
    return { playlists: await NC.getCategoryPlaylists(cat, page, 20, sources.nc.cookie) };
  }
  if (kind === "playlist-categories") {
    if (src === "qq") return { categories: await QQ.getPlaylistCategories(sources.qq.cookie) };
    if (src === "kg") return { categories: await KG.getPlaylistCategories(sources.kg.session) };
    return { categories: await NC.getPlaylistCategories(sources.nc.cookie) };
  }
  if (kind === "playlist-search") {
    const w = q("w", "");
    if (!w) throw Object.assign(new Error("missing query"), { status: 400 });
    // ★ 三源必须统一成 { results, total, page }：
    //   qq/nc 的 searchPlaylist 返回 {results,total,page}；酷狗返回 {playlists,total,page}。
    //   之前直接把酷狗的原始对象塞进 {playlists: ...}，前端拿到的是
    //   {playlists:{results:[...]}}（多套一层），按数组用会炸。这里统一归一化。
    if (src === "qq") { const s = await QQ.searchPlaylist(w, sources.qq.cookie, page); return { results: s.results || [], total: s.total || 0, page: s.page || page }; }
    if (src === "kg") { const s = await KG.searchPlaylist(w, sources.kg.session, page); return { results: s.playlists || s.results || [], total: s.total || 0, page: s.page || page }; }
    const s = await NC.searchPlaylist(w, sources.nc.cookie, page); return { results: s.results || [], total: s.total || 0, page: s.page || page };
  }
  if (kind === "playlist-songs") {
    const id = q("id", "");
    if (!id) throw Object.assign(new Error("missing id"), { status: 400 });
    if (src === "qq") return await QQ.getPlaylistSongs(id, sources.qq.cookie);
    if (src === "kg") return await KG.getPlaylistSongs(id, sources.kg.session);
    return await NC.getPlaylistSongs(id, sources.nc.cookie);
  }
  /* 「我的歌单」的歌曲：不能复用 playlist-songs。
     实测（2026-10-28 用户反馈「我的歌单点进去 0 首」）：酷狗云歌单的自建/收藏用的是
     **云列表 id**，不是公开歌单的 specialid，拿它去查公开接口必然 0 首。正确接口按 kind 分两条：
        own（自建 / 我喜欢）  → v4/get_list_all_file            → KG.getMyPlaylistSongs(listid)
        collect（收藏别人的） → v2/get_other_list_file_nofilt   → KG.getCollectedPlaylistSongs(creatorGid)
     qq / nc 的自建歌单 id 就是歌单 id，沿用 getPlaylistSongs 即可。 */
  if (kind === "my-playlist-songs") {
    const id = q("id", "");
    if (!id) throw Object.assign(new Error("missing id"), { status: 400 });
    const kindOf = q("kind", "own");
    const gid = q("gid", "");
    loadAll();
    // 「我的歌单」必然需要登录态：未登录先给人话，否则会把酷狗内部错误
    // 「kugou session 缺少有效设备标识（mid）」原样甩给用户。
    if (!sources[src].loggedIn) {
      const label = { qq: "QQ音乐", kg: "酷狗", nc: "网易云" }[src];
      throw Object.assign(new Error("需要先在「" + label + "」页签扫码登录，才能读取我的歌单内容"), { status: 400 });
    }
    if (src === "qq") return { id, name: "", songs: sortPlaylistSongs((await QQ.getPlaylistSongs(id, sources.qq.cookie)).songs || [], q("sort", "manual")) };
    if (src === "nc") return { id, name: "", songs: sortPlaylistSongs((await NC.getPlaylistSongs(id, sources.nc.cookie)).songs || [], q("sort", "manual")) };
    if (kindOf === "collect") {
      if (!gid) throw Object.assign(new Error("收藏歌单缺少 creatorGid，无法读取歌曲"), { status: 400 });
      const songs = await KG.getCollectedPlaylistSongs(gid, sources.kg.session);
      return { id, name: "", songs: sortPlaylistSongs(songs || [], q("sort", "manual")) };
    }
    const songs = await KG.getMyPlaylistSongs(id, sources.kg.session);
    return { id, name: "", songs: sortPlaylistSongs(songs || [], q("sort", "manual")) };
  }
  if (kind === "top-lists") {
    if (src === "qq") return { groups: await QQ.getTopLists(sources.qq.cookie) };
    if (src === "kg") return { groups: await KG.getTopLists(sources.kg.session) };
    return { groups: await NC.getTopLists(sources.nc.cookie) };
  }
  if (kind === "top-songs") {
    const id = q("id", "");
    const num = Math.max(1, parseInt(q("num", "100"), 10) || 100);
    if (!id) throw Object.assign(new Error("missing id"), { status: 400 });
    if (src === "qq") return await QQ.getTopListSongs(id, sources.qq.cookie, 0, num);
    if (src === "kg") return await KG.getTopListSongs(id, sources.kg.session, 0, num);
    return await NC.getTopListSongs(id, sources.nc.cookie, 0, num);
  }
  if (kind === "my-playlists") {
    // 未登录时给一句人话，而不是把内部错误（如「kugou session 缺少有效设备标识（mid）」）
    // 原样甩给用户 —— 实测点「我的」页签时就会撞上这句，看不出要做什么。
    if (!sources[src].loggedIn) {
      const label = { qq: "QQ音乐", kg: "酷狗", nc: "网易云" }[src];
      throw Object.assign(new Error("需要先在「" + label + "」页签扫码登录，才能查看我的歌单"), { status: 400 });
    }
    if (src === "qq") return { playlists: await QQ.getMyPlaylists(sources.qq.cookie) };
    if (src === "kg") return { playlists: await KG.getMyPlaylists(sources.kg.session, page, 60) };
    return { playlists: await NC.getMyPlaylists(sources.nc.cookie, page, 100) };
  }
  throw Object.assign(new Error("unknown playlist kind"), { status: 404 });
}

/* ---------------- 歌单排序（对齐酷狗 App 的排序菜单） ----------------
   用户要求（2026-10-28）：默认按「酷狗 App 里该歌单的实际排序」显示，并支持
   新→旧 / 旧→新 / 歌名 A-Z / 歌手 A-Z / 播放量高→低 / 播放量低→高。

   数据来源与口径（实测酷狗云歌单接口字段）：
     sort        手动排序序号 —— 酷狗 App「默认（手动）排序」就是它的降序
     collecttime 收藏时间（秒）—— 新到旧 / 旧到新
     filename/title/artists —— 歌名与歌手，A-Z 排序用
     playCount   播放量 —— 只有部分源提供（酷狗云歌单不提供，缺就保持原序）
   ★ 关键：接口原始返回顺序 ≠ sort 顺序（实测第1首 sort=744、第2首 743，
     是乱序的），所以「默认」必须显式按 sort 降序排，不能直接透传。 */
export function sortPlaylistSongs(songs, mode) {
  const arr = Array.isArray(songs) ? songs.slice() : [];
  const m = String(mode || "manual");
  const nameOf = (s) => String(s.fileName || s.title || s.name || "").replace(/\.[A-Za-z0-9]{1,6}$/, "");
  // 中文按拼音排需要 ICU；这里用 localeCompare('zh') 让 Chromium/Node 自带的
  // 拼音排序生效（Node 24 有完整 ICU），退化时至少保证稳定不报错。
  const cmpText = (a, b) => {
    try { return String(a).localeCompare(String(b), "zh-Hans-CN", { sensitivity: "base" }); }
    catch { return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0; }
  };
  const artistOf = (s) => (Array.isArray(s.artists) && s.artists.length ? s.artists.join(" / ") : (s.artist || ""));
  const manualKey = (s) => (Number(s.sort) || Number(s.fsort) || 0);

  if (m === "manual") {
    // 酷狗 App「默认」= sort 降序（序号越大越靠前）；sort 全为 0（如收藏歌单）时保持原序
    const hasSort = arr.some((s) => manualKey(s) > 0);
    if (hasSort) arr.sort((a, b) => manualKey(b) - manualKey(a));
    return arr;
  }
  if (m === "newest") return arr.sort((a, b) => (Number(b.collecttime) || 0) - (Number(a.collecttime) || 0));
  if (m === "oldest") return arr.sort((a, b) => (Number(a.collecttime) || 0) - (Number(b.collecttime) || 0));
  if (m === "title-asc") return arr.sort((a, b) => cmpText(nameOf(a), nameOf(b)));
  if (m === "artist-asc") return arr.sort((a, b) => cmpText(artistOf(a), artistOf(b)) || cmpText(nameOf(a), nameOf(b)));
  if (m === "play-desc") return arr.sort((a, b) => (Number(b.playCount) || 0) - (Number(a.playCount) || 0));
  if (m === "play-asc") return arr.sort((a, b) => (Number(a.playCount) || 0) - (Number(b.playCount) || 0));
  return arr;
}

export const PLAYLIST_SORT_MODES = ["manual", "newest", "oldest", "title-asc", "artist-asc", "play-desc", "play-asc"];

/* ---------------- 模型工具用：按源搜索（复用适配器，保证与界面同一条路） ---------------- */
export async function searchOnline(src, w, page = 1) {
  const A = ADAPTERS[src];
  if (!A) throw new Error("未知音源：" + src);
  loadAll();
  return await A.search(w, page);
}
/** 取当前已登录的源，供工具在未指定 source 时自动挑一个能播的源 */
export function loggedInSources() {
  loadAll();
  return ["qq", "kg", "nc"].filter((s) => sources[s].loggedIn);
}

/**
 * 处理 /dsh-music/<src>/... 路由。返回 true 表示已处理。
 * 由 lib/index.js 的 serve 在主路由里调用（围栏已在调用方通过）。
 */
export async function handleOnline(req, res, url, writeJson, readJsonBodyOrFail) {
  const pathname = url.pathname;
  const m = /^\/dsh-music\/(qq|kg|nc)\/(.+)$/.exec(pathname);
  if (!m) return false;
  const src = m[1];
  const rest = m[2];
  const A = ADAPTERS[src];
  loadAll();

  // ---- 播放流：/dsh-music/<src>/play/<id>（GET/HEAD，不走 JSON 围栏语义）----
  if (rest.startsWith("play/")) {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return true; }
    const id = decodeURIComponent(rest.slice("play/".length));
    if (!id) { res.writeHead(400); res.end(); return true; }
    try {
      /* ★ 先查磁盘缓存：命中就直接按 Range 回，不再向上游取链/下载。
         只对 GET/HEAD 生效；未命中继续走下面原来的实时转发（行为不变）。 */
      /* 歌名/歌手从查询参数取（客户端点歌 URL 上带 ?t=&a=），用于跨源按名复用缓存 */
      const qTitle = (url.searchParams.get("t") || "").trim();
      const qArtist = (url.searchParams.get("a") || "").trim();
      const songInfo = qTitle ? { title: qTitle, artists: qArtist } : null;
      if (serveFromCache(req, res, src, id, "", songInfo)) return true;
      const dl = await A.play(id);
      await proxyStream(req, res, src, dl.url, dl.quality, cacheKeyFor(src, id, ""), songInfo);
    } catch (e) {
      const msg = String((e && e.message) || e);
      // 取链失败常见的三种原因都如实回传，让客户端能提示而不是静默无声
      try { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("无法播放：" + msg); } catch { }
    }
    return true;
  }

  if (rest === "status" && req.method === "GET") {
    writeJson(res, 200, Object.assign({ ok: true, source: src }, statusOf(src)));
    return true;
  }
  if (rest === "login/start" && req.method === "POST") {
    const body = await readJsonBodyOrFail();
    if (body === null) return true;
    try { writeJson(res, 200, Object.assign({ ok: true }, await A.startLogin(body || {}))); }
    catch (e) { writeJson(res, 502, { ok: false, error: String((e && e.message) || e) }); }
    return true;
  }
  if (rest === "login/check" && req.method === "GET") {
    const key = url.searchParams.get("key") || "";
    if (!key) { writeJson(res, 400, { ok: false, error: "missing key" }); return true; }
    try { writeJson(res, 200, await A.checkLogin(key)); }
    catch (e) { writeJson(res, 502, { ok: false, error: String((e && e.message) || e) }); }
    return true;
  }
  if (rest === "login/logout" && req.method === "POST") {
    try { A.logout(); writeJson(res, 200, { ok: true, loggedIn: false }); }
    catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
    return true;
  }
  if (rest === "search" && req.method === "GET") {
    const w = (url.searchParams.get("w") || "").trim();
    if (!w) { writeJson(res, 400, { ok: false, error: "missing query" }); return true; }
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    try {
      /* 搜索：单一全文搜索（用户 2026-10-29 明确不要「按歌手分类」）。
         by 参数保留解析但不再改变结果，纯为兼容旧调用方，避免它传了就报错。 */
      const by = (url.searchParams.get("by") || "song").trim();
      const s = await A.search(w, page);
      writeJson(res, 200, {
        ok: true, isVip: sources[src].isVip === true,
        results: s.results, total: s.total, page: s.page, by,
        // degraded=true：源的主搜索通道被限流，走了联想接口（结果少但可播）
        degraded: !!s.degraded,
      });
    } catch (e) { writeJson(res, 502, { ok: false, error: String((e && e.message) || e) }); }
    return true;
  }
  if (rest === "lyric" && req.method === "GET") {
    const q = {
      id: url.searchParams.get("id") || "",
      title: url.searchParams.get("title") || "",
      artists: (url.searchParams.get("artist") || "").split(/[,、/]/).map((x) => x.trim()).filter(Boolean),
      duration: Number(url.searchParams.get("duration") || "0") || 0,
    };
    try {
      const r = await A.lyric(q);
      writeJson(res, 200, Object.assign({ ok: true, hasLyric: !!(r.lrc && r.lrc.length) || !!(r.wordLines && r.wordLines.length) }, r));
    } catch (e) { writeJson(res, 502, { ok: false, error: String((e && e.message) || e) }); }
    return true;
  }
  // 歌单 / 榜单 / 我的歌单
  for (const kind of ["playlists", "playlist-categories", "playlist-search", "playlist-songs", "my-playlist-songs", "top-lists", "top-songs", "my-playlists"]) {
    if (rest === kind && req.method === "GET") {
      try { writeJson(res, 200, Object.assign({ ok: true }, await handlePlaylists(src, kind, url))); }
      catch (e) { writeJson(res, Number(e && e.status) || 502, { ok: false, error: String((e && e.message) || e) }); }
      return true;
    }
  }
  writeJson(res, 404, { ok: false, error: "unknown route: " + rest });
  return true;
}
