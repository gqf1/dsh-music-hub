/* dsh-music-hub 浏览器半区。
 *
 * 形态与 dsh-card-desktop / dsh-music-player 的客户端一致：
 *   window.__ModuleLoader__.load({id, factory}) → factory(require) 内部维护 module/exports
 *   末尾 exports.apply = apply; exports.inject = inject;
 *
 * 插槽：
 *   conversation.input.dock —— 播放条（order 40）
 *   shell.overlay          —— 播放面板（order 20）、自动播放提示（order 22）
 *
 * 数据全走同源宿主路由：
 *   本地   /dsh-music/manifest | /dsh-music/stream/<id> | /dsh-music/api/*
 *   在线   /dsh-music/<qq|kg|nc>/{status,login/*,search,play/<id>,lyric,playlists,...}
 */
window.__ModuleLoader__.load({
  id: "dsh-music-hub",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let reactMod = require("react");
    const React = reactMod && reactMod.default && !reactMod.createElement ? reactMod.default : reactMod;

    /* ================= 全局状态 ================= */
    const initState = () => ({
      tracks: [],
      loading: true,
      error: "",
      currentId: null,
      currentName: "",
      currentQuality: "",
      playing: false,
      position: 0,
      duration: 0,
      volume: 0.8,
      muted: false,
      mode: "sequence",
  panelOpen: false,
  showBar: true,        // 主界面输入框上方音乐条是否显示（卡片桌面可关）
      tab: "local",
      dir: "",
      loginFlags: { qq: false, kg: false, nc: false },
      autoplayHint: "",
      online: false,       // 当前播放的是在线曲目
      onlineSrc: "",
      currentArtist: "",
      lyricOpen: false,
      settingsOpen: false,   // 设置浮层（与卡片桌面共用同一份配置）
    });
    // 供测试复用 apply() 内部定义的 applyIntent（生产代码不读）
    let lastApplyIntent = null;
    /* ★ 状态也要跨实例共享（与上面的 SHARED 同一个容器）。
       否则脚本被加载两次时，两个实例各有一份 state：A 实例在放歌、B 实例显示
       「曲库为空」，点暂停只 pause 了 B 的那份视图 —— 正是用户遇到的症状。 */
    const SHARED = window.__mhMusicHubShared || (window.__mhMusicHubShared = {
      audio: null, state: null, listeners: new Set(), booted: false,
    });
    if (!SHARED.state) SHARED.state = initState();
    if (!SHARED.listeners) SHARED.listeners = new Set();
    const listeners = SHARED.listeners;
    const setState = (patch) => {
      if (!patch) return;
      SHARED.state = Object.assign({}, SHARED.state, patch);
      for (const fn of listeners) { try { fn(SHARED.state); } catch { } }
    };
    const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
    const getState = () => SHARED.state;

    /* 在线播放队列（模块级：切换页签不丢） */
    let onlineQueue = [];       // [{ src, song }]
    let onlineIndex = -1;
    /* 从 prefs 恢复出来的队列（{src, idx, list}）。只在首次需要时消费一次，
       避免重启后点上一首/下一首没反应。 */
    let _restoredQueue = null;
    let _queueLoading = false;   // ③ 兜底搜索进行中（避免重复请求）
    let _queuePending = false;   // 搜索期间用户点过下一首/上一首：建好队列后补做这次切换
    let _queuePendingDir = 0;
    let _queuePromise = null;   // ③ 兜底搜索的 Promise（playOnline 要 await 它）

    /* ================= 在线音源 UI 缓存（跨页签保留） ================= */
    const blankOnline = () => ({
      view: "search",       // search | playlists | ranks | mine | songs
      degraded: false,      // 主搜索通道被限流、走了降级联想接口
      sortMode: "manual",   // 当前歌单的排序方式（对齐酷狗 App 排序菜单）
      sortMap: {},          // 每个歌单各自的排序：{ "playlistId": "mode" }
      w: "",
      results: [],
      total: 0,
      playlists: [],
      groups: [],
      songs: [],            // 当前打开的歌单/榜单的歌曲
      opened: null,         // { kind:'playlist'|'rank'|'mine', name }
      busy: false,
      err: "",
      login: { loggedIn: false, nickname: "", qr: null, checking: false, msg: "" },
    });
    const onlineCache = { qq: blankOnline(), kg: blankOnline(), nc: blankOnline() };

    /* ================= 跨实例共享（修「叠音/停不掉/状态各说各话」） =================
       症状（2026-10-28 用户实测）：音乐库自己关了、播放中却显示「曲库为空」、
       点暂停停不掉、再点另一首变成两首叠着放。
       根因：客户端脚本被加载了不止一次（HMR / 重复注册），每次 factory 都新建了一套
       闭包 —— 于是出现多个 `<audio>` 各自播放、多份 state 各自显示。
       做法：把 audio 元素、state、订阅者都挂到 window 上的同一个对象里，
       无论模块实例化几次，全页只有一套播放器与一份状态。
       （SHARED 在状态段已声明并初始化，这里直接复用，不再重复声明。） */

    /* ================= Audio ================= */
    const ensureAudio = () => {
      if (SHARED.audio) return SHARED.audio;
      const audio = document.createElement("audio");
      SHARED.audio = audio;
      window.__mhAudio = () => audio;
      /* ★ 必须挂进 DOM（隐藏）。Chrome 对「不在文档树里的媒体元素」会退化 seek 能力：
         实测服务端 206/Range/Content-Length 全对，但 seekable 仍是 [0,0]（DIAG 显示 sk=0），
         于是 seek 被静默拒绝、位置被拉回 0 —— 就是「点进度条回开头」。
         挂进 body 后 seekable 才按真实缓冲计算。 */
      try {
        audio.setAttribute("data-mh-player", "1");
        audio.style.display = "none";
        audio.style.position = "absolute";
        audio.style.width = "0";
        audio.style.height = "0";
        (document.body || document.documentElement).appendChild(audio);
      } catch { }
      /* preload 必须是 auto：metadata 模式下浏览器只取元数据、不缓冲音频数据，
        实测 readyState 卡在 1（HAVE_METADATA），seek 到未缓冲区会被退回 0。 */
      audio.preload = "auto";
      audio.addEventListener("timeupdate", () => {
        setState({ position: audio.currentTime || 0 });
      });
      audio.addEventListener("play", () => setState({ playing: true, autoplayHint: "" }));
      audio.addEventListener("pause", () => {
        setState({ playing: false });
        /* 暂停时把「当前是哪首 + 停在哪」一起落盘：
           否则暂停后立刻重启，prefs 里可能还是上一首/invalid 的 position（用户实测：重启后回到旧歌）。 */
        try {
          const st = getState();
          /* 暂停时把「哪首 + 停在哪」立刻写盘（不走防抖：防抖窗口内重启就丢了） */
          if (st && st.currentId) {
            /* 时长也要一起存：重启后进度条要用 pos/dur 画，dur=0 会让条停在最开头、
               右边显示 0:00（用户实测：57 秒的进度条画在最左，文字却是 0:57/0:00）。
               优先级：音频解析出的真实时长 → state.trackDur → 已有值。 */
            const d0 = Number.isFinite(audio.duration) && audio.duration > 0
              ? audio.duration
              : (Number(st.trackDur) || Number(st.duration) || 0);
            savePrefs({ currentId: st.currentId, currentName: st.currentName || "", position: audio.currentTime || 0, trackDur: d0 }, true);
          }
        } catch { }
      });
      audio.addEventListener("ended", () => onTrackEnded());
      audio.addEventListener("error", () => {
        const msg = getState().online ? "在线播放失败（取链被拒或网络异常），可试下一首" : "播放失败：音频流错误";
        setState({ error: msg });
      });
      setInterval(() => {
        if (audio && !audio.paused && audio.currentTime > 0) savePrefs({ position: audio.currentTime });
      }, 2000);
      return audio;
    };

    /* ================= Host API ================= */
    const apiJson = async (path, opts) => {
      const res = await fetch(path, opts || {});
      const ct = res.headers.get("content-type") || "";
      const body = ct.indexOf("application/json") >= 0 ? await res.json() : await res.text();
      if (!res.ok) throw new Error(typeof body === "string" ? body : (body && body.error) || ("HTTP " + res.status));
      return body;
    };
    let pendingPrefs = {};
    let prefsTimer = 0;
    /* 立刻发出挂起的 prefs（关闭页面/切后台时用）：防抖窗口内关窗口会丢掉最后一次改动 */
    const flushPrefs = () => {
      if (!pendingPrefs || !Object.keys(pendingPrefs).length) return;
      const body = Object.assign({}, pendingPrefs);
      pendingPrefs = {};
      if (prefsTimer) { clearTimeout(prefsTimer); prefsTimer = null; }
      try {
        /* keepalive 让请求在页面卸载后仍能发出去（常规 fetch 会被取消） */
        fetch("/dsh-music/api/prefs", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(body), keepalive: true,
        }).catch(() => { });
      } catch { }
    };
    /* immediate=true 立刻发（切歌/暂停这类「丢了就回不去」的状态必须立刻写）。
       其余高频改动（进度）仍走 400ms 防抖，避免每 2 秒一次请求。 */
    const savePrefs = (patch, immediate) => {
      pendingPrefs = Object.assign({}, pendingPrefs, patch);
      if (immediate) { flushPrefs(); return; }
      if (prefsTimer) clearTimeout(prefsTimer);
      prefsTimer = setTimeout(flushPrefs, 400);
    };

    /* ================= 曲目工具 ================= */
    const trackById = (id) => getState().tracks.find((t) => t.id === id) || null;
    const indexOfTrack = (id) => getState().tracks.findIndex((t) => t.id === id);
    const fmtTime = (s) => {
      if (!Number.isFinite(s) || s <= 0) return "0:00";
      const m = Math.floor(s / 60), ss = Math.floor(s % 60);
      return m + ":" + (ss < 10 ? "0" : "") + ss;
    };
    const fmtSize = (n) => {
      if (!n) return "";
      if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
      return (n / 1024 / 1024).toFixed(1) + " MB";
    };
    /* 找「输入框外框卡片」——用于把播放条做成同款框（用户 2026-10-29 要求：
       播放条要与输入框一样框，并随输入框宽度调整）。
       做法：取页面下方宽度最大的那个 role=textbox（composer 输入区），再向上找到
       「宽度只比它大一点点（≤8px）」的最近祖先 —— 那就是带背景/边框的卡片外框。
       实测（1280 宽窗口）：dock 列 744px，输入框卡片 x=421 w=712，内层输入 708，
       卡片比内层宽 4px，比列窄 32px（左右各 16px 内边距）。
       宽度本身交给 CSS calc() 跟随，这里只负责「复制外框外观」。
       找不到返回 null，播放条保持自己的 CSS 默认外观，不误伤。 */
    const findComposerCard = () => {
      try {
        const list = Array.from(document.querySelectorAll('[role="textbox"]'));
        let best = null;
        for (const el of list) {
          const r = el.getBoundingClientRect();
          if (r.width < 320 || r.height < 24) continue;      // 排除小搜索框
          if (r.top < window.innerHeight * 0.45) continue;   // composer 在页面下半部
          if (best === null || r.width > best.r.width) best = { el, r };
        }
        if (best === null) return null;
        let el = best.el;
        let rect = best.r;
        for (let i = 0; i < 6; i++) {
          const p = el.parentElement;
          if (p === null) break;
          const pr = p.getBoundingClientRect();
          if (pr.width >= rect.width && pr.width - rect.width <= 8 && pr.left <= rect.left + 1) { el = p; rect = pr; }
          else break;
        }
        return el;
      } catch { return null; }
    };

    // 三源曲目字段差异统一在这里消化
    const songKey = (src, s) => {
      if (src === "kg") return String(s.hash || s.id || "");
      if (src === "qq") return String(s.songmid || s.id || "");
      return String(s.id || "");
    };
    const songTitle = (s) => String(s.title || s.name || s.songname || "未知曲目");
    /* 曲目时长（秒）：三个源字段不同 —— kg/qq 用 interval（秒），
       nc 用 dt（毫秒）。取不到返回 0。
       用途：浏览器解析不出音频时长时（实测 MP3 流会出现 duration=NaN），
       进度条仍要能按正确总长显示与拖动，否则整条进度条是死的。 */
    const songDuration = (s) => {
      if (!s) return 0;
      const dt = Number(s.dt);
      if (Number.isFinite(dt) && dt > 1000) return Math.round(dt / 1000);   // nc 毫秒
      const iv = Number(s.interval);
      if (Number.isFinite(iv) && iv > 0) return Math.round(iv);              // kg / qq 秒
      const du = Number(s.duration);
      if (Number.isFinite(du) && du > 0) return Math.round(du);
      return 0;
    };
    const songArtists = (s) => (Array.isArray(s.artists) ? s.artists.join(" / ") : String(s.artist || s.singername || ""));
    const songAlbum = (s) => String(s.album || s.albumname || "");
    const SRC_LABEL = { qq: "QQ音乐", kg: "酷狗", nc: "网易云" };

    /* ================= 播放控制 ================= */
    const armPlay = (a) => {
      const p = a.play();
      if (p && typeof p.catch === "function") {
        p.catch((err) => {
          const msg = String((err && err.name) || "") + " " + String((err && err.message) || "");
          /* AbortError / interrupted by pause：换歌时我们主动 pause 旧播放造成的，
             属于正常生命周期，绝不能报成「播放失败」（用户实测就是这个红字）。 */
          if (/AbortError|interrupted by a call to pause|interrupted by a new load/i.test(msg)) return;
          if (/autoplay|gesture|user|NotAllowed/i.test(msg)) {
            setState({ autoplayHint: "浏览器拦截了自动播放，点 ▶ 解锁" });
          } else {
            setState({ error: "播放失败：" + (msg.trim() || "未知原因") });
          }
        });
      }
    };
    /* 换歌统一入口：先彻底停掉当前播放再挂新源。
       为什么必须显式 stop：直接改 src 在新源加载完成前，旧音源仍可能在出声；
       若历史上存在过第二个 <audio>（旧版本的多实例），还会出现两首叠着放。
       这里 pause + removeAttribute('src') + load() 三步归零，确保同一时刻只有一路声。 */
    const stopCurrent = (a) => {
      try {
        a.pause();
        a.removeAttribute("src");
        a.load();
      } catch { }
      setState({ playing: false, position: 0, duration: 0 });
    };
    /* ================= Blob 播放（彻底解决「进度条拖不动」） =================
       已经查到的事实（2026-10-29，服务端日志 + 浏览器 DIAG 双向确认）：
         · 代理响应完全正确：206 + Content-Range: bytes 0-N/N + Content-Length + Accept-Ranges: bytes；
         · 但 Chromium 仍把这条流判成不可定位（FLAC 表现 sk=0，MP3 表现 d=NaN 且 sk=Infinity）；
         · 用一个全新的独立 <audio> 元素加载同一 URL，结果一模一样 → 与我们的播放器代码无关；
         · 更关键：日志显示浏览器从头到尾只请求过 bytes=0-，拖动时根本不发中间区间请求，
           说明它在发起请求之前就已经判定了「不可 seek」，任何后续补救都不会生效。
       结论：不要跟浏览器的判定较劲。改成「整首抓成 Blob 再播」——
       Blob URL 的数据全部内存持有，seekable 天然是 [0, duration]，拖动立即生效，
       不需要服务端 Range、不依赖任何启发式判定。
       体验：先用原 URL 立即起播（不等待下载），后台把整首抓进内存；
       抓完且仍是同一首时，无缝切到 blob URL 并恢复到原来的播放位置与播放状态。 */
    const blobUrls = new Map();     // 原 URL -> objectURL
    const blobPending = new Set();  // 正在抓取的 URL
    const BLOB_MAX_BYTES = 160 * 1024 * 1024;
    function primeBlob(a, url, trackId) {
      try {
        const base = String(url || "").split("#")[0];
        if (!base) return;
        if (base.slice(0, 5) === "blob:") return;
        if (blobUrls.has(base) || blobPending.has(base)) return;
        blobPending.add(base);
        fetch(base).then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          const len = Number(r.headers.get("content-length")) || 0;
          if (len > BLOB_MAX_BYTES) throw new Error("too big");
          return r.arrayBuffer().then((buf) => ({ buf, ct: r.headers.get("content-type") || "" }));
        }).then(({ buf, ct }) => {
          blobPending.delete(base);
          if (!buf || buf.byteLength < 4096) return;
          let objUrl = "";
          try { objUrl = URL.createObjectURL(new Blob([buf], { type: ct || "audio/mpeg" })); } catch { return; }
          const old = blobUrls.get(base);
          if (old) { try { URL.revokeObjectURL(old); } catch { } }
          blobUrls.set(base, objUrl);
          // 只在「仍是同一首」时切换，避免把正在播的歌切掉
          if (getState().currentId !== trackId) return;
          /* ★ 恢复位置只认「这一首」的进度，不能直接读 a.currentTime：
             playOnline/playTrack 换歌时 stopCurrent 只做 load()，并不保证 currentTime 归零，
             于是刚换到下一首时 a.currentTime 仍是上一首的值（用户实测：
             上一首点到 1:30，下一首就从 1:30 起播；下一首不到 1:30 就从头）。
             这里改用：state.position（切歌时已被 stopCurrent 清 0 或由 seekTo 更新）
             + pendingResumeAt（仅当是本首的待跳转目标，换歌时已由 dropStaleResume 清掉）。 */
          const wasPlaying = !a.paused;
          const pos = Number((getState() || {}).position) || 0;
          try {
            /* ★ 顺序不能反：先 load() 再 restore()。
               原来 restore() 里设 currentTime，紧跟 a.load() 又把状态清零 →
               进度回 0，且播放到结尾时 ended 事件不稳定（用户反馈：放完不自动下一首）。
               改成：挂 loadedmetadata 一次性恢复，load() 在最前。 */
            const restore = () => {
              /* 切换 blob 时该恢复到哪一秒，三个来源按优先级取：
                 ① resumeTarget（重启续播/换歌后待跳转的目标，由 seekTo 记下，最可靠）
                 ② state.position（用户拖动或播放中的实时进度）
                 ③ pos（下载开始那一刻的 currentTime，最不可靠）
                 ★ 为什么不能只看 ②：playOnline 开头的 stopCurrent 会把 position 清成 0，
                   而 blob 下载期间 seekTo 还在等元数据，这时 ② 是 0、③ 也是 0，
                   结果 restore 把 0 设回去 —— 用户看到的就是「点播放从头开始」。 */
              /* 优先级：本首的待跳转目标 → 本首当前进度（pos 已取自 state.position）。
                 换歌时 dropStaleResume 已清掉 pendingResumeAt，所以这里不会串到上一首。 */
              let use = pos;
              if (Number.isFinite(pendingResumeAt) && pendingResumeAt > 1) use = pendingResumeAt;
              try { a.currentTime = use; } catch { }
              /* ★ 界面也要同步：stopCurrent 把 state.position 清成了 0，
                 只改 audio.currentTime 的话，声音从 57 秒放、进度条却从 0 走
                 （用户实测：「进度条从0开始，后面时间正常累加」就是这个）。 */
              if (use > 1) { try { setState({ position: use }); } catch { } }
              if (use > 1) { try { clearPendingResume(); } catch { } }
              try { setState({ duration: Number.isFinite(a.duration) ? a.duration : (getState().duration || 0) }); } catch { }
              if (wasPlaying) armPlay(a);
            };
            a.src = objUrl;
            a.addEventListener("loadedmetadata", function once() {
              a.removeEventListener("loadedmetadata", once);
              restore();
            });
            a.load();
          } catch { }
        }).catch(() => { blobPending.delete(base); });
      } catch { blobPending.delete(String(url || "")); }
    }
    const playTrack = (id) => {
      const t = trackById(id);
      if (!t) return;
      const a = ensureAudio();
      dropStaleResume();          // 换歌：上一首的待跳转目标必须丢弃
      onlineQueue = []; onlineIndex = -1;
      stopCurrent(a);
      a.src = t.url;
      const _s = getState(); a.volume = _s.muted ? 0 : _s.volume;
      setState({
        currentId: id, currentName: t.name, currentQuality: t.quality || "",
        error: "", autoplayHint: "", online: false, onlineSrc: "",
        trackDur: Number(t.duration) || 0,
      });
      savePrefs({ currentId: id, currentName: t.name }, true);   // 切歌立刻写盘
      armPlay(a);
      primeBlob(a, t.url, id);   // 后台抓整首，成功后切 blob（seek 立即生效）
    };
    /** 在线播放：先 HEAD 探测服务端授予的真实品质，再挂流（<audio> 读不到响应头） */
    const playOnline = async (src, song, queue, index) => {
      const id = songKey(src, song);
      if (!id) { setState({ error: "曲目缺少 id" }); return; }
      const a = ensureAudio();
      dropStaleResume();          // 换歌：上一首的待跳转目标必须丢弃
      if (Array.isArray(queue)) { onlineQueue = queue; onlineIndex = index >= 0 ? index : 0; }
      else {
        /* 传 null 进来（重启后点播放）：不要清空已有队列，能补就补。
           ★ 这里必须 await：补队列可能走「现搜一次」，不 await 的话
             onlineQueue 还是空的，playOnline 就拿不到数组、永不写 prefs.queue，
             形成「队列空 → 不保存 → 重启后还是空」的死锁（用户三轮实测）。 */
        try {
          const pend = ensureOnlineQueue();
          if (pend && typeof pend.then === "function") { await pend; }
        } catch { }
        if (!onlineQueue.length) {
          /* 还是补不出来：至少把当前这首当作一首的队列，保证能写出 prefs.queue */
          onlineQueue = [{ src, song }];
          onlineIndex = 0;
        }
      }
      let quality = "";
      /* 带上歌名/歌手：宿主据此做「跨源按名复用缓存」——
         酷狗听过的歌，QQ 再听时若歌名与歌手一致，直接用已有文件，不再下载。 */
      const qTitle = String(song.title || song.name || "");
      const qArtist = Array.isArray(song.artists) ? song.artists.join("/") : String(song.artist || song.artists || "");
      const url = "/dsh-music/" + src + "/play/" + encodeURIComponent(id)
        + (qTitle ? ("?t=" + encodeURIComponent(qTitle) + "&a=" + encodeURIComponent(qArtist)) : "");
      try {
        const head = await fetch(url, { method: "HEAD" });
        const q = head.headers.get("x-dsh-quality");
        if (q) quality = decodeURIComponent(q);
        if (!head.ok) {
          const txt = await (await fetch(url)).text().catch(() => "");
          setState({ error: (SRC_LABEL[src] || src) + " " + (txt || ("HTTP " + head.status)) });
          return;
        }
      } catch (e) { /* HEAD 失败不阻断，直接试播 */ }
      stopCurrent(a);          // 与 playTrack 同一条换歌路径：先归零再挂新源
      a.src = url;
      const _s = getState(); a.volume = _s.muted ? 0 : _s.volume;
      setState({
        currentId: src + ":" + id, currentName: songTitle(song), currentArtist: songArtists(song),
        currentQuality: quality ? ((SRC_LABEL[src] || src) + " · " + quality) : (SRC_LABEL[src] || src),
        error: "", autoplayHint: "", online: true, onlineSrc: src,
        // 曲目时长来自搜索结果（kg/qq 是 interval 秒，nc 是 dt 毫秒）。
        // 用途：即使浏览器解析不出音频时长，进度条也能按正确总长拖动。
        trackDur: songDuration(song),
      });
      /* ★ 在线歌也要写 prefs：之前这里只 setState 不保存，
         重启后 prefs.currentId 仍是上一首本地歌（或空），用户看到「显示的不是重启前的音乐」。 */
      /* 时长：song 里能取到就用它；取不到（重启后重建的 song 没有 interval）
         保留 state 里已有值，不能写成 0 —— 否则进度条又变成 0:00。 */
      const _dNow = songDuration(song) || Number(getState().trackDur) || 0;
      savePrefs({ currentId: src + ":" + id, currentName: songTitle(song), position: 0, trackDur: _dNow }, true);   // 切歌立刻写盘（含时长，供重启后显示总长）
      /* 队列也存一份：重启后 onlineQueue 是空的，不存就点上一首/下一首没反应 */
      if (Array.isArray(queue) && queue.length) {
        saveQueuePrefs(src, queue.map((q2) => q2.song || q2), index >= 0 ? index : 0);
      }
      armPlay(a);
      primeBlob(a, url, src + ":" + id);   // 后台抓整首，成功后切 blob（seek 立即生效）
    };
    /* 播完一首之后：单曲循环原地重播；其余一律交给 step(1)，
       这样顺序 / 随机 / 在线队列三种情况只有一份实现，不会各自跑偏。 */
    const onTrackEnded = () => {
      if (getState().mode === "repeat-one" && getState().currentId) {
        const a = ensureAudio();
        a.currentTime = 0; armPlay(a); return;
      }
      /* 队列兜底已收进 step()（ensureOnlineQueue：prefs 存的队列 → 搜索结果），
         这里不再重复一份，避免两套逻辑各自跑偏。 */
      step(1);
    };
    const togglePlay = () => {
      const a = ensureAudio();
      const st0 = getState();
      if (!st0.currentId) {
        if (st0.tracks.length) playTrack(st0.tracks[0].id);
        return;
      }
      /* ★ 没有音源时必须重新取链，不能只 play()。
         场景：重启后 prefs 里记着上次的在线歌（currentId=kg:xxx），但刷新后
         没有 src，此时 a.play() 静默失败 —— 用户看到的就是「点播放没反应」。
         在线歌重新走 playOnline 取链；本地歌按 id 重放。 */
      if (!a.src) {
        /* ★ 重启后点播放要从上次暂停的位置续播，而不是从头开始。
           之前这里直接 playOnline/playTrack 都从 0 播（用户实测：1:00 暂停，点播放又回 0）。
           现在把 state 里的 position（恢复时已按保存值填好）记成待跳转，
           等音频挂上后由 seekTo 在 loadedmetadata 里跳过去。 */
        const resumeAt = Number(st0.position) || 0;
        const idStr = String(st0.currentId || "");
        if (idStr.indexOf(":") >= 0) {
          const src = idStr.slice(0, idStr.indexOf(":"));
          const sid = idStr.slice(idStr.indexOf(":") + 1);
          const song = st0.onlineSong && String(st0.onlineSong.__id || "") === sid ? st0.onlineSong : { id: sid, hash: sid, songmid: sid, title: st0.currentName || "上次播放" };
          /* ★ 必须带上队列：重启后点播放如果传 null，onlineQueue 就一直是空的，
             之后点上一首/下一首和自动下一首全部因为 n=0 直接 return（用户实测）。
             队列来源优先 prefs 恢复的那份，其次界面搜索结果。 */
          ensureOnlineQueue();
          let q = null, qi = 0;
          if (onlineQueue.length) {
            q = onlineQueue;
            qi = onlineIndex >= 0 ? onlineIndex : 0;
          } else {
            /* ★ 兜底：队列补不出来（重启后没搜过歌、prefs 也没有）时，
               至少把「当前这一首」当成只有一首的队列。
               否则 playOnline 收不到数组就永不写 prefs.queue，形成死锁：
               队列空 → 不保存 → 重启后还是空（用户三轮实测都是这个）。
               只有一首时按「顺序播放」会原地重播，符合直觉；用户点搜索页点歌后
               队列自然会被真实列表覆盖。 */
            q = [{ src: src, song }];
            qi = 0;
          }
          playOnline(src, song, q, qi);
          if (resumeAt > 1) { try { seekTo(resumeAt, true); } catch { } }
          return;
        }
        playTrack(st0.currentId);
        if (resumeAt > 1) { try { seekTo(resumeAt, true); } catch { } }
        return;
      }
      if (a.paused) armPlay(a); else a.pause();
    };
    /* 切歌（上一首 / 下一首）。
       两个实测缺陷（2026-10-28 用户反馈）：
       ① 随机播放点了没反应 —— 旧实现里「在线队列」分支只做 (i+d+n)%n，完全没看 mode，
          所以在线播放时切歌永远是顺序。
       ② 播第一首按「上一首」停在第一首 —— 旧实现在 indexOfTrack() 返回 -1 时直接
          playTrack(tracks[0])，而 currentId 是 "kg:xxx" 这类在线复合 id 时就命中 -1。
       现在：统一取「当前列表 + 当前下标」，shuffle 走随机（且尽量不重选自己），
       顺序 / 单曲循环走首尾环绕（第 1 首往前 = 最后一首）。 */
    /* 随机播放的「上一首」历史（用户 2026-10-29 要求）：
       正在放 A，点下一首随机到 D，再点上一首应该回到 A，而不是又随机一首。
       做法：正向随机时把「当前项」压栈，反向时优先弹栈；栈空才退化为随机。
       栈里存列表下标；切换播放范围（本地 ↔ 某个在线源）时清空，避免下标错位。 */
    let shuffleHistory = [];
    let shuffleScope = "";
    /* 重启后 onlineQueue 是空的（只有 playOnline 会填），此时点上一首/下一首或播完自动
       下一首都会因为 n=0 直接 return —— 用户看到「按钮没反应 / 放完就停」。
       这里按当前歌在「该源已加载的搜索结果」里的位置重建队列。 */
    /* 把当前在线队列压成最小字段集存进 prefs（重启后能原样恢复）。
       只留 id/歌名/歌手/时长 —— 一首约 80 字符，30 首约 2.4KB，可接受。 */
    const saveQueuePrefs = (src0, list, idx) => {
      try {
        if (!Array.isArray(list) || !list.length) return;
        const slim = list.slice(0, 200).map((s2) => ({
          i: songKey(src0, s2),
          t: songTitle(s2),
          a: songArtists(s2),
          d: songDuration(s2),
        }));
        savePrefs({ queue: { src: src0, idx: idx >= 0 ? idx : 0, list: slim } }, true);
      } catch { }
    };
    /* 重启后 onlineQueue 是空的（只有 playOnline 会填），此时点上一首/下一首或播完自动
       下一首都会因为 n=0 直接 return —— 用户看到「按钮没反应 / 放完就停」。
       优先用 prefs 里存下来的队列；没有就退回「该源已加载的搜索结果」。 */
    const ensureOnlineQueue = () => {
      try {
        const st = getState();
        if (!st.online) return;
        if (onlineQueue.length) return;
        const src0 = st.onlineSrc || "kg";
        /* ① prefs 里存过的队列（重启后最可靠） */
        const q0 = (_restoredQueue && _restoredQueue.src === src0) ? _restoredQueue : null;
        if (q0 && Array.isArray(q0.list) && q0.list.length) {
          onlineQueue = q0.list.map((it) => ({
            src: src0,
            song: { id: it.i, hash: it.i, songmid: it.i, title: it.t, artists: it.a ? [it.a] : [], artist: it.a || "", interval: it.d },
          }));
          let idx = q0.list.findIndex((it) => (src0 + ":" + it.i) === String(st.currentId || ""));
          if (idx < 0) idx = Number(q0.idx) || 0;
          onlineIndex = idx >= 0 && idx < onlineQueue.length ? idx : 0;
          _restoredQueue = null;   // 只用一次
          return;
        }
        /* ② 界面上的搜索结果（同一次会话内切过歌就有） */
        const cache0 = onlineCache[src0];
        const list = (cache0 && Array.isArray(cache0.results)) ? cache0.results : null;
        if (list && list.length) {
          const idx = list.findIndex((s2) => (src0 + ":" + songKey(src0, s2)) === String(st.currentId || ""));
          onlineQueue = list.map((s2) => ({ src: src0, song: s2 }));
          onlineIndex = idx >= 0 ? idx : 0;
          return;
        }
        /* ③ 前两条都没有（重启后且没搜过歌）：拿当前歌名再搜一次，把结果当队列。
           这是最后一道兜底 —— 没有它，重启后上一首/下一首永远没反应（用户实测）。
           异步执行：搜索回来后填队列，用户再点按钮就有效了。 */
        if (_queueLoading) { _queuePending = true; return _queuePromise; }
        const kw = String(st.currentName || "").trim();
        if (!kw) return null;
        _queueLoading = true;
        _queuePending = true;
        _queuePromise = fetch("/dsh-music/" + src0 + "/search?keywords=" + encodeURIComponent(kw) + "&num=30")
          .then((rr) => rr.json())
          .then((dd) => {
            const got = (dd && Array.isArray(dd.songs)) ? dd.songs : [];
            if (!got.length) return;
            const idx = got.findIndex((s2) => (src0 + ":" + songKey(src0, s2)) === String(st.currentId || ""));
            onlineQueue = got.map((s2) => ({ src: src0, song: s2 }));
            onlineIndex = idx >= 0 ? idx : 0;
            /* 顺带写进 prefs，下次重启直接可用 */
            saveQueuePrefs(src0, got, onlineIndex);
            try { setState({}); } catch { }
          }).catch(() => { })
          .then(() => {
            _queueLoading = false;
            _queuePromise = null;
            /* 用户这次点击不能白点：队列建好后立刻把这次切换补做掉 */
            if (_queuePending) {
              _queuePending = false;
              const d2 = _queuePendingDir;
              _queuePendingDir = 0;
              if (d2) { try { step(d2); } catch { } }
            }
          });
        return _queuePromise;
      } catch { return null; }
    };
    const step = (d) => {
      ensureOnlineQueue();
      const _cur = getState();
      const onlineActive = !!(_cur.online && onlineQueue.length);
      const n = onlineActive ? onlineQueue.length : _cur.tracks.length;
      /* 队列还在异步重建（重启后首次点按钮）：记住这次的方向，建好后补做，
         否则用户第一次点击没有任何反馈（体验上就是「按钮没反应」）。 */
      if (!n) {
        if (_queueLoading) { _queuePendingDir = d; }
        return;
      }
      const cur = onlineActive ? onlineIndex : indexOfTrack(_cur.currentId);
      const scope = onlineActive ? ("online:" + (_cur.onlineSrc || "")) : "local";
      if (scope !== shuffleScope) { shuffleHistory = []; shuffleScope = scope; }
      const forward = d > 0;

      let next;
      if (_cur.mode === "shuffle") {
        if (!forward && shuffleHistory.length) {
          const back = shuffleHistory.pop();
          next = Number.isInteger(back) && back >= 0 && back < n ? back : (cur < 0 ? 0 : cur);
        } else {
          if (forward && cur >= 0 && n > 1) {
            shuffleHistory.push(cur);
            if (shuffleHistory.length > 200) shuffleHistory.shift();   // 防止无限增长
          }
          next = cur;
          if (n > 1) {
            let guard = 0;                                  // 防御：避免极端情况下死循环
            while (next === cur && guard++ < 50) next = Math.floor(Math.random() * n);
          }
          if (!(next >= 0 && next < n)) next = 0;
        }
      } else {
        next = cur < 0 ? (forward ? 0 : n - 1) : (cur + d + n) % n;
      }
      if (onlineActive) {
        const item = onlineQueue[next];
        if (item) playOnline(item.src, item.song, onlineQueue, next);
      } else {
        const t = _cur.tracks[next];
        if (t) playTrack(t.id);
      }
    };
    /* 「媒体片段重载」：把 src 换成 原地址#t=目标秒 并重新加载。
       为什么需要它：实测（用户 2026-10-29 DIAG）酷狗 FLAC 流会出现 seekable=[0,0]、duration
       已知、缓冲正常，但 currentTime 赋值被静默拒绝（写 38，20 秒后仍在 20）。#t= 是 Media
       Fragments 标准写法，浏览器会直接从该时间点起播，不依赖 seekable 是否有效。
       代价：重建一次连接（本地代理，代价小），换来「点哪儿播哪儿」。 */
    function reloadAt(a, target) {
      try {
        const base = String(a.src || "").split("#")[0];
        if (!base) return;
        /* blob: 数据全在内存，本来就可任意 seek，绝不能再加 #t= 重载
           （对 blob 加片段会重新解析一遍，白白丢位置） */
        if (base.slice(0, 5) === "blob:") {
          try { a.currentTime = target; } catch { }
          return;
        }
        if (!base) return;
        const wasPlaying = !a.paused;
        if (window.__mhLastSeek) window.__mhLastSeek.fallback = "t=" + target.toFixed(0);
        a.src = base + "#t=" + target.toFixed(2);
        try { a.load(); } catch { }
        setState({ position: target });
        if (wasPlaying) armPlay(a);
      } catch { }
    }
    /* seek：
       正常路径是直接改 currentTime。但实测（用户 2026-10-29 提供的 DIAG）酷狗 FLAC 流
       会出现 seekable=[0,0]、duration 已知、缓冲正常的情况 —— 此时 currentTime 赋值被
       浏览器静默拒绝（写入 38，20 秒后仍在 20）。
       所以这里做「双路径」：
         1) 先按常规改 currentTime；
         2) 若 seekable 无效或 300ms 后位置没跟上，改用「媒体片段重载」：
            src = 原地址 + #t=目标秒，然后 load()。
            #t= 是 Media Fragments 标准写法，浏览器会直接从该时间点起播，
            不依赖 seekable 是否有效 —— 这是弱 Range 支持流上唯一可靠的定位方式。
       代价：会重新建立一次连接（本地代理，代价小），换来「点哪儿播哪儿」。 */
    let seekRetryTimer = 0;   // 等待音频就绪后跳进度的轮询（重启续播用）
    /* 「待跳转目标」：重启续播 / 换歌后要跳到的秒数。
       独立存一份的原因：playOnline 里的 stopCurrent 会把 state.position 清 0，
       而 blob 下载期间 seekTo 还在等元数据 —— 这时 state 和 audio.currentTime 都是 0，
       primeBlob 恢复时就会把 0 设回去（用户实测：点播放从头开始）。
       有了这一份，blob 切换时以它为准。 */
    let pendingResumeAt = NaN;
    const clearPendingResume = () => { pendingResumeAt = NaN; };
    /* pendingResumeAt 是「某一首」的待跳转目标，换歌必须丢弃。
       否则：播放中把进度条点到 1:30（seek 会写入 90），这首播完切到下一首，
       primeBlob 恢复时读到 90 → 下一首直接从 1:30 起播；下一首不足 90 秒则被夹到 0
       （用户实测「下一首从 1:30 开始放，总长不够才从头」）。 */
    const dropStaleResume = () => {
      try { clearPendingResume(); } catch { }
      try { cancelResumeSeek(); } catch { }
    };

    /* 取消「重启续播」的挂起轮询：用户手动点进度条/拖动时必须以手动为准，
       否则续播轮询会在音频就绪后把位置又改回去（用户实测：点进度条后跳回原处/从头）。 */
    const cancelResumeSeek = () => {
      if (seekRetryTimer) { try { clearInterval(seekRetryTimer); } catch { } seekRetryTimer = 0; }
    };
    const seekTo = (sec, isResume) => {
      /* 非「恢复续播」的调用 = 用户主动跳转，先取消挂起的续播 */
      if (!isResume) cancelResumeSeek();
      /* ★ 每一次显式 seek 都以「本次」为准，直接覆盖旧的续播目标。
         之前只在 isResume 时写、非 isResume 不写也不清 ——
         结果用户手动拖到新位置后，pendingResumeAt 还是上次的 1:12，
         blob 切回时又把他拉回去（用户实测：跳过去瞬间又跳回 1:12）。
         现在：任何 seek 都覆盖它（普通拖动=一次新目标，续播=恢复目标）。 */
      if (Number.isFinite(sec) && sec >= 0) pendingResumeAt = sec;
      const a = ensureAudio();
      if (!Number.isFinite(sec)) return;
      /* 音频还没就绪（刚点歌、playOnline 还在 HEAD 探测）：先记下目标，
         等 loadedmetadata 再跳 —— 否则这里会把 src 写成 "#t=" 的空地址，
         结果既没跳转、又把好不容易设上的 src 弄没了（实测：seek(88) 后 currentTime 仍是 0）。 */
      if (!a.src || a.readyState < 1) {
        /* 音频还没挂上（重启后还没点播放，或 playOnline 还在取链）。
           ★ 界面必须先跟着走：用户点了进度条就要看到位置变化，
             不能等音频就绪才动（否则表现为「跳过去瞬间又跳回原位」）。
             真正的跳转等音频就绪后由下面的轮询补上。 */
        try { setState({ position: sec }); } catch { }
        try { savePrefs({ position: sec }, true); } catch { }
        /* 光挂 loadedmetadata 可能错过事件（注册前就触发），所以再加短轮询兜底。
           只允许存在一个轮询：先清旧的，否则反复调用会累积多个定时器。 */
        const waitOnce = () => {
          try { a.removeEventListener("loadedmetadata", waitOnce); } catch { }
          seekTo(sec, isResume);
        };
        try { a.addEventListener("loadedmetadata", waitOnce); } catch { }
        cancelResumeSeek();
        let tries = 0;
        seekRetryTimer = setInterval(() => {
          tries++;
          if (a.src && a.readyState >= 1) {
            clearInterval(seekRetryTimer); seekRetryTimer = 0;
            try { a.removeEventListener("loadedmetadata", waitOnce); } catch { }
            seekTo(sec, isResume);
          } else if (tries > 60) {          // 最多等 12 秒
            clearInterval(seekRetryTimer); seekRetryTimer = 0;
            try { a.removeEventListener("loadedmetadata", waitOnce); } catch { }
          }
        }, 200);
        return;
      }
      const dur = Number.isFinite(a.duration) ? a.duration : 0;
      const target = Math.max(0, Math.min(sec, dur > 0 ? dur - 0.3 : sec));
      const sk = (a.seekable && a.seekable.length) ? a.seekable.end(a.seekable.length - 1) : 0;
      const before = a.currentTime;
      window.__mhLastSeek = { want: target, at: Date.now(), before, dur, sk };
      /* 已知不可 seek（seekable 为空/0）：不必再试 currentTime，直接媒体片段重载。
         同步执行，不依赖定时器 —— 这类流上 currentTime 赋值必然被拒，等 300ms 只是白等。 */
      if (!(sk > 0)) {
        /* ★ seekable 还是 0 有两种情况，必须分清：
           ① 音频元数据都还没到（刚点播放/刚换歌）→ 不能 reloadAt！那会重新 load 一次，
              真实环境里 #t= 对分块 FLAC 常常不生效，结果就是「从头开始」（用户实测）。
              正确做法是等 duration 出来再跳。
           ② duration 已知但 seekable=0（个别流的真实限制）→ 才走 reloadAt。 */
        const dKnown = Number.isFinite(a.duration) && a.duration > 0;
        if (!dKnown) {
          let n = 0;
          const t2 = setInterval(() => {
            n++;
            const ready = Number.isFinite(a.duration) && a.duration > 0;
            if (ready) { clearInterval(t2); seekTo(sec, isResume); }
            else if (n > 50) { clearInterval(t2); }      // 最多等 10 秒
          }, 200);
          try { a.addEventListener("loadedmetadata", function once2() {
            a.removeEventListener("loadedmetadata", once2);
            try { clearInterval(t2); } catch { }
            seekTo(sec, isResume);
          }); } catch { }
          return;
        }
        /* ★ 还在从「流」上播（src 不是内存 blob）时，绝不能 reloadAt 重拉流 ——
           那等于重新加载一条弱 Range 的流，浏览器落回 0 秒，用户看到的就是
           「点进度条跳不过去，又开始从头播」（2026-11-03 用户实测）。
           整首 blob 由 primeBlob 在后台抓，抓完 restore() 会按 pendingResumeAt
           跳到目标位置，所以这里只需「等它落地」；万一抓取一直没成，4 秒后
           再退回原来的重载兜底（至少还能跳，只是会重连）。 */
        const base0 = String(a.src || "").split("#")[0];
        if (base0 && base0.slice(0, 5) !== "blob:") {
          setState({ position: target });
          savePrefs({ position: target });
          let n3 = 0;
          const t3 = setInterval(() => {
            n3++;
            if (String(a.src || "").slice(0, 5) === "blob:") {          // blob 已落地：直接跳
              clearInterval(t3);
              seekTo(sec, isResume);
              return;
            }
            if (n3 > 20) {                                              // 4 秒还没来：退回重载
              clearInterval(t3);
              reloadAt(a, target);
            }
          }, 200);
          return;
        }
        reloadAt(a, target);
        setState({ position: target });
        savePrefs({ position: target });
        return;
      }      try { a.currentTime = target; } catch { }
      setState({ position: target });
      savePrefs({ position: target });
      if (isResume) { try { clearPendingResume(); } catch { } }   // 续播已落地，清掉目标
      /* seekable 有效但仍可能被拒（目标区还没缓冲）：300ms 后复核一次，没跟上就重载。 */
      setTimeout(() => {
        try {
          if (Math.abs(a.currentTime - target) <= 2 || target <= 2) { if (window.__mhLastSeek) window.__mhLastSeek.ok = true; return; }
        reloadAt(a, target);
        } catch { }
      }, 300);
    };
    const setVolume = (v) => {
      const a = ensureAudio();
      a.volume = v;
      setState({ volume: v, muted: v === 0 });
      savePrefs({ volume: v });
    };
    const cycleMode = () => {
      const order = ["sequence", "repeat-one", "shuffle"];
      const m = order[(order.indexOf(getState().mode) + 1) % order.length];
      setState({ mode: m });
      /* 切到非随机模式时清空随机历史：否则下次切回随机，「上一首」会翻出
         上一轮留下的旧下标，跳到一首毫无关系的歌。 */
      if (m !== "shuffle") shuffleHistory = [];
      savePrefs({ mode: m });
    };
    const MODE_LABEL = { sequence: "顺序播放", "repeat-one": "单曲循环", shuffle: "随机播放" };
    const MODE_ICON = { sequence: "↔", "repeat-one": "↻", shuffle: "⤨" };

    /* ================= 初始加载 ================= */
    let pendingRestore = null;
    const loadManifest = async () => {
      setState({ loading: true, error: "" });
      try {
        const man = await apiJson("/dsh-music/manifest");
        setState({
          tracks: (man && man.tracks) || [],
          loading: false,
          dir: (man && man.root) || "",
          loginFlags: { qq: !!man.qqLoggedIn, kg: !!man.kgLoggedIn, nc: !!man.ncLoggedIn },
          error: (man && man.error) || "",
        });
        for (const src of ["qq", "kg", "nc"]) onlineCache[src].login.loggedIn = !!man[src + "LoggedIn"];
        return man;
      } catch (e) {
        setState({ loading: false, error: "读取曲库失败：" + String((e && e.message) || e) });
        return null;
      }
    };
    const loadPrefs = async () => {
      try {
        const st = await apiJson("/dsh-music/api/state");
        if (!st || !st.ok) return;
        const p = st.prefs || {};
        if (typeof p.volume === "number") {
          const a = ensureAudio();
          a.volume = p.volume;
        setState({ volume: p.volume, muted: p.volume === 0 });
        /* 播放条显隐：与 sortMode 同理，三处必须对齐（客户端写 / 宿主白名单 / 宿主回传），
           否则「关掉播放条」重启就失效。 */
        if (typeof p.showBar === "boolean") setState({ showBar: p.showBar });
        }
        if (p.mode) setState({ mode: p.mode });
        /* 排序方式必须跟着重启保留，而且要「分歌单」保留：
           之前是三个源共用一个 p.sortMode，最后一个设的值会把其他全冲掉，
           用户看到的就是「只有当前这个歌单的排序记住了，别的还是默认」。
           现在：p.sortMap = { "<src>:<playlistId>": "<mode>" } 逐歌单恢复；
           p.sortMode 仅作为「没有逐歌单记录时」的兜底默认。 */
        if (p.sortMap && typeof p.sortMap === "object") {
          for (const k of ["qq", "kg", "nc"]) {
            if (onlineCache[k]) onlineCache[k].sortMap = Object.assign({}, p.sortMap);
          }
        }
        if (p.sortMode) {
          for (const k of ["qq", "kg", "nc"]) {
            if (onlineCache[k] && !onlineCache[k].sortMode) onlineCache[k].sortMode = p.sortMode;
          }
        }
        /* 队列随 prefs 一起恢复：否则重启后点上一首/下一首因 onlineQueue 为空而没反应 */
        try {
          if (p.queue && typeof p.queue === "object" && Array.isArray(p.queue.list) && p.queue.list.length) {
            _restoredQueue = { src: String(p.queue.src || "kg"), idx: Number(p.queue.idx) || 0, list: p.queue.list };
          }
        } catch { }
        if (p.currentId) {
          setState({ currentId: p.currentId, currentName: p.currentName || "" });
          /* 名字一并带进恢复上下文：在线歌续不了播放，但条上必须显示对的那首 */
          if (typeof p.position === "number" && p.position > 0) {
            pendingRestore = { id: p.currentId, position: p.position, name: p.currentName || "", trackDur: Number(p.trackDur) || 0 };
          } else {
            pendingRestore = { id: p.currentId, position: 0, name: p.currentName || "", trackDur: Number(p.trackDur) || 0 };
          }
        }
      } catch { }
    };
    /* 重启后恢复「上次在放什么」。
       ★ 关键：不能只认本地曲目。之前这里用 trackById(id) 查本地列表，
       在放的是在线歌（kg:xxx）时必然查不到 → 直接 return，
       但 loadPrefs 已经把 currentId/currentName 设成了那首在线歌 ——
       于是界面显示旧歌名、audio 却没有 src：点播放没反应、音乐库点歌报播放失败。
       现在分三种情况：
         本地且查到 → 恢复音频与进度；
         在线（id 含冒号）→ 保留「上次在放」的显示，但不预设假播放状态；
         本地但查不到（曲库换过/文件没了）→ 清空当前曲目，别留无源状态。 */
    const applyRestore = () => {
      if (!pendingRestore) return;
      const r = pendingRestore;
      const idStr = String(r.id || "");
      const isOnline = idStr.indexOf(":") >= 0;
      if (isOnline) {
        /* 在线歌：取链地址是临时的，刷新后续不了播放，但「听的是哪首 + 停在第几秒」必须还原。
           之前这里把 position/duration 硬写成 0，用户看到的是进度条归零、0:00/0:00。
           现在：position 用保存值，时长从该源的搜索结果里按 id 找回（trackDur），
           仍然 playing=false —— 不伪造「正在播放」，点播放才真正取链。 */
        const srcOf = idStr.slice(0, idStr.indexOf(":"));
        const sid = idStr.slice(idStr.indexOf(":") + 1);
        /* 时长优先用 prefs 里保存的 trackDur（切歌时一起存），
           拿不到再从该源搜索结果里按 id 找 —— 否则重启后显示 0:00 总长。 */
        let dur0 = Number(r.trackDur) || 0;
        if (!dur0) {
          try {
            const cache0 = onlineCache[srcOf];
            const list0 = (cache0 && Array.isArray(cache0.results)) ? cache0.results : [];
            const hit0 = list0.find((s2) => String(songKey(srcOf, s2)) === sid);
            if (hit0) dur0 = songDuration(hit0);
          } catch { }
        }
        /* 老数据没有 trackDur：不要拿 position 冒充总长（那会显示满格，更误导）。
           改为异步去搜索这首歌拿真实时长，拿到后补进 state；期间进度条按「时长未知」处理。 */
        if (!dur0) {
          try {
            const kw = String((r.name || getState().currentName || "")).trim();
            if (kw) {
              fetch("/dsh-music/" + srcOf + "/search?keywords=" + encodeURIComponent(kw) + "&num=10")
                .then((rr) => rr.json())
                .then((dd) => {
                  const list1 = (dd && dd.songs) || [];
                  const hit1 = list1.find((s3) => String(songKey(srcOf, s3)) === sid);
                  const d1 = hit1 ? songDuration(hit1) : 0;
                  if (d1 > 0 && String((getState() || {}).currentId) === idStr) {
                    setState({ trackDur: d1, duration: (getState() || {}).duration || d1 });
                    savePrefs({ trackDur: d1 });
                  }
                }).catch(() => { });
            }
          } catch { }
        }
        const pos0 = Number(r.position) || 0;
        setState({
          position: pos0, duration: dur0, playing: false,
          currentId: idStr, currentName: (r.name || getState().currentName || "上次播放"),
          currentQuality: (SRC_LABEL[srcOf] || srcOf),
          online: true, onlineSrc: srcOf, trackDur: dur0,
        });
        return;
      }
      const t = trackById(r.id);
      if (!t) {
        /* 本地曲目已不存在：清掉当前曲目，避免「显示一首点不动的歌」 */
        setState({ currentId: "", currentName: "", currentQuality: "", position: 0, duration: 0, playing: false });
        return;
      }
      const a = ensureAudio();
      a.src = t.url;
      const _s = getState(); a.volume = _s.muted ? 0 : _s.volume;
      /* 本地歌：position 也写进 state，否则播放条显示 0:00（音频真加载后 timeupdate 会刷新） */
      setState({
        currentId: r.id, currentName: t.name, currentQuality: t.quality || "",
        position: Number(r.position) || 0, trackDur: Number(t.duration) || 0,
      });
      const arm = () => {
        try { a.currentTime = Math.min(r.position, (a.duration || r.position) - 0.5); } catch { }
        a.removeEventListener("loadedmetadata", arm);
      };
      a.addEventListener("loadedmetadata", arm);
    };
    /* ================= 通用小组件 ================= */
    const Btn = ({ label, title, onClick, disabled, active, primary }) => React.createElement("button", {
      type: "button", title: title || label, onClick, disabled: !!disabled,
      className: "mh-btn" + (active ? " mh-btn-active" : "") + (primary ? " mh-btn-primary" : ""),
    }, label);

    /* ================= 播放条 ================= */
    /* 进度条（自绘，不 <input type=range>）。
       为什么换掉原生 range：受控 value 会在每次 timeupdate（约 4Hz）被写回，
       和「点击改变 range 值」的原生行为打架 —— 实测点进度条会跳回开头。
       自绘版按指针 x 直接算比例，拖动中只更新视觉、松手才 seek，行为确定。
       另外 duration 未知（0/NaN）时禁用拖动，避免把 0 当目标时间。 */
    const SeekBar = ({ pos, dur, disabled, onSeek }) => {
      const trackRef = React.useRef(null);
      const [dragging, setDragging] = React.useState(null);
      const canSeek = !disabled && Number.isFinite(dur) && dur > 0;
      const ratioAt = (clientX) => {
        const el = trackRef.current;
        if (!el) return 0;
        const r = el.getBoundingClientRect();
        return Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
      };
      const shown = dragging != null ? dragging : (canSeek ? Math.min(1, Math.max(0, pos / dur)) : 0);
      return React.createElement("div", {
        ref: trackRef,
        className: "mh-sb" + (canSeek ? "" : " mh-sb-dis"),
        title: canSeek ? "点击或拖动跳转" : "时长未知，暂不能拖动",
        onPointerDown: (ev) => {
          if (!canSeek) return;
          ev.preventDefault();
          setDragging(ratioAt(ev.clientX));
          const move = (e) => setDragging(ratioAt(e.clientX));
          const up = (e) => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
            const r = ratioAt(e.clientX);
            setDragging(null);
            onSeek(r * dur);
          };
          document.addEventListener("pointermove", move);
          document.addEventListener("pointerup", up);
        },
      },
        React.createElement("div", { className: "mh-sb-track" },
          React.createElement("div", { className: "mh-sb-fill", style: { width: (shown * 100) + "%" } }),
          React.createElement("div", { className: "mh-sb-dot", style: { left: (shown * 100) + "%" } })));
    };

    /* ================= 共享设置面板（主界面 / 卡片桌面同一份） =================
       做成「工厂」而不是固定组件：两边的 React 实例不同，工厂接收 React 后
       用同一个 createElement 造出结构，样式与逻辑只有这一处。 */
    function makeSettingsPanel(React, apiJson, opts) {
      const C = (opts && opts.colors) || {
        bg: "#0e1014", panel: "#171a1f", text: "#e6ebf2", dim: "#8b94a3", line: "#2a2e36", accent: "#31c27c",
      };
      const lbl = { fontSize: 12, color: C.dim, marginBottom: 4 };
      const inp = {
        width: "100%", boxSizing: "border-box", background: "#22262c", color: C.text,
        border: "1px solid " + C.line, borderRadius: 6, padding: "6px 9px", fontSize: 12, outline: "none",
      };
      const row = { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 };
      const btn = {
        background: "transparent", border: "1px solid " + C.line, color: C.dim,
        borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap",
      };
      const btnA = Object.assign({}, btn, { borderColor: C.accent, color: C.accent });

      return function SettingsPanel(props) {
        const [s, setS] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [msg, setMsg] = React.useState("");
        const [dirInfo, setDirInfo] = React.useState({});
        /* 缓存占用信息：从 /api/cache 读，用于显示已用空间和清空按钮 */
        const [cacheInfo, setCacheInfo] = React.useState({ dir: "", total: 0, count: 0, max: 0 });
        const [cacheBusy, setCacheBusy] = React.useState(false);
        /* 清空需二次确认：Electron 里不能用 window.confirm（会锁死窗口） */
        const [clearArmed, setClearArmed] = React.useState(false);
        const fmtSize = (n) => {
          const b = Number(n) || 0;
          if (b < 1024) return b + " B";
          if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
          if (b < 1073741824) return (b / 1048576).toFixed(1) + " MB";
          return (b / 1073741824).toFixed(2) + " GB";
        };
        const refreshCacheInfo = async () => {
          try {
            const r = await apiJson("/dsh-music/api/cache");
            if (r && r.ok !== false) setCacheInfo({ dir: r.dir || "", total: r.total || 0, count: r.count || 0, max: r.max || 0 });
          } catch { }
        };

        React.useEffect(() => {
          let alive = true;
          (async () => {
            try {
              const r = await apiJson("/dsh-music/api/settings");
              if (alive && r && r.settings) setS(r.settings);
            } catch (e) { if (alive) setMsg("读取设置失败：" + String((e && e.message) || e)); }
            try { const c = await apiJson("/dsh-music/api/cache"); if (alive && c) setCacheInfo({ dir: c.dir || "", total: c.total || 0, count: c.count || 0, max: c.max || 0 }); } catch { }
          })();
          return () => { alive = false; };
        }, []);

        /* 立即保存：任一控件改动都写宿主，两边即时同步 */
        const patch = async (p) => {
          setBusy(true); setMsg("");
          try {
            const r = await apiJson("/dsh-music/api/settings", {
              method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p),
            });
            if (r && r.settings) setS(r.settings);
            setMsg("已保存");
            if (props && typeof props.onChange === "function") props.onChange(r && r.settings);
          } catch (e) { setMsg("保存失败：" + String((e && e.message) || e)); }
          finally { setBusy(false); }
        };

        /* ---- 路径浏览器：目录选择与图片选择共用一套 ----
           mode=dir 只列目录；mode=image 连图片一起列，点文件即选中。
           用户要求：缓存位置与背景图都要能“弹出资源管理器”选，不是手打路径。 */
        const [browse, setBrowse] = React.useState(null);   // { mode, key, cur, dirs, files }
        /* 记忆上次浏览目录。注意：这里是音乐插件的 makeSettingsPanel，
           没有卡片桌面的 MU —— 之前用 MU.lastImageDir 直接抛 ReferenceError，
           导致点「选择…」完全没反应（未声明的变量用 `MU && …` 也挡不住）。
           用组件内 ref 存，两边互不影响。 */
        /* 诊断结果（多行）：独立区块显示，不受消息栏宽度限制 */
        const [diag, setDiag] = React.useState("");
        /* 新建文件夹的内联输入（不用 window.prompt：Electron 下被禁用） */
        const [mkOpen, setMkOpen] = React.useState(false);
        const [mkName, setMkName] = React.useState("");
        const [mkBusy, setMkBusy] = React.useState(false);
        /* 面板可拖动：位置存在这里（null = 默认贴右侧）。
           用户要求设置框能移动 —— 默认位置贴着客户端按钮区，不方便。 */
        const [panelPos, setPanelPos] = React.useState(opts && opts.initialPos ? opts.initialPos : null);
        const dragRef = React.useRef(null);
        const onTitleDown = (e) => {
          if (e.button !== undefined && e.button !== 0) return;
          /* 按钮上按下不启动拖动 */
          if (e.target && e.target.closest && e.target.closest("button, input")) return;
          e.preventDefault();
          /* 起点取面板本体左上角；取不到就退回指针位置，绝不让 NaN 进来
             （NaN 会让 left/top 变成无效值，面板直接消失 —— 实测过）。 */
          let ox = e.clientX, oy = e.clientY;
          try {
            const box = e.currentTarget.parentElement;
            if (box && typeof box.getBoundingClientRect === "function") {
              const r = box.getBoundingClientRect();
              if (r && Number.isFinite(r.left) && Number.isFinite(r.top)) { ox = r.left; oy = r.top; }
            }
          } catch { }
          if (panelPos && Number.isFinite(panelPos.left) && Number.isFinite(panelPos.top)) { ox = panelPos.left; oy = panelPos.top; }
          dragRef.current = { sx: e.clientX, sy: e.clientY, ox: ox, oy: oy };
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { }
        };
        const onTitleMove = (e) => {
          const d = dragRef.current;
          if (!d) return;
          /* 钳制在视口内：至少留 100px 宽 / 80px 高可见，避免拖出屏幕后找不回来 */
          const w = (typeof window !== "undefined" && window.innerWidth) ? window.innerWidth : 1200;
          const h = (typeof window !== "undefined" && window.innerHeight) ? window.innerHeight : 800;
          const left = Math.min(Math.max(0, d.ox + (e.clientX - d.sx)), Math.max(0, w - 100));
          /* top 上限留 200px：至少要能露出 200px 高度，否则内容全被截掉 */
          /* top 下限不能是 0：拖到最顶端会盖住客户端自己的标题栏/退出按钮，
             鼠标事件被那层抢走，面板就再也拖不动了（用户实测）。
             留 44px 让它始终在客户端按钮下方。 */
          const top = Math.min(Math.max(44, d.oy + (e.clientY - d.sy)), Math.max(44, h - 200));
          setPanelPos({ left: left, top: top });
        };
        const onTitleUp = () => { dragRef.current = null; };
        const openBrowse = async (mode, key, startPath) => {
          /* 先无条件打开空弹窗，保证「点了必有反应」；随后再填内容。
             之前是等接口回来才 setBrowse，接口一报错就什么都不弹，用户看到「没反应」。 */
          try { setBrowse({ mode: mode, key: key, cur: "__drives__", dirs: [], files: [], loading: true }); } catch { }
          const p = (startPath || "").trim();
          const base = p && /^[A-Za-z]:[\\\\/]|^\\\\\\\\/.test(p) ? p : "__drives__";
          try {
            const q = "/dsh-music/api/dir?path=" + encodeURIComponent(base)
              + (mode === "image" ? "&files=1&filter=image" : "");
            const r = await apiJson(q);
            const cur0 = (r && r.cur) || base;
            /* 记住图片模式最后停留的目录：下次点「选择…」直接从那里开始 */
            setBrowse({ mode: mode, key: key, cur: cur0, dirs: (r && r.dirs) || [], files: (r && r.files) || [] });
          } catch (e) {
            setMsg("读取目录失败：" + String((e && e.message) || e));
            setDiag("【打开目录失败】startPath=" + JSON.stringify(startPath) + " base=" + JSON.stringify(base) + " 错误=" + String((e && e.message) || e));
          }
        };
        /* 统一交互（用户要求：两处都用自绘窗口，风格照代码工作台的「打开文件」）：
             路径输入框 + [浏览…][↑ 上级] + 列表（📁 目录 / 📄 文件）+ [取消][确定]。
           缓存目录与背景图片共用同一个弹窗，只是 mode 不同决定列什么。
           代码工作台自己也不用资源管理器（它用 apiCall("listDir") 自绘列表），
           所以这里完全对齐它，不再把原生对话框当必经步骤。 */
        const pickDirSmart = async (key) => {
          /* 与背景图一致：从盘符开始，不记忆上次目录 */
          await openBrowse("dir", key, "");
        };

        /* 新建文件夹：不能用 window.prompt —— 本机是 Electron，原生 prompt 被禁用
           会静默返回 null，表现为「点了没反应」（实测反馈）。
           改成在弹窗内显示一行输入框，走 React 状态。 */
        const doMkdir = async (nm) => {
          if (!browse || browse.cur === "__drives__") return;
          const name = String(nm || "").trim();
          if (!name) { setMsg("请输入文件夹名"); return; }
          /* Windows 不允许这些字符，也不能是 . 或 .. */
          if (/[\\/:*?"<>|]/.test(name) || name === "." || name === "..") { setMsg("文件夹名不合法"); return; }
          setMkBusy(true);
          try {
            const r = await apiJson("/dsh-music/api/mkdir", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ parent: browse.cur, name: name }),
            });
            if (r && r.ok && r.path) {
              setMkOpen(false); setMkName("");
              setMsg("已创建：" + r.path);
              await browseInto(r.path);
            } else setMsg("新建失败：" + ((r && r.error) || "未知原因"));
          } catch (e) { setMsg("新建失败：" + String((e && e.message) || e)); }
          finally { setMkBusy(false); }
        };

        /* 背景图：同样用自绘窗口（与缓存目录同一个弹窗）。
           列表里文件夹可点进去、图片可点选，一次走完，不经过原生对话框。 */
        const pickImageSmart = async (key) => {
          /* 不记忆上次目录：用户明确要求每次打开从盘符开始，
             否则会「一打开就停在 F:\\DSH\\图片」显得莫名其妙。 */
          await openBrowse("image", key, "");
        };

        /* 上一级路径：不能用正则直接从 cur 上切。
           实测 C:\\Music 用 /[\\\\/][^\\\\/]*$/ 会得到 "C:"（少了反斜杠），
           宿主拒绝并报「path 必须是绝对路径」→ 用户看到的就是「上一级不能用」。
           正确做法：按分隔符切段、去掉末段、再按 Windows 规则拼回。 */
        const parentOf = (p) => {
          const s = String(p || "");
          if (!s || s === "__drives__") return "__drives__";
          const isWin = /^[A-Za-z]:/.test(s);
          const parts = s.split(/[\\\\/]/).filter(Boolean);
          // C:\\Music → parts=[C:, Music] → 上一级是盘符根本身 C:\\
          if (isWin && parts.length <= 1) return "__drives__";
          if (!isWin && parts.length <= 1) return "/";
          parts.pop();
          if (isWin) return parts.length === 1 ? parts[0] + "\\\\" : parts.join("\\\\");
          return "/" + parts.join("/");
        };

        const browseInto = async (p) => {
          if (!browse) return;
          try {
            const q = "/dsh-music/api/dir?path=" + encodeURIComponent(p || "__drives__")
              + (browse.mode === "image" ? "&files=1&filter=image" : "");
            const r = await apiJson(q);
            const curN = (r && r.cur) || p;
            setBrowse(Object.assign({}, browse, { cur: curN, dirs: (r && r.dirs) || [], files: (r && r.files) || [] }));
          } catch (e) { setMsg("读取目录失败：" + String((e && e.message) || e)); }
        };
        /* 选中结果写回设置：目录 → cache[key]；图片 → bg[key].image */
        const acceptPath = (p, isFile) => {
          if (!browse) return;
          const br = browse;
          setBrowse(null);
          if (br.mode === "image") {
            const val = isFile ? p : "";
            /* 记住图片所在目录：下次打开弹窗直接定位到这里 */
            const dirOfImg = String(p || "").replace(/[\\/][^\\/]*$/, "");
            const next = Object.assign({}, s.bg);
            next[br.key] = Object.assign({}, next[br.key], { image: val, dir: dirOfImg || (next[br.key] && next[br.key].dir) || "" });
            setS(Object.assign({}, s, { bg: next }));
            patch({ bg: { [br.key]: { image: val, dir: dirOfImg } } });
          } else {
            const next = Object.assign({}, s.cache);
            next[br.key] = p;
            setS(Object.assign({}, s, { cache: next }));
            patch({ cache: { [br.key]: p } });
          }
        };

        const testDir = async (key) => {
          const p = key === "common" ? s.cache.common : s.cache[key];
          if (!p) { setDirInfo(Object.assign({}, dirInfo, { [key]: "（空，使用默认目录）" })); return; }
          try {
            const r = await apiJson("/dsh-music/api/checkdir?path=" + encodeURIComponent(p));
            setDirInfo(Object.assign({}, dirInfo, { [key]: r && r.ok ? "✓ 可用" : ("✗ " + ((r && r.error) || "不可用")) }));
          } catch (e) { setDirInfo(Object.assign({}, dirInfo, { [key]: "✗ 检测失败" })); }
        };

        if (!s) {
          return React.createElement("div", { style: { padding: 24, color: C.dim, fontSize: 12 } }, msg || "读取设置中…");
        }

        const dirRow = (key, label) => React.createElement("div", { key: key, style: { marginBottom: 8 } },
          React.createElement("div", { style: lbl }, label),
          React.createElement("div", { style: row },
            React.createElement("input", {
              value: key === "common" ? (s.cache.common || "") : (s.cache[key] || ""),
              placeholder: key === "common" ? "留空 = 默认目录（%USERPROFILE%\\\\.dsh\\\\music-hub-cache）" : "留空 = 跟随共用目录",
              onChange: (e) => {
                const v = e.target.value;
                const next = Object.assign({}, s.cache);
                next[key] = v;
                setS(Object.assign({}, s, { cache: next }));
              },
              onBlur: (e) => { const next = {}; next[key] = e.target.value; patch({ cache: next }); },
              style: Object.assign({}, inp, { flex: 1 }),
            }),
            /* 选择：弹出目录浏览器（用户要求能像资源管理器那样选，而不是手打路径） */
            React.createElement("button", {
              style: btnA,
              onClick: () => pickDirSmart(key),
            }, "选择…"),
            React.createElement("button", { style: btn, onClick: () => testDir(key) }, "测试"),
            (key === "common" ? s.cache.common : s.cache[key])
              ? React.createElement("button", {
                style: btn,
                title: "清空（回到默认/跟随共用）",
                onClick: () => {
                  const next = Object.assign({}, s.cache);
                  next[key] = "";
                  setS(Object.assign({}, s, { cache: next }));
                  patch({ cache: { [key]: "" } });
                },
              }, "清除") : null,
          ),
          dirInfo[key] ? React.createElement("div", { style: { fontSize: 11, color: C.dim, marginTop: 2 } }, dirInfo[key]) : null,
        );

        const bgRow = (key, label) => React.createElement("div", { key: key, style: { marginBottom: 14 } },
          React.createElement("div", { style: { fontSize: 12, color: C.text, marginBottom: 6, fontWeight: 600 } }, label),
          React.createElement("div", { style: row },
            React.createElement("span", { style: Object.assign({}, lbl, { marginBottom: 0, width: 34 }) }, "颜色"),
            React.createElement("input", {
              type: "color",
              value: s.bg[key].color || "#0e1014",
              onChange: (e) => {
                const next = Object.assign({}, s.bg);
                next[key] = Object.assign({}, next[key], { color: e.target.value });
                setS(Object.assign({}, s, { bg: next }));
              },
              onBlur: (e) => patch({ bg: { [key]: { color: e.target.value } } }),
              style: { width: 40, height: 26, border: "1px solid " + C.line, borderRadius: 6, background: "transparent", cursor: "pointer" },
            }),
            React.createElement("input", {
              value: s.bg[key].color || "",
              placeholder: "或输入色值 #1a1d22"
              ,onChange: (e) => {
                const next = Object.assign({}, s.bg);
                next[key] = Object.assign({}, next[key], { color: e.target.value });
                setS(Object.assign({}, s, { bg: next }));
              },
              onBlur: (e) => patch({ bg: { [key]: { color: e.target.value } } }),
              style: Object.assign({}, inp, { width: 110, flex: "none" }),
            }),
          ),
          React.createElement("div", { style: Object.assign({}, row, { marginTop: 6 }) },
            React.createElement("span", { style: Object.assign({}, lbl, { marginBottom: 0, width: 34 }) }, "图片"),
            React.createElement("input", {
              value: s.bg[key].image || "",
              placeholder: "图片路径或 https 链接（有图时优先于颜色）"
              ,onChange: (e) => {
                const next = Object.assign({}, s.bg);
                next[key] = Object.assign({}, next[key], { image: e.target.value });
                setS(Object.assign({}, s, { bg: next }));
              },
              onBlur: (e) => patch({ bg: { [key]: { image: e.target.value } } }),
              style: Object.assign({}, inp, { flex: 1 }),
            }),
            React.createElement("button", {
              style: btnA,
              title: "选择背景图片（与缓存目录同一个窗口，可一路点进去）",
              onClick: () => pickImageSmart(key),
            }, "选择…"),
            React.createElement("button", {
              style: btn,
              /* 清除：颜色、图片、记住的目录一起清（否则路径还会显示，用户反馈） */
              onClick: () => {
                const next = Object.assign({}, s.bg);
                next[key] = Object.assign({}, next[key], { color: "", image: "", dir: "" });
                setS(Object.assign({}, s, { bg: next }));
                patch({ bg: { [key]: { color: "", image: "", dir: "" } } });
              },
            }, "清除"),
            /* 只在「确实有图片」时显示所在目录：清除后不应残留路径（用户反馈） */
            (s.bg[key].image && s.bg[key].dir) ? React.createElement("span", {
              style: { fontSize: 10, color: C.dim, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
              title: s.bg[key].dir,
            }, "📁 " + s.bg[key].dir) : null,
          ),
        );

        const close = props && typeof props.onClose === "function" ? props.onClose : () => { };
        /* 路径浏览弹窗：目录模式可“用这个目录”，图片模式点文件即选中 */
        const browseModal = browse ? React.createElement("div", {
          /* fixed：absolute 会相对面板（可能已被拖动）偏移，弹窗会跑到看不见的位置 */
          style: { position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 },
          onClick: () => setBrowse(null),
        }, React.createElement("div", {
          style: { width: 460, maxWidth: "92%", maxHeight: "80%", background: C.panel, border: "1px solid " + C.line, borderRadius: 10, display: "flex", flexDirection: "column", overflow: "hidden" },
          onClick: (e) => e.stopPropagation(),
        },
          React.createElement("div", { style: { padding: "10px 12px", borderBottom: "1px solid " + C.line, fontSize: 12, color: C.text, display: "flex", alignItems: "center", gap: 8 } },
            React.createElement("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              (browse.mode === "image"
                ? "选择背景图片（点图片选中；点文件夹进入）"
                : "选择缓存目录")
                + "（文件 " + ((browse.files || []).length) + " / 目录 " + ((browse.dirs || []).length) + "）"),
            React.createElement("button", { style: btn, onClick: () => setBrowse(null) }, "取消"),
          ),
          React.createElement("div", { style: { padding: "6px 12px", fontSize: 11, color: C.dim, borderBottom: "1px solid " + C.line, wordBreak: "break-all", display: "flex", alignItems: "center", gap: 8 } },
            React.createElement("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: browse.cur },
              browse.cur === "__drives__" ? "（选择驱动器）" : browse.cur),
            /* 浏览…：想快速跳目录时才用它（弹系统对话框）。不是必经步骤，对齐代码工作台。 */
            React.createElement("button", {
              style: Object.assign({}, btn, { flexShrink: 0 }),
              title: "打开系统目录选择器（可选，用来快速跳到某个文件夹）",
              onClick: async () => {
                const np = (opts && typeof opts.pickNative === "function") ? opts.pickNative : null;
                if (!np) { setMsg("无可用的目录选择服务，可直接在上面输入路径"); return; }
                try {
                  const r = await np();
                  if (r && r.ok && r.path) await browseInto(String(r.path));
                } catch (e) { setMsg("打开失败：" + String((e && e.message) || e)); }
              },
            }, "浏览…"),
            browse.mode === "dir" && browse.cur !== "__drives__"
              ? React.createElement("button", {
                style: Object.assign({}, btn, { flexShrink: 0 }),
                onClick: () => { setMkOpen(!mkOpen); setMkName(""); },
              }, mkOpen ? "取消新建" : "＋ 新建文件夹")
              : null,
          ),
          /* 新建文件夹的输入行：在列表上方就地输入，回车或点「创建」生效 */
          (browse.mode === "dir" && mkOpen) ? React.createElement("div", {
            style: { display: "flex", gap: 6, padding: "8px 12px", borderBottom: "1px solid " + C.line, alignItems: "center" },
          },
            React.createElement("span", { style: { fontSize: 11, color: C.dim, flexShrink: 0 } }, "新文件夹名"),
            React.createElement("input", {
              autoFocus: true,
              value: mkName,
              placeholder: "例如 MusicCache",
              onChange: (e) => setMkName(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") doMkdir(mkName); if (e.key === "Escape") setMkOpen(false); },
              style: Object.assign({}, inp, { flex: 1 }),
            }),
            React.createElement("button", {
              style: btnA, disabled: mkBusy,
              onClick: () => doMkdir(mkName),
            }, mkBusy ? "创建中…" : "创建"),
          ) : null,
          React.createElement("div", { style: { flex: 1, minHeight: 0, overflow: "auto" } },
            /* 上级目录在两种模式下都要有：图片模式也要能从盘符一路点进去 */
            browse.cur !== "__drives__" ? React.createElement("div", {
              onClick: () => browseInto(parentOf(browse.cur)),
              style: { padding: "6px 12px", cursor: "pointer", fontSize: 12, color: C.dim, borderBottom: "1px solid " + C.line },
            }, "⬆ 上级目录") : null,
            browse.dirs.map((d, i) => React.createElement("div", {
              key: "d" + i,
              onClick: () => browseInto(d.path || d.name),
              style: { padding: "6px 12px", cursor: "pointer", fontSize: 12, borderBottom: "1px solid " + C.line },
            }, "📁 " + String(d.name || d.path || ""))),
            (browse.files || []).map((f2, i) => React.createElement("div", {
              key: "f" + i,
              onClick: () => acceptPath(f2.path || f2.name, true),
              title: f2.path || f2.name,
              style: { padding: "6px 12px", cursor: "pointer", fontSize: 12, color: C.accent, borderBottom: "1px solid " + C.line },
            }, "🖼 " + String(f2.name || ""))),
          ),
          /* 底部：[取消][确定]，与代码工作台一致。
             目录模式 = 确定当前目录；图片模式 = 确定时提示要点图片（图片点即生效）。 */
          React.createElement("div", { style: { padding: "8px 12px", borderTop: "1px solid " + C.line, display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" } },
            browse.mode === "image" ? React.createElement("span", { style: { flex: 1, fontSize: 11, color: C.dim } }, "点图片即生效") : null,
            React.createElement("button", { style: btn, onClick: () => setBrowse(null) }, "取消"),
            browse.mode === "dir" ? React.createElement("button", {
              style: btnA,
              disabled: browse.cur === "__drives__",
              onClick: () => acceptPath(browse.cur, false),
            }, "确定") : null,
          ),
        )) : null;

        return React.createElement("div", {
          style: {
            /* ★ 必须 fixed：拖动算出的 left/top 是视口坐标；
               若用 absolute，会相对有定位的祖先（音乐库面板）偏移，
               坐标一叠加就跑到可视区外 —— 表现就是「拖动后面板消失」。 */
            position: "fixed",
            ...(panelPos
              /* 高度不能用 min(720px, calc(100% - Npx))：calc 里拼 JS 字符串一旦算错，
                 面板高度会塌成 0，同样表现为「拖动后消失」。 */
              /* 高度不能再写死 640：拖动后 top 可能很小，640 + top 会超出视口，
                 下半部分就被截断。改成「从 top 到视口底部减余量」，并对 top 做钳制。 */
              ? { left: panelPos.left, top: panelPos.top, bottom: "auto", right: "auto",
                  height: "calc(100vh - " + Math.max(44, panelPos.top) + "px - 24px)",
                  maxHeight: "calc(100vh - 24px)" }
              : { top: 40, right: 0, bottom: 0 }),
            width: 420, maxWidth: "92%",
            background: C.panel, borderLeft: "1px solid " + C.line, display: "flex", flexDirection: "column",
            zIndex: 30, boxShadow: "-8px 0 24px rgba(0,0,0,.4)",
          },
        },
          React.createElement("div", {
            /* 标题栏 = 拖动把手（用户要求设置框能移动）。
               右侧留 44px 安全区避开客户端关闭按钮。 */
            onPointerDown: onTitleDown, onPointerMove: onTitleMove, onPointerUp: onTitleUp,
            style: { display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", paddingRight: 44, borderBottom: "1px solid " + C.line, flexShrink: 0, cursor: "move", userSelect: "none", flexWrap: "wrap" },
          },
            React.createElement("button", { style: btn, onClick: close, title: "关闭设置" }, "✕ 关闭"),
            React.createElement("span", { style: { flex: 1, fontSize: 13, fontWeight: 600, color: C.text } }, "设置"),
            /* 消息不再放标题栏：那里被 44px 安全区挤，用户看不到（实测反馈）。
               改为在内容区顶部单独一块，醒目、可换行、可选中。 */
          ),
          React.createElement("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: 14 } },
            /* 消息块：放内容区最上面，醒目、可换行、可选中复制 */
            msg ? React.createElement("div", {
              style: {
                marginBottom: 12, padding: "7px 10px", background: "rgba(49,194,124,.10)",
                border: "1px solid " + C.accent, borderRadius: 6, fontSize: 12, color: C.text,
                whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.6, userSelect: "text",
              },
            }, msg) : null,
            /* 诊断结果区块：等宽字体、可换行、可选中复制（便于反馈给我） */
            diag ? React.createElement("div", {
              style: {
                marginBottom: 14, padding: "8px 10px", background: "#12161c", border: "1px solid " + C.line,
                borderRadius: 6, fontSize: 11, color: C.dim, whiteSpace: "pre-wrap", wordBreak: "break-all",
                lineHeight: 1.7, fontFamily: "Consolas, monospace", userSelect: "text", cursor: "text",
              },
            }, diag) : null,
            /* 主界面条 */
            React.createElement("div", { style: { marginBottom: 16 } },
              React.createElement("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
                React.createElement("input", {
                  type: "checkbox", checked: !!s.showBar,
                  onChange: (e) => patch({ showBar: e.target.checked }),
                }),
                React.createElement("span", { style: { fontSize: 12, color: C.text } }, "显示主界面输入框上方的播放条"),
              ),
              React.createElement("div", { style: { fontSize: 11, color: C.dim, marginTop: 4, marginLeft: 22 } },
                "关闭后主界面播放条隐藏，音乐库与歌词框仍可用（两个界面共用这一项）"),
            ),

            /* 缓存 */
            React.createElement("div", { style: { fontSize: 12, fontWeight: 600, color: C.text, margin: "18px 0 8px" } }, "歌曲缓存"),
            dirRow("common", "共用目录（三个平台都用它，同一首歌只存一份）"),
            dirRow("qq", "QQ 音乐专用目录（留空则跟随共用目录）"),
            dirRow("kg", "酷狗专用目录"),
            dirRow("nc", "网易云专用目录"),
            /* 缓存上限：以 GB 显示，±1G 步进，也可直接输入任意值（用户要求） */
            React.createElement("div", { style: { marginTop: 10 } },
              React.createElement("div", { style: lbl }, "缓存上限"),
              React.createElement("div", { style: row },
                React.createElement("button", {
                  style: btn, title: "减少 1GB",
                  onClick: () => patch({ cache: { maxMB: Math.max(64, Math.round(s.cache.maxMB / 1024 - 1) * 1024) } }),
                }, "−1G"),
                React.createElement("input", {
                  type: "number", min: 0.0625, step: 0.5,
                  value: Math.round((s.cache.maxMB / 1024) * 100) / 100,
                  onChange: (e) => {
                    const gb = Number(e.target.value);
                    const mb = gb > 0 ? Math.round(gb * 1024) : s.cache.maxMB;
                    setS(Object.assign({}, s, { cache: Object.assign({}, s.cache, { maxMB: mb }) }));
                  },
                  onBlur: (e) => {
                    const gb = Number(e.target.value);
                    patch({ cache: { maxMB: gb > 0 ? Math.round(gb * 1024) : 2048 } });
                  },
                  style: Object.assign({}, inp, { width: 84, flex: "none", textAlign: "center" }),
                }),
                React.createElement("button", {
                  style: btn, title: "增加 1GB",
                  onClick: () => patch({ cache: { maxMB: Math.min(65536, Math.round(s.cache.maxMB / 1024 + 1) * 1024) } }),
                }, "+1G"),
                React.createElement("span", { style: { fontSize: 11, color: C.dim } }, "GB"),
              ),
              React.createElement("div", { style: { fontSize: 11, color: C.dim, marginTop: 3 } },
                "默认 2GB，范围 0.0625 ~ 64GB；超出上限时按最久未使用自动淘汰"),
            /* 缓存占用 + 清空：宿主的 POST /api/cache {clear:true} 早就有了，
               但界面一直没入口，用户找不到（实测反馈「设置里没有清空缓存」）。 */
            React.createElement("div", { style: { marginTop: 10, padding: "8px 10px", background: "#12161c", border: "1px solid " + C.line, borderRadius: 6 } },
              React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                React.createElement("span", { style: { flex: 1, fontSize: 12, color: C.text } },
                  "已用 " + fmtSize(cacheInfo.total) + " · " + (cacheInfo.count || 0) + " 个文件")),
                React.createElement("button", {
                  style: Object.assign({}, btn, { color: "#e06c6c" }),
                  title: "删除该目录下所有缓存文件",
                  disabled: cacheBusy || !cacheInfo.count,
                  onClick: async () => {
                    /* 不用 window.confirm：Electron 下原生对话框会锁死窗口（项目已知坑）。
                       改成两次点击确认：按钮文字变化。 */
                    if (!clearArmed) { setClearArmed(true); return; }
                    setClearArmed(false); setCacheBusy(true);
                    try {
                      const r = await apiJson("/dsh-music/api/cache", {
                        method: "POST", headers: { "content-type": "application/json" },
                        body: JSON.stringify({ clear: true }),
                      });
                      if (r && r.ok) { await refreshCacheInfo(); setMsg("缓存已清空（删除 " + (r.removed || 0) + " 个文件）"); }
                      else setMsg("清空失败：" + ((r && r.error) || "未知原因"));
                    } catch (e) { setMsg("清空失败：" + String((e && e.message) || e)); }
                    finally { setCacheBusy(false); }
                  },
                }, cacheBusy ? "清理中…" : (clearArmed ? "再点一次确认" : "清空缓存")),
              React.createElement("div", { style: { fontSize: 11, color: C.dim, marginTop: 4 } },
                "目录：" + (cacheInfo.dir || "")),
            ),
              React.createElement("button", {
                style: Object.assign({}, btn, { marginTop: 6, fontSize: 10 }),
                onClick: () => {
                  const fns = (opts && typeof opts.nativeMethods === "function") ? opts.nativeMethods() : [];
                  /* 分三种情况报，便于定位到底哪一层失败 */
                  const dbg = (opts && typeof opts.debug === "function") ? opts.debug() : null;
                  if (!fns.length) {
                    setMsg(dbg ? ("取不到。详情：" + dbg) : "取不到 uiWorkspace");
                  } else {
                    /* 关键：有方法时也要把「从哪条路取到的」一起显示，
                       否则分不清是真服务还是兜底取到的错对象（已因此误判过一轮）。 */
                    const all = (opts && typeof opts.probeAll === "function") ? opts.probeAll() : [];
                    /* 直接报告 pickDirectory 是否存在及其类型，不再靠方法名推断 */
                    let pdInfo = "无";
                    try {
                      const svcNow = (opts && typeof opts.peekService === "function") ? opts.peekService() : null;
                      if (svcNow) pdInfo = typeof svcNow.pickDirectory;
                    } catch (e) { pdInfo = "取错:" + String(e && e.message); }
                    /* 逐项分行显示：消息栏宽度有限，长串会被截断看不清（实测）。
                       分行后每项独立一行，完整可读。 */
                    const lines = [];
                    lines.push("取服务路径：" + (dbg || "?"));
                    lines.push("pickDirectory 类型：" + pdInfo);
                    lines.push("该方法列表：" + (fns.join(", ") || "无"));
                    lines.push("可用服务：" + (all.join(", ") || "无"));
                    setDiag(lines.join("\\n"));
                  }
                },
              }, "诊断：列出目录服务可用方法"),
              /* 直接试调用：点它就真的去弹原生目录选择，用来区分
                 「方法存在但调用失败」还是「根本没调到」。 */
              React.createElement("button", {
                style: Object.assign({}, btnA, { marginTop: 6, marginLeft: 6, fontSize: 10 }),
                onClick: async () => {
                  const np = (opts && typeof opts.pickNative === "function") ? opts.pickNative : null;
                  if (!np) { setDiag("没有 pickNative 通道"); return; }
                  setDiag("正在调用 pickDirectory…");
                  try {
                    const r = await np();
                    setDiag("调用返回：" + JSON.stringify(r));
                  } catch (e) { setDiag("调用抛错：" + String((e && e.message) || e)); }
                },
              }, "直接试调用原生选择"),
            ),

            /* 背景 */
            React.createElement("div", { style: { fontSize: 12, fontWeight: 600, color: C.text, margin: "20px 0 8px" } }, "背景"),
            bgRow("stage", "卡片外的大背景"),
            bgRow("card", "悬浮窗背景"),
            bgRow("lyric", "歌词背景"),
          ),
          browseModal,
        );
      };
    }

    const NowPlayingBar = () => {
      const [st, setSt] = React.useState(getState());
      React.useEffect(() => subscribe(setSt), []);
      /* 主界面播放条显隐：默认显示，可在卡片桌面的音乐页关掉。
         返回 null 而不是不注册槽位 —— 运行时注销槽位会留下占位空隙。 */
      if (st.showBar === false) return null;
      /* 总时长优先用浏览器解析出的真实值；解析不出（实测部分在线流 duration=NaN）
         就退回曲目元数据里的时长，保证进度条可用、拖动比例正确。 */
      const dur = (st.duration && Number.isFinite(st.duration) && st.duration > 0)
        ? st.duration
        : (Number(st.trackDur) || 0);
      const pos = st.position || 0;
      const idx = indexOfTrack(st.currentId);
      const placeholder = st.online ? "在线曲目" : (st.loading ? "正在读取音乐库…" : (st.tracks.length ? "未播放" : "曲库为空"));
      // 播放条外框与输入框一致：宽度由 CSS calc() 跟随列宽，这里只复制外框外观
      const barRef = React.useRef(null);
      /* 把输入框卡片的「背景/边框/圆角/阴影」复制到播放条上（用户要求：与输入框一样框）。
         宽度不在这里设 —— CSS 用 calc(100% - 16px*2) 自动跟随列宽，避免 JS 量出 744
         而实际卡片是 712 的偏差（实测数据见 findComposerCard 的注释）。
         只复制外观相关的四项，其余（flex 布局、padding）保持播放条自己的，
         否则会把输入框内部的行高/内边距一并搬过来，播放条会被撑高。 */
      React.useEffect(() => {
        const sync = () => {
          const el = barRef.current;
          if (!el) return;
          const card = findComposerCard();
          if (!card) return;
          let cs;
          try { cs = window.getComputedStyle(card); } catch { return; }
          if (!cs) return;
          const pick = (v) => (v && v !== "rgba(0, 0, 0, 0)" && v !== "transparent") ? v : "";
          // 背景：卡片可能是渐变（background-image），两者都复制才像
          const bg = pick(cs.backgroundColor);
          const bgImg = cs.backgroundImage && cs.backgroundImage !== "none" ? cs.backgroundImage : "";
          el.style.background = bgImg ? (bgImg + (bg ? " " + bg : "")) : (bg || "");
          el.style.backgroundColor = bg;
          el.style.backgroundImage = bgImg;
          el.style.border = cs.borderTopWidth + " " + cs.borderTopStyle + " " + cs.borderTopColor;
          el.style.borderRadius = cs.borderTopLeftRadius;
          if (cs.boxShadow && cs.boxShadow !== "none") el.style.boxShadow = cs.boxShadow;
        };
        sync();
        let mo = null, ro = null;
        try {
          if (typeof MutationObserver === "function") {
            mo = new MutationObserver(() => sync());
            mo.observe(document.body, { childList: true, subtree: true });
          }
        } catch { mo = null; }
        try {
          if (typeof ResizeObserver === "function") {
            const card = findComposerCard();
            if (card) { ro = new ResizeObserver(() => sync()); ro.observe(card); }
          }
        } catch { ro = null; }
        window.addEventListener("resize", sync);
        const t1 = setTimeout(sync, 300);
        const t2 = setTimeout(sync, 1200);
        return () => {
          try { if (mo) mo.disconnect(); } catch { }
          try { if (ro) ro.disconnect(); } catch { }
          window.removeEventListener("resize", sync);
          clearTimeout(t1); clearTimeout(t2);
        };
      }, []);
      return React.createElement(React.Fragment, null, React.createElement("div", {
        className: "mh-bar", ref: barRef,
      },
        React.createElement("button", {
          type: "button", className: "mh-logo", title: "打开播放面板",
          onClick: () => { setState({ panelOpen: true }); savePrefs({ panelOpen: true }); },
        }, "🎵"),
        React.createElement("div", { className: "mh-ctrl" },
          Btn({ label: "⏮", title: "上一首", onClick: () => step(-1), disabled: !st.tracks.length && !st.online }),
          Btn({ label: st.playing ? "⏸" : "▶", title: st.playing ? "暂停" : "播放", onClick: togglePlay, disabled: !st.tracks.length && !st.currentId, active: st.playing }),
          Btn({ label: "⏭", title: "下一首", onClick: () => step(1), disabled: !st.tracks.length && !st.online }),
        ),
        React.createElement("div", { className: "mh-info" },
          React.createElement("div", { className: "mh-name-row" },
            React.createElement("span", { className: "mh-name", title: st.currentName || placeholder },
              st.currentName || placeholder),
            st.currentQuality ? React.createElement("span", { className: "mh-quality" }, st.currentQuality) : null),
          SeekBar({ pos, dur, disabled: !st.currentId, onSeek: seekTo })),
        React.createElement("div", { className: "mh-time" }, fmtTime(pos) + " / " + fmtTime(dur)),

        React.createElement("div", { className: "mh-vol" },
          Btn({ label: st.muted || st.volume === 0 ? "🔇" : "🔊", title: "静音/恢复", onClick: () => setVolume(st.muted || st.volume === 0 ? 0.8 : 0) }),
          React.createElement("input", {
            type: "range", className: "mh-vol-slider", min: 0, max: 1, step: 0.01, value: st.muted ? 0 : st.volume,
            onChange: (e) => setVolume(parseFloat(e.target.value) || 0),
          })),
        Btn({ label: "词", title: "歌词", onClick: () => setState({ lyricOpen: !st.lyricOpen }), active: st.lyricOpen, disabled: !st.currentId }),
        Btn({ label: MODE_ICON[st.mode], title: MODE_LABEL[st.mode] + "（点击切换）", onClick: cycleMode, active: st.mode !== "sequence" }),
        React.createElement("span", { className: "mh-count", title: "本地曲目数" },
          st.tracks.length ? (idx >= 0 ? (idx + 1) + "/" + st.tracks.length : st.tracks.length + " 首") : "")
      ),
      );
    };

    /* ================= 本地曲库 ================= */
    /* 行组件是纯渲染：当前播放态由父组件订阅一次后传下来。
       不能让每个行各自 subscribe —— 酷狗搜索一次最多 480 条，逐行订阅会让
       每次 timeupdate（约 4Hz）触发数百次重渲染。 */
    const TrackRow = ({ t, idx, cur, playing }) => React.createElement("div", {
      className: "mh-row" + (cur ? " mh-row-cur" : ""),
      onClick: () => playTrack(t.id), title: t.path,
    },
      React.createElement("span", { className: "mh-row-idx" }, cur && playing ? "▶" : idx + 1),
      React.createElement("span", { className: "mh-row-name" }, t.name.replace(/\.[A-Za-z0-9]{1,6}$/, "")),
      React.createElement("span", { className: "mh-row-meta" }, [t.quality, fmtSize(t.size)].filter(Boolean).join(" · ")),
    );

    const DirPicker = ({ onPick, onClose }) => {
      const [cur, setCur] = React.useState("__drives__");
      const [dirs, setDirs] = React.useState([]);
      const [crumbs, setCrumbs] = React.useState([]);
      const [err, setErr] = React.useState("");
      const load = React.useCallback((path) => {
        apiJson("/dsh-music/api/dir?path=" + encodeURIComponent(path)).then((d) => {
          if (!d || !d.ok) { setErr((d && d.error) || "读取失败"); return; }
          setCur(d.cur);
          setDirs(d.dirs || []);
          // 盘符列表是特殊占位（不是真实路径）：面包屑显示「本机」，
          // 否则会把内部占位符 "__drives__" 原样画在界面上（实测过）。
          if (String(d.cur) === "__drives__") { setCrumbs([{ name: "本机", path: "__drives__" }]); return; }
          const parts = String(d.cur).split(/[\\/]/).filter(Boolean);
          const isWin = /^[A-Za-z]:/.test(String(d.cur));
          const list = [];
          if (isWin) list.push({ name: parts[0], path: "__drives__" });   // 首级回盘符列表
          else list.push({ name: "/", path: "/" });
          let acc = isWin ? parts[0] + "\\" : "/";
          for (let i = isWin ? 1 : 0; i < parts.length; i++) {
            acc = acc.replace(/[\\/]$/, "") + (isWin ? "\\" : "/") + parts[i];
            list.push({ name: parts[i], path: acc });
          }
          setCrumbs(list);
        }).catch((e) => setErr(String((e && e.message) || e)));
      }, []);
      React.useEffect(() => { load("__drives__"); }, [load]);
      return React.createElement("div", { className: "mh-modal" },
        React.createElement("div", { className: "mh-modal-box" },
          React.createElement("div", { className: "mh-modal-title" }, "选择音乐目录"),
          React.createElement("div", { className: "mh-crumbs" },
            crumbs.map((c) => React.createElement("button", { key: c.path, className: "mh-crumb", onClick: () => load(c.path), title: c.path }, c.name)),
            err ? React.createElement("span", { className: "mh-error" }, err) : null),
          React.createElement("div", { className: "mh-dirlist" },
            dirs.length === 0 && !err ? React.createElement("div", { className: "mh-dir-empty" }, "（没有子目录）") : null,
            dirs.map((d) => React.createElement("button", { key: d.path, className: "mh-dir-item", title: d.path, onClick: () => load(d.path) }, "📁 " + d.name))),
          React.createElement("div", { className: "mh-modal-foot" },
            React.createElement("span", { className: "mh-modal-cur", title: cur }, cur === "__drives__" ? "（选择一个盘符/目录后点确定）" : cur),
            React.createElement("div", null,
              React.createElement("button", { className: "mh-btn", onClick: onClose }, "取消"),
              React.createElement("button", { className: "mh-btn mh-btn-primary", disabled: cur === "__drives__", onClick: () => onPick(cur) }, "设为音乐目录")))),
      );
    };

    const LocalView = ({ onPick, busy, refresh }) => {
      const [st, setSt] = React.useState(getState());
      React.useEffect(() => subscribe(setSt), []);
      return React.createElement(React.Fragment, null,
        React.createElement("div", { className: "mh-toolbar" },
          React.createElement("span", { className: "mh-root", title: st.dir }, "📁 " + (st.dir || "未设置")),
          React.createElement("button", { className: "mh-btn", onClick: onPick }, "选择目录"),
          React.createElement("button", { className: "mh-btn", disabled: busy, onClick: refresh }, busy ? "扫描中…" : "刷新"),
          React.createElement("span", { className: "mh-count" }, st.tracks.length + " 首")),
        st.error ? React.createElement("div", { className: "mh-error mh-lib-error" }, st.error) : null,
        React.createElement("div", { className: "mh-list" },
          st.loading ? React.createElement("div", { className: "mh-dir-empty" }, "正在读取音乐库…")
            : st.tracks.length === 0 ? React.createElement("div", { className: "mh-dir-empty" }, "曲库为空。先「选择目录」指定一个存音乐的文件夹。")
              : st.tracks.map((t, i) => React.createElement(TrackRow, {
                key: t.id, t, idx: i,
                cur: !st.online && st.currentId === t.id, playing: st.playing,
              }))));
    };

    /* ================= 在线音源：登录卡 ================= */
    const LoginBox = ({ src }) => {
      const cache = onlineCache[src];
      const [, force] = React.useState(0);
      const bump = () => force((v) => v + 1);
      const L = cache.login;
      const timerRef = React.useRef(0);

      React.useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

      const start = async () => {
        L.msg = ""; L.busy = true; bump();
        try {
          const r = await apiJson("/dsh-music/" + src + "/login/start", {
            method: "POST", headers: { "content-type": "application/json" }, body: "{}",
          });
          if (!r || !r.ok) throw new Error((r && r.error) || "出码失败");
          L.qr = { key: r.key, image: r.image || "", url: r.url || "" };
          L.msg = r.warning || "请用手机 App 扫码";
          poll(r.key);
        } catch (e) {
          L.msg = "出码失败：" + String((e && e.message) || e);
        } finally { L.busy = false; bump(); }
      };
      const poll = (key) => {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(async () => {
          try {
            const r = await apiJson("/dsh-music/" + src + "/login/check?key=" + encodeURIComponent(key));
            if (r && r.status === "success") {
              clearInterval(timerRef.current); timerRef.current = 0;
              L.loggedIn = true; L.nickname = r.nickname || ""; L.qr = null; L.msg = "登录成功";
              const flags = Object.assign({}, state.loginFlags);
              flags[src] = true;
              setState({ loginFlags: flags });
              bump();
            } else if (r && (r.status === "expired" || r.status === "failed")) {
              clearInterval(timerRef.current); timerRef.current = 0;
              L.msg = r.message || "二维码已失效，请重新获取"; L.qr = null; bump();
            } else if (r && r.message) {
              L.msg = r.message; bump();
            }
          } catch (e) { /* 轮询失败忽略，下次再试 */ }
        }, 2200);
      };
      const logout = async () => {
        try { await apiJson("/dsh-music/" + src + "/login/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } catch { }
        L.loggedIn = false; L.nickname = ""; L.qr = null; L.msg = "";
        const flags = Object.assign({}, state.loginFlags);
        flags[src] = false;
        setState({ loginFlags: flags });
        bump();
      };

      if (L.loggedIn) {
        return React.createElement("div", { className: "mh-login-done" },
          React.createElement("span", null, "✅ 已登录" + (L.nickname ? " · " + L.nickname : "")),
          React.createElement("button", { className: "mh-btn mh-btn-sm", onClick: logout }, "退出登录"));
      }
      return React.createElement("div", { className: "mh-login" },
        React.createElement("div", { className: "mh-login-row" },
          React.createElement("span", { className: "mh-login-title" }, "未登录"),
          React.createElement("span", { className: "mh-login-sub" },
            src === "kg" ? "酷狗试听必须登录（匿名取链已失效）" : "登录后可播 VIP/高音质、看我的歌单"),
          L.qr ? null : React.createElement("button", { className: "mh-btn mh-btn-primary mh-btn-sm", disabled: L.busy, onClick: start },
            L.busy ? "获取中…" : "扫码登录")),
        L.qr ? React.createElement("div", { className: "mh-qr-wrap" },
          L.qr.image ? React.createElement("img", { className: "mh-qr", src: L.qr.image, alt: "登录二维码" }) : null,
          React.createElement("div", { className: "mh-qr-side" },
            React.createElement("div", { className: "mh-qr-tip" }, "用「" + (SRC_LABEL[src] || src) + "」手机 App 扫一扫"),
            React.createElement("div", { className: "mh-qr-msg" }, L.msg || ""),
            React.createElement("div", { className: "mh-qr-btns" },
              React.createElement("button", { className: "mh-btn mh-btn-sm", onClick: start }, "重新获取"),
              React.createElement("button", { className: "mh-btn mh-btn-sm", onClick: () => { L.qr = null; L.msg = ""; bump(); } }, "收起")))) : null,
        !L.qr && L.msg ? React.createElement("div", { className: "mh-qr-msg mh-qr-msg-standalone" }, L.msg) : null,
      );
    };

    /* ================= 在线音源：列表项（纯渲染，播放态由父层传入） ================= */
    const SongRow = ({ src, song, idx, queue, cur, playing }) => React.createElement("div", {
      className: "mh-row" + (cur ? " mh-row-cur" : ""),
      onClick: () => playOnline(src, song, queue, idx),
      title: songTitle(song) + (songAlbum(song) ? " · " + songAlbum(song) : ""),
    },
      React.createElement("span", { className: "mh-row-idx" }, cur && playing ? "▶" : (idx + 1)),
      React.createElement("span", { className: "mh-row-name" },
        songTitle(song),
        songArtists(song) ? React.createElement("span", { className: "mh-row-artist" }, " — " + songArtists(song)) : null),
      React.createElement("span", { className: "mh-row-meta" }, song.album ? String(song.album) : ""));

    const PlaylistCard = ({ src, pl, onOpen }) => React.createElement("div", {
      className: "mh-pl-card", onClick: () => onOpen(pl), title: pl.name,
    },
      React.createElement("div", { className: "mh-pl-name" }, pl.name || "未命名歌单"),
      React.createElement("div", { className: "mh-pl-meta" },
        [pl.trackCount ? pl.trackCount + " 首" : "", pl.creator || ""].filter(Boolean).join(" · ")));

    /* ================= 在线音源：主视图 ================= */
    const OnlineView = ({ src }) => {
      const cache = onlineCache[src];
      const [, force] = React.useState(0);
      const bump = () => force((v) => v + 1);
      const [w, setW] = React.useState(cache.w || "");
      // 播放态只在这里订阅一次，再作为纯 props 传给行组件（避免数百行各自订阅）
      const [st, setSt] = React.useState(getState());
      React.useEffect(() => subscribe(setSt), []);
      const isCur = (song) => {
        const key = songKey(src, song);
        return !!(st.online && st.onlineSrc === src && st.currentId === src + ":" + key);
      };

      const run = async (fn, patchBusy) => {
        cache.busy = true; cache.err = ""; bump();
        try { await fn(); } catch (e) { cache.err = String((e && e.message) || e); }
        finally { cache.busy = false; bump(); }
      };
      const doSearch = (page) => run(async () => {
        const word = String(w || "").trim();
        if (!word) { cache.err = "请输入关键词"; return; }
        const r = await apiJson("/dsh-music/" + src + "/search?w=" + encodeURIComponent(word) + "&page=" + (page || 1));
        cache.w = word;
        cache.results = (r && r.results) || [];
        cache.total = (r && r.total) || 0;
        cache.degraded = !!(r && r.degraded);
        cache.view = "search";
        cache.opened = null;
      });
      const loadPlaylists = () => run(async () => {
        const r = await apiJson("/dsh-music/" + src + "/playlists");
        cache.playlists = (r && r.playlists) || [];
        cache.view = "playlists";
        cache.opened = null;
      });
      const loadRanks = () => run(async () => {
        const r = await apiJson("/dsh-music/" + src + "/top-lists");
        cache.groups = (r && r.groups) || [];
        cache.view = "ranks";
        cache.opened = null;
      });
      const loadMine = () => run(async () => {
        const r = await apiJson("/dsh-music/" + src + "/my-playlists");
        cache.playlists = (r && r.playlists) || [];
        cache.view = "mine";
        cache.opened = null;
      });
      /* 打开歌单：来源不同接口不同（实测 2026-10-28 用户反馈「我的歌单点进去 0 首」）：
         推荐歌单是公开 specialid → playlist-songs；我的歌单是云列表 id
         → my-playlist-songs（酷狗自建/收藏还要再分两条接口，宿主侧已处理）。
         opened.from 记录从哪个子页进来的，用于顶部高亮与「返回」目标。 */
      /* 打开歌单：来源不同接口不同（实测 2026-10-28 用户反馈「我的歌单点进去 0 首」）：
         推荐歌单是公开 specialid → playlist-songs；我的歌单是云列表 id
         → my-playlist-songs（酷狗自建/收藏还要再分两条接口，宿主侧已处理）。
         opened.from 记录从哪个子页进来的，用于顶部高亮与「返回」目标。
         ★ sort 参数交给宿主排（排序口径依赖接口字段 sort/collecttime，宿主侧统一）。 */
      const SORT_MODES = [
        { id: "manual", label: "默认排序" },
        { id: "newest", label: "从新到旧" },
        { id: "oldest", label: "从旧到新" },
        { id: "title-asc", label: "歌名 A-Z" },
        { id: "artist-asc", label: "歌手 A-Z" },
        { id: "play-desc", label: "播放量高→低" },
        { id: "play-asc", label: "播放量低→高" },
      ];
      const sortLabel = (id) => (SORT_MODES.find((x) => x.id === id) || SORT_MODES[0]).label;
      const fetchPlaylistSongs = async (pl, from, sortMode) => {
        const base = "/dsh-music/" + src + (from === "mine" ? "/my-playlist-songs?" : "/playlist-songs?");
        const qs = "id=" + encodeURIComponent(pl.id)
          + "&sort=" + encodeURIComponent(sortMode || "manual")
          + (from === "mine" ? "&kind=" + encodeURIComponent(pl.kind || "own") + "&gid=" + encodeURIComponent(pl.creatorGid || "") : "");
        return await apiJson(base + qs);
      };
      /* 读某个歌单自己的排序（没有记录就用源默认） */
      const sortOf = (plId) => {
        const m = (cache.sortMap && cache.sortMap[src + ":" + plId]) ? cache.sortMap[src + ":" + plId] : "";
        return m || cache.sortMode || "manual";
      };
      /* 打开歌单前先从宿主同步一次 sortMap：
         卡片桌面改了排序只写进宿主，主界面内存里没有，不同步就会一直显示旧排序。 */
      const syncSortMap = async () => {
        try {
          const d = await apiJson("/dsh-music/api/state");
          const sm = d && d.prefs && d.prefs.sortMap;
          if (sm && typeof sm === "object") cache.sortMap = Object.assign({}, sm);
          const gsm = d && d.prefs && d.prefs.sortMode;
          if (typeof gsm === "string" && gsm) cache.sortMode = gsm;
        } catch { }
      };
      const openPlaylist = (pl, from) => run(async () => {
        await syncSortMap();
        const r = await fetchPlaylistSongs(pl, from, sortOf(pl.id));
        cache.songs = (r && r.songs) || [];
        cache.opened = { kind: "playlist", from: from || "playlists", name: (r && r.name) || pl.name || "歌单", id: pl.id, pl };
        cache.view = "songs";
      });
      /* 切换排序：重新拉一次（排序在宿主做，保证与酷狗 App 同口径），
         并保持当前打开的歌单与播放队列的可重建性。 */
      const changeSort = (mode) => run(async () => {
        cache.sortMode = mode;
        const op0 = cache.opened;
        /* 写进「这个歌单自己的」记录：不同歌单可以各用不同排序，
           重启后逐个恢复，不再互相覆盖。 */
        if (op0 && op0.id) {
          cache.sortMap = Object.assign({}, cache.sortMap || {});
          cache.sortMap[src + ":" + op0.id] = mode;
          savePrefs({ sortMode: mode, sortMap: cache.sortMap });
        } else {
          savePrefs({ sortMode: mode });
        }
        const op = cache.opened;
        if (op && op.kind === "playlist" && op.pl) {
          const r = await fetchPlaylistSongs(op.pl, op.from, mode);
          cache.songs = (r && r.songs) || [];
        }
      });
      const openRank = (rl) => run(async () => {
        const r = await apiJson("/dsh-music/" + src + "/top-songs?id=" + encodeURIComponent(rl.id) + "&num=300");
        cache.songs = (r && r.songs) || [];
        cache.opened = { kind: "rank", from: "ranks", name: (r && r.name) || rl.name || "榜单", id: rl.id };
        cache.view = "songs";
      });

      const subnav = [
        { id: "search", label: "搜索", onClick: () => { cache.view = "search"; cache.opened = null; bump(); } },
        { id: "playlists", label: "推荐", onClick: loadPlaylists },
        { id: "ranks", label: "排行", onClick: loadRanks },
        { id: "mine", label: "我的", onClick: loadMine },
      ];

      let body = null;
      if (cache.view === "songs") {
        const queue = cache.songs.map((s) => ({ src, song: s }));
        body = React.createElement(React.Fragment, null,
          React.createElement("div", { className: "mh-songs-head" },
            React.createElement("button", { className: "mh-btn mh-btn-sm", onClick: () => { cache.view = (cache.opened && cache.opened.from) || "playlists"; bump(); } }, "← 返回"),
            React.createElement("span", { className: "mh-songs-title", title: cache.opened && cache.opened.name }, (cache.opened && cache.opened.name) || "曲目"),
            React.createElement("span", { className: "mh-count" }, cache.songs.length + " 首"),
            /* 排序：只在「歌单」里出现（榜单/搜索有自己的天然顺序，不该被改） */
            (cache.opened && cache.opened.kind === "playlist") ? React.createElement("select", {
              className: "mh-sort",
              /* 显示「当前歌单自己的」排序：之前读的是全局 cache.sortMode，
                 切到别的歌单时下拉框仍显示最后一个值，看起来「排序没记住」。 */
              value: (cache.opened && cache.opened.id) ? sortOf(cache.opened.id) : (cache.sortMode || "manual"),
              title: "排序方式（与酷狗 App 一致）",
              onChange: (e) => changeSort(e.target.value),
            }, SORT_MODES.map((m) => React.createElement("option", { key: m.id, value: m.id }, m.label))) : null,
            cache.songs.length ? React.createElement("button", {
              className: "mh-btn mh-btn-sm mh-btn-primary",
              onClick: () => playOnline(src, cache.songs[0], queue, 0),
            }, "▶ 播放全部") : null),
          React.createElement("div", { className: "mh-list" },
            cache.songs.map((s, i) => React.createElement(SongRow, { key: songKey(src, s) + "_" + i, src, song: s, idx: i, queue, cur: isCur(s), playing: st.playing }))));
      } else if (cache.view === "playlists" || cache.view === "mine") {
        body = React.createElement("div", { className: "mh-list" },
          cache.playlists.length === 0 ? React.createElement("div", { className: "mh-dir-empty" },
            cache.view === "mine" ? "没有歌单（需登录；或该账号无自建/收藏歌单）" : "暂无推荐歌单") : null,
          React.createElement("div", { className: "mh-pl-grid" },
            cache.playlists.map((pl, i) => React.createElement(PlaylistCard, {
              key: (pl.id || i) + "", src, pl,
              // 从「我的」进来要标记来源：歌单内容要用云歌单接口取（见 openPlaylist 注释）
              onOpen: (p) => openPlaylist(p, cache.view === "mine" ? "mine" : "playlists"),
            }))));
      } else if (cache.view === "ranks") {
        body = React.createElement("div", { className: "mh-list" },
          (cache.groups || []).map((g, gi) => React.createElement("div", { key: gi, className: "mh-rank-group" },
            g.name ? React.createElement("div", { className: "mh-rank-gname" }, g.name) : null,
            React.createElement("div", { className: "mh-rank-grid" },
              (g.toplists || g.list || []).map((rl, i) => React.createElement("div", {
                key: (rl.id || i) + "", className: "mh-rank-item", title: rl.name, onClick: () => openRank(rl),
              },
                React.createElement("span", { className: "mh-rank-name" }, rl.name || "榜单"),
                React.createElement("span", { className: "mh-rank-meta" }, rl.updateTime || (rl.totalNum ? rl.totalNum + " 首" : ""))))))));
      } else {
        body = React.createElement("div", { className: "mh-list" },
          cache.results.length === 0
            ? React.createElement("div", { className: "mh-dir-empty" }, "输入歌名/歌手搜索（三源都支持匿名搜索）")
            : React.createElement(React.Fragment, null,
              cache.degraded
                ? React.createElement("div", { className: "mh-search-note" }, "主搜索接口被平台限流，已降级为联想结果（仅 " + cache.results.length + " 条），稍后重试可恢复完整结果")
                : (cache.total ? React.createElement("div", { className: "mh-search-note" }, "共 " + cache.total + " 条，显示前 " + cache.results.length + " 条") : null),
              cache.results.map((s, i) => React.createElement(SongRow, { key: songKey(src, s) + "_" + i, src, song: s, idx: i, queue: cache.results.map((x) => ({ src, song: x })), cur: isCur(s), playing: st.playing }))));
      }

      return React.createElement("div", { className: "mh-online" },
        React.createElement(LoginBox, { src }),
        React.createElement("div", { className: "mh-searchbar" },
          React.createElement("input", {
            className: "mh-input", placeholder: "搜索歌曲 / 歌手", value: w,
            onChange: (e) => setW(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") doSearch(1); },
          }),
          React.createElement("button", { className: "mh-btn mh-btn-primary", disabled: cache.busy, onClick: () => doSearch(1) }, "搜索")),
        React.createElement("div", { className: "mh-subnav" },
          subnav.map((t) => {
            /* 高亮口径：songs 视图下按「从哪个子页进来」高亮（opened.from），
               否则从「我的」点进去会错亮成「推荐」（2026-10-28 用户实测反馈）。 */
            const active = cache.view === t.id
              || (cache.view === "songs" && cache.opened && cache.opened.from === t.id);
            return React.createElement("button", {
              key: t.id, className: "mh-subtab" + (active ? " mh-subtab-cur" : ""),
              onClick: t.onClick,
            }, t.label);
          }),
          cache.busy ? React.createElement("span", { className: "mh-busy" }, "加载中…") : null),
        cache.err ? React.createElement("div", { className: "mh-error mh-lib-error" }, cache.err) : null,
        /* 播放错误：st.error 由 playOnline/playTrack 写入（取链被拒、VIP、未登录、网络）。
           以前只在「本地」页签渲染，在线页签点歌失败时用户什么都看不到（实测：
           未登录点 QQ 歌曲，界面毫无反应）。这里补一份在线页签的显示。 */
        st.error ? React.createElement("div", { className: "mh-error mh-lib-error" }, st.error) : null,
        body);
    };

    /* ================= 歌词 ================= */
    // 歌词浮层的可调状态（拖动位置 / 不透明度），模块级保存以免切歌重渲染时丢失。
    const lyricLayerState = { pos: null, opacity: 1, size: null, offset: 0 };
    // 缓存按「当前曲目 key」失效；切歌时重新取。在线曲目走 <src>/lyric，本地走 /api/lyric（同名 .lrc）。
    const lyricCache = { key: "", lines: [], wordLines: null, loading: false, err: "", tried: false };
    const lyricKeyOf = (st) => (st.currentId ? (st.online ? "o:" + st.currentId : "l:" + st.currentId) : "");
    const loadLyric = async () => {
      const st = getState();
      const key = lyricKeyOf(st);
      if (!key || (lyricCache.key === key && lyricCache.tried)) return;
      lyricCache.key = key; lyricCache.tried = true; lyricCache.loading = true; lyricCache.err = ""; lyricCache.lines = []; lyricCache.wordLines = null;
      try {
        let r;
        if (st.online) {
          const id = String(st.currentId).slice(String(st.onlineSrc).length + 1);
          const q = new URLSearchParams({ id, title: st.currentName || "", artist: st.currentArtist || "", duration: String(Math.round(st.duration || 0)) });
          r = await apiJson("/dsh-music/" + st.onlineSrc + "/lyric?" + q.toString());
        } else {
          r = await apiJson("/dsh-music/api/lyric?id=" + encodeURIComponent(String(st.currentId)));
        }
        if (r && r.ok) {
          if (Array.isArray(r.wordLines) && r.wordLines.length) {
            lyricCache.wordLines = r.wordLines;
            lyricCache.lines = r.wordLines.map((w) => ({ t: w.t, text: w.text }));
          } else if (Array.isArray(r.lrc)) {
            lyricCache.lines = r.lrc;
          }
        }
      } catch (e) { lyricCache.err = String((e && e.message) || e); }
      finally { lyricCache.loading = false; }
    };

    const LyricPanel = () => {
      const [st, setSt] = React.useState(getState());
      React.useEffect(() => subscribe(setSt), []);
      const [, force] = React.useState(0);
      const bump = () => force((v) => v + 1);
      /* 歌词浮层的可调项（模块级保存：切歌/重渲染不丢）：
         - lyricPos：拖动后的位置（null = 用 CSS 默认位置）
         - lyricOpacity：不透明度，默认 1 */
      const [lyricPos, setLyricPos] = React.useState(lyricLayerState.pos);
      const [lyricOpacity, setLyricOpacityState] = React.useState(lyricLayerState.opacity);
      const setLyricOpacity = (v) => { lyricLayerState.opacity = v; setLyricOpacityState(v); };
      /* 尺寸（缩放手柄拖动后）与歌词偏移（±秒）同样是模块级保存，
         切歌/重渲染/关开歌词都不会丢。 */
      const [lyricSize, setLyricSizeState] = React.useState(lyricLayerState.size);
      const setLyricSize = (v) => { lyricLayerState.size = v; setLyricSizeState(v); };
      const [lyricOffset, setLyricOffsetState] = React.useState(lyricLayerState.offset);
      const setLyricOffset = (delta) => {
        const v = Math.round((lyricLayerState.offset + delta) * 10) / 10;
        lyricLayerState.offset = v; setLyricOffsetState(v);
      };
      React.useEffect(() => { lyricLayerState.pos = lyricPos; }, [lyricPos]);
      React.useEffect(() => {
        let alive = true;
        if (st.lyricOpen && st.currentId) loadLyric().then(() => { if (alive) bump(); });
        return () => { alive = false; };
      }, [st.lyricOpen, st.currentId]);
      const listRef = React.useRef(null);
      /* 歌词框拖动/缩放的指针状态（照参考实现用 ref 存，不触发重渲染） */
      const dragBoxRef = React.useRef(null);
      const sizeBoxRef = React.useRef(null);
      // 当前行：最后一个 t <= position 的行
      let curIdx = -1;
      const lines = lyricCache.lines || [];
      // 歌词偏移：正数 = 歌词提前（声音还没到就先显示），用于修正不同步。
      // 判据：当前行取「最后一个 t <= 播放位置 - offset 的行」。
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].t <= (st.position || 0) - lyricOffset + 0.15) curIdx = i; else break;
      }
      React.useEffect(() => {
        if (!st.lyricOpen || curIdx < 0) return;
        const box = listRef.current;
        if (!box) return;
        const el = box.querySelector('[data-lyric-idx="' + curIdx + '"]');
        if (el && typeof el.scrollIntoView === "function") { try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { } }
      }, [curIdx, st.lyricOpen]);

      /* 常驻不卸载（照参考实现）：关闭只切 display，歌词缓存/缩放/偏移全保留。
         位置与尺寸合成一个 pos，一起持久化。 */
      const boxStyle = { opacity: lyricOpacity, display: st.lyricOpen ? "" : "none" };
      if (lyricPos) { boxStyle.left = lyricPos.left + "px"; boxStyle.top = lyricPos.top + "px"; boxStyle.right = "auto"; boxStyle.bottom = "auto"; }
      if (lyricSize) { boxStyle.width = lyricSize.w + "px"; boxStyle.height = lyricSize.h + "px"; }
      /* 拖动 / 缩放：pointer 事件 + setPointerCapture（照参考实现）。
         捕获后事件始终回到按下元素，滑出窗口也不丢，且不会触发浏览器原生拖拽的
         「圆圈斜杠」光标。按「按下原点 + 位移」累计，避免每帧重取 rect 的误差。 */
      const startDrag = (kind) => (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest("button, input")) return;
        const box = e.currentTarget.closest(".mh-lyric");
        if (!box) return;
        const r = box.getBoundingClientRect();
        const st0 = {
          startX: e.clientX, startY: e.clientY,
          originX: lyricPos ? lyricPos.left : r.left,
          originY: lyricPos ? lyricPos.top : r.top,
          originW: r.width, originH: r.height,
        };
        dragBoxRef.current = kind === "move" ? st0 : null;
        sizeBoxRef.current = kind === "resize" ? st0 : null;
        if (!lyricPos) setLyricPos({ left: r.left, top: r.top });
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { }
      };
      const onLyricMove = (e) => {
        const mv = dragBoxRef.current;
        const rs = sizeBoxRef.current;
        if (mv) {
          const x = Math.max(0, Math.min(mv.originX + (e.clientX - mv.startX), window.innerWidth - 90));
          const y = Math.max(0, Math.min(mv.originY + (e.clientY - mv.startY), window.innerHeight - 32));
          setLyricPos({ left: x, top: y });
          return;
        }
        if (rs) {
          const baseL = lyricPos ? lyricPos.left : rs.originX;
          const baseT = lyricPos ? lyricPos.top : rs.originY;
          const maxW = Math.max(280, window.innerWidth - baseL);
          const maxH = Math.max(200, window.innerHeight - baseT);
          const w = Math.max(280, Math.min(rs.originW + (e.clientX - rs.startX), maxW));
          const h = Math.max(200, Math.min(rs.originH + (e.clientY - rs.startY), maxH));
          setLyricSize({ w, h });
        }
      };
      const onLyricUp = (e) => {
        dragBoxRef.current = null;
        sizeBoxRef.current = null;
        try {
          if (e.currentTarget.hasPointerCapture && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        } catch { }
      };
      return React.createElement("div", { className: "mh-lyric", style: boxStyle },
        React.createElement("div", {
          className: "mh-panel-head",
          onPointerDown: startDrag("move"),
          onPointerMove: onLyricMove,
          onPointerUp: onLyricUp,
          /* 双保险：即使某层 CSS 让元素变成可拖，也拦掉 HTML5 dragstart，
             否则浏览器会显示「圆圈斜杠」禁止光标并中断我们的拖动。 */
          draggable: false,
          onDragStart: (e) => e.preventDefault(),
        },
          React.createElement("span", { className: "mh-panel-drag" }, "⋮⋮"),
          React.createElement("span", { className: "mh-panel-title" }, "歌词"),
          React.createElement("span", { className: "mh-lyric-song", title: st.currentName || "" }, st.currentName || "未播放"),
          /* 歌词偏移调节：歌词比歌声早/晚时手动对齐（±0.5s，可连续点） */
          React.createElement("span", { className: "mh-lyric-tune", title: "歌词快了就点「-」，慢了就点「+」，单位 0.5 秒" },
            React.createElement("button", {
              className: "mh-btn mh-btn-sm", title: "歌词显示提前 0.5 秒",
              onMouseDown: (e) => e.stopPropagation(),
              onClick: () => setLyricOffset(-0.5),
            }, "−"),
            React.createElement("span", { className: "mh-lyric-off" + (lyricOffset === 0 ? " mh-lyric-off-zero" : "") },
              (lyricOffset > 0 ? "+" : "") + lyricOffset.toFixed(1) + "s"),
            React.createElement("button", {
              className: "mh-btn mh-btn-sm", title: "歌词显示延后 0.5 秒",
              onMouseDown: (e) => e.stopPropagation(),
              onClick: () => setLyricOffset(0.5),
            }, "+"),
            lyricOffset !== 0 ? React.createElement("button", {
              className: "mh-btn mh-btn-sm", title: "清零",
              onMouseDown: (e) => e.stopPropagation(),
              onClick: () => setLyricOffset(-lyricOffset),
            }, "⟲") : null),
          /* 透明度：拖动滑杆调浮层不透明度，避免挡住底下的对话内容 */
          React.createElement("input", {
            type: "range", className: "mh-lyric-op", min: 0.25, max: 1, step: 0.05,
            value: lyricOpacity, title: "透明度 " + Math.round(lyricOpacity * 100) + "%",
            onMouseDown: (e) => e.stopPropagation(),
            onChange: (e) => setLyricOpacity(parseFloat(e.target.value) || 1),
          }),
          React.createElement("button", {
            className: "mh-btn mh-panel-close", title: "关闭歌词",
            onClick: () => setState({ lyricOpen: false }),
          }, "✕")),
        React.createElement("div", { className: "mh-lyric-body", ref: listRef },
          !st.currentId ? React.createElement("div", { className: "mh-dir-empty" }, "播放一首歌后这里显示歌词")
            : lyricCache.loading ? React.createElement("div", { className: "mh-dir-empty" }, "正在取歌词…")
              : lyricCache.err ? React.createElement("div", { className: "mh-error mh-dir-empty" }, "取词失败：" + lyricCache.err)
                : lines.length === 0 ? React.createElement("div", { className: "mh-dir-empty" }, "这首歌没有可用歌词（本地需同名 .lrc）")
                  : lines.map((l, i) => React.createElement("div", {
                    key: i, "data-lyric-idx": i,
                    className: "mh-lyric-line" + (i === curIdx ? " mh-lyric-cur" : ""),
                    onClick: () => seekTo(l.t),
                    title: "跳到 " + fmtTime(l.t),
                  }, l.text))),
        /* 右下角缩放手柄：拖动改变歌词框宽高（最小 240×160） */
        React.createElement("div", {
          className: "mh-lyric-resize", title: "拖动调整大小",
          onPointerDown: startDrag("resize"),
          onPointerMove: onLyricMove,
          onPointerUp: onLyricUp,
        }));
    };

    /* ================= 播放面板 =================
       交互骨架照 dsh-music-player 的实现（MIT）：
         · 位置与尺寸合成一个 pos 状态，一起持久化；
         · 拖动/缩放都用 **pointer 事件 + setPointerCapture**（不是 mousedown +
           document 监听）—— 指针捕获后即使滑出元素甚至窗口，事件仍回到原元素，
           拖动不会中断，也不会出现「圆圈斜杠」的禁止光标；
         · 面板常驻不卸载（关闭只切 display），所以内部 useState / 页签 / 打开的歌单
           在关开之间全部保留 —— 旧实现用 `if (!panelOpen) return null` 会整棵卸载，
           这是「音乐库自己关了、状态全丢」的根源。
       尺寸常量同样照参考实现：PANEL_W 600 / MIN_W 320 / MAX_W 720 / MIN_H 200 / 最大高 80vh。 */
    const PANEL_DEFAULT = { w: 600, h: 0 };   // h=0 表示「自动高度」（用 CSS minHeight）
    const PANEL_MIN_W = 320, PANEL_MAX_W = 720, PANEL_MIN_H = 200, PANEL_MAX_H_VH = 0.8;
    /* 主界面持有的设置面板实例（与 window.__mhMusicHubSettings.makePanel 同一工厂，只此一份实现） */
    /* 主界面持有的设置面板实例：把原生目录选择也传进去（两边共用同一份） */
    const SettingsPanel = makeSettingsPanel(React, apiJson, {
      pickNative: () => (nativePickerHolder.fn ? nativePickerHolder.fn() : Promise.resolve({ ok: false, reason: "no-service" })),
      debug: () => (nativePickerHolder.debug ? nativePickerHolder.debug() : "无诊断"),
        probeAll: () => (nativePickerHolder.probeAll ? nativePickerHolder.probeAll() : []),
        peekService: () => (nativePickerHolder.peekService ? nativePickerHolder.peekService() : null),
      nativeMethods: () => (nativePickerHolder.listMethods ? nativePickerHolder.listMethods() : []),
    });

    const PlayerPanel = () => {
      const [st, setSt] = React.useState(getState());
      React.useEffect(() => subscribe(setSt), []);
      const [picker, setPicker] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [pos, setPos] = React.useState(lyricLayerState.panelPos || null);
      const panelRef = React.useRef(null);
      const dragRef = React.useRef(null);
      const resizeRef = React.useRef(null);

      const savePos = (p) => { lyricLayerState.panelPos = p; setPos(p); };

      /* 头部拖动：pointer 捕获，位移按「按下时的原点 + 增量」计算（不是每帧重新取 rect，
         否则会累积误差），并夹在视口内保证标题栏始终可再抓。 */
      const onHeadDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest("button, input, select")) return;
        const el = panelRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const w = pos ? pos.w : (rect.width || PANEL_DEFAULT.w);
        const h = pos ? pos.h : rect.height;
        const next = { x: pos ? pos.x : rect.left, y: pos ? pos.y : rect.top, w, h };
        dragRef.current = { startX: e.clientX, startY: e.clientY, originX: next.x, originY: next.y, w, h };
        savePos(next);
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { }
      };
      const onHeadMove = (e) => {
        const d = dragRef.current;
        if (!d) return;
        const el = panelRef.current;
        let x = d.originX + (e.clientX - d.startX);
        let y = d.originY + (e.clientY - d.startY);
        if (el) {
          x = Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth));
          y = Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight));
        }
        savePos({ x, y, w: d.w, h: d.h });
      };
      const onHeadUp = (e) => {
        dragRef.current = null;
        try {
          if (e.currentTarget.hasPointerCapture && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        } catch { }
      };

      /* 右下角缩放：只改宽高，不动左上角；上限同时受 PANEL_MAX_* 与视口约束。 */
      const onResizeDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        const el = panelRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const cur = { x: pos ? pos.x : rect.left, y: pos ? pos.y : rect.top, w: pos ? pos.w : PANEL_DEFAULT.w, h: pos ? pos.h : rect.height };
        resizeRef.current = { startX: e.clientX, startY: e.clientY, originW: cur.w, originH: cur.h };
        savePos(cur);
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { }
      };
      const onResizeMove = (e) => {
        const d = resizeRef.current;
        if (!d) return;
        const el = panelRef.current;
        const x = pos ? pos.x : (el ? el.getBoundingClientRect().left : 0);
        const y = pos ? pos.y : (el ? el.getBoundingClientRect().top : 0);
        const vw = window.innerWidth, vh = window.innerHeight;
        const maxW = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, vw - x));
        const maxH = Math.min(Math.floor(vh * PANEL_MAX_H_VH), Math.max(PANEL_MIN_H, vh - y));
        const w = Math.max(PANEL_MIN_W, Math.min(d.originW + (e.clientX - d.startX), maxW));
        const h = Math.max(PANEL_MIN_H, Math.min(d.originH + (e.clientY - d.startY), maxH));
        savePos({ x, y, w, h });
      };
      const onResizeUp = (e) => {
        resizeRef.current = null;
        try {
          if (e.currentTarget.hasPointerCapture && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        } catch { }
      };

      const tabs = [
        { id: "local", label: "本地" },
        { id: "qq", label: "QQ" },
        { id: "kg", label: "酷狗" },
        { id: "nc", label: "网易云" },
      ];
      const refresh = async () => {
        setBusy(true);
        try {
          await apiJson("/dsh-music/api/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          await loadManifest();
        } catch (e) { setState({ error: "重扫失败：" + String((e && e.message) || e) }); }
        finally { setBusy(false); }
      };
      /* 常驻不卸载：关闭只切 display（照参考实现）。
         pos 为 null 时用 CSS 默认位置与自动高度；一旦拖动/缩放就锁定 left/top/w/h。 */
      const panelStyle = pos
        ? { left: pos.x + "px", top: pos.y + "px", right: "auto", width: pos.w + "px", height: pos.h + "px", maxHeight: "none" }
        : null;
      const rootStyle = Object.assign({}, panelStyle || {}, { display: st.panelOpen ? "" : "none" });
      return React.createElement("div", {
        id: "mh-panel", className: "mh-panel", ref: panelRef,
        style: rootStyle,
      },
        React.createElement("div", {
          className: "mh-panel-head",
          onPointerDown: onHeadDown,
          onPointerMove: onHeadMove,
          onPointerUp: onHeadUp,
        },
          React.createElement("span", { className: "mh-panel-drag" }, "⋮⋮"),
          React.createElement("span", { className: "mh-panel-title" }, "音乐库"),
          React.createElement("span", { className: "mh-panel-login" },
            [["qq", "QQ"], ["kg", "酷狗"], ["nc", "网易云"]].map(([k, label]) =>
              React.createElement("span", {
                key: k, className: "mh-dot" + (st.loginFlags[k] ? " mh-dot-on" : ""),
                title: label + (st.loginFlags[k] ? " 已登录" : " 未登录"),
              }, label))),
          React.createElement("button", {
            className: "mh-btn mh-panel-close", title: "关闭面板",
            onClick: () => { setState({ panelOpen: false }); savePrefs({ panelOpen: false }); },
          }, "✕")),
        React.createElement("div", { className: "mh-tabs" },
          tabs.map((t) => React.createElement("button", {
            key: t.id, className: "mh-tab" + (st.tab === t.id ? " mh-tab-cur" : ""),
            onClick: () => { setState({ tab: t.id }); savePrefs({ tab: t.id }); },
          }, t.label))),
        /* 面板内的播放控制条。
           为什么要有：面板浮在右下、高度覆盖到输入框上方，把「播放条右侧
           （音量/词/模式）」压在下面点不到 —— 实测点「词」按钮时点击落在了
           面板上，歌词层永远打不开。这里补一份等价控制，面板开着也能操作。 */
        React.createElement("div", { className: "mh-panel-ctrl" },
          Btn({ label: "⏮", title: "上一首", onClick: () => step(-1), disabled: !st.tracks.length && !st.online }),
          Btn({ label: st.playing ? "⏸" : "▶", title: st.playing ? "暂停" : "播放", onClick: togglePlay, active: st.playing }),
          Btn({ label: "⏭", title: "下一首", onClick: () => step(1), disabled: !st.tracks.length && !st.online }),
          /* 播放模式也放进面板：播放条右侧的模式按钮会被面板遮住点不到 */
          Btn({ label: MODE_ICON[st.mode], title: MODE_LABEL[st.mode] + "（点击切换顺序/单曲/随机）", onClick: cycleMode, active: st.mode !== "sequence" }),
          Btn({ label: "词", title: "歌词", onClick: () => setState({ lyricOpen: !st.lyricOpen }), active: st.lyricOpen, disabled: !st.currentId }),
          Btn({ label: "⚙", title: "设置（与卡片桌面共用）", onClick: () => setState({ settingsOpen: !st.settingsOpen }), active: st.settingsOpen }),
          React.createElement("span", { className: "mh-panel-cur", title: st.currentName || "" },
            st.currentName || "未播放",
            st.currentQuality ? React.createElement("span", { className: "mh-quality" }, "  " + st.currentQuality) : null)),
        st.tab === "local"
          ? React.createElement(LocalView, { onPick: () => setPicker(true), busy, refresh })
          : React.createElement(OnlineView, { src: st.tab }),
        picker ? React.createElement(DirPicker, {
          onPick: async (dir) => {
            setPicker(false);
            setBusy(true);
            try {
              await apiJson("/dsh-music/api/setroot", {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir }),
              });
              await loadManifest();
            } catch (e) { setState({ error: "设置目录失败：" + String((e && e.message) || e) }); }
            finally { setBusy(false); }
          },
        }) : null,
        /* 设置面板：与卡片桌面共用 makeSettingsPanel，配置存宿主 prefs.settings */
        st.settingsOpen ? React.createElement(SettingsPanel, {
          onClose: () => setState({ settingsOpen: false }),
        }) : null,
        /* 右下角缩放手柄（音乐库面板也能改大小） */
        React.createElement("div", {
          className: "mh-panel-resize", title: "拖动调整音乐库大小",
          onPointerDown: onResizeDown,
          onPointerMove: onResizeMove,
          onPointerUp: onResizeUp,
        }),
      );
    };

    /* ================= CSS ================= */
    const PLAYER_CSS = `
/* 播放条 = 输入框同款外框（用户 2026-10-29 要求：与输入框一样框，且随输入框宽度调整）。
   实测（1280 宽窗口）：dock 列 744px，输入框卡片 712px，差值正是左右各 16px 内边距。
   所以宽度用 calc(100% - 16px*2) 由 CSS 自己跟随列宽，不再用 JS 量 rect 设宽度
   （JS 量出来的 744 会宽出一截，正是「播放条比输入框长」的原因）。
   max-width 用 DSH 自己的 --dsh-composer-card-max-width（与 composer 卡片同源）。
   背景/边框/圆角在运行时从输入框卡片复制（见 syncBarFrame），保证「一样框」。 */
.mh-bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--dsw-alias-bg-layer-1, var(--dsw-bg-elevated, #26272a)); border: 1px solid var(--dsw-alias-border-l1, var(--dsw-border, #3a3b3e)); border-radius: 10px; font-size: 12px; color: var(--dsw-text, #e6e8eb); user-select: none; box-sizing: border-box; width: calc(100% - var(--dsh-composer-side-clearance, 16px) * 2); max-width: var(--dsh-composer-card-max-width, 780px); margin: 0 auto; }
.mh-logo { background: none; border: none; cursor: pointer; font-size: 16px; padding: 0 2px; }
.mh-ctrl { display: flex; gap: 4px; }
.mh-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mh-name-row { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
.mh-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.mh-quality { flex-shrink: 0; color: var(--dsw-text-secondary, #9aa4b2); font-size: 11px; }
.mh-time { flex-shrink: 0; color: var(--dsw-text-secondary, #9aa4b2); font-variant-numeric: tabular-nums; }
.mh-vol { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.mh-count { flex-shrink: 0; color: var(--dsw-text-secondary, #9aa4b2); font-size: 11px; }
.mh-btn { background: #2a2b2e; color: var(--dsw-text, #e6e8eb); border: 1px solid #3c3d40; border-radius: 6px; padding: 3px 8px; cursor: pointer; font-size: 12px; }
.mh-btn:hover { border-color: var(--dsw-accent, #3b82f6); }
.mh-btn:disabled { opacity: .45; cursor: default; }
.mh-btn-sm { padding: 2px 7px; font-size: 11px; }
.mh-btn-active { color: var(--dsw-accent, #3b82f6); border-color: var(--dsw-accent, #3b82f6); }
.mh-btn-primary { background: var(--dsw-accent, #3b82f6); border-color: var(--dsw-accent, #3b82f6); color: #fff; }
input[type=range].mh-seek, input[type=range].mh-vol-slider { -webkit-appearance: none; appearance: none; height: 4px; background: #3a3b3e; border-radius: 2px; outline: none; padding: 0; }
.mh-sb { width: 100%; padding: 4px 0; cursor: pointer; user-select: none; touch-action: none; }
.mh-sb-dis { cursor: default; opacity: .55; }
.mh-sb-track { position: relative; height: 4px; background: #3a3b3e; border-radius: 2px; }
.mh-sb-fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--dsw-accent, #3b82f6); border-radius: 2px; }
.mh-sb-dot { position: absolute; top: 50%; width: 10px; height: 10px; margin-left: -5px; transform: translateY(-50%); border-radius: 50%; background: var(--dsw-accent, #3b82f6); box-shadow: 0 0 0 2px rgba(59,130,246,.25); }
.mh-sb:hover .mh-sb-dot { transform: translateY(-50%) scale(1.15); }
input[type=range].mh-vol-slider { width: 62px; }
input[type=range].mh-seek::-webkit-slider-thumb, input[type=range].mh-vol-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 12px; height: 12px; border-radius: 50%; background: var(--dsw-accent, #3b82f6); cursor: pointer; }
input[type=range].mh-seek::-moz-range-thumb, input[type=range].mh-vol-slider::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: var(--dsw-accent, #3b82f6); cursor: pointer; border: none; }
.mh-panel { position: fixed; top: 72px; right: 24px; width: 440px; height: min(600px, 76vh); background: var(--dsw-bg-elevated, #232427); border: 1px solid var(--dsw-border, #3a3b3e); border-radius: 12px; display: flex; flex-direction: column; box-shadow: 0 16px 48px rgba(0,0,0,.5); z-index: 20; overflow: hidden; }
.mh-panel-head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid var(--dsw-border, #3a3b3e); cursor: move; flex-shrink: 0; user-select: none; -webkit-user-drag: none; position: relative; z-index: 1; }
.mh-panel-drag { color: var(--dsw-text-secondary, #777); font-size: 11px; letter-spacing: -2px; }
/* 兜底：浮层整体禁掉原生拖拽/选中。Chromium 对可拖拽元素显示「圆圈加斜杠」
   的 no-drop 光标（用户实测反馈），除 JS preventDefault 外再从 CSS 侧禁一次。 */
.mh-panel, .mh-lyric { -webkit-user-drag: none; user-select: none; }
.mh-panel-head, .mh-panel-head * { -webkit-user-drag: none; user-select: none; }
.mh-lyric-body { user-select: text; }
/* 音乐库面板右下角缩放手柄（与歌词框同款斜纹） */
.mh-panel-resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; z-index: 3; background: linear-gradient(135deg, transparent 50%, rgba(140,160,200,.5) 50%, rgba(140,160,200,.5) 62%, transparent 62%, transparent 74%, rgba(140,160,200,.5) 74%, rgba(140,160,200,.5) 86%, transparent 86%); }
.mh-panel-title { font-weight: 700; font-size: 13px; }
.mh-panel-login { display: flex; gap: 5px; margin-left: auto; }
.mh-dot { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: #333; color: #888; }
.mh-dot-on { background: rgba(46,160,67,.25); color: #5fd98a; }
.mh-panel-close { padding: 2px 7px; }
.mh-tabs { display: flex; gap: 2px; padding: 6px 12px 0; flex-shrink: 0; }
.mh-tab { background: none; border: none; color: var(--dsw-text-secondary, #9aa4b2); padding: 5px 12px; cursor: pointer; font-size: 12px; border-bottom: 2px solid transparent; }
.mh-tab-cur { color: var(--dsw-text, #e6e8eb); border-bottom-color: var(--dsw-accent, #3b82f6); font-weight: 600; }
.mh-panel-ctrl { display: flex; align-items: center; gap: 5px; padding: 6px 12px; border-bottom: 1px solid var(--dsw-border, #3a3b3e); flex-shrink: 0; }
.mh-panel-cur { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; margin-left: 4px; }
.mh-toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 12px; flex-shrink: 0; }
.mh-root { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-text-secondary, #9aa4b2); font-size: 11px; }
.mh-list { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 6px 8px; }
.mh-row { display: flex; gap: 8px; align-items: center; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; }
.mh-row:hover { background: rgba(255,255,255,.05); }
.mh-row-cur { background: rgba(59,130,246,.16); }
.mh-row-idx { width: 20px; flex-shrink: 0; text-align: right; color: var(--dsw-text-secondary, #9aa4b2); font-variant-numeric: tabular-nums; }
.mh-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mh-row-artist { color: var(--dsw-text-secondary, #9aa4b2); }
.mh-row-meta { flex-shrink: 0; color: var(--dsw-text-secondary, #9aa4b2); font-size: 11px; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mh-error { color: #e5645e; font-size: 12px; }
.mh-lib-error { padding: 4px 12px; }
.mh-dir-empty { color: var(--dsw-text-secondary, #9aa4b2); padding: 18px 16px; text-align: center; font-size: 12px; line-height: 1.6; }
.mh-online { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.mh-login { flex-shrink: 0; padding: 8px 12px; border-bottom: 1px solid var(--dsw-border, #3a3b3e); }
.mh-login-row { display: flex; align-items: center; gap: 8px; }
.mh-login-title { font-size: 12px; font-weight: 600; }
.mh-login-sub { flex: 1; min-width: 0; font-size: 11px; color: var(--dsw-text-secondary, #9aa4b2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mh-login-done { flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-border, #3a3b3e); font-size: 12px; color: #5fd98a; }
.mh-login-done button { margin-left: auto; }
.mh-qr-wrap { display: flex; gap: 12px; margin-top: 8px; align-items: flex-start; }
.mh-qr { width: 132px; height: 132px; background: #fff; border-radius: 8px; padding: 4px; object-fit: contain; flex-shrink: 0; }
.mh-qr-side { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.mh-qr-tip { font-size: 12px; }
.mh-qr-msg { font-size: 11px; color: var(--dsw-text-secondary, #9aa4b2); word-break: break-all; }
.mh-qr-msg-standalone { margin-top: 6px; }
.mh-qr-btns { display: flex; gap: 6px; }
.mh-searchbar { display: flex; gap: 6px; padding: 8px 12px 4px; flex-shrink: 0; }
.mh-input { flex: 1; min-width: 0; background: #1b1c1f; border: 1px solid #3c3d40; border-radius: 6px; color: var(--dsw-text, #e6e8eb); padding: 5px 8px; font-size: 12px; outline: none; }
.mh-input:focus { border-color: var(--dsw-accent, #3b82f6); }
.mh-subnav { display: flex; gap: 2px; padding: 4px 12px 6px; flex-shrink: 0; align-items: center; }
.mh-subtab { background: none; border: none; color: var(--dsw-text-secondary, #9aa4b2); padding: 3px 10px; cursor: pointer; font-size: 12px; border-radius: 6px; }
.mh-subtab:hover { background: rgba(255,255,255,.06); }
.mh-subtab-cur { color: var(--dsw-text, #e6e8eb); background: rgba(59,130,246,.18); font-weight: 600; }
.mh-busy { margin-left: auto; font-size: 11px; color: var(--dsw-text-secondary, #9aa4b2); }
.mh-search-note { font-size: 11px; color: var(--dsw-text-secondary, #9aa4b2); padding: 2px 8px 6px; }
.mh-songs-head { display: flex; align-items: center; gap: 8px; padding: 6px 12px; flex-shrink: 0; }
.mh-songs-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 12px; }
.mh-sort { flex-shrink: 0; background: #2a2b2e; color: var(--dsw-text, #e6e8eb); border: 1px solid #3c3d40; border-radius: 6px; padding: 2px 4px; font-size: 11px; cursor: pointer; outline: none; }
.mh-sort:hover { border-color: var(--dsw-accent, #3b82f6); }
.mh-pl-grid { display: flex; flex-direction: column; gap: 2px; }
.mh-pl-card { padding: 7px 9px; border-radius: 6px; cursor: pointer; }
.mh-pl-card:hover { background: rgba(255,255,255,.05); }
.mh-pl-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mh-pl-meta { font-size: 11px; color: var(--dsw-text-secondary, #9aa4b2); margin-top: 2px; }
.mh-rank-group { padding: 4px 2px; }
.mh-rank-gname { font-size: 11px; color: var(--dsw-text-secondary, #9aa4b2); padding: 2px 6px 4px; }
.mh-rank-grid { display: flex; flex-wrap: wrap; gap: 4px; }
.mh-rank-item { display: flex; flex-direction: column; gap: 1px; padding: 5px 9px; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,.04); min-width: 96px; }
.mh-rank-item:hover { background: rgba(59,130,246,.18); }
.mh-rank-name { font-size: 12px; }
.mh-rank-meta { font-size: 10px; color: var(--dsw-text-secondary, #9aa4b2); }
.mh-modal { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 2000; display: flex; align-items: center; justify-content: center; }
.mh-modal-box { width: 480px; max-width: 92vw; height: 420px; max-height: 80vh; background: var(--dsw-bg-elevated, #232427); border: 1px solid var(--dsw-border, #3a3b3e); border-radius: 12px; display: flex; flex-direction: column; box-shadow: 0 16px 48px rgba(0,0,0,.5); }
.mh-modal-title { font-weight: 700; padding: 10px 14px; border-bottom: 1px solid var(--dsw-border, #3a3b3e); flex-shrink: 0; }
.mh-crumbs { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 14px; border-bottom: 1px solid var(--dsw-border, #3a3b3e); flex-shrink: 0; }
.mh-crumb { background: none; border: none; color: var(--dsw-accent, #3b82f6); cursor: pointer; font-size: 12px; padding: 2px 4px; }
.mh-dirlist { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 14px; }
.mh-dir-item { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--dsw-text, #e6e8eb); padding: 5px 6px; border-radius: 6px; cursor: pointer; font-size: 12px; }
.mh-dir-item:hover { background: rgba(255,255,255,.06); }
.mh-modal-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--dsw-border, #3a3b3e); flex-shrink: 0; }
.mh-modal-cur { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-text-secondary, #9aa4b2); font-size: 11px; }
.mh-autoplay-hint { position: fixed; left: 50%; bottom: 76px; transform: translateX(-50%); background: rgba(60,64,72,.96); color: #e6e8eb; font-size: 12px; padding: 6px 14px; border-radius: 8px; z-index: 3000; box-shadow: 0 6px 20px rgba(0,0,0,.4); pointer-events: none; }
/* 歌词浮层外观：深色玻璃 + 顶部柔光（不压暗正文区）。
   设计约束（用户要求「美观但不要影响看歌词」）：
   · 背景只用低饱和深色 + 轻微蓝紫光晕，正文区保持深纯色底，保住对比度；
   · backdrop-filter 让底下对话透出轮廓，但文字始终在纯色层之上；
   · 圆角 + 细边框 + 外阴影，与主界面卡片风格一致。 */
.mh-lyric { position: fixed; left: 24px; bottom: 96px; width: 380px; height: min(420px, 52vh); background: linear-gradient(160deg, rgba(38,41,52,.96) 0%, rgba(24,26,32,.97) 55%, rgba(20,22,27,.98) 100%); border: 1px solid rgba(120,140,190,.22); border-radius: 14px; display: flex; flex-direction: column; box-shadow: 0 18px 52px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.05); z-index: 21; overflow: hidden; backdrop-filter: blur(12px) saturate(1.2); }
.mh-lyric::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 110px; pointer-events: none; background: radial-gradient(120% 100% at 20% 0%, rgba(92,132,255,.16) 0%, rgba(92,132,255,0) 70%); }
.mh-lyric-resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; background: linear-gradient(135deg, transparent 50%, rgba(140,160,200,.5) 50%, rgba(140,160,200,.5) 62%, transparent 62%, transparent 74%, rgba(140,160,200,.5) 74%, rgba(140,160,200,.5) 86%, transparent 86%); }
.mh-lyric-tune { display: flex; align-items: center; gap: 3px; flex-shrink: 0; margin-right: 4px; }
.mh-lyric-off { font-size: 11px; min-width: 42px; text-align: center; color: var(--dsw-accent, #7aa2ff); font-variant-numeric: tabular-nums; }
.mh-lyric-off-zero { color: var(--dsw-text-secondary, #8a93a5); }
.mh-lyric-song { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dsw-text-secondary, #9aa4b2); margin-left: 6px; }
/* 歌词居中：用户要求「歌词居中，并且随缩放一直居中」。
   只做水平居中（text-align:center 会随容器宽窄自动跟随，缩放后无需重算）；
   垂直方向不做 justify-content:center —— 内容超出时那会把顶部截掉，
   纵向定位仍由「滚动到当前行」负责。 */
.mh-lyric-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 16px 20px; text-align: center; }
.mh-lyric-line { padding: 5px 4px; font-size: 13px; color: var(--dsw-text-secondary, #9aa4b2); cursor: pointer; border-radius: 6px; transition: color .15s ease; text-align: center; word-break: break-word; }
.mh-lyric-line:hover { color: var(--dsw-text, #e6e8eb); }
.mh-lyric .mh-panel-head { cursor: move; }
.mh-lyric-op { width: 64px; flex-shrink: 0; -webkit-appearance: none; appearance: none; height: 4px; background: #4a4b4f; border-radius: 2px; outline: none; }
.mh-lyric-op::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 11px; height: 11px; border-radius: 50%; background: var(--dsw-accent, #3b82f6); cursor: pointer; }
.mh-lyric-op::-moz-range-thumb { width: 11px; height: 11px; border-radius: 50%; background: var(--dsw-accent, #3b82f6); cursor: pointer; border: none; }
.mh-lyric-cur { color: var(--dsw-accent, #3b82f6); font-weight: 600; font-size: 14px; }
`;

