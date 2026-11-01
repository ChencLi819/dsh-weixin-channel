// regression.mjs —— 回归测试:钉住已经踩过的坑,别再犯第二次。
//
// 每个用例都对应一个**真实发生过的**缺陷,注释里写清楚当时的表现。
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { register } from 'node:module'
register(new URL('./load-hook.mjs', import.meta.url).href, import.meta.url)

const { mergeConfig, stateDirOf, qrDirOf, DEFAULTS } = await import('../lib/config.js')
const { createClient } = await import('../lib/client.js')
const { createStore } = await import('../lib/store.js')
const { encodeMatrix, toPng } = await import('../lib/qr.js')

let pass = 0
let fail = 0
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? `\n      ${extra}` : ''}`) }
}

const silent = { info() {}, warn() {}, error() {}, log() {} }

// ────────────────────────────────────────────────────────────
console.log('\n── 回归 1:stateDir 为空串时必须解析出绝对路径 ──')
// 当时的症状:二维码落盘失败 ENOENT mkdir '',SDK 凭证目录变成相对路径 'sdk',
// 于是凭证写到进程 CWD,下次启动找不到 → 每次都像没登录过。
{
  const settings = mergeConfig({})   // 不给 stateDir,走默认
  ok('DEFAULTS.stateDir 确实是空串(这就是坑)', DEFAULTS.stateDir === '', `实际 ${JSON.stringify(DEFAULTS.stateDir)}`)
  ok('stateDirOf 解析出绝对路径', isAbsolute(stateDirOf(settings)), stateDirOf(settings))
  ok('qrDirOf 解析出绝对路径', isAbsolute(qrDirOf(settings)), qrDirOf(settings))
  ok('qrDir 默认跟随 stateDir', qrDirOf(settings) === stateDirOf(settings))

  const store = createStore(mkdtempSync(join(tmpdir(), 'wechat-reg-')))
  const client = createClient({ settings, store, log: silent })
  ok('createClient.stateDir 是绝对路径(不是空串)', isAbsolute(client.stateDir), JSON.stringify(client.stateDir))
  ok('createClient.qrDir 是绝对路径(不是空串)', isAbsolute(client.qrDir), JSON.stringify(client.qrDir))
  ok('qrDir 不等于空串', client.qrDir !== '', '(空串会让 mkdir 抛 ENOENT)')
  client.stop()
  rmSync(store.file.replace(/[\\/]state\.json$/, ''), { recursive: true, force: true })
}

// ────────────────────────────────────────────────────────────
console.log('\n── 回归 2:显式配置要能覆盖默认目录 ──')
{
  const custom = mkdtempSync(join(tmpdir(), 'wechat-reg-custom-'))
  const settings = mergeConfig({ stateDir: custom, login: { qrDir: join(custom, 'qr') } })
  const store = createStore(custom)
  const client = createClient({ settings, store, log: silent })
  ok('stateDir 用显式值', client.stateDir === custom, client.stateDir)
  ok('qrDir 用显式值', client.qrDir === join(custom, 'qr'), client.qrDir)
  client.stop()
  rmSync(custom, { recursive: true, force: true })
}

// ────────────────────────────────────────────────────────────
console.log('\n── 回归 3:重置会话必须真的换 sessionId ──')
// 当时的症状:reset() 删了记录再 getOrCreate,但 sessionId 是从 sessionKey
// 确定性派生的 —— 删了重建还是同一个,等于没重置。
{
  const { WeChatSessions } = await import('../lib/session.js')
  const { randomUUID } = await import('node:crypto')
  const stateDir = mkdtempSync(join(tmpdir(), 'wechat-reg-reset-'))
  const store = createStore(stateDir)
  const settings = mergeConfig({ stateDir })

  const makeSessions = () => new WeChatSessions({
    ctx: { wechatAccountId: 'acct' },
    agents: {
      get: () => undefined,
      async create(o) {
        return {
          agent: { session: { id: o.sessionId }, followup() {}, async whenIdle() {}, cancel() {} },
          dispose: async () => {},
        }
      },
      async resume() { throw new Error('first run') },
    },
    settings,
    log: silent,
    store,
  })

  const sessions = makeSessions()
  const before = await sessions.getOrCreate('u1')
  ok('首次派生是 uuid 形状', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(before.sessionId)), String(before.sessionId))

  // 重启后同一个用户应该拿到同一个 id(上下文能 resume)
  const sessions2 = makeSessions()
  const again = await sessions2.getOrCreate('u1')
  ok('重启后 sessionId 不变', String(again.sessionId) === String(before.sessionId))

  // 重置后必须换
  const afterReset = await sessions2.reset('u1')
  ok('重置后 sessionId 变了', String(afterReset.sessionId) !== String(before.sessionId),
    `重置前 ${before.sessionId} / 重置后 ${afterReset.sessionId}`)
  ok('重置后的 id 仍是 uuid 形状', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(afterReset.sessionId)))

  // 重置要跨重启有效
  const sessions3 = makeSessions()
  const afterRestart = await sessions3.getOrCreate('u1')
  ok('重置跨重启有效(不会又变回老会话)', String(afterRestart.sessionId) === String(afterReset.sessionId))

  // 另一个用户不受影响
  const other = await sessions3.getOrCreate('u2')
  ok('别的用户是独立会话', String(other.sessionId) !== String(afterReset.sessionId))

  rmSync(stateDir, { recursive: true, force: true })
}

// ────────────────────────────────────────────────────────────
console.log('\n── 回归 4:白名单为空时绝不能放行所有人 ──')
// 插件 v2.4.8 的老毛病:名单为空 + 没有扫码用户 id 时,fallback 到「放行任何人」。
{
  const { isAllowed } = await import('../lib/inbound.js')
  const stateDir = mkdtempSync(join(tmpdir(), 'wechat-reg-allow-'))
  const store = createStore(stateDir)

  // 还没登录(没有 selfUserId),名单也空 → 必须全拒
  for (const uid of ['a', 'b', 'stranger@wechat']) {
    ok(`未登录+空名单 → 拒绝 ${uid}`,
      !isAllowed({ userId: uid }, { settings: mergeConfig({ stateDir, allow: { users: [] } }), store, log: silent }))
  }
  // 登录后,只放行本人
  store.setMeta('userId', 'me@wechat')
  ok('已登录+空名单 → 放行本人',
    isAllowed({ userId: 'me@wechat' }, { settings: mergeConfig({ stateDir, allow: { users: [] } }), store, log: silent }))
  ok('已登录+空名单 → 仍拒绝他人',
    !isAllowed({ userId: 'stranger' }, { settings: mergeConfig({ stateDir, allow: { users: [] } }), store, log: silent }))

  rmSync(stateDir, { recursive: true, force: true })
}

// ────────────────────────────────────────────────────────────
console.log('\n── 回归 5:二维码编码器的两处位序坑 ──')
// 坑 A:格式信息副本2 的走向和副本1 不同,照抄副本1 会写错(副本1 对、副本2 全错)。
// 坑 B:分块时「短块在前」写反成「长块在前」,v1~v7 因 g2=0 掩盖,到 v8+ 才炸。
{
  const MASK_FORMAT = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0]
  const readCopy1 = (m, size) => {
    let v = 0
    for (let i = 0; i <= 5; i++) if (m[i][8]) v |= 1 << i
    if (m[7][8]) v |= 1 << 6
    if (m[8][8]) v |= 1 << 7
    if (m[8][7]) v |= 1 << 8
    for (let i = 9; i <= 14; i++) if (m[8][14 - i]) v |= 1 << i
    return v
  }
  const readCopy2 = (m, size) => {
    let v = 0
    for (let i = 0; i <= 7; i++) if (m[8][size - 1 - i]) v |= 1 << i
    for (let i = 8; i <= 14; i++) if (m[size - 15 + i][8]) v |= 1 << i
    return v
  }

  for (let mask = 0; mask < 8; mask++) {
    const m = encodeMatrix('回归测试', { forceMask: mask })
    const expected = MASK_FORMAT[mask]
    ok(`mask ${mask}: 副本1 读回 0x${expected.toString(16)}`, readCopy1(m.modules, m.size) === expected,
      `实际 0x${readCopy1(m.modules, m.size).toString(16)}`)
    ok(`mask ${mask}: 副本2 读回同一个值`, readCopy2(m.modules, m.size) === expected,
      `实际 0x${readCopy2(m.modules, m.size).toString(16)}`)
  }

  // 多分组的版本:g2>0,短块必须在长块之前
  const caps = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 8: 152, 9: 180, 10: 213 }
  for (const v of [8, 9, 10]) {
    const m = encodeMatrix('q'.repeat(caps[v]))
    ok(`v${v} 能编出正确尺寸`, m.size === 17 + 4 * v, `${m.size} != ${17 + 4 * v}`)
    ok(`v${v} 格式信息副本1/副本2 一致`, readCopy1(m.modules, m.size) === readCopy2(m.modules, m.size))
  }
}

// ────────────────────────────────────────────────────────────
console.log('\n── 回归 6:二维码 PNG 尺寸与静默区 ──')
{
  const url = 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=fedcba9876543210fedcba9876543210&bot_type=3'
  const m = encodeMatrix(url)
  ok('89 字节 → 版本 6', m.version === 6, String(m.version))
  const png = toPng(url, { scale: 8, quiet: 4 })
  ok('PNG 魔数正确', png[0] === 0x89 && png[1] === 0x50)
  ok('PNG 宽高 = (41+8)*8 = 392', png.readUInt32BE(16) === 392 && png.readUInt32BE(20) === 392,
    `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`)
  ok('PNG 是有效灰度图(位深 8)', png[24] === 8, `位深 ${png[24]}`)
}

// ────────────────────────────────────────────────────────────
console.log('\n── 回归 7:agent preset(可选收口) ──')
{
  const { WeChatSessions } = await import('../lib/session.js')

  const makeSessions = (preset, presetsService, log) => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wechat-reg-preset-'))
    const store = createStore(stateDir)
    const settings = mergeConfig({ stateDir, session: { preset }, tools: { restrict: false } })
    const created = []
    const sessions = new WeChatSessions({
      ctx: { wechatAccountId: 'acct', get: (n) => (n === 'agentPresets' ? presetsService : undefined) },
      agents: {
        get: () => undefined,
        async create(o) {
          created.push(o)
          if (typeof o.setup === 'function') await o.setup({ get: () => undefined })
          return {
            agent: { session: { id: o.sessionId }, followup() {}, async whenIdle() {}, cancel() {} },
            dispose: async () => {},
          }
        },
        async resume() { throw new Error('first run') },
      },
      settings, log, store,
    })
    return { sessions, created, stateDir }
  }

  // 7a. preset 可用 → 应当挂上 preset 并传 setup
  {
    const mounted = []
    const presets = {
      async resolve(id) { return { id } },
      async mount(agentCtx, id) { mounted.push(id) },
    }
    const { sessions, created, stateDir } = makeSessions('wechat', presets, silent)
    const record = await sessions.getOrCreate('u1')
    ok('7a 会话记录带上了 preset 名', record.agentPreset === 'wechat', JSON.stringify(record.agentPreset))
    ok('7a create 时传了 agentPreset', created[0]?.meta?.agentPreset === 'wechat', JSON.stringify(created[0]?.meta))
    ok('7a create 时传了 setup', typeof created[0]?.setup === 'function')
    ok('7a setup 真的去 mount 了这个 preset', mounted[0] === 'wechat', JSON.stringify(mounted))
    rmSync(stateDir, { recursive: true, force: true })
  }

  // 7b. preset 不存在 → 警告 + 跳过,不炸
  {
    const warns = []
    const log = { info() {}, warn: (m) => warns.push(String(m)), error() {}, log() {} }
    const presets = {
      async resolve() { throw new Error('Unknown agent preset: nonexistent') },
      async mount() {},
    }
    const { sessions, created, stateDir } = makeSessions('nonexistent', presets, log)
    const record = await sessions.getOrCreate('u1')
    ok('7b 跳过 preset 后 agentPreset 为空', record.agentPreset === '')
    ok('7b create 没传 agentPreset', created[0]?.meta?.agentPreset === undefined)
    ok('7b 警告里点明了 preset 名', warns.some((w) => w.includes('nonexistent')), JSON.stringify(warns))
    rmSync(stateDir, { recursive: true, force: true })
  }

  // 7c. 服务不可用 → 警告 + 跳过
  {
    const warns = []
    const log = { info() {}, warn: (m) => warns.push(String(m)), error() {}, log() {} }
    const { sessions, created, stateDir } = makeSessions('wechat', undefined, log)
    const record = await sessions.getOrCreate('u1')
    ok('7c 跳过 preset 后 agentPreset 为空', record.agentPreset === '')
    ok('7c create 没传 agentPreset', created[0]?.meta?.agentPreset === undefined)
    ok('7c 有明确警告', warns.some((w) => w.includes('agentPresets')), JSON.stringify(warns))
    rmSync(stateDir, { recursive: true, force: true })
  }

  // 7d. 默认留空 —— 因为本部署扫不到用户 preset 根目录,填了只会一直报警告
  {
    const settings = mergeConfig({})
    ok('7d 默认 session.preset 为空', settings.session.preset === '', JSON.stringify(settings.session.preset))
  }
}

// ────────────────────────────────────────────────────────────
console.log('\n── 回归 8:工具收口(真正的机制) ──')
// 这是「第一版只开放聊天能力」的落点。要点:收口必须真的调用 tools.restrict,
// 而且失败时要**明确警告**,不能静默放过 —— 否则以为收窄了其实工具全开。
{
  const { WeChatSessions } = await import('../lib/session.js')

  const makeSessions = ({ toolsConfig, toolsService, log }) => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wechat-reg-tools-'))
    const store = createStore(stateDir)
    const settings = mergeConfig({ stateDir, session: { preset: '' }, tools: toolsConfig })
    const setups = []
    const sessions = new WeChatSessions({
      ctx: { wechatAccountId: 'acct', get: () => undefined },
      agents: {
        get: () => undefined,
        async create(o) {
          setups.push(o.setup)
          if (typeof o.setup === 'function') await o.setup({ get: (n) => (n === 'tools' ? toolsService : undefined) })
          return {
            agent: { session: { id: o.sessionId }, followup() {}, async whenIdle() {}, cancel() {} },
            dispose: async () => {},
          }
        },
        async resume() { throw new Error('first run') },
      },
      settings, log, store,
    })
    return { sessions, stateDir, setups }
  }

  // 8a. 默认就该收口,并且把 allow 原样传给 restrict
  {
    const calls = []
    let lifted = false
    const tools = {
      restrict(filter) { calls.push(filter); return () => { lifted = true } },
    }
    const { sessions, stateDir } = makeSessions({
      toolsConfig: { restrict: true, allow: ['wechat_login', 'wechat_status', 'wechat_send'], deny: [] },
      toolsService: tools, log: silent,
    })
    await sessions.getOrCreate('u1')
    ok('8a 调用了 tools.restrict', calls.length === 1, JSON.stringify(calls))
    ok('8a allow 传对了', JSON.stringify(calls[0]?.allow) === JSON.stringify(['wechat_login', 'wechat_status', 'wechat_send']),
      JSON.stringify(calls[0]))
    ok('8a 空的 deny 不传(免得被当成「排除空集」报错)', calls[0]?.deny === undefined, JSON.stringify(calls[0]))
    await sessions.disposeAll()
    ok('8a 卸载时会解除收口', lifted === true)
    rmSync(stateDir, { recursive: true, force: true })
  }

  // 8b. 默认配置:开、allow 三个、deny 空
  {
    const settings = mergeConfig({})
    const allow = settings.tools.allow
    ok('8b 默认开启收口', settings.tools.restrict === true)
    ok('8b 默认 deny 为空', Array.isArray(settings.tools.deny) && settings.tools.deny.length === 0)
    ok('8b allow 是数组且不为空', Array.isArray(allow) && allow.length > 0, JSON.stringify(allow))

    // 早先这里钉的是字面名单(就三个 wechat_*)。后来要「放行更多工具」,
    // 钉字面名单的写法立刻变成绊脚石 —— 改一次默认值就得改一次测试。
    // 换成断言**意图**:必备能力 + 安全底线,这两条才是真正不能破的。

    // 必备:渠道自己的三个 + 人格(心情)
    for (const must of ['wechat_login', 'wechat_status', 'wechat_send', 'mood_now', 'mood_feel', 'mood_diary']) {
      ok(`8b 必备工具在名单里:${must}`, allow.includes(must), JSON.stringify(allow))
    }

    // 安全底线:这些**绝不能**出现在默认名单里
    const forbidden = [
      // 任意命令 / 改文件 —— 聊天渠道里风险太高
      'pwsh', 'write', 'edit', 'working_directory', 'load_workspace_dependencies',
      // 起更多 agent —— 会绕开这里的收口
      'subagent', 'subagent_fork', 'workflow', 'interrupt_agent', 'send_message', 'list_agents',
      // QQ 专用发送类 —— 在微信里必然失败
      'qqbot_say', 'qqbot_send_file', 'qqbot_voice_call',
      // 吐的是 Web/QQ 格式的标记,微信发不出去
      'send_meme',
      // GUI 卡片 / 计划模式,微信里没意义
      'present', 'exit_plan_mode',
    ]
    for (const bad of forbidden) {
      ok(`8b 危险/无关工具不在默认名单里:${bad}`, !allow.includes(bad), JSON.stringify(allow))
    }

    ok('8b 名单没有重复项', new Set(allow).size === allow.length,
      JSON.stringify(allow.filter((n, i) => allow.indexOf(n) !== i)))
  }

  // 8c. 服务没有 restrict 方法(DSH 版本不匹配)→ 必须警告,不能静默
  {
    const warns = []
    const log = { info() {}, warn: (m) => warns.push(String(m)), error() {}, log() {} }
    const { sessions, stateDir } = makeSessions({
      toolsConfig: { restrict: true, allow: ['wechat_login'], deny: [] },
      toolsService: { register() {} }, log,
    })
    await sessions.getOrCreate('u1')
    ok('8c 缺 restrict 时报了警告', warns.some((w) => w.includes('restrict')), JSON.stringify(warns))
    ok('8c 警告说明工具没收窄', warns.some((w) => w.includes('没有') && w.includes('收窄')), JSON.stringify(warns))
    rmSync(stateDir, { recursive: true, force: true })
  }

  // 8d2. 名单里有不存在的名字 → **摘掉那一个再收口**,而不是让 restrict 抛错
  //
  // 这是「失败往安全方向倒」:写错一个名字的后果必须是「那一个工具不放行」,
  // 而不是「restrict 抛错 → 收口没装上 → 工具全开」。
  {
    const errors = []
    const log = { info() {}, warn() {}, error: (m) => errors.push(String(m)), log() {} }
    const calls = []
    const known = new Set(['wechat_login', 'wechat_status', 'web_search'])
    const { sessions, stateDir } = makeSessions({
      toolsConfig: { restrict: true, allow: ['wechat_login', '拼错的名字', 'web_search'], deny: [] },
      toolsService: {
        // ⚠️ 故意**不**提供 view():生产代码不许靠 view(undefined) 自己猜名单,
        //    那个 scope 不对(实测会把 13 个正常工具误判成未知)。只能靠 restrict 的报错。
        restrict(filter) {
          // 真的模拟 dsh-tools:名字不认识就抛,报错格式**一字不差**照抄 ——
          // 生产代码正是解析这条消息里的两段来定位问题名的。
          const bad = [...(filter.allow ?? []), ...(filter.deny ?? [])].filter((n) => !known.has(n))
          if (bad.length) {
            throw new Error(`tools.restrict() names unknown global tool${bad.length > 1 ? 's' : ''} `
              + `${bad.map((n) => `"${n}"`).join(', ')}; known global tools: ${[...known].sort().join(', ')}`)
          }
          calls.push(filter)
          return () => {}
        },
      },
      log,
    })
    const record = await sessions.getOrCreate('u1')
    ok('8d2 会话照常建立', !!record?.agent)
    ok('8d2 restrict 没抛错(名单被洗干净了)', calls.length === 1, JSON.stringify(calls))
    ok('8d2 收口用上了正确的名字', JSON.stringify(calls[0]?.allow) === JSON.stringify(['wechat_login', 'web_search']),
      JSON.stringify(calls[0]))
    ok('8d2 拼错的名字被摘掉了', !JSON.stringify(calls[0]?.allow ?? []).includes('拼错的名字'),
      JSON.stringify(calls[0]))
    ok('8d2 大声报了错', errors.some((e) => e.includes('拼错的名字')), JSON.stringify(errors))
    ok('8d2 错误里说明了后果是「整个装不上」', errors.some((e) => e.includes('整个装不上')), JSON.stringify(errors))
    ok('8d2 顺手给出了可用清单', errors.some((e) => e.includes('能收口的工具')), JSON.stringify(errors))
    ok('8d2 清单里带着真实工具名(从报错里抄出来的)',
      errors.some((e) => e.includes('wechat_login') && e.includes('web_search')), JSON.stringify(errors))
    rmSync(stateDir, { recursive: true, force: true })
  }

  // 8d. restrict 抛错 → 警告,但不影响会话建立
  {
    const warns = []
    const log = { info() {}, warn: (m) => warns.push(String(m)), error() {}, log() {} }
    const { sessions, stateDir } = makeSessions({
      toolsConfig: { restrict: true, allow: ['不存在的工具'], deny: [] },
      toolsService: { restrict() { throw new Error('unknown tool name: 不存在的工具') } }, log,
    })
    const record = await sessions.getOrCreate('u1')
    ok('8d restrict 抛错不影响会话建立', !!record?.agent)
    ok('8d 收口失败报了警告', warns.some((w) => w.includes('收口失败')), JSON.stringify(warns))
    rmSync(stateDir, { recursive: true, force: true })
  }

  // 8e. 关掉收口 → 不调 restrict
  {
    const calls = []
    const { sessions, stateDir } = makeSessions({
      toolsConfig: { restrict: false, allow: ['wechat_login'], deny: [] },
      toolsService: { restrict(f) { calls.push(f); return () => {} } }, log: silent,
    })
    await sessions.getOrCreate('u1')
    ok('8e 关闭时完全不碰 tools.restrict', calls.length === 0)
    rmSync(stateDir, { recursive: true, force: true })
  }

  // 8f. 空 allow = 纯聊天,一个工具都不留
  {
    const calls = []
    const { sessions, stateDir } = makeSessions({
      toolsConfig: { restrict: true, allow: [], deny: [] },
      toolsService: { restrict(f) { calls.push(f); return () => {} } }, log: silent,
    })
    await sessions.getOrCreate('u1')
    ok('8f 空 allow 会调 restrict', calls.length === 1)
    ok('8f 空 allow 不传 allow 键', calls[0]?.allow === undefined, JSON.stringify(calls[0]))
    rmSync(stateDir, { recursive: true, force: true })
  }
}

// ────────────────────────────────────────────────────────────
console.log('\n── 回归 9:登录轮询的瞬时错误重试 ──')
// SDK 的 qrLogin 只处理协议层状态,不接网络异常:单次轮询 15 秒超时就会把
// 整个登录打断,而用户可能正拿着手机对着二维码。所以必须区分「瞬时错误」
// (重试)和「协议错误」(直接抛)。
{
  const { isTransientNetworkError } = await import('../lib/client.js')

  const yes = [
    ['AbortError', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })],
    ['TimeoutError', Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
    ['ETIMEDOUT', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })],
    ['ECONNRESET', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ['EAI_AGAIN', Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' })],
    ['UND_ERR_CONNECT_TIMEOUT', Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' })],
    ['cause 里带 code', Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })],
    ['消息里写 timeout', new Error('Request timeout after 15000ms')],
    ['消息里写 fetch failed', new Error('fetch failed')],
  ]
  for (const [label, error] of yes) {
    ok(`9 瞬时错误要重试:${label}`, isTransientNetworkError(error) === true)
  }

  const no = [
    ['null', null],
    ['参数错', new Error('invalid qrcode')],
    ['凭证缺失', new Error('Login confirmed but server did not return credentials')],
    ['QR 过期太多次', new Error('QR code expired 5 times — login aborted')],
    ['401', Object.assign(new Error('unauthorized'), { code: 'ERR_UNAUTHORIZED' })],
  ]
  for (const [label, error] of no) {
    ok(`9 协议错误不重试:${label}`, isTransientNetworkError(error) === false)
  }
}

// ────────────────────────────────────────────────────────────
console.log('\n── 回归 10:入站图片走 attachments(原生进模型) ──')
// 这条是工具收口的配套:收口之后微信会话没有文件工具,「落盘 + 正文写路径」
// 等于图发进来模型看不见。所以图片必须走 attachments 变成原生图片块。
{
  const { buildAgentBody } = await import('../lib/inbound.js')

  const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex')
  const mkMsg = () => ({
    userId: 'u1',
    text: '看看这个',
    raw: { message_id: 'm1' },
    images: [{ kind: 'image' }],
  })
  const mkClient = () => ({
    async download() {
      return { data: PNG_BYTES, mimeType: 'image/png', type: 'image', fileName: 'pic.png' }
    },
  })
  const stateDirOf = () => mkdtempSync(join(tmpdir(), 'wechat-reg-att-'))

  // 10a. attachments 可用 → 出原生图片块,正文里**不再**写路径
  {
    const saved = []
    const attachments = {
      async saveImage(input) {
        saved.push(input)
        return { attachmentId: 'att-1', mediaType: 'image/png', bytes: input.data.length, width: 1, height: 1 }
      },
    }
    const stateDir = stateDirOf()
    const out = await buildAgentBody(mkMsg(), {
      client: mkClient(), settings: mergeConfig({ stateDir }), stateDir, log: silent, attachments,
    })
    ok('10a 调用了 attachments.saveImage', saved.length === 1)
    ok('10a 传的是图片字节', saved[0]?.data?.length === PNG_BYTES.length)
    ok('10a 传了正确的 mediaType', saved[0]?.mediaType === 'image/png')
    ok('10a 内容里有 image 块', out.content.some((c) => c.type === 'image'), JSON.stringify(out.content))
    const img = out.content.find((c) => c.type === 'image')
    ok('10a image 块带 attachment 引用', img?.attachment?.attachmentId === 'att-1', JSON.stringify(img))
    ok('10a 正文里不再出现 [图片] 路径', !out.body.includes('[图片]'), out.body)
    ok('10a 配文还在', out.body.includes('看看这个'), out.body)
    ok('10a 文本块在图片块之前', out.content[0]?.type === 'text', JSON.stringify(out.content.map((c) => c.type)))
    ok('10a nativeImageCount = 1', out.nativeImageCount === 1)
    rmSync(stateDir, { recursive: true, force: true })
  }

  // 10b. attachments 不可用 → 回落成路径写法(老行为)
  {
    const stateDir = stateDirOf()
    const out = await buildAgentBody(mkMsg(), {
      client: mkClient(), settings: mergeConfig({ stateDir }), stateDir, log: silent, attachments: undefined,
    })
    ok('10b 没有 image 块', !out.content.some((c) => c.type === 'image'))
    ok('10b 正文里写了路径', /\[图片\] .+\.png/.test(out.body), out.body)
    ok('10b nativeImageCount = 0', out.nativeImageCount === 0)
    rmSync(stateDir, { recursive: true, force: true })
  }

  // 10c. 格式不被 attachments 接受(比如 tiff)→ 回落路径,不能丢
  {
    const stateDir = stateDirOf()
    const out = await buildAgentBody(mkMsg(), {
      client: { async download() { return { data: PNG_BYTES, mimeType: 'image/tiff', type: 'image' } } },
      settings: mergeConfig({ stateDir }), stateDir, log: silent,
      attachments: { async saveImage() { throw new Error('不该被调用') } },
    })
    ok('10c 不支持的格式回落到路径', /\[图片\] /.test(out.body), out.body)
    ok('10c 没有 image 块', !out.content.some((c) => c.type === 'image'))
    rmSync(stateDir, { recursive: true, force: true })
  }

  // 10d. saveImage 抛错 → 回落路径,消息不能因此丢掉
  {
    const stateDir = stateDirOf()
    const warns = []
    const log = { info() {}, warn: (m) => warns.push(String(m)), error() {}, log() {} }
    const out = await buildAgentBody(mkMsg(), {
      client: mkClient(), settings: mergeConfig({ stateDir }), stateDir, log,
      attachments: { async saveImage() { throw new Error('存储满了') } },
    })
    ok('10d 抛错时回落到路径', /\[图片\] /.test(out.body), out.body)
    ok('10d 报了警告', warns.some((w) => w.includes('attachments')), JSON.stringify(warns))
    rmSync(stateDir, { recursive: true, force: true })
  }

  // 10e. 纯图片没配文 → 内容不能是空的
  {
    const stateDir = stateDirOf()
    const msg = mkMsg()
    delete msg.text
    const out = await buildAgentBody(msg, {
      client: mkClient(), settings: mergeConfig({ stateDir }), stateDir, log: silent,
      attachments: { async saveImage(input) { return { attachmentId: 'a', mediaType: input.mediaType, bytes: 1, width: 1, height: 1 } } },
    })
    ok('10e 纯图片也有内容', out.content.length >= 1, JSON.stringify(out.content))
    ok('10e body 非空(投递要判空)', out.body.length > 0, JSON.stringify(out.body))
    rmSync(stateDir, { recursive: true, force: true })
  }

  // 10f. 语音仍然走落盘 + 平台转写
  {
    const stateDir = stateDirOf()
    const out = await buildAgentBody({
      userId: 'u1', raw: { message_id: 'm2' },
      voices: [{ text: '平台转写的内容' }],
    }, {
      client: { async download() { return { data: Buffer.from('fake'), mimeType: 'audio/silk', type: 'voice' } } },
      settings: mergeConfig({ stateDir }), stateDir, log: silent, attachments: undefined,
    })
    ok('10f 语音转写在正文里', out.body.includes('平台转写的内容'), out.body)
    ok('10f 语音文件也落了盘', /\[语音\] /.test(out.body), out.body)
    rmSync(stateDir, { recursive: true, force: true })
  }

  // 10g. selftestAttachments —— 入站图片通路的自检
  //
  // 这条自检存在的意义:入站图片**只有**「变 attachments 原生块」这一条路。
  // 收口之后微信会话没有文件工具,图片要是只落了个路径,模型就完全看不见,
  // 而现象是「她收到了图但答非所问」—— 很难联想到是这条路断了。
  {
    const { selftestAttachments } = await import('../lib/inbound.js')

    // 服务在 → 应该收下,并把引用返回
    let seen = null
    const good = await selftestAttachments(
      { async saveImage(input) { seen = input; return { attachmentId: 'sha256:abc', mediaType: input.mediaType, bytes: input.data.length } } },
      silent,
    )
    ok('10g 服务在时自检通过', good.ok === true, JSON.stringify(good))
    ok('10g 传的是 image/png', seen?.mediaType === 'image/png', JSON.stringify(seen))
    ok('10g 真的给了 PNG 字节', seen?.data?.[0] === 0x89 && seen?.data?.[1] === 0x50, `前两字节 ${seen?.data?.[0]},${seen?.data?.[1]}`)
    ok('10g 返回了引用', Boolean(good.ref?.attachmentId), JSON.stringify(good.ref))

    // 服务不在 → 明确说不可用,不能假装成功
    const noSvc = await selftestAttachments(undefined, silent)
    ok('10g 服务不在时明确报不可用', noSvc.ok === false && /拿不到/.test(noSvc.reason ?? ''), JSON.stringify(noSvc))

    // saveImage 抛错 → 也要说失败,不能吞
    const bad = await selftestAttachments({ async saveImage() { throw new Error('boom') } }, silent)
    ok('10g saveImage 抛错时自检报失败', bad.ok === false, JSON.stringify(bad))
  }
}

// ────────────────────────────────────────────────────────────
console.log('\n── 回归 11:回复不会发两遍 ──')
// 助手正文会被 onSessionEvent 自动发出去;wechat_send 也能发文字。模型要是
// 用 wechat_send 回了话、正文又写了同样一句,对方就会收到两遍。
// (dsh-qqbot 没这问题是因为它的 qqbot_send_file 只发文件不发文字。)
{
  const { createOutbound } = await import('../lib/outbound.js')

  const mkOutbound = () => {
    const sent = []
    const counted = []
    const log = { info() {}, warn() {}, error() {}, log() {} }
    const sessions = {
      findBySessionId: (id) => (id === 'S1' ? { sessionId: 'S1', userId: 'u1' } : undefined),
    }
    const client = { async sendText(userId, text) { sent.push({ userId, text }) } }
    const outbound = createOutbound({
      settings: mergeConfig({ send: { maxChars: 2000 } }), log, client, sessions,
      onSent: (userId, text) => counted.push({ userId, text }),
    })
    return { outbound, sent, counted }
  }
  const event = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })

  // 11a. 正常回复照发
  {
    const { outbound, sent } = mkOutbound()
    await outbound.onSessionEvent({ header: { id: 'S1' } }, event('在'))
    ok('11a 普通回复正常发出', sent.length === 1 && sent[0].text === '在', JSON.stringify(sent))
  }

  // 11a2. 发出去了就要计数
  //
  // 这条是补的:diagnostics.sent 以前**从头到尾没人加过**,于是 wechat_status
  // 永远报「发出 0 条」—— 明明发出去好几条。状态工具报假数最误导排查。
  {
    const { outbound, sent, counted } = mkOutbound()
    await outbound.sendTo('u1', '直接发')
    ok('11a2 sendTo 真的发出去了', sent.length === 1, JSON.stringify(sent))
    ok('11a2 sendTo 也会计数', counted.length === 1 && counted[0].text === '直接发', JSON.stringify(counted))

    const b = mkOutbound()
    await b.outbound.onSessionEvent({ header: { id: 'S1' } }, event('自动发'))
    ok('11a2 自动回复也会计数', b.counted.length === 1, JSON.stringify(b.counted))

    // 被去重挡掉的那次不该计数
    const c = mkOutbound()
    c.outbound.noteManualTextSend('u1', '在')
    await c.outbound.onSessionEvent({ header: { id: 'S1' } }, event('在'))
    ok('11a2 没发出去就不计数', c.counted.length === 0, JSON.stringify(c.counted))
  }

  // 11b. 手动发过同样的话 → 正文不再自动发一遍
  {
    const { outbound, sent } = mkOutbound()
    outbound.noteManualTextSend('u1', '在')
    await outbound.onSessionEvent({ header: { id: 'S1' } }, event('在'))
    ok('11b 手动发过同样的话就不再自动重发', sent.length === 0, JSON.stringify(sent))
  }

  // 11c. 只挡一次 —— 下次说同样的话还是要发(不能永久拉黑这句话)
  {
    const { outbound, sent } = mkOutbound()
    outbound.noteManualTextSend('u1', '在')
    await outbound.onSessionEvent({ header: { id: 'S1' } }, event('在'))
    await outbound.onSessionEvent({ header: { id: 'S1' } }, event('在'))
    ok('11c 只挡一次,第二次照发', sent.length === 1, JSON.stringify(sent))
  }

  // 11d. 内容不同 → 照发(不能误伤)
  {
    const { outbound, sent } = mkOutbound()
    outbound.noteManualTextSend('u1', '在')
    await outbound.onSessionEvent({ header: { id: 'S1' } }, event('不在'))
    ok('11d 内容不同不误伤', sent.length === 1 && sent[0].text === '不在', JSON.stringify(sent))
  }

  // 11e. 发给别人 → 不挡
  {
    const { outbound, sent } = mkOutbound()
    outbound.noteManualTextSend('u2', '在')
    await outbound.onSessionEvent({ header: { id: 'S1' } }, event('在'))
    ok('11e 发给别人的不挡本会话', sent.length === 1, JSON.stringify(sent))
  }

  // 11f. 空文本登记应当被忽略(别把 '' 存进去)
  {
    const { outbound, sent } = mkOutbound()
    outbound.noteManualTextSend('u1', '   ')
    await outbound.onSessionEvent({ header: { id: 'S1' } }, event('在'))
    ok('11f 空白文本不登记', sent.length === 1, JSON.stringify(sent))
  }
}

// ────────────────────────────────────────────────────────────
console.log('\n── 回归 12:入站媒体解密(拿标准向量对,不自洽) ──')
// 入站图片/语音/文件都要过 CDN 的 AES-128-ECB 解密。这是整条媒体链路里
// **唯一没法用本地 mock 验**的一环 —— 要么真收到一条媒体,要么拿外部已知答案对。
//
// 拿的是 FIPS-197 C.1 的 AES-128 标准向量。为什么非要用外部向量:
// 自洽的加解密对可以**同时是错的**(加密写错、解密也照错写,来回都对),
// 只有标准文档给的已知答案才算证据。这条原则在这个项目里已经吃过一次亏
// (二维码的格式信息副本2 —— 编码解码都是自己写的,一起错)。
{
  const { encryptAesEcb, decryptAesEcb, decodeAesKey, encodeAesKeyHex, encodeAesKeyBase64, encryptedSize }
    = await import('../vendor/wechatbot/dist/media/crypto.js')

  const KEY = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
  const PT = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const WANT = '69c4e0d86a7b0430d8cdb78070b4c55a'   // FIPS-197 C.1

  const ct = encryptAesEcb(PT, KEY)
  ok('12a 密文按 16 字节对齐(有 PKCS7 填充)', ct.length % 16 === 0 && ct.length > PT.length,
    `明文 ${PT.length} → 密文 ${ct.length}`)
  ok('12a 第一块 == FIPS-197 标准向量', ct.subarray(0, 16).toString('hex') === WANT,
    `${ct.subarray(0, 16).toString('hex')} vs ${WANT}`)
  ok('12a 解得回原明文', decryptAesEcb(ct, KEY).equals(PT))

  // 加密尺寸公式 —— 上传前要拿它算加密后大小
  for (const [n, want] of [[0, 16], [1, 16], [15, 16], [16, 32], [17, 32], [31, 32], [32, 48]]) {
    ok(`12b encryptedSize(${n}) == ${want}`, encryptedSize(n) === want, String(encryptedSize(n)))
  }

  // aes_key 在协议里有三种编码形态,认错一个就解不开图
  const k = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
  ok('12c 直接 hex(32 字符)解得出', decodeAesKey(encodeAesKeyHex(k)).equals(k))
  ok('12c base64(原始 16 字节)解得出', decodeAesKey(k.toString('base64')).equals(k))
  ok('12c base64(hex 32 字符)解得出', decodeAesKey(encodeAesKeyBase64(k)).equals(k))
  ok('12c 乱码 key 要抛错(不能静默给个错 key)',
    (() => { try { decodeAesKey('不是个 key'); return false } catch { return true } })())
}

// ────────────────────────────────────────────────────────────
console.log('\n── 回归 13:语音合成里的 WAV 解析 ──')
// dashscope 的 TTS 返回的 WAV,**RIFF 和 data 两个长度字段都是流式占位值**
// (实测 0x7fffffbf / 0x7fffffdb),不是真实长度。标准解析器会拒收
// (silk-wasm 的 isWav() 就拒了),所以自己剥 PCM 时必须夹到实际文件长度。
{
  const { parseWav } = await import('../lib/voice.js')

  // 造一个「长度字段是占位值」的 WAV
  const pcm = Buffer.alloc(32, 7)          // 32 字节假 PCM
  const wav = Buffer.alloc(44 + pcm.length)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(0x7fffffbf, 4)          // ← 占位值,不是真实长度
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)                  // PCM
  wav.writeUInt16LE(1, 22)                  // 单声道
  wav.writeUInt32LE(24000, 24)              // 24kHz
  wav.writeUInt32LE(48000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(0x7fffffdb, 40)         // ← 也是占位值
  pcm.copy(wav, 44)

  const info = parseWav(wav)
  ok('13a 认出 24kHz 单声道 16bit', info.sampleRate === 24000 && info.channels === 1 && info.bits === 16,
    JSON.stringify({ r: info.sampleRate, c: info.channels, b: info.bits }))
  ok('13a 占位长度不会越界读', info.pcm.length === 32, `读到 ${info.pcm.length} 字节,应为 32`)
  ok('13a PCM 内容正确', info.pcm.equals(pcm))

  // 正常 WAV(真实长度)也要认
  const wav2 = Buffer.from(wav)
  wav2.writeUInt32LE(wav2.length - 8, 4)
  wav2.writeUInt32LE(32, 40)
  ok('13a 真实长度的 WAV 也认', parseWav(wav2).pcm.length === 32)

  ok('13a 不是 WAV 要抛错(不能静默当 PCM)', (() => {
    try { parseWav(Buffer.from('这不是 WAV 啦')); return false } catch { return true }
  })())
}

// ────────────────────────────────────────────────────────────
console.log('\n── 回归 14:sendmessage 必须检查 ret ──')
// 上游把服务端返回原样丢掉,没人看 ret —— 服务端拒了消息也一路「发送成功」。
// 发语音那轮就是栽在这上面:没报错,但对方什么都没收到。
// 这里直接读源码钉住这个补丁,免得将来重新同步 vendor 时被冲掉。
{
  const { readFileSync: readSrc } = await import('node:fs')
  const src = readSrc(new URL('../vendor/wechatbot/dist/protocol/api.js', import.meta.url), 'utf8')
  ok('14a sendMessage 检查了 ret', /res\.ret\s*!==\s*0/.test(src), '没找到 ret 校验 —— 静默失败会回来')
  ok('14a 非 0 会抛错', /throw err/.test(src))
  ok('14a 保留了原始返回(便于排查)', /err\.response\s*=\s*res/.test(src))

  // 语音那两个字段也不能被冲掉:少了它们服务端照收但不投递
  const builder = readSrc(new URL('../vendor/wechatbot/dist/message/builder.js', import.meta.url), 'utf8')
  ok('14b voice_item 带 bits_per_sample', /bits_per_sample/.test(builder))
  ok('14b voice_item 带 sample_rate', /sample_rate/.test(builder))
}

// ────────────────────────────────────────────────────────────
console.log('\n── 回归 15:客户端界面(插件页里的二维码) ──')
// 客户端插件是**预打包**的,不跑构建、也没法 import 进来测行为。
// 但它有几条约定踩错了就整块不显示,而且报错在浏览器控制台里 —— 服务端
// 日志里什么都看不到。所以至少把约定钉住。
{
  const { readFileSync: readSrc } = await import('node:fs')
  const pkg = JSON.parse(readSrc(new URL('../package.json', import.meta.url), 'utf8'))
  const uiPath = new URL('../client/ui.js', import.meta.url)
  const ui = readSrc(uiPath, 'utf8')

  ok('15a package.json 声明了 ./client 出口',
    pkg.exports?.['./client'] === './client/ui.js', JSON.stringify(pkg.exports))
  ok('15a 文件真的存在', ui.length > 0)
  ok('15a dsh.client 声明了 platform=web',
    pkg.dsh?.client?.platform === 'web', JSON.stringify(pkg.dsh?.client))
  ok('15a dsh.client 注入了插件管理器',
    (pkg.dsh?.client?.inject ?? []).some((n) => n.includes('plugin-manager')),
    JSON.stringify(pkg.dsh?.client?.inject))

  // ⚠️ 这条最要命:dsh-meme 的注释里记着 —— id 不等于包名时,
  // ModuleLoader 会报「loaded without registering <name>」然后整块不显示。
  const idMatch = /__ModuleLoader__\.load\(\s*\{\s*id:\s*'([^']+)'/.exec(ui)
  ok('15b loader id == 包名', idMatch && idMatch[1] === pkg.name,
    `id=${idMatch?.[1]} 包名=${pkg.name}`)

  ok('15b 导出 apply', /exports\.apply\s*=/.test(ui))
  ok('15b 导出 inject', /exports\.inject\s*=/.test(ui))
  ok('15b inject 里有 slots', /inject\s*=\s*\[\s*'slots'/.test(ui))

  // 挂到插件页上
  ok('15c 注册进 plugins.bundle.config', /plugins\.bundle\.config/.test(ui))
  ok('15c key 用包名', ui.includes("key: '" + pkg.name + "'"), 'key 得是包名,不然插件页上不显示')
  // 行那一层也挂(不同 DSH 版本入口不同)
  ok('15c 也注册了 plugins.row.config', /plugins\.row\.config/.test(ui))
  ok('15c 行 key 是 包名#行id', ui.includes("key: '" + pkg.name + '#'), '行 key 规则:<包名>#<patch 里声明的行 id>')

  // 二维码复用宿主已有的路由,不自己画
  ok('15d 二维码用宿主的 qr.png 路由', /\/wechat-channel\/qr\.png/.test(ui))
  ok('15d 状态用宿主的 status 路由', /BASE\s*=\s*'\/wechat-channel'/.test(ui) && /\/status/.test(ui), '状态端点')
  ok('15d 登录用宿主的 login 路由', /\/login/.test(ui), '登录端点')
  // 二维码会换,不能吃缓存
  ok('15d 二维码带 cache-bust 参数', /qr\.png\?t=/.test(ui))
}

// ────────────────────────────────────────────────────────────
console.log('\n── 回归 12:登出要真登出 ──')
// 只清内存 meta 的话,凭证还在 <stateDir>/sdk/credentials.json,
// 下次启动 autoLogin 会拿它直接登回来 ——「登出」等于没发生。
{
  const { createClient } = await import('../lib/client.js')
  const { existsSync, writeFileSync: writeF, mkdirSync: mkdirD } = await import('node:fs')

  const stateDir = mkdtempSync(join(tmpdir(), 'wechat-reg-logout-'))
  const sdkDir = join(stateDir, 'sdk')
  mkdirD(sdkDir, { recursive: true })
  // 假装登过一次:SDK 的 FileStorage 每个 key 一个 json
  for (const key of ['credentials', 'cursor', 'context_tokens', 'typing_tickets']) {
    writeF(join(sdkDir, `${key}.json`), JSON.stringify({ fake: key }))
  }

  const store = createStore(stateDir)
  const client = createClient({
    settings: mergeConfig({ stateDir, login: { autoLogin: false } }),
    store, log: silent, hooks: {},
  })

  ok('12 有凭证时 hasStoredCredentials 为真', client.hasStoredCredentials() === true)

  await client.logout()

  ok('12 登出后 credentials.json 没了', !existsSync(join(sdkDir, 'credentials.json')))
  ok('12 登出后整个 sdk 目录都没了', !existsSync(sdkDir))
  ok('12 登出后 hasStoredCredentials 为假', client.hasStoredCredentials() === false)
  ok('12 登出后 isLoggedIn 为假', client.isLoggedIn() === false)
  ok('12 重复登出不抛错', await client.logout().then(() => true, () => false))

  rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${'─'.repeat(44)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
