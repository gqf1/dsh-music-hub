/**
 * dsh-music-hub 宿主半区（Cordis 插件，跑在 DSH 主机进程）。
 *
 * 职责：本地音乐库扫描 / 流式播放（Range/seek）/ 播放偏好持久化 /
 * 在线音源（QQ/酷狗/网易云，后续阶段）的宿主路由。
 *
 * 路由（webServer prefix /dsh-music）：
 *   GET  /dsh-music/manifest          —— 曲库摘要（兼容 card-desktop 音乐视图契约）
 *   GET  /dsh-music/stream/<id>       —— 音频流（支持 Range/206）
 *   GET  /dsh-music/api/state         —— 偏好 + 曲库状态
 *   POST /dsh-music/api/setroot       —— 设置曲库根目录（触发重扫）
 *   POST /dsh-music/api/refresh       —— 重扫当前根目录
 *   POST /dsh-music/api/prefs         —— 保存播放偏好（音量/模式/当前曲目/进度…）
 *   GET  /dsh-music/api/life          —— 存活线：桌面壳一发出退出信号就回 {quit:true}
 *
 * 安全：API 请求走与 dsh-card-desktop 同款 trusted-host 围栏（回环或 trustedHosts，
 * 且 Origin 同源）；流式请求要求曲目在扫描结果中登记过（不开放任意路径读）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, createReadStream, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, resolve as pathResolve } from "node:path";
import { scanLibrary, audioType, isAudioName, listEntries } from "./local.js";
import { handleOnline, loginFlags, searchOnline, loggedInSources } from "./online.js";
import { cacheUsage, clearCache, configureCache, healCacheNames } from "./cache.js";
import { mergeSettings, patchSettings, dirForSource, checkDir } from "./settings.js";
import { parseLrc } from "./sources/lrc.js";

export const name = "dsh-music-hub";
// 只 inject webServer：路由注册必需。其余服务（webStartup 的 trustedHosts、tools 等）
// 属可选依赖，放 inject 会在未就绪时让整个插件停在等待态（dsh-card-desktop 的教训）。
export const inject = ["webServer"];

// 状态目录：优先跟随 DSH_HOME（dsh 自身的家目录约定），否则 ~/.dsh。
// ★ 为什么必须支持 DSH_HOME：多实例/测试验证要用临时家目录隔离，否则跑一次测试
//   就会把 rootDir/音量写进用户真实配置（实测发生过：真实 ~/.dsh/music-hub-prefs.json
//   被写成测试临时目录，用户打开面板即「曲库为空」）。
const DSH_DIR = process.env.DSH_HOME ? process.env.DSH_HOME : join(homedir(), ".dsh");
const PREFS_FILE = join(DSH_DIR, "music-hub-prefs.json");
const DEFAULT_ROOT = join(homedir(), "Music");
const HUB_VERSION = 1;

/* ---------------- 偏好持久化 ---------------- */
function loadPrefs() {
  try {
    const p = JSON.parse(readFileSync(PREFS_FILE, "utf8"));
    return p && typeof p === "object" ? p : {};
  } catch { return {}; }
}
function savePrefs(p) {
  try {
    mkdirSync(DSH_DIR, { recursive: true });
    writeFileSync(PREFS_FILE, JSON.stringify(p, null, 2), "utf8");
  } catch { /* 偏好写失败不影响播放 */ }
}

/* ---------------- 曲库状态 ---------------- */
let prefs = loadPrefs();

/* ★ 启动即应用已保存的缓存设置。
   之前只在 POST /api/settings 里 configureCache，重启后不加载 →
   用户在设置里选的缓存目录（如 F:\\DSH\\音乐）明明存在却用不上，
   实际写到了默认的 ~/.dsh/music-hub-cache（用户实测：那里有 28MB，F: 盘空）。 */
const _bootSettings = mergeSettings(prefs.settings);
if (Number.isFinite(Number(_bootSettings.cache.maxMB))) {
  configureCache({ maxBytes: Math.round(Number(_bootSettings.cache.maxMB)) * 1024 * 1024 });
}
const _bootDir = dirForSource(_bootSettings, "kg") || dirForSource(_bootSettings, "qq") || dirForSource(_bootSettings, "nc");
if (_bootDir && checkDir(_bootDir).ok) configureCache({ dir: _bootDir });
/* 启动自愈：旧版在 content-type 不可靠时写出的 .bin（实为 flac/mp3）改成正确扩展名，
   并同步索引路径。只动 .bin，不碰其它文件 —— 老缓存不用重下。 */
