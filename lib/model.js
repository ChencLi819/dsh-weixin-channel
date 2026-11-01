// 解析微信会话该用哪个模型。
//
// ── 为什么非给不可 ──
// DSH 的提示词里有一段 `persona-prefix`,内容是
//   You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
// 而 `{{model}}` 这个变量的取值方式是(dsh-agent-loop):
//   ctx.systemPrompt.variable("model", (context) => context.agent?.options.model)
//
// 也就是说它来自 **agent 自己的 options.model**。渠道自己 `agents.create()`
// 建出来的会话如果没带这个选项,变量就是 undefined,拼提示词时直接抛:
//
//   prompt variable "{{model}}" has no value for this assembly
//   (section "deployment:persona-prefix")
//
// 用户看到的是「本轮运行失败」。踩过。
//
// ── 优先级(和 dsh-qqbot 的 ModelResolver 保持一致)──
//   1. 插件配置 model.provider + model.model   —— 显式覆盖
//   2. 宿主服务 agentDefaultModel.currentSelection() —— 用户在 GUI 里选的
//   3. settings.yaml 的 agent-default-model
//   4. 兜底 deepseek-official / deepseek-v4-flash
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const FALLBACK = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

/** 读 settings.yaml 里的 agent-default-model(找不到就 undefined) */
function fromSettingsFile() {
  const candidates = [
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'settings.yaml') : null,
    join(homedir(), '.dsh', 'settings.yaml'),
  ].filter(Boolean)
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      // 只做够用的解析:找到 `agent-default-model:` 那一段里的 provider/model。
      // 不引 yaml 依赖 —— 这里只要两个标量,为一个可选配置背一个解析器不划算。
      const idx = text.indexOf('agent-default-model:')
      if (idx < 0) continue
      const block = text.slice(idx, idx + 400)
      const provider = /provider:\s*['"]?([\w.-]+)['"]?/.exec(block)?.[1]
      const model = /model:\s*['"]?([\w.-]+)['"]?/.exec(block)?.[1]
      if (provider && model) return { provider, model, source: `settings.yaml(${file})` }
    } catch { /* 读不动就当没有 */ }
  }
  return undefined
}

/** 问宿主:用户当前选的模型是哪个 */
function fromHost(ctx) {
  try {
    const svc = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined
    if (!svc) return undefined
    const pick = typeof svc.currentSelection === 'function' ? svc.currentSelection() : undefined
    if (pick?.provider && pick?.model) {
      return { provider: pick.provider, model: pick.model, source: '宿主 agentDefaultModel' }
    }
  } catch { /* 服务没有就没有 */ }
  return undefined
}

/**
 * @returns {{ provider: string, model: string, source: string }}
 */
export function resolveModel({ ctx, settings, log }) {
  const cfg = settings?.model ?? {}
  if (cfg.provider && cfg.model) {
    return { provider: cfg.provider, model: cfg.model, source: '插件配置' }
  }
  const host = fromHost(ctx)
  if (host) return host
  const file = fromSettingsFile()
  if (file) return file
  log?.warn?.(`没问出模型路由,回退到 ${FALLBACK.provider}/${FALLBACK.model}`)
  return { ...FALLBACK, source: '兜底' }
}

/**
 * 拿给 `agents.create({ agentOptions })` / `agents.resume({ agentOptions })` 用。
 * 解析失败时返回 undefined,让 SDK 用会话自己的路由(resume 时更安全)。
 */
export function agentOptionsFor(opts) {
  try {
    const resolved = resolveModel(opts)
    return { provider: resolved.provider, model: resolved.model }
  } catch {
    return undefined
  }
}
