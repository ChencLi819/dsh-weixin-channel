// qr-spec-vector.mjs —— 用 ISO/IEC 18004 附录 I 的标准测试向量做硬验证。
// 向量:v1-M,内容 "01234567"(数字模式)
//   数据码字: 10 20 0c 56 61 80 ec 11 ec 11 ec 11 ec 11 ec 11
//   纠错码字: a5 24 d4 c1 ed 36 c7 87 2c 55
// 用途:① 验证 RS 纠错实现是否与规范一致(这是最容易"自洽但错"的一环)
//      ② 用这组码字手工构造矩阵,交给 OpenCV 判定 —— 把「RS 错」与「矩阵生成错」分开。
import { writeFileSync } from 'node:fs'

const EXP = new Uint8Array(512), LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

function rsGen(deg) {
  let g = [1]
  for (let i = 0; i < deg; i++) {
    const next = new Array(g.length + 1).fill(0)
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]) }
    g = next
  }
  return g
}
function rsEc(data, deg) {
  const g = rsGen(deg)
  const rem = new Array(deg).fill(0)
  for (const b of data) {
    const f = b ^ rem[0]
    rem.shift(); rem.push(0)
    for (let i = 0; i < deg; i++) rem[i] ^= mul(g[i + 1], f)
  }
  return rem
}

const DATA = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]
const EC = [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]

const got = rsEc(DATA, 10)
console.log('RS 自检(规范向量):')
console.log('  期望 EC:', EC.map((b) => b.toString(16).padStart(2, '0')).join(' '))
console.log('  实际 EC:', got.map((b) => b.toString(16).padStart(2, '0')).join(' '))
console.log('  RS 实现与规范一致:', JSON.stringify(got) === JSON.stringify(EC))
if (JSON.stringify(got) !== JSON.stringify(EC)) {
  console.log('  → RS 生成多项式或编码过程有误,必须先修这个')
  process.exit(1)
}

// ── 用规范码字手工构造 v1-M 矩阵,交给 OpenCV ──
const FORMAT_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0]
const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

function buildMatrix(codewords, mask) {
  const size = 21
  const mod = Array.from({ length: size }, () => new Array(size).fill(false))
  const fn = Array.from({ length: size }, () => new Array(size).fill(false))
  const setF = (r, c, v) => { mod[r][c] = v; fn[r][c] = true }
  for (const [rr, cc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const y = rr + r, x = cc + c
      if (y < 0 || x < 0 || y >= size || x >= size) continue
      const border = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6))
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4
      setF(y, x, border || core)
    }
  }
  for (let i = 8; i < size - 8; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0) }
  for (let i = 0; i <= 8; i++) { if (i !== 6) { setF(8, i, false); setF(i, 8, false) } }
  for (let i = 0; i < 8; i++) { setF(8, size - 1 - i, false); setF(size - 1 - i, 8, false) }
  setF(size - 8, 8, true)
  // 数据
  const bits = []
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1)
  let bi = 0, upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i
      for (const col of [right, right - 1]) {
        if (fn[row][col]) continue
        mod[row][col] = bi < bits.length ? bits[bi++] === 1 : false
      }
    }
    upward = !upward
  }
  // 掩码
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fn[r][c] && MASK_FNS[mask](r, c)) mod[r][c] = !mod[r][c]
  // 格式信息(高位在 (8,0))
  const f = FORMAT_M[mask]
  for (let i = 0; i <= 5; i++) mod[8][i] = ((f >> (14 - i)) & 1) === 1
  mod[8][7] = ((f >> 8) & 1) === 1
  mod[8][8] = ((f >> 7) & 1) === 1
  mod[7][8] = ((f >> 6) & 1) === 1
  for (let i = 0; i <= 5; i++) mod[5 - i][8] = ((f >> i) & 1) === 1
  for (let i = 0; i <= 7; i++) mod[8][size - 8 + i] = ((f >> (14 - i)) & 1) === 1
  for (let i = 0; i <= 6; i++) mod[size - 7 + i][8] = ((f >> (6 - i)) & 1) === 1
  mod[size - 8][8] = true
  return mod
}

// 导出 8 个掩码版本的矩阵,让 python 侧渲染 + OpenCV 解码
const out = {}
for (let mask = 0; mask < 8; mask++) {
  out[mask] = buildMatrix([...DATA, ...EC], mask).map((row) => row.map((v) => (v ? 1 : 0)))
}
writeFileSync('tmp-spec-vector-masks.json', JSON.stringify(out))
console.log('已导出 8 个掩码的矩阵(tmp-spec-vector-masks.json),内容为规范测试向量 "01234567"')