try { healCacheNames(); } catch { }
let tracks = [];          // 扫描结果（id/name/path/size/ext/quality/url）
let scanning = false;
let started = false;
let startError = "";

function rootDir() {
  const r = prefs.rootDir;
  return (typeof r === "string" && r) || DEFAULT_ROOT;
}

// 懒启动：首次 manifest/stream 请求才扫描，避免拖慢宿主开机
async function ensureStarted() {
  if (started || scanning) return;
  started = true;
  await rescan();
}
async function rescan() {
  scanning = true;
  startError = "";
  try {
    const out = scanLibrary(rootDir());
    tracks = out.tracks;
  } catch (e) {
    startError = (e && e.message) || String(e);
    tracks = [];
  } finally {
    scanning = false;
  }
}

/* ---------------- HTTP 工具（围栏与 card-desktop 同款） ---------------- */
const header = (headers, name) => {
  if (!headers) return undefined;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name) return headers[k];
  }
  return undefined;
};
function parseAuthority(entry) {
  try { return new URL("http://" + entry); } catch { return undefined; }
}
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
  return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
function isTrustedAuthority(hostUrl, trustedHosts) {
  return (trustedHosts || []).some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === void 0) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
  });
}
/**
 * trustedHosts 相关服务在 HTTP 服务绑定之后才就绪，一次性快照会把名单永久固化
 * 为 []（局域网/隧道访问全 403）——必须每次请求重新取（dsh-card-desktop 实测教训）。
 */
function makeFence(ctx) {
  return (req) => {
    const get = (typeof ctx.get === "function")
      ? (n) => { try { return ctx.get(n); } catch { return null; } }
      : () => null;
    const rt = get("webStartup") || get("webRuntime");
    const hosts = ((rt && rt.trustedHosts) || []).slice();
    try {
      const ws = get("webServer");
      if (ws && typeof ws.getOrigin === "function") hosts.push(new URL(ws.getOrigin()).host);
    } catch { }
    try {
      const app = get("webApp");
      if (app && typeof app.getAdvertisedUrl === "function") hosts.push(new URL(app.getAdvertisedUrl()).host);
    } catch { }
    const host = header(req.headers, "host");
    if (host === void 0) return false;
    const hostUrl = parseAuthority(host);
    if (hostUrl === void 0) return false;
    const loopback = isLoopbackHostname(hostUrl.hostname);
    if (!loopback && !isTrustedAuthority(hostUrl, hosts)) return false;
    if (header(req.headers, "sec-fetch-site") === "cross-site") return false;
    const origin = header(req.headers, "origin");
    if (origin === void 0) return loopback;
    try { return new URL(origin).host === hostUrl.host; } catch { return false; }
  };
}
function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const contentType = header(req.headers, "content-type") || "";
    if (!/^application\/json\b/i.test(contentType)) { reject(new Error("unsupported content-type")); return; }
    const chunks = [];
    let size = 0, settled = false;
    try { req.setTimeout(30000, () => { if (settled) return; settled = true; reject(new Error("request body timeout")); }); } catch { }
    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (size > 1024 * 1024) { settled = true; reject(new Error("request body too large")); try { req.resume(); } catch { } return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) || {}); } catch { reject(new Error("bad json body")); }
    });
    req.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
  });
}

/* ---------------- 流式响应（Range/206） ---------------- */
function serveTrackFile(req, res, filePath, size) {
  let start = 0, end = size - 1, status = 200;
  const range = header(req.headers, "range");
  if (typeof range === "string") {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m !== null && (m[1] !== "" || m[2] !== "")) {
      if (m[1] !== "") {
        start = parseInt(m[1], 10);
        end = m[2] !== "" ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      } else {
        start = Math.max(size - parseInt(m[2], 10), 0);
        end = size - 1;
      }
      if (!Number.isFinite(start) || start > end || start >= size) {
        res.writeHead(416, { "Content-Range": "bytes */" + size });
        res.end();
        return;
      }
      status = 206;
    }
  }
  const headers = {
    "Content-Type": audioType(filePath),
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
    "Cache-Control": "no-store",
  };
  if (status === 206) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
  res.writeHead(status, headers);
  if (req.method === "HEAD") { res.end(); return; }
  // createReadStream 按区间流式吐数据，不把整文件读进内存
  createReadStream(filePath, { start, end }).on("error", () => { try { res.end(); } catch { } }).pipe(res);
}

