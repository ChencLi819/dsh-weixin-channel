// 本地状态:context_token 缓存、去重窗口、登录元信息。
//
// 为什么 context_token 必须持久化:iLink 要求每条出站消息都回带最近一次入站
// 消息的 context_token。插件重启后如果没有它,就再也发不出消息 —— 用户看到的是
// 「她不理我了」,而实际上只是丢了一个 token。所以落盘,重启后继续能用。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EMPTY = { version: 1, contexts: {}, seen: [], meta: {} }

export function createStore(stateDir) {
  const file = join(stateDir, 'state.json')
  let data = { ...EMPTY, contexts: {}, seen: [], meta: {} }

  const load = () => {
    try {
      if (!existsSync(file)) return
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (raw && typeof raw === 'object') {
        data = {
          version: 1,
          contexts: raw.contexts && typeof raw.contexts === 'object' ? raw.contexts : {},
          seen: Array.isArray(raw.seen) ? raw.seen : [],
          meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
        }
      }
    } catch {
      /* 坏了就从头开始,不阻塞启动 */
    }
  }

  /** 先写临时文件再改名:避免写一半崩了留下半个 JSON */
  const save = () => {
    try {
      mkdirSync(stateDir, { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
      renameSync(tmp, file)
    } catch {
      /* 写不动就算了,内存里还有 */
    }
  }

  load()

  return {
    file,
    /** 最近一次入站消息的 context_token(按微信 user id 存) */
    setContext(userId, token) {
      if (!userId || !token) return
      data.contexts[String(userId)] = String(token)
      save()
    },
    getContext(userId) {
      return data.contexts[String(userId)] || ''
    },
    /** 是否已经见过这条消息(去重);返回 true 表示重复 */
    hasSeen(messageId) {
      const key = String(messageId)
      return data.seen.includes(key)
    },
    markSeen(messageId, window = 500) {
      const key = String(messageId)
      if (data.seen.includes(key)) return
      data.seen.push(key)
      if (data.seen.length > window) data.seen.splice(0, data.seen.length - window)
      save()
    },
    /** 任意元信息(登录者 id、上次登录时间等) */
    setMeta(key, value) {
      data.meta[String(key)] = value
      save()
    },
    getMeta(key) {
      return data.meta[String(key)]
    },
    allMeta() {
      return { ...data.meta }
    },
    /** 清空会话相关状态(重新登录时用) */
    clearContexts() {
      data.contexts = {}
      save()
    },
  }
}
