/**
 * lib/krc.js — 酷狗逐字歌词（KRC）解密与解析。
 *
 * 与 lib/qrc.js（QQ QRC：hex 密文 + 3DES + zlib + XML）同层级，产出对齐：
 * 解析结果为 [{ t, end, text }]（秒时基、含行结束时间的精确行窗口），可直接喂给
 * 客户端现有的整行扫色逻辑；词级时间轴保留在 words 字段备用。
 *
 * KRC 格式（实测验证，参考 shansing.com/read/392 与 lx-music-api-server）：
 *   - 下载 content 为 base64；解码后头 4 字节为 "krc1" 魔数；
 *   - 其后字节与 16 字节密钥循环异或，再 zlib inflate 得 UTF-8 文本；
 *   - 文本每行：[起始ms,持续ms]<行内偏移ms,词长ms,_>字<…>字… （LRC-like 非纯 XML）
 *   - 头部元数据 [ti:][ar:][al:][offset:] 等；[language:<base64 JSON>] 内嵌翻译(1)/罗马音(0)
 *
 * ⚠️ 合规：歌词版权归著作权人及酷狗平台所有，仅个人试听使用。
 */

import zlib from 'node:zlib'

// KRC 循环异或密钥（多语言开源实现一致：0x40 47 61 77 5E 32 74 47 51 36 31 2D CE D2 6E 69）
const KRC_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105]

/**
 * 解密 KRC 内容。入参 base64 字符串或 Buffer/Uint8Array。
 * 成功返回 UTF-8 明文（含 [ti:] 元数据与逐字时间轴）；失败返回空串。
 */
export function decryptKrc(content) {
  let bytes = null
  try {
    if (typeof content === 'string') bytes = Buffer.from(content, 'base64')
    else if (content instanceof Uint8Array || Buffer.isBuffer(content)) bytes = Buffer.from(content)
  } catch { return '' }
  if (!bytes || bytes.length <= 4) return ''
  const body = bytes.subarray(4) // 跳过 "krc1" 头
  const out = Buffer.alloc(body.length)
  for (let i = 0; i < body.length; i++) out[i] = body[i] ^ KRC_KEY[i % KRC_KEY.length]
  try {
    return zlib.inflateSync(out).toString('utf8')
  } catch {
    // 少量响应可能是未加密直接 deflate/base64 的兜底路径
    try { return zlib.inflateRawSync(out).toString('utf8') } catch { return '' }
  }
}

// 唱完后再让高亮保持一小会的自然尾巴（与 qrc.js 同值，保持两来源行为一致）
const VOCAL_TAIL_MS = 400

// 行结构：`[start,dur]…词条若干`
const LINE_RE = /^\[(\d+),(\d+)\](.*)$/
// 词标签：`<offset,dur[,extra]>text…`
const WORD_RE = /<(\d+),(\d+)(?:,(\d+))?>/g

/** 解析单个词条序列。<off,dur>token……返回 words 与整行文本。 */
function parseWords(rest) {
  const matches = []
  WORD_RE.lastIndex = 0
  let m
  while ((m = WORD_RE.exec(rest)) !== null) {
    matches.push({ m, textStart: m.index + m[0].length })
  }
  const words = []
  let text = ''
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]
    const nextStart = i + 1 < matches.length ? matches[i + 1].m.index : rest.length
    const wText = rest.slice(cur.textStart, nextStart).replace(/\\r/g, '')
    const offMs = Number(cur.m[1]) || 0
    const durMs = Number(cur.m[2]) || 0
    if (wText !== '') words.push({ startMs: offMs, durMs, text: wText })
    text += wText
  }
  return { words, text }
}