/** 读 JSON body；失败时已写入对应状态码（415/413/408/400）并返回 null */
async function readBodyOr400(req, res) {
  try {
    return await readJsonBody(req);
  } catch (error) {
    const m = (error && error.message) || "bad json body";
    const status = m === "unsupported content-type" ? 415 : (m === "request body too large" ? 413 : (m === "request body timeout" ? 408 : 400));
    writeJson(res, status, { ok: false, error: m });
    return null;
  }
}

/* ---------------- 模型工具意图：agent 点歌 → 浏览器半区轮询执行 ---------------- */
// 单槽位：后一条覆盖前一条（播放指令天然只关心最新的那条）。
let pendingIntent = null;
export function takeIntent() {
  const it = pendingIntent;
  pendingIntent = null;
  return it;
}

/* ---------------- 退出信号：宿主一开始拆机就通知浏览器半区停播 ----------------
   桌面壳 dsh-desktop 的 finishQuit 顺序是：hide 两个窗口 → backend.close()（等宿主进程
   退出，最多 1e4 ms 才 SIGTERM）→ app.quit() 杀渲染进程。窗口只是隐藏，页面收不到
   pagehide/beforeunload/unload，<audio> 会一直播到渲染进程被杀 —— 用户实测「退出后
   还响约 10 秒」，就是这段。
   页面能拿到的最早信号只有一个：壳通过 IPC 发给宿主的 {type:"shutdown"}（进程结束时
   还会断 IPC）。这里把它翻成 /dsh-music/api/life 上的 {quit:true}。
   ★ 必须「即问即答」，不做长连接挂起：挂起的请求会长期占住浏览器对同一主机的
     连接槽位，而音频流的 Range 请求也走这个池子（用户实测：进度条点了跳不动）。 */
let quitting = false;
function markQuitting() {
  quitting = true;
}

