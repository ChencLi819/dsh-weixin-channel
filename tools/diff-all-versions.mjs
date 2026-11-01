// 全版本对拍:对 v1~v10 各取一个文本,与 OpenCV 参考逐格比对。
// 需要先用 python tools/cv-ref-any.py 生成参考 json。
import { readFileSync } from 'node:fs'
import { encodeMatrix } from '../lib/qr.js'

const ROWS = {
  L: [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976],
  M: [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0],
}

// 每个版本取一个刚好落在该版本的字节数
const CAP = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 8: 152, 9: 180, 10: 213 }
let pass = 0, fail = 0
for (let v = 1; v <= 10; v++) {
  const text = 'Q'.repeat(CAP[v])
  const refPath = `tmp-cv-ref-v${v}.json`
  let ref
  try { ref = JSON.parse(readFileSync(refPath, 'utf8')) } catch { console.log(`v${v}: 缺少参考文件,跳过`); continue }

  const at2 = (r, c) => ref.modules[r][c] === 1
  let fmt = 0
  for (let i = 0; i <= 5; i++) if (at2(i, 8)) fmt |= 1 << i
  if (at2(7, 8)) fmt |= 1 << 6
  if (at2(8, 8)) fmt |= 1 << 7
  if (at2(8, 7)) fmt |= 1 << 8
  for (let i = 9; i <= 14; i++) if (at2(8, 14 - i)) fmt |= 1 << i
  let refMask = -1, refEc = null
  for (const ec of ['L', 'M']) for (let i = 0; i < 8; i++) if (ROWS[ec][i] === fmt) { refMask = i; refEc = ec }

  const mine = encodeMatrix(text, { forceMask: refMask })
  let diff = 0
  if (mine.size === ref.size) {
    for (let r = 0; r < ref.size; r++) for (let c = 0; c < ref.size; c++) {
      if ((mine.modules[r][c] ? 1 : 0) !== ref.modules[r][c]) diff++
    }
  } else diff = -1

  const ok = diff === 0
  if (ok) pass++; else fail++
  console.log(`v${String(v).padStart(2)} (${CAP[v]}字节, ${ref.size}x${ref.size}, 参考EC=${refEc} mask=${refMask}): 差异 ${diff} ${ok ? '✓' : '✗'}`)
}
console.log(`\n对拍结果: ${pass} 通过 / ${fail} 失败`)
