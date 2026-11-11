// 统一设置层：主界面与卡片桌面音乐共用同一份配置。
//
// 用户需求（2026-10-31）：
//   ① 两边各一个入口，改一处两边都变（不能各存一份，否则必然走偏）；
//   ② 设置项：主界面条开关 / 歌曲缓存位置（可分源）/ 缓存上限 /
//      卡片大背景 / 悬浮窗背景 / 歌词背景；
//   ③ 缓存位置支持三源共用一个目录，也支持分开；共用时同一首歌只下一份。
//
// 设计取舍：
//   · 配置落在 prefs.json 的 settings 段，与播放状态分开命名，互不干扰；
//   · 读时合并默认值（老用户没有 settings 段也不会炸）；写时只接受白名单字段；
//   · 路径只存字符串，不在这里做存在性校验（目录可能暂时不存在，由缓存层按需创建）。
import { existsSync, statSync, mkdirSync } from "node:fs";

export const DEFAULT_SETTINGS = {
  /* 主界面输入框上方的播放条是否显示（原 showBar，挪进来统一管理） */
  showBar: true,
  /* 歌曲缓存：dirs 为三个源各自的目录；common 为「共用目录」。
     留空表示跟随默认（%USERPROFILE%\.dsh\music-hub-cache）。 */
  cache: {
    common: "",          // 共用目录；三源其中之一指向它即可复用
    qq: "",
    kg: "",
    nc: "",
    maxMB: 2048,         // 上限，单位 MB（默认 2GB）
  },
  /* 背景：颜色与图片都支持，图片优先 */
  bg: {
    /* dir = 记住的图片文件夹（用户选过一次后，以后直接从它列图） */
    stage: { color: "", image: "", dir: "" },   // 卡片外的大背景（舞台）
    card: { color: "", image: "", dir: "" },    // 悬浮窗本体
    lyric: { color: "", image: "", dir: "" },   // 歌词栏
  },
};

/** 深合并默认值：老配置缺字段时补上，不覆盖用户已设值 */
export function mergeSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

  if (typeof src.showBar === "boolean") out.showBar = src.showBar;

  const c = src.cache && typeof src.cache === "object" ? src.cache : {};
  for (const k of ["common", "qq", "kg", "nc"]) {
    if (typeof c[k] === "string") out.cache[k] = c[k];
  }
  if (Number.isFinite(Number(c.maxMB)) && Number(c.maxMB) > 0) {
    out.cache.maxMB = Math.max(64, Math.min(65536, Math.round(Number(c.maxMB))));
  }

  const b = src.bg && typeof src.bg === "object" ? src.bg : {};
  for (const k of ["stage", "card", "lyric"]) {
    const v = b[k] && typeof b[k] === "object" ? b[k] : {};
    if (typeof v.color === "string") out.bg[k].color = v.color;
    if (typeof v.image === "string") out.bg[k].image = v.image;
    if (typeof v.dir === "string") out.bg[k].dir = v.dir;
  }
  return out;
}

/** 只接受白名单字段的增量更新，返回合并后的完整配置 */
export function patchSettings(cur, body) {
  const base = mergeSettings(cur);
  const src = body && typeof body === "object" ? body : {};

  if (typeof src.showBar === "boolean") base.showBar = src.showBar;

  if (src.cache && typeof src.cache === "object") {
    for (const k of ["common", "qq", "kg", "nc"]) {
      if (typeof src.cache[k] === "string") base.cache[k] = src.cache[k];
    }
    if (src.cache.maxMB !== undefined && Number.isFinite(Number(src.cache.maxMB))) {
      base.cache.maxMB = Math.max(64, Math.min(65536, Math.round(Number(src.cache.maxMB))));
    }
  }

  if (src.bg && typeof src.bg === "object") {
    for (const k of ["stage", "card", "lyric"]) {
      const v = src.bg[k];
      if (!v || typeof v !== "object") continue;
      if (typeof v.color === "string") base.bg[k].color = v.color;
      if (typeof v.image === "string") base.bg[k].image = v.image;
      if (typeof v.dir === "string") base.bg[k].dir = v.dir;
    }
  }
  return base;
}

/**
 * 解析某个源的实际缓存目录。
 *
 * 规则（用户确认的形态）：
 *   · 该源自己有目录 → 用自己的；
 *   · 没设自己的但设了 common → 用 common（于是三源共享一份缓存）；
 *   · 都没设 → 返回 "" 表示走默认目录。
 */
export function dirForSource(settings, src) {
  const c = (settings && settings.cache) || {};
  const own = (c[src] || "").trim();
  if (own) return own;
  const common = (c.common || "").trim();
  if (common) return common;
  return "";
}

/** 确保目录可用；失败返回 false（调用方应回落到默认目录） */
export function ensureDir(p) {
  if (!p) return false;
  try {
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 校验一个路径是否可写（设置界面用「测试」按钮） */
export function checkDir(p) {
  if (!p || typeof p !== "string") return { ok: false, error: "路径为空" };
  try {
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
    if (!statSync(p).isDirectory()) return { ok: false, error: "不是目录" };
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
