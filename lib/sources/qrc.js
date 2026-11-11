/**
 * lib/qrc.js — QQ 音乐逐字歌词（QRC）解密与解析。
 *
 * QRC 是 QQ 客户端渲染卡拉OK歌词用的私有格式：GetPlayLyricInfo 接口返回的
 * `data.lyric` 是一串 hex 编码的密文，解链路为：
 *
 *   hex → 按 8 字节块跑「D(K3) → E(K2) → D(K1)」三重分组加密（ECB）
 *       → zlib inflate → 去 UTF-8 BOM → 明文（XML 包裹的 QRC 文本）
 *       → 逐行解析出 [{ startMs, durMs, text, words:[{text,startMs,durMs}] }]
 *
 * 密码学要点（从公开互操作实现归纳出的算法规格，实现为本项目自有代码）：
 *  - 三把固定 8 字节密钥：K1="!@#)(*$%" K2="123ZXC!@" K3="!@#)(NHL"；
 *  - 分组算法是 DES 家族的变体：轮函数/扩展盒/P 盒/S 盒均为标准 DES 数值，
 *    差异在于①密钥位按「两个小端 32 位字拼接」的非常规顺序读取；②PC-2 压缩
 *    置换的表是 0 基索引、且 D 半段消费时用 pos-27 而非 pos-28；③块置换 IP /
 *    FP 使用同一非常规位序下的专用规则表。本文实现严格按上述语义复刻。
 *  - 每字节最低位作为奇偶校验位被忽略（标准 DES 约定），实际密钥仅 56 位。
 *
 * ⚠️ 合规：该代码仅为让本地播放器解析用户有权访问的歌词数据（个人试听/学习），
 *    与 lib/qq.js 同属非官方接口对接，失败一律静默回退，不做二次分发服务。
 */

import { inflateSync, deflateSync } from 'node:zlib'

// ---------------------------------------------------------------------
// 固定常量（QQ 音乐 QRC 算法的公开事实数据）
// ---------------------------------------------------------------------

const KEY_K1 = Buffer.from('!@#)(*$%', 'utf8')
const KEY_K2 = Buffer.from('123ZXC!@', 'utf8')
const KEY_K3 = Buffer.from('!@#)(NHL', 'utf8')

// 标准 DES S 盒（行优先展平为 64 项：index = row*16 + col）。
const SBOXES = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
    0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
    15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
    3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
    13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
    13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
    1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
    13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
    3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
  ],  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
    14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
    11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
    10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
    4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
    13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
    6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
    1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
    2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
  ],
]

// 标准 DES 扩展盒 E（1 基位号）与 P 盒。
const E_TABLE = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9,
  8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
  24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
]
const P_TABLE = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
]

// PC-1 两半（1 基，针对该算法自己的 64 位虚拟位空间）。
const PC1_C = [56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35]
const PC1_D = [62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3]
// 轮内循环左移量（标准 DES 节奏）。
const SHIFT_SCHEDULE = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]
// PC-2（0 基！consumption: pos<28 读 C 半段第 31-pos 位；pos≥28 读 D 半段第 31-(pos-27) 位）。
const PC2_ZERO_BASED = [
  13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3, 25, 7, 15, 6, 26,
  19, 12, 1, 40, 51, 30, 36, 46, 54, 29, 39, 50, 44, 32, 47, 43, 48, 38, 55, 33,
  52, 45, 41, 49, 35, 28, 31,
]
// 块初始/逆初始置换规则（1 基，作用于按大端拼装的 64 位块位空间）。
const BLOCK_IP = [
  34, 42, 50, 58, 2, 10, 18, 26, 36, 44, 52, 60, 4, 12, 20, 28,
  38, 46, 54, 62, 6, 14, 22, 30, 40, 48, 56, 64, 8, 16, 24, 32,
  33, 41, 49, 57, 1, 9, 17, 25, 35, 43, 51, 59, 3, 11, 19, 27,
  37, 45, 53, 61, 5, 13, 21, 29, 39, 47, 55, 63, 7, 15, 23, 31,
]
const BLOCK_INV_IP = [
  37, 5, 45, 13, 53, 21, 61, 29, 38, 6, 46, 14, 54, 22, 62, 30,
  39, 7, 47, 15, 55, 23, 63, 31, 40, 8, 48, 16, 56, 24, 64, 32,
  33, 1, 41, 9, 49, 17, 57, 25, 34, 2, 42, 10, 50, 18, 58, 26,
  35, 3, 43, 11, 51, 19, 59, 27, 36, 4, 44, 12, 52, 20, 60, 28,
]

