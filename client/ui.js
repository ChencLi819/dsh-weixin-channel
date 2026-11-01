// 微信渠道的客户端界面:把实时二维码放进插件页。
//
// ── 为什么要这么写 ──
// DSH 的客户端插件不是普通 ESM,而是**预打包**成 `window.__ModuleLoader__.load(...)`
// 的形式,由宿主发给浏览器。所以这里不能用 import / JSX —— 只能用 factory 里
// `require("react")` 拿到的 React 和 `react.createElement`。
// 形状照着 dsh-meme / dsh-free-search 的 client.js 抄的(同一套机制)。
//
// ⚠️ `id` 必须等于**包名**(dsh-weixin-channel)。写成别的,ModuleLoader 会报
// 「loaded without registering ...」然后整块不显示(dsh-meme 的注释里记了这条)。
//
// ── 挂在哪 ──
// `plugins.bundle.config` 插槽,key = 包名。挂上之后,
// 侧栏「插件 → 已安装 → dsh-weixin-channel」那一页的说明文字下面就会出现这张卡片。
//
// ── 二维码从哪来 ──
// 不重新画:直接 <img src="/wechat-channel/qr.png">,用宿主已经注册好的那个路由。
// 二维码是插件在服务端生成并落盘的,两边各写一份迟早会不一致。
window.__ModuleLoader__.load({
  id: 'dsh-weixin-channel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    let react = require('react')

    const BASE = '/wechat-channel'
    const h = react.createElement

    /**
     * 轮询宿主的状态端点。
     * 登录状态会自己变(扫码、确认、过期),所以不能只读一次。
     * 2 秒一次:够快,又不至于把 webserver 打满。
     */
    function useStatus(intervalMs) {
      const [status, setStatus] = react.useState(null)
      const [error, setError] = react.useState('')
      react.useEffect(() => {
        let alive = true
        let timer
        const tick = async () => {
          try {
            const res = await fetch(`${BASE}/status`, { cache: 'no-store' })
            // 路由没注册时返回的是 404 的 HTML/空体 —— 直接 res.json() 会抛
            // 「Unexpected end of JSON input」,完全看不出真正原因是 404。
            // 先把状态码说清楚,再谈解析。
            if (!res.ok) {
              if (alive) setError(`状态接口返回 HTTP ${res.status} —— 插件的路由可能没注册`)
              if (alive) timer = setTimeout(tick, intervalMs)
              return
            }
            const text = await res.text()
            let json = null
            try { json = text ? JSON.parse(text) : null } catch { /* 下面按空处理 */ }
            if (!alive) return
            if (!json) {
              setError('状态接口返回的不是 JSON')
            } else {
              setStatus(json)
              setError(json.error ? String(json.error) : '')
            }
          } catch (e) {
            if (alive) setError(String((e && e.message) || e))
          }
          if (alive) timer = setTimeout(tick, intervalMs)
        }
        tick()
        return () => { alive = false; clearTimeout(timer) }
      }, [intervalMs])
      return { status, error }
    }

    const S = {
      card: {
        border: '1px solid rgba(0,0,0,.08)',
        borderRadius: 12,
        padding: '16px 18px',
        margin: '12px 0',
        background: 'rgba(255,255,255,.6)',
        fontFamily: '-apple-system, "SF Pro Text", "PingFang SC", "Segoe UI", system-ui, sans-serif',
        color: 'inherit',
      },
      head: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 },
      title: { fontSize: 15, fontWeight: 600 },
      dot: (color) => ({ width: 8, height: 8, borderRadius: '50%', background: color, flex: 'none' }),
      sub: { fontSize: 13, color: '#6e6e73', lineHeight: 1.6 },
      row: { display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' },
      btn: {
        font: 'inherit', fontSize: 13, padding: '5px 12px', borderRadius: 8,
        border: '1px solid rgba(0,0,0,.14)', background: 'rgba(255,255,255,.9)',
        cursor: 'pointer', color: 'inherit',
      },
      qrWrap: {
        marginTop: 14, padding: 12, borderRadius: 10, background: '#fff',
        border: '1px solid rgba(0,0,0,.08)', display: 'inline-block', lineHeight: 0,
      },
      qr: { width: 240, height: 240, imageRendering: 'pixelated', display: 'block' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, wordBreak: 'break-all' },
      warn: { color: '#b25000' },
    }

    function WeChatCard() {
      const { status, error } = useStatus(2000)
      const [busy, setBusy] = react.useState(false)
      const [note, setNote] = react.useState('')
      const [imgOk, setImgOk] = react.useState(true)
      // 已登录时默认不显示二维码(没什么用),但用户主动点了「换一张二维码」
      // 就得给他看 —— 否则按钮点了像没反应。
      const [showQr, setShowQr] = react.useState(false)

      // 二维码换了就换 src(qrAt 变了 → 浏览器不会拿旧缓存)
      const qrSrc = status && status.qrAt
        ? `${BASE}/qr.png?t=${encodeURIComponent(status.qrAt)}`
        : `${BASE}/qr.png`

      react.useEffect(() => { setImgOk(true) }, [qrSrc])

      const doLogin = async () => {
        setBusy(true)
        setShowQr(true)
        setNote('正在向微信要二维码…')
        try {
          const res = await fetch(`${BASE}/login`, { method: 'POST' })
          if (!res.ok) {
            // 405 / 404 基本都是「路由没注册」,不是「请求写错了」。
            // 光显示一个数字帮不上忙,把可能的原因写出来。
            setNote(res.status === 405 || res.status === 404
              ? `失败:HTTP ${res.status} —— 插件的路由没注册,重启 DSH 后再试`
              : `失败:HTTP ${res.status}`)
            return
          }
          setNote('二维码已更新 —— 用微信扫上面那张。')
        } catch (e) {
          setNote(`失败:${String((e && e.message) || e)}`)
        } finally {
          setBusy(false)
        }
      }

      const loggedIn = Boolean(status && status.loggedIn)
      const scanned = Boolean(status && status.scanned)
      const qrReady = Boolean(status && status.qrReady)

      let dot = '#8e8e93'
      let line = '正在读取状态…'
      if (error) { dot = '#d70015'; line = error }
      else if (loggedIn) { dot = '#34c759'; line = '已登录,收消息中。' }
      else if (scanned) { dot = '#ff9500'; line = '已扫码 —— 请在手机上点确认。' }
      else if (qrReady) { dot = '#ff9500'; line = '等扫码。这张码是当前有效的,过期会自动换新。' }
      else if (status) { dot = '#8e8e93'; line = '还没登录 —— 点下面的按钮生成二维码。' }

      const children = [
        h('div', { key: 'head', style: S.head }, [
          h('span', { key: 'd', style: S.dot(dot) }),
          h('span', { key: 't', style: S.title }, '微信渠道'),
          h('span', { key: 's', style: { ...S.sub, marginLeft: 'auto' } }, loggedIn ? '运行中' : '未登录'),
        ]),
        h('div', { key: 'line', style: S.sub }, line),
      ]

      if (loggedIn && status && status.userId) {
        children.push(h('div', { key: 'uid', style: { ...S.sub, ...S.mono, marginTop: 6 } },
          `本人:${status.userId}`))
      }

      const qrVisible = qrReady && imgOk && (!loggedIn || showQr)
      if (qrVisible) {
        children.push(h('div', { key: 'qr', style: S.qrWrap },
          h('img', {
            src: qrSrc,
            alt: '微信登录二维码',
            style: S.qr,
            onError: () => setImgOk(false),
          })))
        children.push(h('div', { key: 'hint', style: { ...S.sub, marginTop: 8 } },
          '用微信扫这张码。授权出来的是一个「机器人身份」,不会读你的通讯录和朋友圈。'))
      }

      if (qrReady && !imgOk && (!loggedIn || showQr)) {
        children.push(h('div', { key: 'noimg', style: { ...S.sub, ...S.warn, marginTop: 10 } },
          '二维码图片加载失败 —— 可能刚被换掉了,点下面的按钮重新生成。'))
      }

      children.push(h('div', { key: 'row', style: S.row }, [
        h('button', {
          key: 'btn',
          type: 'button',
          style: { ...S.btn, opacity: busy ? 0.5 : 1 },
          disabled: busy,
          onClick: doLogin,
        }, busy ? '正在生成…' : (qrReady ? '换一张二维码' : '生成二维码')),
        h('a', {
          key: 'open',
          href: `${BASE}/qr`,
          target: '_blank',
          rel: 'noreferrer',
          style: { ...S.sub, textDecoration: 'underline' },
        }, '单独打开二维码页面'),
        note ? h('span', { key: 'note', style: S.sub }, note) : null,
      ]))

      return h('div', { style: S.card }, children)
    }

    const inject = ['slots']

    function apply(ctx) {
      // 包那一层(key = 包名)。插件页的说明文字下面就是这儿。
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          { name: 'plugins.bundle.config', key: 'dsh-weixin-channel' },
          () => h(WeChatCard),
        ))

      // 行那一层(key = "包名#行 id")。DSH 不同版本入口不一样,两边都挂上,
      // 免得只有其中一个生效时看不到卡片。
      ctx.slots.inject('plugins.row.config', () =>
        ctx.slots.register(
          { name: 'plugins.row.config', key: 'dsh-weixin-channel#wechat-channel' },
          () => h(WeChatCard),
        ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
