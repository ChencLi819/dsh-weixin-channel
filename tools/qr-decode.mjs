// qr-decode.mjs —— 独立解码器:从矩阵把文本读回来(自带 RS 纠错,能报告纠正了几个错误)。
// 用途:验证编码器;也给以后排查「扫码扫不动」留一个本地判定手段。
import { encodeMatrix } from '../lib/qr.js'

const VERSIONS_M = {
  1: [26, 16, 10, 1, 0], 2: [44, 28, 16, 1, 0], 3: [70, 44, 26, 1, 0], 4: [100, 64, 18, 2, 0],
  5: [134, 86, 24, 2, 0], 6: [172, 108, 16, 4, 0], 7: [196, 124, 18, 4, 0], 8: [242, 154, 22, 2, 2],
  9: [292, 182, 22, 3, 2], 10: [346, 216, 26, 4, 1],
}

// ── GF(256) ──
const EXP = new Uint8Array(512), LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])
const inv = (a) => EXP[255 - LOG[a]]

/** 伯利坎普-梅西:求错误位置多项式 */
function berlekampMassey(syndromes) {
  let errLoc = [1], oldLoc = [1]
  for (let i = 0; i < syndromes.length; i++) {
    let delta = syndromes[i]
    for (let j = 1; j < errLoc.length; j++) delta ^= mul(errLoc[errLoc.length - 1 - j], syndromes[i - j])
    oldLoc.push(0)
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const next = oldLoc.map((v) => mul(v, delta))
        oldLoc = errLoc.map((v) => mul(v, inv(delta)))
        errLoc = next
      }
      for (let j = 0; j < oldLoc.length; j++) errLoc[errLoc.length - 1 - j] ^= mul(oldLoc[oldLoc.length - 1 - j], delta)
    }
  }
  return errLoc
}
/** 钱搜索:找错误位置 */
function findErrors(errLoc, count) {
  const positions = []
  for (let i = 0; i < count; i++) {
    let sum = 0
    for (let j = 0; j < errLoc.length; j++) sum ^= mul(errLoc[j], EXP[(i * j) % 255])
    if (sum === 0) positions.push(count - 1 - i)
  }
  return positions.reverse()
}
/**
 * RS 纠错(完整实现):BM 求错误位置多项式 → Chien 找位置 → Forney 算错误值。
 * 注意:综合征全零时必须原样返回 data 部分,别做任何"重建"——早期版本在这里
 * 把纠错码字当数据拼回去,产出「前半对、后半乱」的假结果,极难排查。
 */
function rsCorrect(codeword, ecLen) {
  const n = codeword.length
  const syndromes = []
  for (let i = 0; i < ecLen; i++) {
    let s = 0
    for (const c of codeword) s = mul(s, EXP[i]) ^ c
    syndromes.push(s)
  }
  if (syndromes.every((s) => s === 0)) return { data: codeword.slice(0, n - ecLen), corrected: 0 }

  // ── BM:求错误位置多项式 Λ(x) ──
  let lambda = [1]
  let prev = [1]
  let L = 0
  let m = 1
  let b = 1
  for (let k = 0; k < ecLen; k++) {
    let delta = syndromes[k]
    for (let i = 1; i <= L; i++) delta ^= mul(lambda[i], syndromes[k - i])
    if (delta === 0) { m++ }
    else if (2 * L <= k) {
      const next = lambda.slice()
      const scale = mul(delta, inv(b))
      for (let i = 0; i < prev.length; i++) {
        const idx = i + m
        next[idx] = (next[idx] ?? 0) ^ mul(scale, prev[i])
      }
      prev = lambda.slice()
      lambda = next
      L = k + 1 - L
      b = delta
      m = 1
    }
    else {
      const scale = mul(delta, inv(b))
      for (let i = 0; i < prev.length; i++) {
        const idx = i + m
        lambda[idx] = (lambda[idx] ?? 0) ^ mul(scale, prev[i])
      }
      m++
    }
  }
  while (lambda.length && lambda[lambda.length - 1] === 0) lambda.pop()
  const errCount = lambda.length - 1
  if (errCount <= 0 || errCount * 2 > ecLen) throw new Error(`RS 纠错失败:错误数 ${errCount} 超出能力 ${Math.floor(ecLen / 2)}`)

  // ── Chien:找错误位置 ──
  const positions = []
  for (let i = 0; i < n; i++) {
    // 位置 i(从最高位起算)对应 x = α^(n-1-i)
    const xInv = EXP[(255 - ((n - 1 - i) % 255)) % 255]
    let v = 0
    for (let j = 0; j < lambda.length; j++) v ^= mul(lambda[j], EXP[(LOG[xInv] * j) % 255])
    if (v === 0) positions.push(i)
  }
  if (positions.length !== errCount) throw new Error(`RS 纠错失败:Chien 找到 ${positions.length} 个位置,期望 ${errCount}`)

  // ── Forney:算错误值 ──
  const omega = new Array(ecLen).fill(0)
  for (let i = 0; i < ecLen; i++) {
    let v = 0
    for (let j = 0; j <= i && j < lambda.length; j++) v ^= mul(lambda[j], syndromes[i - j])
    omega[i] = v
  }
  const lambdaPrime = []
  for (let i = 1; i < lambda.length; i++) if (i % 2 === 1) lambdaPrime.push(lambda[i])

  const fixed = codeword.slice()
  for (const pos of positions) {
    const power = n - 1 - pos
    const xInv = EXP[(255 - (power % 255)) % 255]
    let num = 0
    for (let j = 0; j < omega.length; j++) num ^= mul(omega[j], EXP[(LOG[xInv] * j) % 255])
    let den = 0
    for (let j = 0; j < lambdaPrime.length; j++) den ^= mul(lambdaPrime[j], EXP[(LOG[xInv] * (2 * j)) % 255])
    if (den === 0) throw new Error('RS 纠错失败:Forney 分母为 0')
    fixed[pos] ^= mul(EXP[power % 255], mul(num, inv(den)))
  }

  // 纠完再验一次综合征
  const check = []
  for (let i = 0; i < ecLen; i++) { let s = 0; for (const c of fixed) s = mul(s, EXP[i]) ^ c; check.push(s) }
  if (!check.every((s) => s === 0)) throw new Error('RS 纠错失败:纠错后综合征仍非零')
  return { data: fixed.slice(0, n - ecLen), corrected: errCount }
}