// ---------------------------------------------------------------------
// S×P 合并查表：SP[g][sixBits] = P(SBOX[g][sixBits] 左移到半字位置) —— 一次查出省两步。
// 构建方式与语义：S 输出 4bit 放到该盒对应的 32 位半字槽位（slot g 从高位起），
// 再按 P 表做位重排。注意本项目实现直接生成组合表，而非分步应用。
// ---------------------------------------------------------------------

// 对 32 位值做 P 盒：输出第 i 位 = 输入第 P_TABLE[i] 位（均以 MSB 为第 1 位计）。
function applyP(input) {
  let out = 0
  for (let i = 0; i < 32; i++) {
    const srcMask = 1 << (32 - P_TABLE[i])
    if ((input & srcMask) !== 0) out |= 1 << (31 - i)
  }
  return out >>> 0
}

const SP = (() => {
  const tbl = []
  for (let g = 0; g < 8; g++) {
    const per = new Int32Array(64)
    for (let six = 0; six < 64; six++) {
      // 行列抽取约定：bit5 与 bit0 组成 2 位行号，中间 4 位为列号。
      const row = ((six & 0x20) >>> 4) | (six & 1)
      const col = (six >>> 1) & 0xf
      const four = SBOXES[g][row * 16 + col]
      per[six] = applyP(four << (28 - g * 4))
    }
    tbl.push(per)
  }
  return tbl
})()

// ---------------------------------------------------------------------
// 轮密钥。每轮 48 位子密钥拆成 { hi, lo } 两个 24 位整数（分别异或到扩展后的
// 高/低 24 位上）。mode='e' 子密钥按轮次正序存放；mode='d' 反序存放——这正是
/// 「加密方向 / 解密方向」两种密钥编排的全部差异。
// ---------------------------------------------------------------------

// 该算法把 8 字节密钥视作两个独立的小端 32 位字拼接成的虚拟位串：
// 虚拟位 pos → 字 index=pos>>5；字内 bitInWord=pos&31 →
// 字节 index = word*4 + 3 - (bitInWord>>3)，位 = 7 - (bitInWord&7)。
function keyVirtualBit(key, pos) {
  const wordIndex = pos >>> 5
  const bitInWord = pos & 31
  const byteInWord = bitInWord >>> 3
  const bitInByte = bitInWord & 7
  return (key[wordIndex * 4 + 3 - byteInWord] >>> (7 - bitInByte)) & 1
}

// 28 位寄存器存放在 32 位整数的 31..4 位（低 4 位恒 0），循环左移在此基础上进行。
function rot28(v, sh) {
  const m = v & 0xfffffff0
  return (((m << sh) | (m >>> (28 - sh))) & 0xfffffff0) >>> 0
}

// 取寄存器中「逻辑位 idx」：idx=0 对应 31 位（最高有效位）。
function regBit(reg, idx) {
  return (reg >>> (31 - idx)) & 1
}

export function makeRoundKeys(key8, mode) {
  if (!(key8 instanceof Uint8Array) || key8.length !== 8) throw new Error('qrc: key must be 8 bytes')
  const dir = mode === 'd' ? 'd' : 'e'
  // PC-1 两半 → 虚拟位空间的取法与上面的 keyVirtualBit 相同（pos 即表值）。
  let c = 0
  let d = 0
  let cmask = 1 << (PC1_C.length - 1)
  let dmask = 1 << (PC1_D.length - 1)
  for (let i = 0; i < PC1_C.length; i++) {
    if (keyVirtualBit(key8, PC1_C[i])) c |= cmask
    if (keyVirtualBit(key8, PC1_D[i])) d |= dmask
    cmask >>>= 1
    dmask >>>= 1
  }
  // 把 28 位结果挪到 31..4 的高对齐位置（rot28 的输入要求）。
  c = (c << 4) >>> 0
  d = (d << 4) >>> 0
  const keys = new Array(16)
  for (let round = 0; round < 16; round++) {
    c = rot28(c, SHIFT_SCHEDULE[round])
    d = rot28(d, SHIFT_SCHEDULE[round])
    const slot = dir === 'd' ? 15 - round : round
    let hi = 0
    let lo = 0
    for (let k = 0; k < 48; k++) {
      const p = PC2_ZERO_BASED[k]
      // 双怪癖之二：0 基压缩表，且表值直接作为「寄存器逻辑位号」消费——
      // C 半段读第 31-p 位；D 半段跳过间隔读第 31-(p-27) 位（不是标准的 p-28）。
      const bit = p < 28
        ? ((c >>> (31 - p)) & 1)
        : ((d >>> (31 - (p - 27))) & 1)
      if (bit) {
        if (k < 24) hi |= 1 << (23 - k)
        else lo |= 1 << (47 - k)
      }
    }
    keys[slot] = { hi: hi >>> 0, lo: lo >>> 0 }
  }
  return keys
}

