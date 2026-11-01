// qr.js —— 零依赖二维码渲染器：字符串 → PNG(可直接扫) / ASCII(终端看)
//
// 为什么自己写:微信 iLink 的 qrcode_img_content 是一个 URL(不是图片),
// 得由客户端渲染成二维码。为了不给插件拖依赖,这里自带一个最小实现:
//   · 字节模式(byte mode)、纠错等级 M、版本 1~10 自动选
//   · PNG 输出用 node:zlib 手写(IDAT 非压缩 deflate 存储块),不依赖任何库
//
// 输出质量按「手机扫得动」来要求:每模块 8px、四周留 4 模块静默区。
import { deflateSync } from 'node:zlib'

// ── GF(256) 伽罗华域表(QR 纠错用) ──
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

/** 生成 RS 纠错码字 */
function rsGenerator(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= mul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen)
  const res = new Array(ecLen).fill(0)
  for (const byte of data) {
    const factor = byte ^ res[0]
    res.shift()
    res.push(0)
    for (let i = 0; i < ecLen; i++) res[i] ^= mul(gen[i + 1], factor)
  }
  return res
}

// ── 版本参数(纠错 M):[总码字, 数据码字, 每块EC码字, 第一组块数, 第二组块数] ──
// 数值取自 QR 规范 Table 9(EC level M),别凭记忆改:每块 EC 数错了会静默产出废码。
// 自检:总码字 == 数据码字 + 每块EC × (g1+g2);数据码字 + 每块EC×块数 ≤ 总码字。
const VERSIONS_M = {
  1: [26, 16, 10, 1, 0], 2: [44, 28, 16, 1, 0], 3: [70, 44, 26, 1, 0], 4: [100, 64, 18, 2, 0],
  5: [134, 86, 24, 2, 0], 6: [172, 108, 16, 4, 0], 7: [196, 124, 18, 4, 0], 8: [242, 154, 22, 2, 2],
  9: [292, 182, 22, 3, 2], 10: [346, 216, 26, 4, 1],
}
// 启动即校验参数自洽,错了宁可炸掉也不要产出扫不动的码
for (const [v, [total, dataCw, ec, g1, g2]] of Object.entries(VERSIONS_M)) {
  const blocks = g1 + g2
  if (dataCw + ec * blocks !== total) {
    throw new Error(`QR 版本表第 ${v} 版参数不自洽: ${dataCw} + ${ec}×${blocks} != ${total}`)
  }
}
const ALIGN_CENTERS = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
}

// ── 模式/容量 ──
const MODE_BYTE = 0b0100
function charCountBits(version) { return version < 10 ? 8 : 16 }
function dataCapacityBytes(version) {
  const [, dataCw] = VERSIONS_M[version]
  const cci = charCountBits(version)
  return Math.floor((dataCw * 8 - 4 - cci) / 8)
}
function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) if (dataCapacityBytes(v) >= byteLen) return v
  throw new Error(`内容太长(${byteLen} 字节),只支持到版本 10`)
}

// ── 位流 ──
class BitBuffer {
  constructor() { this.bits = [] }
  put(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1)
  }
  get length() { return this.bits.length }
  toBytes() {
    while (this.bits.length % 8 !== 0) this.bits.push(0)
    const out = new Uint8Array(this.bits.length / 8)
    for (let i = 0; i < out.length; i++) {
      let b = 0
      for (let j = 0; j < 8; j++) b = (b << 1) | this.bits[i * 8 + j]
      out[i] = b
    }
    return out
  }
}

/** 组装数据码字(含填充) */
function buildDataCodewords(bytes, version) {
  const [, dataCw] = VERSIONS_M[version]
  const buf = new BitBuffer()
  buf.put(MODE_BYTE, 4)
  buf.put(bytes.length, charCountBits(version))
  for (const b of bytes) buf.put(b, 8)
  const capacityBits = dataCw * 8
  // 终止符(最多 4 位)
  for (let i = 0; i < 4 && buf.length < capacityBits; i++) buf.put(0, 1)
  while (buf.length % 8 !== 0) buf.put(0, 1)
  const data = Array.from(buf.toBytes())
  // 填充码字
  const PAD = [0xec, 0x11]
  let p = 0
  while (data.length < dataCw) data.push(PAD[p++ % 2])
  return data
}

