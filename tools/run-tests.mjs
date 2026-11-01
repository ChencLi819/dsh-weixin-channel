// run-tests.mjs —— 一次跑完所有测试,汇总结果。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const suites = [
  { name: '纯逻辑自测', cmd: 'node', args: ['tools/selftest.mjs'] },
  { name: '回归测试(已踩过的坑)', cmd: 'node', args: ['tools/regression.mjs'] },
  { name: '插件加载', cmd: 'node', args: ['tools/loadtest.mjs'] },
  { name: '端到端集成', cmd: 'node', args: ['tools/e2e.mjs'] },
  { name: '二维码验收', cmd: 'node', args: ['tools/qr-suite.mjs'] },
  { name: '二维码解码对照', cmd: 'python', args: ['tools/qr-suite-check.py'] },
]

const results = []
for (const suite of suites) {
  process.stdout.write(`\n${'═'.repeat(52)}\n${suite.name}\n${'═'.repeat(52)}\n`)
  const res = spawnSync(suite.cmd, suite.args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    shell: process.platform === 'win32',
  })
  const ok = res.status === 0
  results.push({ name: suite.name, ok, status: res.status })
  if (!ok) console.log(`\n⚠️  ${suite.name} 退出码 ${res.status}`)
}

console.log(`\n${'═'.repeat(52)}\n汇总\n${'═'.repeat(52)}`)
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` (退出码 ${r.status})`}`)
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} 套通过`)
process.exit(failed === 0 ? 0 : 1)
