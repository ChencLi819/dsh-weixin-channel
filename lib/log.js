// 日志:既写给宿主 logger,也追加到 <stateDir>/wechat.log。
//
// 为什么落盘:桌面版看不到 stdout,而「消息没发出去 / 收不到消息」这类失败
// 只写日志。落一份盘,check-live 之类的工具才有线索可看。
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 512 * 1024
const TAG = '[wechat-channel]'

export function createLogger(stateDir, hostLogger) {
  const file = join(stateDir, 'wechat.log')
  const write = (level, message) => {
    const text = String(message)
    const line = `${new Date().toISOString()} [${level}] ${text}\n`
    try {
      mkdirSync(stateDir, { recursive: true })
      try {
        if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
      } catch {
        /* 文件还不存在 */
      }
      appendFileSync(file, line)
    } catch {
      /* 写不动就算了 */
    }
    try {
      const fn = hostLogger?.[level]
      if (typeof fn === 'function') fn.call(hostLogger, text.startsWith(TAG) ? text : `${TAG} ${text}`)
      else if (level === 'error' || level === 'warn') console.log(`${TAG} ${text}`)
    } catch {
      /* 日志失败不连坐 */
    }
  }
  return {
    file,
    log: write,
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}