const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]
// 标准格式信息表(ISO/IEC 18004 Table 25)。注意 L 行与 M 行的数值很容易记混:
// 0x5412 是 M/mask0、0x77C4 是 L/mask0 —— 这条已由 OpenCV 实扫验证。
const FORMAT_VALUES = new Map([
  [0x77c4, { ec: 'L', mask: 0 }], [0x72f3, { ec: 'L', mask: 1 }], [0x7daa, { ec: 'L', mask: 2 }], [0x789d, { ec: 'L', mask: 3 }],
  [0x662f, { ec: 'L', mask: 4 }], [0x6318, { ec: 'L', mask: 5 }], [0x6c41, { ec: 'L', mask: 6 }], [0x6976, { ec: 'L', mask: 7 }],
  [0x5412, { ec: 'M', mask: 0 }], [0x5125, { ec: 'M', mask: 1 }], [0x5e7c, { ec: 'M', mask: 2 }], [0x5b4b, { ec: 'M', mask: 3 }],
  [0x45f9, { ec: 'M', mask: 4 }], [0x40ce, { ec: 'M', mask: 5 }], [0x4f97, { ec: 'M', mask: 6 }], [0x4aa0, { ec: 'M', mask: 7 }],
  [0x355f, { ec: 'Q', mask: 0 }], [0x3068, { ec: 'Q', mask: 1 }], [0x3f31, { ec: 'Q', mask: 2 }], [0x3a06, { ec: 'Q', mask: 3 }],
  [0x24b4, { ec: 'Q', mask: 4 }], [0x2183, { ec: 'Q', mask: 5 }], [0x2eda, { ec: 'Q', mask: 6 }], [0x2bed, { ec: 'Q', mask: 7 }],
  [0x1689, { ec: 'H', mask: 0 }], [0x13be, { ec: 'H', mask: 1 }], [0x1ce7, { ec: 'H', mask: 2 }], [0x19d0, { ec: 'H', mask: 3 }],
  [0x0762, { ec: 'H', mask: 4 }], [0x0255, { ec: 'H', mask: 5 }], [0x0d0c, { ec: 'H', mask: 6 }], [0x083b, { ec: 'H', mask: 7 }],
])