// ---------------------------------------------------------------------
// 单块加/解密（ECB 一个 8 字节块）。in/out 均为长度 ≥8 的视图。
// ---------------------------------------------------------------------

function blockBitOf64(hi, lo, oneBasedIdx) {
  // 1 基位号：1..32 在 hi，33..64 在 lo（MSB-first）。
  return oneBasedIdx <= 32 ? ((hi >>> (32 - oneBasedIdx)) & 1) : ((lo >>> (64 - oneBasedIdx)) & 1)
}

// 轮函数：E 扩展 → 与子密钥异或 → 8×S 合并查表（P 已并入）。
function fF(r32, sk) {
  // E 扩展（1 基表值 → 32 位寄存器位）。
  let exHi = 0
  let exLo = 0
  let hmask = 1 << 23
  let lmask = 1 << 23
  for (let i = 0; i < 24; i++) {
    if ((r32 >>> (32 - E_TABLE[i])) & 1) exHi |= hmask
    if ((r32 >>> (32 - E_TABLE[i + 24])) & 1) exLo |= lmask
    hmask >>>= 1
    lmask >>>= 1
  }
  exHi = (exHi ^ sk.hi) >>> 0
  exLo = (exLo ^ sk.lo) >>> 0
  return (
    SP[0][(exHi >>> 18) & 0x3f] |
    SP[1][(exHi >>> 12) & 0x3f] |
    SP[2][(exHi >>> 6) & 0x3f] |
    SP[3][exHi & 0x3f] |
    SP[4][(exLo >>> 18) & 0x3f] |
    SP[5][(exLo >>> 12) & 0x3f] |
    SP[6][(exLo >>> 6) & 0x3f] |
    SP[7][exLo & 0x3f]
  ) >>> 0
}

export function cryptBlock(input, out, keys) {
  // 组装大端 64 位块的两个 32 位半字。
  let hi = 0
  let lo = 0
  for (let i = 0; i < 4; i++) hi = ((hi << 8) | input[i]) >>> 0
  for (let i = 4; i < 8; i++) lo = ((lo << 8) | input[i]) >>> 0

  // 初始置换。
  let L = 0
  let R = 0
  let lmask = 1 << 31
  let rmask = 1 << 31
  for (let i = 0; i < 64; i++) {
    if (blockBitOf64(hi, lo, BLOCK_IP[i])) {
      if (i < 32) L |= lmask
      else R |= rmask
    }
    if (i === 31) lmask = rmask = 1 << 31
    else {
      lmask >>>= 1
      rmask >>>= 1
    }
  }

  // 16 轮 Feistel：前 15 轮显式交换，第 16 轮只异或不交换。
  for (let r = 0; r < 15; r++) {
    const tmp = R
    R = (L ^ fF(R, keys[r])) >>> 0
    L = tmp
  }
  L = (L ^ fF(R, keys[15])) >>> 0

  // 逆初始置换后按 (L, R) 大端写出。
  let oh = 0
  let ol = 0
  lmask = 1 << 31
  rmask = 1 << 31
  for (let i = 0; i < 64; i++) {
    const src = blockBitOf64(L, R, BLOCK_INV_IP[i])
    if (src) {
      if (i < 32) oh |= lmask
      else ol |= rmask
    }
    if (i === 31) lmask = rmask = 1 << 31
    else {
      lmask >>>= 1
      rmask >>>= 1
    }
  }
  out[0] = (oh >>> 24) & 0xff
  out[1] = (oh >>> 16) & 0xff
  out[2] = (oh >>> 8) & 0xff
  out[3] = oh & 0xff
  out[4] = (ol >>> 24) & 0xff
  out[5] = (ol >>> 16) & 0xff
  out[6] = (ol >>> 8) & 0xff
  out[7] = ol & 0xff
}

