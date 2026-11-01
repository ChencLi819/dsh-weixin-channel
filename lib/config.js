// 配置默认值 + 深合并 + 状态目录解析。
//
// 想改配置不用动这个文件:在 profile 的 cordis.patch.yml 里补一行
//   - id: wechat-channel
//     config: { allow: { users: ['wxid_xxx'] } }
// 就行(深合并,没写的字段仍用这里的默认值)。
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 代码版本标记:写进 diagnostic.json,用来确认「热重载后加载的到底是不是新代码」 */
export const LIB_VERSION = '0.1.0+39'

export const DEFAULTS = {
  enabled: true,
  /** 状态目录(默认 ~/.dsh/wechat-channel),凭证/context_token/日志都落这里 */
  stateDir: '',
  /** iLink Bot API 基址。腾讯官方协议,默认即生产环境 */
  baseUrl: 'https://ilinkai.weixin.qq.com',
  /** 每次请求带的 base_info.bot_agent,方便服务端侧识别调用方 */
  botAgent: 'DSH-WeChat-Channel/0.1',

  /** 扫码登录 */
  login: {
    /** 启动时若已有凭证就自动登录(不弹二维码) */
    autoLogin: true,
    /** 二维码 PNG 落盘目录,空 = 用 stateDir */
    qrDir: '',
    /** 二维码渲染参数:每模块像素 / 静默区模块数 */
    qrScale: 8,
    qrQuiet: 4,
    /** 等扫码的总时长(毫秒),超时作废重来 */
    timeoutMs: 180_000,
    /** 收到 -14(会话过期)后暂停多久再允许重试(毫秒),避免死循环 */
    expiredCooldownMs: 3_600_000,
  },

  /** 放行规则 —— 安全边界都在这 */
  allow: {
    /**
     * 白名单:只处理这些微信 user id 的消息。留空则退化为「只放行登录者本人」
     * (即扫码登录的那个微信号),绝不会因为列表为空就放行所有人。
     */
    users: [],
    /** true = 只放行登录者本人(即便 users 里写了别人也忽略) */
    selfOnly: true,
    /** 非白名单消息:静默丢弃(true)还是记一条日志(false 会刷屏) */
    silentDrop: true,
  },

  /** 会话映射 */
  session: {
    /** 会话 key 前缀,改它等于换一套会话命名空间 */
    prefix: 'wechat',
    /** 收到这条消息就重置会话(清上下文),留空则不启用 */
    resetCommand: '/new',
    /**
     * agent preset id —— **可选的**第二道收口。
     *
     * 默认留空:preset 走的是 dsh-agent-presets 的「用户 preset 根目录」;若部署
     * 未扫描 ~/.dsh/.agent-presets(只列出随附 preset),
     * 填了只会一直报警告。工具收口由 tools.restrict 负责,那条一定生效。
     *
     * 如果你的部署确实支持用户 preset(能 resolve 到自定义 id),可以填上,
     * 那会连「挂哪些插件」一起收窄,比只过滤工具更彻底。
     */
    preset: '',
  },

  /** 出站 */
  /** 微信会话的模型路由。留空则问宿主,再退回兜底。必须能解析出一个 model ——
   *  提示词里的 {{model}} 就来自它,拿不到会直接抛「本轮运行失败」。 */
  model: {
    provider: '',
    model: '',
  },
  /** 语音合成(发语音用)。默认复用 dsh-qqbot-voice 那套:百炼 qwen3-tts-flash + Cherry 音色 */
  tts: {
    /** 从环境变量或 ~/.dsh/.credentials.yaml 里找这个 key 名 */
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    /** 直接给 key(留空则按 apiKeyEnv 找) */
    apiKey: '',
    /** 接口地址,留空 = 阿里云百炼 */
    baseURL: '',
    model: 'qwen3-tts-flash',
    voice: 'Cherry',
    timeoutMs: 60_000,
  },

  send: {
    /** 单条文本上限,超了按段落切分成多条 */
    maxChars: 2000,
    /** 发送前显示「正在输入」 */
    typing: true,
    /** 出站限流:每分钟最多几条(0 = 不限) */
    maxPerMinute: 12,
  },

  /** 入站 */
  receive: {
    /** 是否开启长轮询收消息 */
    poll: true,
    /** 去重窗口(最近多少条 message_id 记着,防止重复投递) */
    dedupeSize: 500,
  },

  /** 工具:给助手暴露的 wechat_* 工具,以及微信会话的**工具收口** */
  tools: {
    /** 是否注册 wechat_* 工具 */
    enabled: true,
    /**
     * 工具收口开关 —— 「第一版只开放聊天能力」的落点。
     *
     * 打开后,微信会话能用的工具被限制成 allow 里那几个(见 tools.restrict):
     * 没有 shell、没有文件读写、没有联网、没有子代理。模型即使被诱导去调,
     * 那个工具在它眼里根本不存在。
     *
     * 为什么这条比 agent preset 靠谱:preset 走的是 dsh-agent-presets 的
     * 「用户 preset 根目录」;若部署未扫描该目录(只列出
     * 随附 preset)。tools.restrict 是运行时直接生效的,不依赖目录发现。
     */
    restrict: true,
    /**
     * 收口后**只保留**这些全局工具。留空数组 = 一个工具都不留(纯聊天)。
     *
     * ⚠️ 名字写错会让**整个收口失效(工具全开)** —— dsh-tools 的 restrict()
     *    对未知名字直接抛错,而不是忽略那一个。插件对此的处理是「摘掉问题名
     *    再重试」(见 lib/session.js),让失败往安全方向倒。
     *
     * ── 这份名单的边界:agent 的工具宇宙 ──
     *
     * restrict() 只能在**这个 agent 继承到的工具面**里做过滤 —— 它给不了原本
     * 就不在那儿的工具。实测(wechat_status selftest=true 探出来的)这个 agent
     * 的可收口工具是 **33 个**,下面这些**不在其中**,写了也会被摘掉:
     *
     *   web_search / web_fetch      —— 来自 `web` 插件,不在本插件的继承链上
     *   read / glob / grep / write / edit / pwsh
     *   schedule_create/list/update/delete
     *   todo_write / skill / ask_user_question / read_image / present
     *
     * 好消息是这些**本来就不可见**(实测 agent 视角看不到 pwsh/write/edit),
     * 所以安全边界不受影响;联网能力由 advanced_search / multi_search /
     * research 顶上,一样能搜。
     *
     * 想把这些也拿进来,得改 DSH 的插件树(让本插件继承到那些 scope),
     * 不是改这份名单能解决的。详见 README 的「工具收口」。
     */
    allow: [
      // ── 渠道 + 人格 ──
      'wechat_login',
      'wechat_status',
      'wechat_send',
      'mood_now',
      'mood_feel',
      'mood_diary',
      // ── 联网(web_search/web_fetch 不在本 agent 的工具面里,用这些顶) ──
      'advanced_search',
      'multi_search',
      'research',
      'cache_search',
      'platform_search',
      'domain_search',
      'image_search',
      'video_search',
      'grab_image',
      // ── 刷内容(B站/知乎/掘金/贴吧/HN/少数派/IT之家/GitHub) ──
      'feed_scroll',
      'feed_read',
      'feed_share',
      'feed_history',
      'feed_watch',
      // ── 表情包图库(发图走 meme_list 拿路径 + wechat_send) ──
      'meme_list',
      'meme_update',
      'learn_meme',
      // ── 识图 ──
      'qqbot_describe_image',
      // ── 实用 ──
      'weather',
      'qqbot_time',
    ],
    /** 在 allow 之外再减掉这些(一般不用填) */
    deny: [],
  },

  /** 给这个渠道的会话追加一段系统提示 */
  promptEnabled: true,
  promptText: '',
}

