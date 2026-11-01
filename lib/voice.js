// 语音合成(说):把一句话变成微信能收的语音消息。
//
// ── 为什么要自己写 ──
// SDK 的 MessageBuilder 上游只有 text/image/file/video,**没有 voice**
// (见 vendor 里那两处「本地补丁」注释)。协议是支持的(MediaType.VOICE = 4),
// 但没人用它。补完 SDK 之后,还缺「文字 → 音频」这一段 —— 模型不会说话,
// 得有 TTS。
//
// ── 引擎 ──
// 和 dsh-qqbot-voice 用同一套:阿里云百炼 qwen3-tts-flash,音色 Cherry。
// key 从 DSH 自己的凭据文件 ~/.dsh/.credentials.yaml 里读(和 qqbot-voice
// 共用同一个 key,不用再配一遍)。
//
// ── 格式 ──
// dashscope 返回 24kHz 单声道 16-bit WAV —— 正好是微信语音要的采样率。
// 但它的 RIFF/data **两个长度字段都是流式占位值**(0x7fffffbf),标准 WAV
// 解析器会直接拒收(实测 silk-wasm 的 isWav 就拒了),所以自己剥 PCM。
//
// 然后 PCM → SILK(silk-wasm)。SILK 是微信语音的编码,`#!SILK_V3` 头。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const DASHSCOPE_TTS_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'

/** 读 DSH 的凭据文件(一行一个 `  KEY: value`) */
function readCredentials() {
  const out = {}
  try {
    const file = join(homedir(), '.dsh', '.credentials.yaml')
    if (!existsSync(file)) return out
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s{2}([A-Z0-9_]+):\s*(\S+)\s*$/.exec(line)
      if (m) out[m[1]] = m[2]
    }
  } catch { /* 读不到就当没有 */ }
  return out
}

/** 解析 key:显式配置 > 环境变量 > 凭据文件 */
export function resolveTtsKey(cfg = {}) {
  if (cfg.apiKey) return String(cfg.apiKey).trim()
  const envName = String(cfg.apiKeyEnv ?? '').trim()
  if (!envName) return ''
  const fromEnv = process.env[envName]
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim()
  return String(readCredentials()[envName] ?? '').trim()
}

/** 从 dashscope 的返回里取出音频地址(两种形态都见过) */
function pickAudioUrl(json) {
  const audio = json?.output?.audio
  if (typeof audio === 'string') return audio
  if (audio && typeof audio.url === 'string') return audio.url
  return ''
}

/**
 * 文字 → WAV。
 * @returns {{ buffer: Buffer, sampleRate: number, channels: number, bits: number }}
 */
export async function synthesize(text, { settings, log } = {}) {
  const cfg = settings?.tts ?? {}
  const key = resolveTtsKey(cfg)
  if (!key) {
    throw new Error(`没有 TTS key(要 ${cfg.apiKeyEnv || '一个 apiKeyEnv'} 对应的凭据)`)
  }
  const res = await fetch(cfg.baseURL || DASHSCOPE_TTS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: cfg.model || 'qwen3-tts-flash',
      input: { text: String(text), voice: cfg.voice || 'Cherry' },
    }),
    signal: AbortSignal.timeout(Number(cfg.timeoutMs) || 60_000),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(`TTS 接口 ${res.status}:${JSON.stringify(json ?? {}).slice(0, 200)}`)
  }
  const url = pickAudioUrl(json)
  if (!url) throw new Error(`TTS 没返回音频地址:${JSON.stringify(json ?? {}).slice(0, 200)}`)

  const audioRes = await fetch(url, { signal: AbortSignal.timeout(Number(cfg.timeoutMs) || 60_000) })
  if (!audioRes.ok) throw new Error(`音频下载失败 HTTP ${audioRes.status}`)
  const buffer = Buffer.from(await audioRes.arrayBuffer())
  if (buffer.length === 0) throw new Error('TTS 返回了空音频')

  const info = parseWav(buffer)
  log?.info?.(`TTS 出音频:${buffer.length} 字节,${info.sampleRate}Hz ${info.channels}ch ${info.bits}bit,`
    + `约 ${(info.pcm.length / 2 / info.channels / info.sampleRate).toFixed(2)} 秒`)
  return { buffer, ...info }
}