/** 解密一组 hex 密文（QQ音乐 GetPlayLyricInfo data.lyric 原样字符串）→ QRC 明文。 */
export function decryptHex(hexStr) {
  if (typeof hexStr !== 'string' || hexStr.trim() === '') throw new Error('qrc: empty cipher')
  const enc = Buffer.from(hexStr, 'hex')
  if (enc.length === 0 || enc.length % 8 !== 0) throw new Error(`qrc: cipher length ${enc.length} not multiple of 8`)
  // 解密方向固定：D(K3) → E(K2) → D(K1)。
  const ks3 = makeRoundKeys(KEY_K3, 'd')
  const ks2 = makeRoundKeys(KEY_K2, 'e')
  const ks1 = makeRoundKeys(KEY_K1, 'd')
  const dec = Buffer.alloc(enc.length)
  const t1 = Buffer.alloc(8)
  const t2 = Buffer.alloc(8)
  for (let off = 0; off < enc.length; off += 8) {
    cryptBlock(enc.subarray(off, off + 8), t1, ks3)
    cryptBlock(t1, t2, ks2)
    cryptBlock(t2, dec.subarray(off, off + 8), ks1)
  }
  let plain = inflateSync(dec)
  if (plain.length >= 3 && plain[0] === 0xef && plain[1] === 0xbb && plain[2] === 0xbf) plain = plain.subarray(3)
  return plain.toString('utf8')
}

/**
 * 加密（decryptHex 的逆过程）：明文 UTF-8 → zlib deflate → 零填充到 8 字节倍数
 * → 每块跑 E(K1) → D(K2) → E(K3)。仅用于自测回环与协议理解，线上只消费密文。
 * @returns {string} hex 密文
 */
export function encryptHex(text) {
  const raw = Buffer.from(String(text ?? ''), 'utf8')
  const compressed = deflateSync(raw)
  const paddedLen = Math.ceil(compressed.length / 8) * 8
  const padded = Buffer.alloc(paddedLen) // 零填充
  compressed.copy(padded)
  const ek1 = makeRoundKeys(KEY_K1, 'e')
  const dk2 = makeRoundKeys(KEY_K2, 'd')
  const ek3 = makeRoundKeys(KEY_K3, 'e')
  const out = Buffer.alloc(paddedLen)
  const t1 = Buffer.alloc(8)
  const t2 = Buffer.alloc(8)
  for (let off = 0; off < paddedLen; off += 8) {
    cryptBlock(padded.subarray(off, off + 8), t1, ek1)
    cryptBlock(t1, t2, dk2)
    cryptBlock(t2, out.subarray(off, off + 8), ek3)
  }
  return out.toString('hex')
}

// ---------------------------------------------------------------------
// QRC 明文解析：每行形如 [起始ms,时长ms]词(词起始ms,词时长ms)词(...)
// 元数据行（[ar:] 等）与 XML 包裹行跳过。空文本/无逐词标记的行忽略。
// ---------------------------------------------------------------------

const LINE_RE = /^\[(\d+),(\d+)\](.*)$/
const WORD_RE = /\((\d+),(\d+)\)/g

/**
 * 解析 QRC 明文 → 行数组 [{ startMs, durMs, text, words:[{ text, startMs, durMs }] }]。
 * text 已去掉逐词时间标记；words 为空数组时表示该行无可用的逐字时间轴（调用方可回退整行扫色）。
 */
export function parseQrc(text) {
  const out = []
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    const m = LINE_RE.exec(line)
    if (!m) continue // XML 头/[ar:] 元数据/其它包裹行
    const startMs = Number(m[1])
    const durMs = Number(m[2])
    if (!Number.isFinite(startMs) || !Number.isFinite(durMs)) continue
    const content = m[3]
    const words = []
    let plainText = ''
    let cursor = 0
    WORD_RE.lastIndex = 0
    let w
    while ((w = WORD_RE.exec(content)) !== null) {
      // QRC 词序约定：时间标记跟在它所标注的文本段之后。
      const textBefore = content.slice(cursor, w.index)
      plainText += textBefore
      words.push({ text: textBefore, startMs: Number(w[1]), durMs: Number(w[2]) })
      cursor = w.index + w[0].length
    }
    plainText += content.slice(cursor)
    const t = plainText.replace(/\u0000/g, '').trim()
    if (t === '') continue
    out.push({ startMs, durMs: Math.max(0, durMs), text: t, words })
  }
  return out
}