/** 分块 + 纠错 + 交错 */
function interleave(data, version) {
  const [totalCw, dataCw, ecPerBlock, g1, g2] = VERSIONS_M[version]
  if (data.length !== dataCw) throw new Error(`数据码字数不符: ${data.length} != ${dataCw}(v${version})`)
  // 块划分:第一组 g1 块(每块 shortLen),第二组 g2 块(每块 shortLen+1)
  const shortLen = Math.floor(dataCw / (g1 + g2))
  const longLen = shortLen + 1
  const longCount = dataCw - shortLen * (g1 + g2)   // 需要 +1 的块数,等于 g2(参数表已保证)
  if (longCount !== g2) throw new Error(`块划分参数不一致: longCount=${longCount} g2=${g2}(v${version})`)

  const blocks = []
  let offset = 0
  for (let i = 0; i < g1 + g2; i++) {
    // ⚠️ 规范 Table 9 的组序是「第一组(短块)在前,第二组(长块)在后」。
    //    这里曾经写成 i < g2 ? longLen : shortLen(长块在前)—— v1~v7 的 g2=0
    //    恰好掩盖了这个错误,到 v8/v9/v10(g2>0)就整块错位、扫不出来。
    const len = i < g1 ? shortLen : longLen
    const chunk = data.slice(offset, offset + len)
    offset += len
    blocks.push({ data: chunk, ec: rsEncode(chunk, ecPerBlock) })
  }
  if (offset !== dataCw) throw new Error(`分块吃掉了 ${offset} 个码字,应为 ${dataCw}`)

  // 交错:先按列取数据码字,再按列取纠错码字
  const out = []
  const maxData = Math.max(...blocks.map((b) => b.data.length))
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i])
  for (let i = 0; i < ecPerBlock; i++) for (const b of blocks) out.push(b.ec[i])
  if (out.length !== totalCw) throw new Error(`交错后码字数不符: ${out.length} != ${totalCw}(v${version})`)
  return out
}

// ── 矩阵 ──
function createMatrix(version) {
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => new Array(size).fill(null))
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (r, c, v) => { modules[r][c] = v; reserved[r][c] = true }
  /**
   * 定位图形(7x7) + 分隔符(四周 1 格白边)。
   * ⚠️ 这里必须严格按「7x7 + 分隔符」保留,不能整块按 9x9 圈地:
   *   9x9 会把格式信息所在的 row8 / col8 一起圈进来,数据区被多占 25 格,
   *   结果是 OpenCV 能定位却解不出数据(数据区整体错位)。v1-M 应为
   *   441 − 225 = 216 格 = 26 码字(208 位) + 8 剩余位。
   */
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6))
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4
        set(rr, cc, inRing || inCore)
      }
    }
  }
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0)
  // 定位图形(alignment)
  const centers = ALIGN_CENTERS[version]
  for (const r of centers) for (const c of centers) {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const isBorder = Math.abs(dr) === 2 || Math.abs(dc) === 2
      const isCenter = dr === 0 && dc === 0
      set(r + dr, c + dc, isBorder || isCenter)
    }
  }
  // 时序图形:(6,8) 起「黑、白」交替 —— i 为偶数时黑。
  // 已用真实二维码逐格验证过:row6 = 1111111 0 1 0 1 …(定位图形边框黑、分隔符白、时序列黑起)。
  // 这里曾经写成 i%2===1(整条反转),OpenCV 直接拒扫 —— 而自家解码器因为与编码器
  // 共享同一处错误,反而"验证通过",所以外部解码器才是硬标准。
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) set(6, i, i % 2 === 0)
    if (!reserved[i][6]) set(i, 6, i % 2 === 0)
  }
  // 格式信息占位(稍后填)。
  // 注意:i=6 那两格 (8,6) 与 (6,8) 属于时序图形,不是格式信息 —— 早期版本把它们
  // 一起填成白色,时序列被截断,OpenCV 之类的标准解码器会直接拒扫。
  for (let i = 0; i <= 8; i++) {
    if (i === 6) continue
    if (!reserved[8][i]) { modules[8][i] = false; reserved[8][i] = true }
    if (!reserved[i][8]) { modules[i][8] = false; reserved[i][8] = true }
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[8][size - 1 - i]) { modules[8][size - 1 - i] = false; reserved[8][size - 1 - i] = true }
    if (!reserved[size - 1 - i][8]) { modules[size - 1 - i][8] = false; reserved[size - 1 - i][8] = true }
  }
  modules[size - 8][8] = true; reserved[size - 8][8] = true
  // 版本信息(版本 >= 7)
  if (version >= 7) {
    const VERSION_INFO = {
      7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3,
    }
    const bits = VERSION_INFO[version]
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >> i) & 1) === 1
      const r = Math.floor(i / 3), c = i % 3
      modules[r][size - 11 + c] = bit; reserved[r][size - 11 + c] = true
      modules[size - 11 + c][r] = bit; reserved[size - 11 + c][r] = true
    }
  }
  return { size, modules, reserved }
}