/** 从解出的 KRC 明文头部提取元数据（ti/ar/al/by/offset/hash…）。 */
function parseMeta(text) {
  const meta = {}
  for (const m of text.matchAll(/^\[([A-Za-z#]+):([^\]]*)\]\r?$/gm)) {
    meta[m[1].toLowerCase()] = (m[2] || '').trim()
  }
  return meta
}

/**
 * 解析 [language:<base64 JSON>] 标签 —— 翻译(type 1)/罗马音(type 0)内嵌其中。
 * 返回数组按 krc 行序对齐：第 i 个元素是第 i 行歌词的翻译文本（无则空串）。
 * 结构与行数并非总是严格 1:1（逐词拆分），尽力按时间轴对齐，失败返回 []。
 */
export function parseLanguageTag(jsonObj) {
  if (!jsonObj || !Array.isArray(jsonObj.content)) return []
  const outTypeMap = { 1: [], 0: [] } // type -> 依次出现的各行文本
  for (const item of jsonObj.content) {
    const type = Number(item && item.type)
    const rows = item && Array.isArray(item.lyricContent) ? item.lyricContent : null
    if (!rows) continue
    const list = outTypeMap[type === 1 ? 1 : type === 0 ? 0 : 0]
    for (const row of rows) {
      if (Array.isArray(row)) list.push(row.join('').trim())
      else if (typeof row === 'string') list.push(row.trim())
      else if (row && typeof row.words === 'string') list.push(row.words.trim())
      else list.push('')
    }
  }
  return outTypeMap[1] // 只取翻译行序（罗马音暂不下发）
}

/** 把翻译行序对齐到解析出的时间轴行（长度一致才采纳；否则返回 []）。 */
function alignTranslations(transList, lineCount) {
  if (!transList || transList.length !== lineCount) return null
  return transList
}

/**
 * 主入口：解密后的 KRC 明文 → { lines, translations, meta, wordLevel }。
 * lines 形状与 qrc.js 对齐：[{ t, end, text }]（t/end 秒时基）。
 * 可从同一明文反复调用的纯函数，方便测试。
 */
export function parseKrc(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  let languageObj = null
  const lines = []
  const rawLines = text.split('\n')

  for (const raw of rawLines) {
    const line = raw.replace(/\r$/, '').trim()
    if (line === '') continue
    if (/^\[[A-Za-z#]+:/i.test(line)) {
      const mm = /^\[language:([^\]]*)\]/i.exec(line)
      if (mm && !languageObj) {
        try {
          const json = Buffer.from(mm[1], 'base64').toString('utf8')
          languageObj = JSON.parse(json)
        } catch { /* 忽略坏 translation 包 */ }
      }
      continue // 其余 [key:value] 元数据不进 lines
    }
    const lm = LINE_RE.exec(line)
    if (!lm) continue
    const startMs = Number(lm[1]) || 0
    const durMs = Number(lm[2]) || 0
    const { words, text: lineText } = parseWords(lm[3])
    if (lineText.replace(/\u30fb/g, '') === '') continue // 全间隔符整行丢弃

    // 与 qrc.js 一致的窗口收敛：KRC 行时长偶见把间奏摊平，以最后一个词的结束时刻收紧
    // （words 的 startMs 是行内相对偏移，需加上行起点再与绝对窗口比较）
    let endMs = startMs + durMs
    if (words.length > 0) {
      const relEndMax = Math.max(...words.map((w) => w.startMs + w.durMs))
      const absEnd = startMs + relEndMax
      if (absEnd > startMs && absEnd <= startMs + Math.max(durMs, 1)) {
        endMs = Math.min(endMs, Math.max(startMs + 600, absEnd + VOCAL_TAIL_MS))
      }
    }
    lines.push({
      t: startMs / 1000,
      end: endMs / 1000,
      text: lineText,
      ...(words.length > 0 ? { words: words.map((w) => ({ t: (startMs + w.startMs) / 1000, end: (startMs + w.startMs + w.durMs) / 1000, text: w.text })) } : {}),
    })
  }

  const meta = parseMeta(text)
  const transRows = languageObj ? parseLanguageTag(languageObj) : null
  // 时间偏移修正（KRC offset 单位 ms，正值整体后移语义与其余实现一致地应用到 t/end）
  const offset = Math.round(Number(meta.offset) || 0)
  if (offset !== 0) {
    for (const l of lines) { l.t += offset / 1000; l.end += offset / 1000 }
  }

  return {
    lines,
    translations: lines.length > 0 ? alignTranslations(transRows, lines.length) : null,
    meta,
    wordLevel: lines.some((l) => Array.isArray(l.words)),
  }
}

/**
 * 「搜索候选 → 最佳 ID」打分：优先 krctype===1（确有逐字数据），再按时长接近
 * （±3s 满分递减），标题包含次之。供 getKrcWordLines 与测试共用。
 */
export function pickLyricCandidate(candidates, want = {}) {
  const wantDur = Math.round(Number(want.durationSec) * 1000) || 0
  const wt = String(want.title || '').toLowerCase().replace(/\s+/g, '')
  let best = null, bestScore = -Infinity
  for (const c of candidates || []) {
    if (!c || !c.id || !c.accesskey) continue
    let score = 0
    if (Number(c.krctype) === 1) score += 40
    const dur = Number(c.duration) || 0
    if (wantDur > 0 && dur > 0) {
      const d = Math.abs(dur - wantDur)
      if (d <= 3000) score += 35
      else if (d <= 10000) score += 18
      else if (d <= 30000) score += 6
      else score -= 10
    }
    const name = `${c.song || ''}${c.singer || ''}`.toLowerCase()
    if (wt && name && (name.includes(wt) || wt.includes(String(c.song || '').toLowerCase().replace(/\s+/g, '')))) score += 15
    if (score > bestScore) { bestScore = score; best = c }
  }
  return best
}
