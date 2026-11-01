// verify-qr.mjs —— 二维码编码器的独立验证链。
//
// 核心原则:自洽的编码器/解码器对可以「一起错」而互相验证通过,
// 所以这里只认**外部**证据 —— 国际标准测试向量、OpenCV(独立的第三方实现)、
// 以及真实世界里已经能扫的二维码。
//
// 链路:
//   1. ISO/IEC 18004 附录 I 规范向量  → RS 纠错码字是否与标准逐字节一致
//   2. OpenCV 编码器逐格对拍 v1~v10   → 矩阵构造是否一致(强制同一掩码)
//   3. OpenCV 解码器验收              → 渲染出来真能扫
//   4. OpenCV 局限对照                → 读不出的用例是否连它自己也读不出
//   5. 独立解码器                     → 反向验证(含一张真实二维码)
import { spawnSync } from 'node:child_process'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const run = (label, cmd, args, { quiet = false } = {}) => {
  console.log(`\n${'═'.repeat(56)}\n${label}\n${'═'.repeat(56)}`)
  const res = spawnSync(cmd, args, {
    cwd: root, stdio: 'inherit', shell: process.platform === 'win32',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  return res.status === 0
}

const CAP = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 8: 152, 9: 180, 10: 213 }
const results = []

// 1. 规范向量
results.push(['ISO 规范向量(RS 纠错)', run('1/5  ISO/IEC 18004 附录 I 规范向量', 'node', ['tools/qr-spec-vector.mjs'])])

// 2. 生成 OpenCV 参考矩阵(用非字母数字内容,强制它走字节模式)
for (let v = 1; v <= 10; v++) {
  spawnSync('python', ['tools/cv-ref-any.py', 'q'.repeat(CAP[v]), `tmp-cv-ref-v${v}.json`], {
    cwd: root, shell: process.platform === 'win32', stdio: 'ignore',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
}
results.push(['OpenCV 编码器逐格对拍 v1~v10', run('2/5  OpenCV 编码器逐格对拍(强制同一掩码)', 'node', ['tools/diff-all-versions.mjs'])])

// 3+4. 渲染 + 解码验收
spawnSync('node', ['tools/qr-suite.mjs'], { cwd: root, shell: process.platform === 'win32', stdio: 'ignore' })
results.push(['OpenCV 解码器验收', run('3/5  OpenCV 解码器验收(含检测器局限对照)', 'python', ['tools/qr-suite-check.py'])])

// 5. 独立解码器
results.push(['独立解码器反向验证', run('4/5  独立解码器(含真实二维码)', 'node', ['tools/qr-decode.mjs'])])

// 6. OpenCV 局限的决定性证明
results.push(['OpenCV 局限证明', run('5/5  OpenCV 局限的决定性对照', 'python', ['tools/decisive.py'])])

console.log(`\n${'═'.repeat(56)}\n二维码验证链汇总\n${'═'.repeat(56)}`)
for (const [name, ok] of results) console.log(`  ${ok ? '✓' : '✗'} ${name}`)
const failed = results.filter(([, ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
process.exit(failed === 0 ? 0 : 1)
