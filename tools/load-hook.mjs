// load-hook.mjs —— 测试用 ESM 解析钩子。
//
// 为什么需要:插件正式安装后会落在 profile 的 node_modules 里,靠向上查找
// 自然解析到 @deepseek-ai/*(它们在 profiles/node_modules,是 desktop 的上一级)。
// 但在工作区里直接跑测试时没有这层目录结构,所以用钩子把裸包名指到真实路径 ——
// 测的是真包,不是 stub。
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(homedir(), '.dsh', 'profiles', 'node_modules')

const entryOf = (dir) => {
  try {
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
    const exp = pkg.exports
    if (typeof exp === 'string') return `${dir}/${exp.replace(/^\.\//, '')}`
    if (exp && typeof exp === 'object') {
      const dot = exp['.']
      if (typeof dot === 'string') return `${dir}/${dot.replace(/^\.\//, '')}`
      if (dot && typeof dot === 'object' && typeof dot.import === 'string') {
        return `${dir}/${dot.import.replace(/^\.\//, '')}`
      }
      if (dot && typeof dot === 'object' && typeof dot.default === 'string') {
        return `${dir}/${dot.default.replace(/^\.\//, '')}`
      }
    }
    if (typeof pkg.module === 'string') return `${dir}/${pkg.module}`
    if (typeof pkg.main === 'string') return `${dir}/${pkg.main}`
  } catch { /* 落到下面 */ }
  return `${dir}/index.js`
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/')) {
    const dir = `${ROOT}/${specifier}`
    try {
      const file = entryOf(dir)
      return { url: pathToFileURL(file).href, shortCircuit: true, format: 'module' }
    } catch { /* 交回默认解析 */ }
  }
  return next(specifier, context)
}