/** 在曲库里做「按关键词模糊匹配」：先精确包含歌名/歌手，再按分词命中数排序。 */
function matchLocal(query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return tracks.length ? tracks[0] : null;
  const words = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const t of tracks) {
    const name = t.name.replace(/\.[^.]+$/, "").toLowerCase();
    let score = 0;
    if (name === q) score += 100;
    if (name.includes(q)) score += 50;
    for (const w of words) if (name.includes(w)) score += 10;
    if (score > 0) scored.push({ t, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].t : null;
}

/* ---------------- 路由分发 ---------------- */
export function apply(ctx) {
  const fence = makeFence(ctx);
  /* 插件被重新装载（HMR / 重启）时复位退出标记 */
  quitting = false;
  /* 退出信号源：壳发给宿主的 IPC {type:"shutdown"}；IPC 断开等价于壳已经走掉。
     注意 IPC 在宿主的优雅退出窗口之前就到达，所以这条信号比「进程被杀」早 10 秒。 */
  ctx.effect(() => {
    const onMessage = (m) => { if (m && typeof m === "object" && m.type === "shutdown") markQuitting(); };
    const onDisconnect = () => markQuitting();
    try {
      process.on("message", onMessage);
      process.once("disconnect", onDisconnect);
    } catch { }
    return () => {
      try { process.off("message", onMessage); } catch { }
      try { process.off("disconnect", onDisconnect); } catch { }
      /* 插件卸载（HMR/重启）也当退出处理：旧宿主不能再让页面继续播 */
      markQuitting();
    };
  }, "dsh-music-hub: quit signal");

  const serve = async (req, res) => {
    try {
      let url;
      try { url = new URL(req.url || "/", "http://dsh.internal"); } catch { res.writeHead(400); res.end(); return; }
      const pathname = url.pathname;

      // ---- 流式：/dsh-music/stream/<id>（先于围栏 cutoff 之前单独处理鉴权）----
      // 浏览器 <audio> 不发 Origin（非 CORS 模式），所以流式路由只按 Host 判：
      // 回环或受信主机直接放行；非受信主机 403。
      if (pathname.startsWith("/dsh-music/stream/")) {
        const host = header(req.headers, "host");
        const hostUrl = host ? parseAuthority(host) : undefined;
        if (!hostUrl || (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHostsNow(ctx)))) {
          res.writeHead(403); res.end(); return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
        await ensureStarted();
        const id = pathname.slice("/dsh-music/stream/".length);
        const track = tracks.find((t) => t.id === id);
        if (!track) { res.writeHead(404); res.end(); return; }
        let st;
        try { st = statSync(track.path); } catch { res.writeHead(404); res.end(); return; }
        if (!st.isFile()) { res.writeHead(404); res.end(); return; }
        serveTrackFile(req, res, track.path, st.size);
        return;
      }

      // ---- 在线音源（/dsh-music/<qq|kg|nc>/...）：先过围栏，播放流单独放行 ----
      // 播放流走 <audio> 的普通 GET（无 Origin），因此只按 Host 判信；其余 JSON 接口过完整围栏。
      if (/^\/dsh-music\/(qq|kg|nc)\//.test(pathname)) {
        const isPlay = /^\/dsh-music\/(qq|kg|nc)\/play\//.test(pathname);
        if (isPlay) {
          const host = header(req.headers, "host");
          const hostUrl = host ? parseAuthority(host) : undefined;
          if (!hostUrl || (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHostsNow(ctx)))) {
            res.writeHead(403); res.end(); return;
          }
        } else if (!fence(req)) {
          writeJson(res, 403, { ok: false, error: "forbidden" });
          return;
        }
        const handled = await handleOnline(req, res, url, writeJson, async () => readBodyOr400(req, res));
        if (handled) return;
      }

      // ---- JSON API：一律过围栏 ----
      if (pathname.startsWith("/dsh-music/api/") || pathname === "/dsh-music/manifest") {
        if (!fence(req)) { writeJson(res, 403, { ok: false, error: "forbidden" }); return; }
      } else {
        res.writeHead(404); res.end(); return;
      }

      if (pathname === "/dsh-music/manifest" && req.method === "GET") {
        await ensureStarted();
        const flags = loginFlags();
        writeJson(res, 200, {
          version: HUB_VERSION,
          root: rootDir(),
          count: tracks.length,
          tracks: tracks.map((t) => ({
            id: t.id, name: t.name, path: t.path, size: t.size, ext: t.ext,
            quality: t.quality, url: t.url,
          })),
          scanning,
          error: startError || undefined,
          qqLoggedIn: flags.qq, kgLoggedIn: flags.kg, ncLoggedIn: flags.nc,
          ttsConfigured: false,
        });
        return;
      }

      /* 存活线：浏览器半区在播放期间每隔几百毫秒问一次，宿主一开始拆机就改口说 quit。
         为什么必须有它：桌面壳的「托盘退出」= 先 hide 窗口，再等宿主进程退出（最多 10s
         才 SIGTERM），最后才杀渲染进程；窗口只是隐藏，页面不会收到 pagehide/unload，
         <audio> 就会一直播到进程被杀。壳发给宿主的 {type:"shutdown"} 是页面能拿到的最早信号。
         ★ 即问即答、绝不挂住连接：挂起的请求会占住浏览器连接槽，音频流的 Range 请求
           排不上队，表现就是「点进度条跳不动 / 又从头播」（2026-11-03 用户实测）。 */
      if (pathname === "/dsh-music/api/life") {
        if (req.method !== "GET") { writeJson(res, 405, { ok: false, error: "GET only" }); return; }
        writeJson(res, 200, { ok: true, quit: quitting });
        return;
      }
      if (pathname === "/dsh-music/api/state" && req.method === "GET") {
        await ensureStarted();
        const flags = loginFlags();
        writeJson(res, 200, {
          ok: true,
          /* 回给客户端的 prefs 必须包含「客户端需要记住的全部项」。
             之前只回 volume/mode/rootDir，导致 tab / sortMode / showBar 永远存不住。 */
          prefs: {
            volume: prefs.volume, mode: prefs.mode,
            rootDir: prefs.rootDir || DEFAULT_ROOT,
            tab: prefs.tab, currentId: prefs.currentId, currentName: prefs.currentName,
            position: prefs.position, trackDur: prefs.trackDur, queue: prefs.queue, sortMode: prefs.sortMode, sortMap: prefs.sortMap || {},
            showBar: prefs.showBar === undefined ? true : prefs.showBar,
          },
          count: tracks.length, scanning, error: startError || undefined,
          qqLoggedIn: flags.qq, kgLoggedIn: flags.kg, ncLoggedIn: flags.nc,
        });
        return;
      }

      // 目录浏览（给前端选目录弹窗用）：只列目录，不列文件
      // path="__drives__"（Windows）返回盘符列表
      if (pathname === "/dsh-music/api/dir" && req.method === "GET") {
        const q = url.searchParams.get("path") || "";
        if (process.platform === "win32" && q === "__drives__") {
          const drives = [];
          for (let c = 65; c <= 90; c++) {
            const d = String.fromCharCode(c) + ":\\";
            if (existsSync(d)) drives.push({ name: String.fromCharCode(c) + ":\\", path: d });
          }
          writeJson(res, 200, { ok: true, dirs: drives, cur: "__drives__" });
          return;
        }
        if (!q || !isAbsolute(q)) { writeJson(res, 400, { ok: false, error: "path 必须是绝对路径" }); return; }
        const resolved = pathResolve(q);
        if (!existsSync(resolved)) { writeJson(res, 404, { ok: false, error: "目录不存在" }); return; }
        /* files=1：连文件一起列（背景图选择器要能点到图片）。
           filter 可传扩展名过滤，如 filter=image 只看图片。 */
        const wantFiles = url.searchParams.get("files") === "1";
        const filter = url.searchParams.get("filter") || "";
        const IMG_RE = /[.](png|jpe?g|gif|webp|bmp|svg)$/i;
        const entries = listEntries(resolved)
          .filter((e) => e.isDir || wantFiles)
          .filter((e) => e.isDir || filter !== "image" || IMG_RE.test(e.name))
          .map((e) => ({ name: e.name, path: join(resolved, e.name), isDir: !!e.isDir }));
        writeJson(res, 200, { ok: true, cur: resolved, dirs: entries.filter((e) => e.isDir), files: entries.filter((e) => !e.isDir) });
      }
      /* 新建目录：设置里选缓存位置时直接建，省得退出到资源管理器去建。
         只允许在已有父目录下建一级子目录，名字做白名单校验防路径穿越。 */
      if (pathname === "/dsh-music/api/mkdir" && req.method === "POST") {
        const body = await readBodyOr400(req, res); if (body === null) return;
        const parent = String(body.parent || "").trim();
        const name = String(body.name || "").trim();
        if (!parent || !isAbsolute(parent)) { writeJson(res, 400, { ok: false, error: "父目录必须是绝对路径" }); return; }
        if (!name || /[\\\\/:*?"<>|]/.test(name) || name === "." || name === "..") {
          writeJson(res, 400, { ok: false, error: "文件夹名不合法" }); return;
        }
        try {
          if (!existsSync(parent)) { writeJson(res, 404, { ok: false, error: "父目录不存在" }); return; }
          const target = join(pathResolve(parent), name);
          /* 二次防线：拼出来的路径必须真在父目录下 */
          if (pathResolve(target).indexOf(pathResolve(parent)) !== 0) {
            writeJson(res, 400, { ok: false, error: "路径非法" }); return;
          }
          mkdirSync(target, { recursive: true });
          writeJson(res, 200, { ok: true, path: target });
        } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
        return;
      }


      // 本地歌词：读同名 .lrc（与音频同目录、同基名），找不到返回 hasLyric:false
      if (pathname === "/dsh-music/api/lyric" && req.method === "GET") {
        await ensureStarted();
        const id = url.searchParams.get("id") || "";
        const track = tracks.find((t) => t.id === id);
        if (!track) { writeJson(res, 404, { ok: false, error: "未知曲目" }); return; }
        const lrcPath = track.path.replace(/\.[^.\\/]+$/, ".lrc");
        let text = "";
        try { text = readFileSync(lrcPath, "utf8"); } catch { text = ""; }
        if (!text) { writeJson(res, 200, { ok: true, hasLyric: false }); return; }
        let lines = [];
        try { lines = parseLrc(text); } catch { lines = []; }
        writeJson(res, 200, { ok: true, hasLyric: lines.length > 0, lrc: lines, source: "local-lrc" });
        return;
      }

      // 浏览器半区每 2s 轮询一次：拿到就执行并清空（单槽位，后到覆盖先到）
      if (pathname === "/dsh-music/api/intent" && req.method === "GET") {
        /* 顺带把 showBar 回传：卡片桌面关掉播放条后，主界面要在 2 秒内跟着消失，
           不必等用户刷新页面（intent 本来就每 2s 轮询，不带额外开销）。 */
        writeJson(res, 200, { ok: true, intent: takeIntent(), showBar: prefs.showBar === undefined ? true : prefs.showBar });
        return;
      }
      /* 浏览器侧也能投递 intent（卡片桌面 ↔ 主界面同步用）：
         卡片里拖进度/切歌后投 {action:"seek", position} 或 {action:"play"...}，
         主界面轮询 GET 时取到并执行，两条播放条因此保持一致。 */
      if (pathname === "/dsh-music/api/intent" && req.method === "POST") {
        const body = await readBodyOr400(req, res); if (body === null) return;
        const act = String(body.action || "");
        if (!act) { writeJson(res, 400, { ok: false, error: "缺少 action" }); return; }
        pendingIntent = {
          action: act,
          position: Number.isFinite(Number(body.position)) ? Number(body.position) : undefined,
          kind: body.kind ? String(body.kind) : undefined,
          id: body.id ? String(body.id) : undefined,
          name: body.name ? String(body.name) : undefined,
          mode: body.mode ? String(body.mode) : undefined,
        };
        writeJson(res, 200, { ok: true });
        return;
      }

      if (pathname === "/dsh-music/api/setroot" && req.method === "POST") {
        const body = await readBodyOr400(req, res); if (body === null) return;
        const dir = String(body.dir || "");
        if (!dir || !isAbsolute(dir)) { writeJson(res, 400, { ok: false, error: "dir 必须是绝对路径" }); return; }
        const resolved = pathResolve(dir);
        if (!existsSync(resolved)) { writeJson(res, 404, { ok: false, error: "目录不存在" }); return; }
        prefs.rootDir = resolved;
        savePrefs(prefs);
        started = true;
        await rescan();
        writeJson(res, 200, { ok: true, root: resolved, count: tracks.length });
        return;
      }

      if (pathname === "/dsh-music/api/refresh" && req.method === "POST") {
        started = true;
        await rescan();
        writeJson(res, 200, { ok: true, count: tracks.length });
        return;
      }
      /* 统一设置：主界面与卡片桌面共用这一份（两边浮层读同一接口）。
         字段见 lib/settings.js 的 DEFAULT_SETTINGS。 */
      if (pathname === "/dsh-music/api/settings" && req.method === "GET") {
        const s = mergeSettings(prefs.settings);
        writeJson(res, 200, { ok: true, settings: s, cache: cacheUsage() });
        return;
      }
      if (pathname === "/dsh-music/api/settings" && req.method === "POST") {
        const body = await readBodyOr400(req, res); if (body === null) return;
        prefs.settings = patchSettings(prefs.settings, body);
        savePrefs(prefs);
        /* 立即把新配置应用到缓存层：换目录、改上限马上生效，不用重启 */
        const s2 = prefs.settings;
        if (s2 && s2.cache) {
          if (Number.isFinite(Number(s2.cache.maxMB))) configureCache({ maxBytes: Math.round(Number(s2.cache.maxMB)) * 1024 * 1024 });
          const mhDir = dirForSource(s2, "kg") || dirForSource(s2, "qq") || dirForSource(s2, "nc");
          if (mhDir && checkDir(mhDir).ok) configureCache({ dir: mhDir });
        }
        writeJson(res, 200, { ok: true, settings: s2, cache: cacheUsage() });
        return;
      }
      /* 目录自检：设置界面点「测试」时用，回可写/不可写及原因 */
      if (pathname === "/dsh-music/api/checkdir" && req.method === "GET") {
        const p = (url.searchParams.get("path") || "").trim();
        writeJson(res, 200, Object.assign({ ok: true }, checkDir(p)));
        return;
      }


      /* 缓存管理：GET 看占用、POST {clear:true} 清空。
         用户 2026-10-31 要求在线音频有固定保存位置，这里给出可查可清的入口。 */
      if (pathname === "/dsh-music/api/cache" && req.method === "GET") {

        writeJson(res, 200, Object.assign({ ok: true }, cacheUsage()));
        return;
      }

      /* 本地图片：设置里的「背景图片」允许填本地路径，浏览器不能直接读 file:，
         这里转成可访问的 HTTP 地址。只允许图片扩展名，避免被当成任意文件读取通道。 */
      if (pathname === "/dsh-music/api/file" && req.method === "GET") {
        const p = (url.searchParams.get("path") || "").trim();
        if (!p || !isAbsolute(p)) { writeJson(res, 400, { ok: false, error: "path 必须是绝对路径" }); return; }
        const ext = String(p).toLowerCase().match(/\.(png|jpe?g|gif|webp|bmp|svg)$/);
        if (!ext) { writeJson(res, 400, { ok: false, error: "只支持图片文件" }); return; }
        try {
          const st2 = statSync(p);
          if (!st2.isFile()) { writeJson(res, 400, { ok: false, error: "不是文件" }); return; }
          const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" }[ext[1]] || "application/octet-stream";
          res.writeHead(200, { "Content-Type": mime, "Content-Length": String(st2.size), "Cache-Control": "max-age=3600" });
          (async () => { try { for await (const c of createReadStream(p)) res.write(c); } catch { } try { res.end(); } catch { } })();
        } catch (e) { writeJson(res, 404, { ok: false, error: "读不到文件：" + String((e && e.message) || e) }); }
        return;
      }
      if (pathname === "/dsh-music/api/cache" && req.method === "POST") {
        const body = await readBodyOr400(req, res); if (body === null) return;
        if (body.clear) {
          const r = clearCache();
          writeJson(res, 200, Object.assign({ ok: true }, r, cacheUsage()));
          return;
        }
        if (typeof body.maxBytes === "number" && body.maxBytes > 0) {
          configureCache({ maxBytes: body.maxBytes });
          writeJson(res, 200, Object.assign({ ok: true }, cacheUsage()));
          return;
        }
        writeJson(res, 400, { ok: false, error: "需要 clear 或 maxBytes" });
        return;
      }

      if (pathname === "/dsh-music/api/prefs" && req.method === "POST") {
        const body = await readBodyOr400(req, res); if (body === null) return;
        /* sortMap = 每个歌单各自的排序（键 "src:playlistId"），与全局 sortMode 并存 */
        const allowed = ["volume", "mode", "currentId", "currentName", "position", "panelOpen", "tab", "sortMode", "sortMap", "showBar", "trackDur", "queue"];
        for (const k of allowed) {
          if (body[k] === undefined) continue;
          /* sortMap 是对象：只收纯对象，防止写入乱七八糟的东西 */
          if (k === "sortMap") {
            if (body[k] && typeof body[k] === "object" && !Array.isArray(body[k])) prefs[k] = body[k];
            continue;
          }
          /* queue 也是对象（{src, idx, list}）：同样只收纯对象，且 list 必须是数组 */
          if (k === "queue") {
            if (body[k] && typeof body[k] === "object" && !Array.isArray(body[k]) && Array.isArray(body[k].list)) prefs[k] = body[k];
            continue;
          }
          prefs[k] = body[k];
        }
        /* ★ 必须落盘：曾经这行被误删，导致 prefs 只在内存改、从不写文件，
           表现为「重启后 currentId 永远停在旧歌」「排序不保存」（用户实测）。 */
        savePrefs(prefs);
        writeJson(res, 200, { ok: true });
        return;
      }

      writeJson(res, 404, { ok: false, error: "unknown route" });
    } catch (err) {
      try { writeJson(res, 500, { ok: false, error: (err && err.message) || String(err) }); } catch { }
    }
  };

  ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: "/dsh-music", handler: serve }), "dsh-music-hub: routes");

  /* ---------------- 模型工具 music_play ----------------
     tools 是**可选**服务：只准 ctx.get + try/catch，绝不写进 export const inject
     （未就绪的服务会让整个 host 插件停在等待态，/dsh-music 全路由一起失效）。
     工具只做「解析意图 + 写 pendingIntent」，真正出声由浏览器半区轮询 /api/intent 执行：
     宿主进程里没有音频设备，模型也不可能替用户按下播放键（浏览器自动播放策略）。 */
  installTool(ctx);
}

