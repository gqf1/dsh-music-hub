/**
 * dsh-music-hub 本地音乐模块：目录扫描 + 音频文件头解析（音质识别）。
 *
 * 音频头解析（parseAudioMeta/audioQualityLabel 等）移植自 kendu76 的
 * dsh-music-player（MIT），原文件 lib/index.js §本地音乐部分；按本插件结构
 * 整理并保留其全部边界处理（ID3 前缀、假同步帧、M4A 多层盒嵌套等）。
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename, extname, sep } from "node:path";
import { createHash } from "node:crypto";

// 支持的扩展名 → 浏览器 <audio> 的 MIME（与参考实现一致）
export const AUDIO_TYPES = {
  mp3: "audio/mpeg", m4a: "audio/mp4", m4b: "audio/mp4", aac: "audio/aac",
  flac: "audio/flac", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
  opus: "audio/ogg", webm: "audio/webm", aiff: "audio/aiff", aif: "audio/aiff",
};

export function isAudioName(name) {
  const i = name.lastIndexOf(".");
  return i > 0 && Object.prototype.hasOwnProperty.call(AUDIO_TYPES, name.slice(i + 1).toLowerCase());
}
export function audioType(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? (AUDIO_TYPES[name.slice(i + 1).toLowerCase()] || "application/octet-stream") : "application/octet-stream";
}

// ---- 音频头解析（移植自 dsh-music-player，MIT）----
const AUDIO_HEADER_LEN = 64 * 1024;      // 只读前 64KB
const AUDIO_LOSSY_HIGH_KBPS = 256;       // 有损 ≥256kbps → 「高音质」
const AUDIO_CODEC_NAMES = { FLAC: "FLAC", WAV: "WAV", AIFF: "AIFF", MP3: "MP3", AAC: "AAC", OGG: "OGG", Opus: "Opus" };

function mpegLayer3Kbps(version, idx) {
  if (idx === 0 || idx > 14) return 0;
  if (version === 1) return [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][idx];
  return [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160][idx];
}
function mpegSampleRate(version, idx) {
  if (idx > 2) return 0;
  if (version === 1) return [44100, 48000, 32000][idx];
  if (version === 2) return [22050, 24000, 16000][idx];
  return [11025, 12000, 8000][idx];
}
// AIFF 80-bit 扩展浮点采样率
function aiffSampleRate(b, off) {
  const exp = ((b[off] & 0x7f) << 8) | b[off + 1];
  let mant = 0;
  for (let i = 0; i < 8; i++) mant = mant * 256 + b[off + 2 + i];
  if (exp === 0 && mant === 0) return 0;
  if (exp === 0x7fff) return 0;
  return (mant / 2 ** 63) * 2 ** (exp - 16383);
}
// 扫描 MPEG Layer III 帧头；带「下一帧同步」校验降低假同步概率
function parseMpegFrame(b, off) {
  const n = b.length;
  for (let i = off; i + 4 <= n; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    if ((b[i + 1] & 0x0f) === 0x01 || (b[i + 1] & 0x0f) === 0x09) continue; // 跳过 ADTS 裸 AAC
    const versionBits = (b[i + 1] >> 3) & 0x03;
    const layerBits = (b[i + 1] >> 1) & 0x03;
    if (versionBits === 1 || layerBits !== 1) continue;
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
    const kbps = mpegLayer3Kbps(version, (b[i + 2] >> 4) & 0x0f);
    const rate = mpegSampleRate(version, (b[i + 2] >> 2) & 0x03);
    if (kbps === 0 || rate === 0) continue;
    const padding = (b[i + 2] >> 1) & 0x01;
    const frameLen = Math.floor((version === 1 ? 144 : 72) * kbps * 1000 / rate) + padding;
    if (i + frameLen + 4 <= n) {
      const nx = i + frameLen;
      if (!(b[nx] === 0xff && (b[nx + 1] & 0xe0) === 0xe0)) continue;
    }
    const chmode = (b[i + 3] >> 6) & 0x03;
    return { bitrateKbps: kbps, sampleRate: rate, channels: chmode === 3 ? 1 : 2, tier: kbps >= AUDIO_LOSSY_HIGH_KBPS ? "高音质" : "标准" };
  }
  return null;
}
// 有界 M4A/MP4 盒解析：mvhd 时长 + stsd>mp4a 采样率/声道
function parseM4a(b, n) {
  let sampleRate = 0, channels = 0, duration = 0, timescale = 1, hasMp4a = false;
  const walk = (start, end, depth) => {
    let off = start;
    while (off + 8 <= end) {
      const size = b.readUInt32BE(off);
      const type = b.toString("ascii", off + 4, off + 8);
      if (size < 8) break;
      const cs = off + 8;
      const ce = Math.min(off + size, end);
      if (type === "mvhd" && cs + 16 <= ce) {
        if (b[cs] === 0) { timescale = b.readUInt32BE(cs + 12); duration = b.readUInt32BE(cs + 16); }
        else if (cs + 28 <= ce) { timescale = b.readUInt32BE(cs + 20); duration = b.readUInt32BE(cs + 24) * 2 ** 32 + b.readUInt32BE(cs + 28); }
      }
      if (type === "mp4a" && cs + 28 <= ce) {
        channels = b.readUInt16BE(cs + 16);
        sampleRate = Math.round(b.readUInt32BE(cs + 24) / 65536);
        hasMp4a = true;
      }
      if (depth < 8) walk(cs + (type === "stsd" ? 8 : 0), ce, depth + 1);
      off += size;
    }
  };
  walk(0, n, 0);
  if (!hasMp4a) return null;
  return { sampleRate, channels, durationSec: timescale > 0 ? duration / timescale : 0 };
}
// 有界 EBML(WebM) 扫描：CodecID / SamplingFrequency / Channels
function parseEbml(b, n) {
  let codec = "", rate = 0, ch = 0;
  for (let i = 0; i + 2 < n;) {
    const id = b[i];
    if (id === 0x86 && i + 2 <= n) {
      const len = b[i + 1];
      if (i + 2 + len <= n) codec = b.toString("ascii", i + 2, i + 2 + len);
      i += 2 + len;
    } else if (id === 0xb5 && i + 2 <= n) {
      const len = b[i + 1];
      if (len === 4 && i + 6 <= n) rate = b.readUInt32BE(i + 2);
      i += 2 + len;
    } else if (id === 0x9f && i + 2 <= n) {
      const len = b[i + 1];
      if (len === 1 && i + 3 <= n) ch = b[i + 2];
      i += 2 + len;
    } else { i++; }
  }
  if (codec === "A_OPUS") return { codec: "Opus", sampleRate: rate, channels: ch, tier: "高音质" };
  if (codec === "A_VORBIS") return { codec: "OGG", sampleRate: rate, channels: ch, tier: "" };
  return null;
}
function parseContainerAt(buf, off, size) {
  const b = buf.subarray(off);
  const n = b.length;
  if (n < 8) return null;
  const ascii = (o, l) => b.toString("ascii", o, o + l);
  if (ascii(0, 4) === "fLaC") {
    if ((b[4] & 0x7f) === 0 && n >= 42) {
      const v = (BigInt(b.readUInt32BE(18)) << 32n) | BigInt(b.readUInt32BE(22));
      const sampleRate = Number((v >> 44n) & 0xfffffn);
      const channels = Number((v >> 41n) & 0x7n) + 1;
      const bits = Number((v >> 36n) & 0x1fn) + 1;
      return { codec: "FLAC", sampleRate, channels, bitDepth: bits, tier: "无损" };
    }
    return { codec: "FLAC", tier: "无损" };
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") {
    let p = 12;
    while (p + 8 <= n) {
      const id = ascii(p, 4);
      const sz = b.readUInt32LE(p + 4);
      if (id === "fmt ") {
        const fmt = b.readUInt16LE(p + 8);
        if (fmt === 1 || fmt === 3) return { codec: "WAV", sampleRate: b.readUInt32LE(p + 12), channels: b.readUInt16LE(p + 10), bitDepth: b.readUInt16LE(p + 22), tier: "无损" };
        return { codec: "WAV", tier: "无损" };
      }
      p += 8 + sz + (sz & 1);
    }
    return { codec: "WAV", tier: "无损" };
  }
  if (ascii(0, 4) === "FORM" && (ascii(8, 4) === "AIFF" || ascii(8, 4) === "AIFC")) {
    let p = 12;
    while (p + 8 <= n) {
      const id = ascii(p, 4);
      const sz = b.readUInt32BE(p + 4);
      if (id === "COMM") {
        const rate = aiffSampleRate(b, p + 16);
        return { codec: "AIFF", sampleRate: Math.round(rate), channels: b.readUInt16BE(p + 8), bitDepth: b.readUInt16BE(p + 14), tier: "无损" };
      }
      p += 8 + sz + (sz & 1);
    }
    return { codec: "AIFF", tier: "无损" };
  }
  if (ascii(0, 4) === "OggS") {
    const head = b.toString("latin1", 0, Math.min(n, 128));
    const vi = head.indexOf("\x01vorbis");
    if (vi >= 0 && vi + 24 <= n) {
      const ch = b[vi + 11];
      const rate = b.readUInt32LE(vi + 12);
      const bitrateNom = b.readUInt32LE(vi + 20);
      return { codec: "OGG", sampleRate: rate, channels: ch, bitrateKbps: Math.round(bitrateNom / 1000), tier: bitrateNom >= AUDIO_LOSSY_HIGH_KBPS * 1000 ? "高音质" : "标准" };
    }
    const oi = head.indexOf("OpusHead");
    if (oi >= 0 && oi + 13 <= n) {
      return { codec: "Opus", sampleRate: b.readUInt32LE(oi + 12), channels: oi + 10 <= n ? b[oi + 9] : 0, tier: "高音质" };
    }
    return null;
  }
  if (ascii(4, 4) === "ftyp") {
    const m = parseM4a(b, n);
    if (m) {
      const bitrate = size > 0 && m.durationSec > 0 ? Math.round((size * 8) / m.durationSec / 1000) : 0;
      return { codec: "AAC", sampleRate: m.sampleRate, channels: m.channels, bitrateKbps: bitrate, tier: bitrate > 0 ? (bitrate >= AUDIO_LOSSY_HIGH_KBPS ? "高音质" : "标准") : "" };
    }
    return null;
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return parseEbml(b, n) || null;
  }
  return null;
}

/**
 * 解析音频文件头（前 64KB）识别音质。按内容（魔数）而非扩展名识别。
 * 返回 { codec, sampleRate?, channels?, bitDepth?, bitrateKbps?, tier? } 或 null。
 */