/* 原生目录选择器持有者：apply() 内定义，共享 API 在模块作用域引用，故用这层转接。
   不挂 window：避免与其他插件抢命名。 */
const nativePickerHolder = { fn: null };

    /* ================= apply ================= */
    const inject = ["slots"];
    function apply(ctx) {
      const slots = (typeof ctx.get === "function") ? ctx.get("slots") : null;
      if (slots === undefined || slots === null) return;
      /* ★ 正确取法是「两跳」：先取 uiSession，再经它的 ctx.get("uiWorkspace")。
         直接 ctx.get("uiWorkspace") 拿到的是另一层对象（实测方法为
         notify/startSession/connectWorkspace，没有 pickDirectory），
         这就是「诊断说取不到、但目录选择又能用系统对话框」的原因：
         之前能弹原生的那条路靠的是别处碰巧命中，不稳定。
         取法照 card-desktop 的 getUiWorkspace：uiSessionCtx.get("uiWorkspace")。 */
      const resolveWs = () => {
        const tries = [];
        // ① 标准两跳：uiSession → uiWorkspace
        try {
          const us = (typeof ctx.get === "function") ? ctx.get("uiSession") : null;
          if (us && typeof us.get === "function") {
            const w = us.get("uiWorkspace");
            if (w && typeof w.pickDirectory === "function") return { svc: w, via: "uiSession.get" };
            tries.push("uiSession.get=无pickDirectory");
          } else tries.push("uiSession=无");
        } catch (e) { tries.push("uiSession抛错"); }
        // ② 退而直取
        try {
          const w2 = (typeof ctx.get === "function") ? ctx.get("uiWorkspace") : null;
          if (w2 && typeof w2.pickDirectory === "function") return { svc: w2, via: "ctx.get直取" };
          tries.push("直取=无pickDirectory");
        } catch { tries.push("直取抛错"); }
        // ③ 属性直读兜底
        try {
          if (ctx.uiWorkspace && typeof ctx.uiWorkspace.pickDirectory === "function") return { svc: ctx.uiWorkspace, via: "属性直读" };
        } catch { }
        return { svc: null, via: tries.join("；") };
      };
      if (slots === undefined || slots === null) return;

      /* ★ 原生目录选择器：DSH 的 uiWorkspace 服务提供 pickDirectory()，
         它弹的是系统资源管理器对话框（用户实测「添加工作区」时就是这个）。
         取法照 card-desktop 的既有做法：ctx.get 优先，再兜属性直读，两层都不许抛。
         不进 inject —— 可选服务写进 inject 会让整个插槽注册失败。
         拿不到时返回 false，调用方自动回落到内置浏览窗。 */
      const pickNativeDirectory = async () => {
        const r = resolveWs();
        const svc = r.svc;
        if (!svc || typeof svc.pickDirectory !== "function") return { ok: false, reason: "no-service：" + r.via };
        try {
          const raw = await svc.pickDirectory();
          /* 返回值可能是字符串，也可能是 { path } / { directory } 之类对象：
             不兼容的话 String(对象) 会变成 "[object Object]"，接口必然返回空 ——
             这正是「选了文件夹但列表啥也没有」的一种可能原因。 */
          let p = "";
          if (typeof raw === "string") p = raw;
          else if (raw && typeof raw === "object") p = String(raw.path || raw.directory || raw.dir || raw.value || "");
          if (!p) return { ok: false, reason: "cancelled" };
          return { ok: true, path: p, rawType: typeof raw };
        } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
      };
      nativePickerHolder.fn = pickNativeDirectory;   // 交给共享 API 用
      /* 诊断：列出真实服务的方法名（两跳取到后枚举，含原型链） */
      nativePickerHolder.listMethods = () => {
        /* 注意：这里必须与 pickNative 用同一个「已解析」对象，
           否则两次 resolveWs 可能拿到不同实例，出现「诊断说有路径、方法列表却是空/错」的怪象。 */
        const r = resolveWs();
        const svc = r.svc;
        if (!svc) return [];
        const names = new Set();
        let o = svc;
        while (o && o !== Object.prototype) {
          for (const k of Object.getOwnPropertyNames(o)) {
            try { if (typeof svc[k] === "function") names.add(k); } catch { }
          }
          o = Object.getPrototypeOf(o);
        }
        return Array.from(names);
      };
      /* 全量枚举：列出 ctx 上能取到的服务名，确认 pickDirectory 挂在哪个名字下 */
      nativePickerHolder.probeAll = () => {
        const found = [];
        const names = ["uiSession", "uiWorkspace", "workspaces", "workspace", "ui", "shell", "desktop", "app", "window", "dialog", "fs", "files", "explorer"];
        for (const n of names) {
          try {
            const v = (typeof ctx.get === "function") ? ctx.get(n) : null;
            if (!v) continue;
            const hasPick = typeof v.pickDirectory === "function";
            const hasFile = typeof v.openFile === "function" || typeof v.pickFile === "function";
            found.push(n + (hasPick ? "(可挑目录)" : "") + (hasFile ? "(有openFile)" : ""));
          } catch { }
        }
        return found;
      };
      /* 诊断：报告取服务的具体路径，用于定位「取到错对象」 */
      nativePickerHolder.debug = () => resolveWs().via;
      /* 暴露已解析的服务本体：诊断直接看 pickDirectory 类型，不靠方法名推断 */
      nativePickerHolder.peekService = () => resolveWs().svc;
      if (slots === undefined || slots === null) return;

      ctx.effect(() => {
        const styleEl = document.createElement("style");
        styleEl.setAttribute("data-plugin", "dsh-music-hub");
        styleEl.textContent = PLAYER_CSS;
        document.head.appendChild(styleEl);
        return () => { if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); };
      });

      ctx.effect(() => {
        let alive = true;
        Promise.all([loadPrefs(), loadManifest()]).then(() => { if (alive) applyRestore(); }).catch(() => { });
        /* 关窗/切后台时立刻落盘：防抖窗口内关闭会把最后一次「换了哪首」丢掉（用户实测重启回到旧歌） */
        /* 离开页面要两件事：① 把挂起的 prefs 立刻发出去；② 主动暂停音频。
           ★ 真页面卸载（刷新/导航）才走这里；托盘退出时窗口只是 hide，这三个事件
             一个都不会触发 —— 那条路径见下面的「宿主退出信号」。 */
        /* 统一的「离开页面即停播」：暂停 + 记住进度。 */
        const stopForQuit = () => {
          try { flushPrefs(); } catch { }
          try {
            /* 用 ensureAudio() 而不是只读全局：组件可能还没挂载，此时 shared.audio 是空的，
               读全局会让「关窗停播」静默失效。ensureAudio 是惰性单例，拿到的就是同一个元素。 */
            let a = null;
            try { a = ensureAudio(); } catch { }
            if (!a) { a = window.__mhMusicHubShared && window.__mhMusicHubShared.audio; }
            if (!a || a.paused) return;
            const st = getState();
            if (st && st.currentId) {
              savePrefs({
                currentId: st.currentId,
                currentName: st.currentName || "",
                position: a.currentTime || 0,
                trackDur: (Number.isFinite(a.duration) && a.duration > 0) ? Math.round(a.duration) : (Math.round(Number(st.trackDur)) || 0),
              }, true);
            }
            try { a.pause(); } catch { }
          } catch { }
        };
        const onHide = stopForQuit;
        try {
          window.addEventListener("pagehide", onHide);
          window.addEventListener("beforeunload", onHide);
          window.addEventListener("unload", onHide);          // 第三道：Electron 关窗有时只派发它
          /* ★ 这里绝不能"因为页面隐藏就暂停"。
             曾经加过一段「hidden + 失去焦点 1.5 秒后暂停」的兜底，想解决关窗后还播几秒，
             但 Electron 里「最小化到任务栏」「切到浏览器」同样会 hidden + 失焦，
             结果只要 DSH 不在前台音乐就停（用户实测）。
             现在这三个事件只负责「真页面卸载」那几种情况；切后台一律不停播，只刷 prefs。 */
          document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
              try { flushPrefs(); } catch { }
            }
          });
        } catch { }
        /* ★ 托盘退出的真实路径（2026-11-03 读 dsh-desktop 的 finishQuit 定案）：
           点「退出」后壳先 hide 两个窗口，再等宿主进程退出（等满 10s 才 SIGTERM），
           最后才 app.quit() 杀掉渲染进程。窗口只是隐藏 → pagehide/beforeunload/unload
           一个都不触发 → <audio> 一直播到渲染进程被杀，用户听到的就是这 10 秒。
           页面侧唯一可靠的信号是「宿主开始拆机」：播放期间每隔几百毫秒问一次
           /dsh-music/api/life，宿主收到壳的 {type:"shutdown"} 就立刻回 {quit:true}。
           ★ 必须是短轮询、不能挂长连接：挂住的请求会长期占住浏览器对同一主机的连接
             槽位，音频流的 Range 请求排不上队 —— 用户实测「点进度条跳不动、又从头播」。
           ★ 循环状态放在 SHARED 里：客户端脚本被加载两次时（HMR/重复注册），
             两个实例各起一个循环 = 双倍占用，这里保证全页只有一个。 */
        const LIFE = SHARED.life || (SHARED.life = { on: false, timer: 0, gen: 0 });
        LIFE.on = false;
        LIFE.gen++;          // 作废上一代循环（重复实例加载时只允许一个循环活着）
        LIFE.gen = LIFE.gen >>> 0;
        const lifeLoop = async (gen) => {
          let fails = 0;
          while (LIFE.on && LIFE.gen === gen) {
            let quit = false;
            let ok = false;
            try {
              const r = await fetch("/dsh-music/api/life", { cache: "no-store" });
              if (r.status === 404) { LIFE.on = false; return; }       // 老宿主没这条路由：不误停
              if (r.ok) {
                ok = true;
                const j = await r.json().catch(() => null);
                if (j && j.quit) quit = true;
              }
            } catch { }
            if (!LIFE.on || LIFE.gen !== gen) return;
            if (quit) { LIFE.on = false; stopForQuit(); return; }
            fails = ok ? 0 : fails + 1;
            if (fails >= 2) { LIFE.on = false; stopForQuit(); return; }   // 宿主进程已不在
            /* 600ms 一次：本地回环请求，开销可忽略；退出信号最多晚 0.6s 落到页面上 */
            await new Promise((res) => { LIFE.timer = setTimeout(res, 600); });
          }
        };
        const startLife = () => {
          if (LIFE.on) return;
          LIFE.on = true;
          const gen = ++LIFE.gen;
          lifeLoop(gen).catch(() => { });
        };
        const stopLife = () => { LIFE.on = false; try { clearTimeout(LIFE.timer); } catch { } };
        /* 只在真的出声时轮询：暂停/空闲不发请求，切到后台也不产生多余流量 */
        const unsubLife = subscribe((st) => { if (st && st.playing) startLife(); else stopLife(); });
        try { if (getState().playing) startLife(); } catch { }
        return () => { alive = false; try { unsubLife(); } catch { } stopLife(); };
      }, "dsh-music-hub: init");

      /* 播放条显隐开关：用户要求「在卡片桌面里也能选择是否打开主界面输入框上方的音乐条」。
         实现方式：槽位照常注册，组件内部按 showBar 决定返回 null 还是内容 ——
         这样不需要动态注册/注销槽位（注销在运行时会残留占位），开关也能立即生效。
         默认显示；开关值存 prefs.showBar，重启后保持。 */
      ctx.effect(() => slots.inject("conversation.input.dock", () => slots.register(
        { name: "conversation.input.dock", id: "music-hub-bar", order: 40 },
        NowPlayingBar,
      )), "dsh-music-hub: now playing bar");

      ctx.effect(() => slots.inject("shell.overlay", () => slots.register(
        { name: "shell.overlay", id: "music-hub-panel", order: 20 },
        PlayerPanel,
      )), "dsh-music-hub: panel");

      ctx.effect(() => slots.inject("shell.overlay", () => slots.register(
        { name: "shell.overlay", id: "music-hub-lyric", order: 21 },
        LyricPanel,
      )), "dsh-music-hub: lyric panel");

      ctx.effect(() => slots.inject("shell.overlay", () => slots.register(
        { name: "shell.overlay", id: "music-hub-autoplay-hint", order: 22 },
        () => {
          const [st, setSt] = React.useState(getState());
          React.useEffect(() => subscribe(setSt), []);
          if (!st.autoplayHint) return null;
          return React.createElement("div", { className: "mh-autoplay-hint" }, st.autoplayHint);
        },
      )), "dsh-music-hub: autoplay hint");

      /* agent 点歌：宿主半区的 music_play 工具只写「意图」，由这里轮询执行。
         为什么必须在浏览器端执行：宿主进程没有音频设备，且自动播放策略只认用户手势/
         已解锁的 <audio> 元素。轮询间隔 2s：太短会白打宿主，太长会显得迟钝。 */
      let intentTimer = 0;
      const applyIntent = async (it) => {
        // 调试用可观测点：把收到的意图摘要挂到 state（播放条 title 能看到）
        const act = it.action || "play";
        if (act === "pause") { const a = ensureAudio(); a.pause(); return; }
        if (act === "resume") { const a = ensureAudio(); if (a.src) armPlay(a); return; }
        if (act === "stop") { const a = ensureAudio(); a.pause(); try { a.currentTime = 0; } catch { } return; }
        if (act === "next") { step(1); return; }
        /* seek：卡片桌面里拖了进度，主界面那条要跟着跳（node 侧只转发意图） */
        if (act === "seek") { seekTo(Number(it.position)); return; }
        /* mode：卡片桌面切了播放顺序，主界面要跟着换（两边共用一个值） */
        if (act === "mode" && it.mode) {
          if (["sequence", "repeat-one", "shuffle"].indexOf(it.mode) >= 0) {
            setState({ mode: it.mode });
            if (it.mode !== "shuffle") shuffleHistory = [];
          }
          return;
        }
        if (act === "prev") { step(-1); return; }
        if (act !== "play") return;
        if (it.kind === "local") {
          if (trackById(it.id)) { playTrack(it.id); return; }
          const t = getState().tracks.find((x) => x.name === it.name);
          if (t) { playTrack(t.id); return; }
          // ★ 曲库缓存过期：页面打开时曲库可能是空的，之后用户在别处（或别的标签页）
          //   才设置了目录/重扫。此时意图里的 id 在本页 state 里查不到 —— 之前这里直接
          //   静默 return，用户看到的就是「agent 说已请求播放，但一点声音没有」。
          //   现改为重拉一次曲库再匹配，仍找不到才算真的没有。
          await loadManifest();
          const t2 = trackById(it.id) || getState().tracks.find((x) => x.name === it.name);
          if (t2) { playTrack(t2.id); return; }
          setState({ error: "找不到曲目「" + (it.name || it.id) + "」，可能曲库已变更，请打开面板点「刷新」。" });
          return;
        }
        // 在线：意图里带完整 song 对象（取链需要的 hash/songmid 都在里面）
        if (it.kind === "qq" || it.kind === "kg" || it.kind === "nc") {
          const song = it.song || { id: it.id };
          playOnline(it.kind, song, [{ src: it.kind, song }], 0);
        }
      };
      lastApplyIntent = applyIntent;
      const pollIntent = async () => {
        if (typeof document !== "undefined" && document.hidden) return; // 后台标签不抢播
        try {
          const r = await apiJson("/dsh-music/api/intent");
          /* 播放条显隐由宿主 prefs 统一管控：卡片桌面一关，主界面 2 秒内跟着消失。
             只在值真的变了才 setState，避免每 2 秒白触发一次 React 渲染。 */
          if (r && typeof r.showBar === "boolean" && r.showBar !== getState().showBar) {
            setState({ showBar: r.showBar });
          }
          if (r && r.intent) await applyIntent(r.intent);
        } catch { /* 轮询失败静默，下一轮再试 */ }
      };
      ctx.effect(() => {
        intentTimer = setInterval(pollIntent, 2000);
        const first = setTimeout(pollIntent, 800); // 启动后先探一次，免得刚开页要等 2s
        return () => { clearInterval(intentTimer); clearTimeout(first); };
      }, "dsh-music-hub: intent poll");
    }

    /* ===== 对外控制 API（卡片桌面音乐卡直接驱动同一个播放器） =====
       为什么要有它：两边各建一个 <audio> 时，主界面那条并不知道卡片在放什么 ——
       它没有 src、没有 duration、不能播也不能前进。发 intent 只能传「动作」，
       传不了「正在播的那一路音频」，所以永远同步不上（用户 2026-10-29 实测：
       卡片 0:53/4:16 正常，主界面 2:29/0:00 卡死且暂停）。
       正确做法：全页只有一个播放器，卡片通过这组 API 直接指挥它 ——
       点歌 = 让主界面去播（playOnline/playTrack），进度 = seekTo，
       暂停/下一首/顺序 = togglePlay/step/cycleMode。状态天然一致，无需同步逻辑。 */
    window.__mhMusicHubAPI = {
      getState,
      subscribe,
      playLocal: (id) => playTrack(id),
      playOnline: (src, song, queue, index) => playOnline(src, song, queue, index),
      toggle: () => togglePlay(),
      step: (d) => step(d),
      seek: (sec) => seekTo(sec),
      cycleMode: () => cycleMode(),
      setVolume: (v) => {
        const a = ensureAudio();
        const nv = Math.max(0, Math.min(1, v));
        try { a.volume = nv; } catch { }
        setState({ volume: nv, muted: nv === 0 });
        savePrefs({ volume: nv });
      },
      /* 暴露 audio 元素本身：卡片要复用它，才能在「还没点播」时就拿到同一个对象。
         用 getter 保证拿到的是最新那个（ensureAudio 是惰性创建）。 */
      get audio() { try { return ensureAudio(); } catch { return null; } },
      ensure: () => { try { ensureAudio(); return true; } catch { return false; } },
      version: 2,
    };

    /* ===== 共享设置组件（主界面与卡片桌面共用同一份实现，避免两套走偏） =====
       为什么挂在 window 上：卡片桌面是独立插件包，不能 import 本包代码；
       把「组件工厂」暴露出去，卡片只需 React.createElement(window.__mhMusicHubSettings.Panel, props)，
       渲染与逻辑就只有这一份，任何一边改另一边自动跟随。
       配置读写走 /dsh-music/api/settings，两边看到的是同一份数据。 */
    window.__mhMusicHubSettings = {
      version: 1,
      /* 读设置 → Promise<settings> */
      load: async () => {
        const r = await apiJson("/dsh-music/api/settings");
        return (r && r.settings) || null;
      },
      /* 改设置（增量）→ Promise<settings> */
      save: async (patch) => {
        const r = await apiJson("/dsh-music/api/settings", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch || {}),
        });
        return (r && r.settings) || null;
      },
      /* 目录自检 → { ok, path|error } */
      checkDir: async (p) => {
        const r = await apiJson("/dsh-music/api/checkdir?path=" + encodeURIComponent(p || ""));
        return r || { ok: false, error: "无响应" };
      },
      /* 背景样式解析：图片优先，没图用颜色，都没有返回 null（调用方保留默认） */
      bgStyle: (v) => {
        if (!v) return null;
        const img = String(v.image || "").trim();
        const color = String(v.color || "").trim();
        if (img) {
          const isUrl = /^https?:/i.test(img) || /^data:/i.test(img);
          const url = isUrl ? img : (img.indexOf("/") === 0 ? img : "/dsh-music/api/file?path=" + encodeURIComponent(img));
          return { backgroundImage: "url(" + JSON.stringify(url) + ")", backgroundSize: "cover", backgroundPosition: "center", backgroundColor: color || "#0e1014" };
        }
        if (color) return { background: color };
        return null;
      },
      /* apply() 里拿到的原生选择函数会写进这个模块级持有者；
         API 对象在模块作用域，直接引用 apply 内部的名字会 ReferenceError（实测踩过）。 */
      pickNative: () => (nativePickerHolder.fn ? nativePickerHolder.fn() : Promise.resolve({ ok: false, reason: "no-service" })),
        debug: () => (nativePickerHolder.debug ? nativePickerHolder.debug() : "无诊断"),
        probeAll: () => (nativePickerHolder.probeAll ? nativePickerHolder.probeAll() : []),
        peekService: () => (nativePickerHolder.peekService ? nativePickerHolder.peekService() : null),
      /* 诊断：列出 uiWorkspace 可用方法（设置面板里有个按钮会显示它） */
      nativeMethods: () => (nativePickerHolder.listMethods ? nativePickerHolder.listMethods() : []),
      makePanel: (React, opts) => makeSettingsPanel(React, apiJson, Object.assign({
        pickNative: () => (nativePickerHolder.fn ? nativePickerHolder.fn() : Promise.resolve({ ok: false, reason: "no-service" })),
        debug: () => (nativePickerHolder.debug ? nativePickerHolder.debug() : "无诊断"),
        probeAll: () => (nativePickerHolder.probeAll ? nativePickerHolder.probeAll() : []),
        peekService: () => (nativePickerHolder.peekService ? nativePickerHolder.peekService() : null),
        nativeMethods: () => (nativePickerHolder.listMethods ? nativePickerHolder.listMethods() : []),
      }, opts || {})),
    };

    exports.apply = apply;
    exports.inject = inject;
    /* 仅测试用：暴露内部组件与状态读写，供 test/client-render.mjs 在不启浏览器的情况下
       逐个组件真跑一遍（用于抓「node --check 通过但一渲染就 threw」的未声明标识符类缺陷）。
       生产代码不读这些字段，保留无副作用。 */
    exports.__test = {
      components: { NowPlayingBar, PlayerPanel, LocalView, OnlineView, LoginBox, SongRow, TrackRow, DirPicker, LyricPanel },
      getState, setState, onlineCache, playTrack, playOnline, step, togglePlay, songKey, seekTo, primeBlob, songDuration,
      // applyIntent 在 apply() 内定义（需要闭包里的 armPlay/loadManifest），
      // 通过 apply() 时挂到临时槽位，供测试复用同一条真实链路。
      // 持久化恢复链路（供测试真跑：重启后「显示旧歌、点播放没反应」就是这条链的问题）
      loadPrefs, applyRestore, loadManifest,
      get applyIntent() { return lastApplyIntent; },   // 恢复：被插入时误删过，client-render 依赖它
      get pendingRestore() { return pendingRestore; },
      set pendingRestore(v) { pendingRestore = v; },
    };
    return module.exports;
  },
});