const MUSIC_ACTIONS = ["play", "pause", "resume", "stop", "next", "prev"];
const MUSIC_SOURCES = ["local", "qq", "kg", "nc"];

function installTool(ctx) {
  let tools;
  try { tools = typeof ctx.get === "function" ? ctx.get("tools") : null; } catch { tools = null; }
  if (!tools || typeof tools.register !== "function") return;

  const tool = {
    name: "music_play",
    description: "控制 DSH 音乐播放器（dsh-music-hub）。播放时按关键词搜歌并播放：source=local 本地曲库（默认）、qq/ kg/ nc 分别走在线 QQ 音乐/酷狗/网易云（在线取链需要先在播放面板扫码登录，酷狗必须登录）。不传 query 时播本地第一首。也可用 action 执行暂停/继续/停止/上一首/下一首。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "歌名/歌手关键词，用于搜索并播放；仅 action=play 时使用" },
        source: { type: "string", enum: MUSIC_SOURCES, description: "播放来源：local 本地曲库（默认）/ qq 在线QQ音乐 / kg 在线酷狗 / nc 在线网易云" },
        action: { type: "string", enum: MUSIC_ACTIONS, description: "动作：play 播放（默认）/ pause 暂停 / resume 继续 / stop 停止 / next 下一首 / prev 上一首" },
      },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          action: { type: "string" }, played: { type: "boolean" }, kind: { type: "string" },
          track: { type: "string" }, matches: { type: "number" }, notice: { type: "string" },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: (value && value.notice) || "已请求播放" }];
      },
    },
    async execute(args) {
      const a = args && typeof args === "object" ? args : {};
      const action = MUSIC_ACTIONS.includes(a.action) ? a.action : "play";
      const source = MUSIC_SOURCES.includes(a.source) ? a.source : "local";
      const query = typeof a.query === "string" ? a.query.trim() : "";

      // 非 play：直接转发传输控制
      if (action !== "play") {
        pendingIntent = { action };
        const label = { pause: "已请求暂停", resume: "已请求继续播放", stop: "已请求停止", next: "已请求下一首", prev: "已请求上一首" }[action];
        return { action, played: false, kind: "", track: "", matches: 0, notice: label + "。若浏览器拦截，请在播放条上点对应按钮。" };
      }

      if (source === "local") {
        await ensureStarted();
        if (!tracks.length) {
          return { action, played: false, kind: "local", track: "", matches: 0, notice: "本地曲库为空。请打开播放面板点「选择目录」配置音乐文件夹。" };
        }
        const t = matchLocal(query);
        if (!t) {
          return { action, played: false, kind: "local", track: "", matches: 0, notice: "本地曲库没有匹配「" + query + "」的曲目。" };
        }
        pendingIntent = { action: "play", kind: "local", id: t.id, name: t.name };
        return { action, played: true, kind: "local", track: t.name, matches: 1, notice: "已请求播放本地「" + t.name.replace(/\.[^.]+$/, "") + "」。若被拦截请点 ▶ 解锁。" };
      }

      // 在线三源：必须在 manifest 里就能看出登录态，未登录直接给出可执行的提示
      const flags = loginFlags();
      if (!flags[source]) {
        const label = { qq: "QQ音乐", kg: "酷狗", nc: "网易云" }[source];
        return { action, played: false, kind: source, track: "", matches: 0, notice: label + "未登录：在线取链需要登录态。请打开播放面板切到「" + label + "」页签扫码登录后再试。" };
      }
      if (!query) {
        return { action, played: false, kind: source, track: "", matches: 0, notice: "请给出要播放的歌名或歌手（query 不能为空）。" };
      }
      try {
        const s = await searchOnline(source, query, 1);
        const results = (s && s.results) || [];
        if (!results.length) {
          return { action, played: false, kind: source, track: "", matches: 0, notice: "在线搜索没有结果：" + query };
        }
        const first = results[0];
        const title = String(first.title || first.name || "");
        const artists = Array.isArray(first.artists) ? first.artists : [];
        const id = source === "kg" ? String(first.hash || first.id || "") : (source === "qq" ? String(first.songmid || first.id || "") : String(first.id || ""));
        pendingIntent = { action: "play", kind: source, id, name: title, song: first };
        const label = { qq: "QQ音乐", kg: "酷狗", nc: "网易云" }[source];
        return {
          action, played: true, kind: source, track: title, matches: results.length,
          notice: "已请求播放" + label + "「" + title + "」" + (artists.length ? "（" + artists.slice(0, 2).join("/") + "）" : "") + "。若被拦截请点 ▶ 解锁。",
        };
      } catch (e) {
        return { action, played: false, kind: source, track: "", matches: 0, notice: "在线搜索失败：" + String((e && e.message) || e) };
      }
    },
  };

  try {
    ctx.effect(() => tools.register(tool), "dsh-music-hub: music_play tool");
  } catch (e) {
    /* 工具注册失败（名称冲突/契约变化）不得牵连路由：静默降级，界面照常可用 */
  }
}

/** 每次请求现场取受信主机名单（供流式路由复用） */
function trustedHostsNow(ctx) {
  const get = (typeof ctx.get === "function") ? (n) => { try { return ctx.get(n); } catch { return null; } } : () => null;
  const rt = get("webStartup") || get("webRuntime");
  const hosts = ((rt && rt.trustedHosts) || []).slice();
  try {
    const ws = get("webServer");
    if (ws && typeof ws.getOrigin === "function") hosts.push(new URL(ws.getOrigin()).host);
  } catch { }
  try {
    const app = get("webApp");
    if (app && typeof app.getAdvertisedUrl === "function") hosts.push(new URL(app.getAdvertisedUrl()).host);
  } catch { }
  return hosts;
}