/** 放置数据位(之字形,跳过时序列) */
function placeData(matrix, codewords) {
  const { size, modules, reserved } = matrix
  const bits = []
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push(((cw >> i) & 1) === 1)
  let idx = 0
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue
        modules[row][col] = idx < bits.length ? bits[idx++] : false
      }
    }
    upward = !upward
  }
}

/** 掩码(评分选最优) */
function applyMask(matrix, codewords, forceMask) {
  const { size, modules, reserved } = matrix
  const maskFns = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ]
  const ecLevelBits = 0b00 // M
  // 标准格式信息表(ISO/IEC 18004 Table 25)的 EC=M 行。
  // 自检:0x5412 是 M/mask0、0x5E7C 是 M/mask2 —— 这两条已由 OpenCV 实扫与真实二维码双重验证。
  const FORMAT_BITS = {
    0: 0x5412, 1: 0x5125, 2: 0x5e7c, 3: 0x5b4b,
    4: 0x45f9, 5: 0x40ce, 6: 0x4f97, 7: 0x4aa0,
  }
  /** 把格式信息写进「传入的矩阵」——注意必须写 target,不能写外层 modules。
   *  ⚠️ 调用时机:必须在**应用掩码之后**。格式信息属于功能图形,不参与掩码;
   *     早期版本先写格式位再套掩码,格式位被一起翻转,标准解码器读到的
   *     掩码编号与实际不符 → 能定位、解不出数据。 */
  const placeFormat = (target, mask) => {
    const bits = FORMAT_BITS[mask]
    const bit = (i) => ((bits >> i) & 1) === 1   // bit(i) = 第 i 位,i=0 为最低位
    // 副本1(绕左上定位图形的 L 形,15 格):
    //   (0,8)=bit0 向上到 (5,8)=bit5 → (7,8)=bit6 → (8,8)=bit7 → (8,7)=bit8
    //   → 再向左 (8,5)=bit9 … (8,0)=bit14
    // 注意 (6,8)/(8,6) 属时序图形,跳过。
    for (let i = 0; i <= 5; i++) target[i][8] = bit(i)
    target[7][8] = bit(6)
    target[8][8] = bit(7)
    target[8][7] = bit(8)
    for (let i = 9; i <= 14; i++) target[8][14 - i] = bit(i)
    // 副本2(右下行 8 格 + 右下列 7 格):
    //   (8,size-1)=bit0 向左到 (8,size-8)=bit7 → (size-7,8)=bit8 向下到 (size-1,8)=bit14
    // ⚠️ 副本2 与副本1 的走向不同,不能照抄。这里曾经把副本2 写成 bit14..bit0 降序,
    //     结果:副本1 正确、副本2 全错。自家解码器只读副本1 所以"验证通过",
    //     而标准解码器会拿两份副本交叉校验 → 一律拒扫。已由 OpenCV 编码器与
    //     真实可扫二维码两份独立参照反推确认。
    for (let i = 0; i <= 7; i++) target[8][size - 1 - i] = bit(i)
    for (let i = 8; i <= 14; i++) target[size - 15 + i][8] = bit(i)
    target[size - 8][8] = true
  }
  void ecLevelBits

  const score = (m) => {
    // 简化评分:连续同色 + 2x2 同色块(够用即可,不追求最优)
    let s = 0
    for (let r = 0; r < size; r++) {
      let run = 1
      for (let c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) { run++; if (run === 5) s += 3; else if (run > 5) s += 1 }
        else run = 1
      }
    }
    for (let c = 0; c < size; c++) {
      let run = 1
      for (let r = 1; r < size; r++) {
        if (m[r][c] === m[r - 1][c]) { run++; if (run === 5) s += 3; else if (run > 5) s += 1 }
        else run = 1
      }
    }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
      const v = m[r][c]
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) s += 3
    }
    return s
  }

  // 逐个掩码试:对「候选副本」应用掩码 + 写入格式信息,再评分,取最优。
  // (这里曾经把格式信息写到外层 modules,导致候选与真矩阵互相污染 —— 短码侥幸能扫,
  //  长码直接扫不出来。修法:一切都在候选矩阵上完成。)
  const build = (mask) => {
    const candidate = modules.map((row) => row.slice())
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && maskFns[mask](r, c)) candidate[r][c] = !candidate[r][c]
    }
    placeFormat(candidate, mask)
    return candidate
  }
  // forceMask:仅测试用 —— 与参照实现(如 OpenCV)对同一掩码逐格比对时,需要禁用自动选优。
  let chosen
  if (forceMask !== undefined) {
    chosen = forceMask
  } else {
    let best = null
    for (let mask = 0; mask < 8; mask++) {
      const s = score(build(mask))
      if (!best || s < best.score) best = { mask, score: s }
    }
    chosen = best.mask
  }
  const finalMatrix = build(chosen)
  for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) { modules[i][j] = finalMatrix[i][j] }
  void codewords
  return chosen
}