/**
 * 剥出 WAV 里的 PCM。
 *
 * ⚠️ 不能用标准解析器:dashscope 返回的 RIFF 长度和 data 长度**都是流式占位值**
 * (0x7fffffbf / 0x7fffffdb),`silk-wasm` 的 `isWav()` 校验「声明长度 == 实际长度」
 * 会直接拒收。所以这里按实际文件长度夹一下。
 */
export function parseWav(buf) {
  if (buf.subarray(0, 4).toString('ascii') !== 'RIFF') {
    throw new Error('不是 WAV(没有 RIFF 头)')
  }
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.subarray(off, off + 4).toString('ascii')
    const size = buf.readUInt32LE(off + 4)
    const start = off + 8
    if (id === 'fmt ') {
      fmt = {
        formatCode: buf.readUInt16LE(start),
        channels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        bits: buf.readUInt16LE(start + 14),
      }
    } else if (id === 'data') {
      // 长度字段可能是占位值,夹到实际文件末尾
      data = buf.subarray(start, Math.min(start + size, buf.length))
      break
    }
    off = start + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('WAV 里找不到 fmt 或 data 段')
  return { ...fmt, pcm: data }
}

/**
 * 加载 silk-wasm —— **可选依赖**,拿不到就明说,不要静默降级。
 *
 * 它由 dsh-qqbot-voice 提供(QQ 那边解码语音要用),
 * 所以顺带找一下那个路径,免得为了这个功能再装一遍。
 */
let silkModule
export async function loadSilk() {
  if (silkModule !== undefined) return silkModule
  const candidates = [
    'silk-wasm',
    join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-qqbot-voice', 'node_modules', 'silk-wasm', 'lib', 'index.cjs'),
    join(homedir(), '.dsh', 'profiles', 'node_modules', 'silk-wasm', 'lib', 'index.cjs'),
  ]
  for (const spec of candidates) {
    try {
      if (spec.includes('\\') || spec.includes('/')) {
        if (!existsSync(spec)) continue
        const { createRequire } = await import('node:module')
        const require = createRequire(import.meta.url)
        silkModule = require(spec)
      } else {
        silkModule = await import(spec)
      }
      if (silkModule?.encode) return silkModule
    } catch { /* 换下一个 */ }
  }
  silkModule = null
  return null
}

/**
 * WAV → SILK(微信语音的编码)。
 * @returns {{ silk: Buffer, durationMs: number }}
 */
export async function wavToSilk(wavBuffer, { log } = {}) {
  const silk = await loadSilk()
  if (!silk?.encode) {
    throw new Error('没找到 silk-wasm —— 发语音需要它把音频转成微信的 SILK 编码')
  }
  const info = parseWav(wavBuffer)
  // 裸 PCM 传进去:silk-wasm 见到「不是标准 WAV」就当 PCM 用,
  // 正好绕开它那个严格校验。
  const enc = await silk.encode(info.pcm, info.sampleRate)
  if (!enc?.data?.length) throw new Error('SILK 编码返回空')
  log?.info?.(`SILK 编码:${enc.data.length} 字节,时长 ${enc.duration}ms`)
  return { silk: Buffer.from(enc.data), durationMs: Number(enc.duration) || 0, sampleRate: info.sampleRate, bitsPerSample: info.bits }
}

/** 一句话走完:文字 → SILK。 */
export async function textToSilk(text, { settings, log } = {}) {
  const { buffer } = await synthesize(text, { settings, log })
  return await wavToSilk(buffer, { log })
}