/** 从矩阵解出文本 */
export function decodeMatrix(modules, reserved) {
  const size = modules.length
  const version = (size - 17) / 4
  if (!Number.isInteger(version) || version < 1 || version > 10) throw new Error(`尺寸非法: ${size}`)
  const at = (r, c) => modules[r][c] === true

  // 读格式信息(副本1)。位序:bit14 在 (8,0) —— 已用真实二维码穷举验证
  // (真实码按此读法得到 0x1689 = EC-H/mask0 的合法组合;其它读法都命中不了标准表)。
  let bits = 0
  for (let i = 0; i <= 5; i++) if (at(8, i)) bits |= 1 << (14 - i)
  if (at(8, 7)) bits |= 1 << 8
  if (at(8, 8)) bits |= 1 << 7
  if (at(7, 8)) bits |= 1 << 6
  for (let i = 0; i <= 5; i++) if (at(5 - i, 8)) bits |= 1 << (5 - i)
  const fmt = FORMAT_VALUES.get(bits)
  if (!fmt) throw new Error(`格式信息无法识别: 0x${bits.toString(16)}`)
  if (fmt.ec !== 'M') throw new Error(`纠错等级不是 M 而是 ${fmt.ec}`)

  // 取位(之字形),按掩码还原
  const maskFn = MASK_FNS[fmt.mask]
  const stream = []
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue
        let bit = at(row, col)
        if (maskFn(row, col)) bit = !bit
        stream.push(bit ? 1 : 0)
      }
    }
    upward = !upward
  }
  const totalCw = Math.floor(stream.length / 8)
  const codewords = []
  for (let i = 0; i < totalCw; i++) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | stream[i * 8 + j]
    codewords.push(b)
  }

  const [, dataCw, ecPerBlock, g1, g2] = VERSIONS_M[version]
  if (totalCw !== VERSIONS_M[version][0]) throw new Error(`码字数不符: ${totalCw} != ${VERSIONS_M[version][0]}`)

  // 去交错
  if (process.env.QR_DEBUG) {
    console.log(`  [dec] mask=${fmt.mask} totalCw=${totalCw} 前6码字=${codewords.slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join(' ')}`)
  }
  const shortLen = Math.floor(dataCw / (g1 + g2))
  const blocks = []
  for (let i = 0; i < g1 + g2; i++) {
    const len = i < g2 ? shortLen + 1 : shortLen
    blocks.push({ dataLen: len, data: [], ec: [] })
  }
  let idx = 0
  const maxData = Math.max(...blocks.map((b) => b.dataLen))
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.dataLen) b.data.push(codewords[idx++])
  for (let i = 0; i < ecPerBlock; i++) for (const b of blocks) b.ec.push(codewords[idx++])

  // 逐块纠错
  if (process.env.QR_DEBUG) {
    console.log(`  [dec] 块数据长=${blocks.map((b) => b.data.length)} 块首字节=${blocks.map((b) => b.data[0].toString(16)).join(',')}`)
  }
  let correctedTotal = 0
  const dataBytes = []
  for (const b of blocks) {
    const { data, corrected } = rsCorrect([...b.data, ...b.ec], ecPerBlock)
    correctedTotal += corrected
    dataBytes.push(...data)
  }

  // 解位流
  const bitsArr = []
  for (const b of dataBytes) for (let i = 7; i >= 0; i--) bitsArr.push((b >> i) & 1)
  if (process.env.QR_DEBUG) {
    console.log(`  [dec] 数据码字前4=${dataBytes.slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join(' ')} 头12位=${bitsArr.slice(0, 12).join('')} 长度字段=${parseInt(bitsArr.slice(4, 12).join(''), 2)}`)
  }
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bitsArr.shift(); return v }
  const mode = take(4)
  if (mode !== 0b0100) throw new Error(`模式不是 byte 而是 0b${mode.toString(2)}`)
  const len = take(version < 10 ? 8 : 16)
  const out = []
  for (let i = 0; i < len; i++) out.push(take(8))
  return { text: Buffer.from(out).toString('utf8'), version, mask: fmt.mask, ec: fmt.ec, corrected: correctedTotal }
}

// 直接跑:编码 → 解码 → 对照
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (isMain) {
  const TEXT = process.argv[2] ?? 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=0123456789abcdef0123456789abcdef&bot_type=3'
  const m = encodeMatrix(TEXT)
  console.log('编码:', m.version, '版本', m.size, 'x', m.size, ' mask', m.mask, ' 字节', Buffer.byteLength(TEXT))
  const r = decodeMatrix(m.modules, m.reserved)
  console.log('解码: mask', r.mask, ' ec', r.ec, ' 纠正错误数', r.corrected)
  console.log('文本一致:', r.text === TEXT)
  if (r.text !== TEXT) {
    console.log('  期望:', TEXT)
    console.log('  实际:', r.text)
  }
}