/** 文本 → 布尔矩阵(版本、尺寸)。options.forceMask 仅供与参照实现对拍时使用。 */
export function encodeMatrix(text, options = {}) {
  const bytes = Array.from(new TextEncoder().encode(text))
  const version = pickVersion(bytes.length)
  const data = buildDataCodewords(bytes, version)
  const codewords = interleave(data, version)
  const matrix = createMatrix(version)
  placeData(matrix, codewords)
  const mask = applyMask(matrix, codewords, options.forceMask)
  return {
    version,
    size: matrix.size,
    modules: matrix.modules.map((row) => row.map((v) => v === true)),
    reserved: matrix.reserved.map((row) => row.map((v) => v === true)),
    codewords,
    mask,
  }
}

// ── 输出:PNG ──
function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
/** 手写 PNG:8 位灰度、无压缩存储块(deflate stored),不依赖 zlib 压缩 */
function pngFromPixels(width, height, pixels) {
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0 // filter: none
    for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = pixels[y * width + x]
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 0   // grayscale
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    // level 9 而不是 0:二维码是大片纯白 + 硬边,压缩率极高(867KB → 几 KB)。
    // 不压的话图太大,发到 QQ/微信里更容易被平台二次压缩糊掉,而且传得慢。
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 二维码 → PNG Buffer(白底黑块,四周静默区) */
export function toPng(text, { scale = 8, quiet = 4 } = {}) {
  const { size, modules } = encodeMatrix(text)
  const dim = (size + quiet * 2) * scale
  const px = Buffer.alloc(dim * dim, 0xff)
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules[r][c]) continue
      for (let dy = 0; dy < scale; dy++) {
        const y = (r + quiet) * scale + dy
        const base = y * dim + (c + quiet) * scale
        px.fill(0x00, base, base + scale)
      }
    }
  }
  return pngFromPixels(dim, dim, px)
}

/** 二维码 → ASCII(半块字符,终端/日志里直接看) */
export function toAscii(text, { quiet = 2 } = {}) {
  const { size, modules } = encodeMatrix(text)
  const get = (r, c) => {
    const rr = r - quiet, cc = c - quiet
    if (rr < 0 || cc < 0 || rr >= size || cc >= size) return false
    return modules[rr][cc]
  }
  const lines = []
  for (let r = 0; r < size + quiet * 2; r += 2) {
    let line = ''
    for (let c = 0; c < size + quiet * 2; c++) {
      const top = get(r, c), bottom = get(r + 1, c)
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines.join('\n')
}