export function parseAudioMeta(buf, size = 0) {
  const b = buf;
  if (b.length < 8) return null;
  try {
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) { // ID3 前缀
      const tagSize = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
      const skip = 10 + tagSize + ((b[5] & 0x10) ? 10 : 0);
      if (skip >= b.length) return null;
      const c = parseContainerAt(b, skip, size);
      if (c) return c;
      const r = parseMpegFrame(b, skip);
      if (r) return { codec: "MP3", ...r };
      return null;
    }
    const c = parseContainerAt(b, 0, size);
    if (c) return c;
    const r = parseMpegFrame(b, 0);
    if (r) return { codec: "MP3", ...r };
    return null;
  } catch { return null; }
}

/** 播放条标签：「格式 · 档位」（FLAC · 无损 / MP3 · 高音质） */
export function audioQualityLabel(meta) {
  if (!meta || !meta.codec) return "";
  const name = AUDIO_CODEC_NAMES[meta.codec] || meta.codec;
  return meta.tier ? name + " · " + meta.tier : name;
}

// ---- 目录扫描 ----
// 参考实现的边界经验：dsh-fs-local 的 listDir 是全有或全无（一个不可读子项就整盘失败），
// 所以直接用 node:fs 枚举并跳过不可读项；上限 500 首、深度 4 层。
export const SCAN_MAX_TRACKS = 500;
export const SCAN_MAX_DEPTH = 4;

