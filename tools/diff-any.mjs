// 通用对拍:我方 vs OpenCV 参考(同一文本、同一纠错等级、强制同一掩码)
import { readFileSync } from 'node:fs'
import { encodeMatrix } from '../lib/qr.js'

const [, , refPath, text] = process.argv
const ref = JSON.parse(readFileSync(refPath, 'utf8'))
const size = ref.size

// 从参考矩阵读格式信息(副本1)
const at2 = (r, c) => ref.modules[r][c] === 1
let fmt = 0
for (let i = 0; i <= 5; i++) if (at2(i, 8)) fmt |= 1 << i
if (at2(7, 8)) fmt |= 1 << 6
if (at2(8, 8)) fmt |= 1 << 7
if (at2(8, 7)) fmt |= 1 << 8
for (let i = 9; i <= 14; i++) if (at2(8, 14 - i)) fmt |= 1 << i
const ROWS = {
  L: [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976],
  M: [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0],
}
let refMask = -1
for (const ec of ['L', 'M']) for (let i = 0; i < 8; i++) if (ROWS[ec][i] === fmt) refMask = i
console.log(`参考: size=${size} 版本=${(size - 17) / 4} 格式=0x${fmt.toString(16)} → mask ${refMask}`)

const mine = encodeMatrix(text, { forceMask: refMask })
console.log(`我方: size=${mine.size} 版本=${mine.version}`)
if (mine.size !== size) { console.log('尺寸不同,无法对拍'); process.exit(0) }

let diff = 0
const diffCells = []
for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
  const a = mine.modules[r][c] ? 1 : 0
  const b = ref.modules[r][c]
  if (a !== b) { diff++; if (diffCells.length < 40) diffCells.push([r, c, a, b]) }
}
console.log(`差异: ${diff} / ${size * size}`, diff === 0 ? '✓ 完全一致' : '')
if (diff) {
  // 按区域归类
  const zone = (r, c) => {
    const v = (size - 17) / 4
    if (r < 9 && c < 9) return '左上(定位+格式)'
    if (r < 9 && c >= size - 8) return '右上(定位+格式)'
    if (r >= size - 8 && c < 9) return '左下(定位+格式)'
    if (r === 6 || c === 6) return '时序'
    return '数据区'
  }
  const byZone = {}
  for (const [r, c] of diffCells) { const z = zone(r, c); byZone[z] = (byZone[z] ?? 0) + 1 }
  console.log('差异分布(前 40 格):', JSON.stringify(byZone))
  diffCells.slice(0, 15).forEach(([r, c, a, b]) => console.log(`  (${r},${c}) 我方=${a} 参考=${b}`))
}