export const DEFAULT_PROMPT = [
  '【微信】',
  '- 你现在在微信里跟人一对一聊天。微信只有单聊,没有群。',
  '- 说话短一点、口语一点,别用 Markdown 大标题和长列表 —— 微信里不好看。',
  '- 图片/语音都能收能发。要发东西用 wechat_send:',
  '  · **回复直接用你的正文就行,会自动发出去** —— 别用 wechat_send 回话,会重复。',
  '  · wechat_send 用来发图/发文件,或者主动给**别人**发消息。',
  '  · 发图/发文件:file 给 http(s) 链接(插件自己下载),或本地绝对路径。',
  '  · 优先用链接 —— 这个会话里没有文件工具,拿不到本地路径。',
  '- 别声称发了其实没发。发失败时工具会告诉你原因,照实说。',
].join('\n')

/** 深合并:对象递归,数组/标量直接覆盖 */
export function mergeConfig(config) {
  const merge = (base, patch) => {
    if (patch === undefined || patch === null) return base
    if (Array.isArray(base) || typeof base !== 'object') return patch
    const out = { ...base }
    for (const [key, value] of Object.entries(patch)) {
      out[key] = key in base && typeof base[key] === 'object' && !Array.isArray(base[key])
        ? merge(base[key], value)
        : value
    }
    return out
  }
  return merge(DEFAULTS, config && typeof config === 'object' ? config : {})
}

export function stateDirOf(settings) {
  return settings.stateDir || join(homedir(), '.dsh', 'wechat-channel')
}

export function qrDirOf(settings) {
  return settings.login.qrDir || stateDirOf(settings)
}
