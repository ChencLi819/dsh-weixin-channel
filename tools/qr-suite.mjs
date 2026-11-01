// qr-suite.mjs —— 二维码编码器最终验收:生成全版本 + 各类内容的 PNG,交给 OpenCV 解码。
import { writeFileSync } from 'node:fs'
import { encodeMatrix, toPng } from '../lib/qr.js'

const CAP = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 8: 152, 9: 180, 10: 213 }
const cases = []
for (let v = 1; v <= 10; v++) cases.push([`v${v}`, 'q'.repeat(CAP[v])])
cases.push(['url', 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=0123456789abcdef0123456789abcdef&bot_type=3'])
cases.push(['cn', '微信扫码登录测试用例'])
cases.push(['mixed', 'ilink bot_token=abc123 中文混排 test'])
cases.push(['short', 'A'])
cases.push(['punct', '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'])

const meta = []
for (const [name, text] of cases) {
  const m = encodeMatrix(text)
  writeFileSync(`tmp-suite-${name}.png`, toPng(text, { scale: 8, quiet: 4 }))
  meta.push({ name, text, version: m.version, file: `tmp-suite-${name}.png` })
}
writeFileSync('tmp-suite.json', JSON.stringify(meta))
console.log(`生成 ${cases.length} 个用例`)