/** 容错目录列表：跳过 stat 不了的条目（EPERM/EBUSY），其余按名字排序 */
export function listEntries(dirPath) {
  let dirents = [];
  try { dirents = readdirSync(dirPath, { withFileTypes: true, encoding: "utf8" }); } catch { return []; }
  const out = [];
  for (const ent of dirents) {
    try {
      const isDir = ent.isDirectory() || (ent.isSymbolicLink() && statSync(join(dirPath, ent.name)).isDirectory());
      out.push({ name: ent.name, isDir });
    } catch { /* 不可读条目：跳过，保住其余列表 */ }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function trackId(path) {
  return createHash("sha1").update(path, "utf16le").digest("hex").slice(0, 16);
}

/**
 * 扫描音乐目录。返回 { tracks, skipped }。
 * tracks: { id, name, path, size, ext, quality(标签), url } —— url 是浏览器可直接
 * 播放的流式地址（相对路径，由前端拼同源前缀）。音质探测读每个文件前 64KB，
 * 跳过无法读取的文件（不计入 skipped 计数也不中断扫描）。
 */
export function scanLibrary(rootDir, onProgress) {
  const tracks = [];
  const state = { stopped: false };
  const walk = (dir, depth) => {
    if (state.stopped) return;
    if (depth > SCAN_MAX_DEPTH) return;
    if (tracks.length >= SCAN_MAX_TRACKS) return;
    let entries = [];
    try { entries = listEntries(dir); } catch { return; }
    for (const ent of entries) {
      if (state.stopped) return;
      if (tracks.length >= SCAN_MAX_TRACKS) return;
      const abs = join(dir, ent.name);
      if (ent.isDir) { walk(abs, depth + 1); continue; }
      if (!isAudioName(ent.name)) continue;
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (!st.isFile()) continue;
      let quality = "";
      try {
        const fd = readFileSync(abs, { start: 0, end: AUDIO_HEADER_LEN - 1 });
        quality = audioQualityLabel(parseAudioMeta(fd, st.size));
      } catch { /* 读不了头：质量标签留空，仍允许播放（扩展名已知） */ }
      const ext = extname(ent.name).slice(1).toLowerCase();
      tracks.push({
        id: trackId(abs),
        name: basename(ent.name),
        path: abs,
        size: st.size,
        ext,
        quality,
        url: "dsh-music/stream/" + trackId(abs),
      });
      if (typeof onProgress === "function") onProgress(tracks.length);
    }
  };
  walk(rootDir, 0);
  return { tracks, stopped: state.stopped };
}
