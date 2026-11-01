// 实时二维码页面。
//
// 为什么需要它:扫码是「人现在就要看着一张**当前有效**的图」的动作,而
// 任何静态快照都会过期 —— 服务端每隔一阵就换一张二维码,聊天里贴的那张图
// 从贴出去那一刻就开始变旧。
//
// 所以这里注册几条 HTTP 路由,挂在 DSH 自己的 web 服务器上:
//   GET  /wechat-channel/qr        → 一个会自动刷新的页面(给人看的)
//   GET  /wechat-channel/qr.png    → 当前二维码(no-store,永远是新的)
//   GET  /wechat-channel/status    → 状态 JSON(页面轮询用)
//   POST /wechat-channel/login     → 现场申请一张新二维码
//
// 页面每 1.5 秒问一次状态;二维码变了才换图,所以不会闪。
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const BASE = '/wechat-channel'

/** 页面本体。没有外部依赖,单文件。 */
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>微信扫码登录</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: #f5f6f8; color: #1a1a1a; padding: 24px;
  }
  @media (prefers-color-scheme: dark) { body { background: #16181d; color: #e8e8e8; } }
  .card {
    background: #fff; border-radius: 16px; padding: 28px 32px 24px; text-align: center;
    box-shadow: 0 6px 28px rgba(0,0,0,.10); max-width: 460px; width: 100%;
  }
  @media (prefers-color-scheme: dark) { .card { background: #21242b; box-shadow: 0 6px 28px rgba(0,0,0,.4); } }
  h1 { font-size: 17px; margin: 0 0 4px; font-weight: 600; }
  .sub { font-size: 13px; opacity: .6; margin-bottom: 18px; }
  .qrbox {
    width: 320px; height: 320px; max-width: 100%; margin: 0 auto 16px;
    display: flex; align-items: center; justify-content: center;
    background: #fff; border: 1px solid rgba(128,128,128,.25); border-radius: 12px;
    position: relative; overflow: hidden;
  }
  .qrbox img { width: 100%; height: 100%; display: block; image-rendering: pixelated; }
  .ph { font-size: 13px; opacity: .5; padding: 0 24px; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #bbb; margin-right: 7px; vertical-align: middle; }
  .dot.on { background: #22c55e; }
  .dot.warn { background: #f59e0b; }
  .dot.err { background: #ef4444; }
  #status { font-size: 14px; min-height: 22px; margin-bottom: 6px; }
  #meta { font-size: 12px; opacity: .5; min-height: 18px; }
  button {
    margin-top: 16px; padding: 9px 20px; font-size: 14px; font-family: inherit; cursor: pointer;
    border: 1px solid rgba(128,128,128,.35); border-radius: 9px; background: transparent; color: inherit;
  }
  button:hover { background: rgba(128,128,128,.12); }
  button:disabled { opacity: .45; cursor: default; }
</style>
</head>
<body>
<div class="card">
  <h1>微信扫码登录</h1>
  <div class="sub">用微信扫下面的码 · 扫完手机上可能要确认</div>
  <div class="qrbox" id="qrbox"><div class="ph" id="ph">正在取二维码…</div></div>
  <div id="status"><span class="dot" id="dot"></span><span id="statustext">连接中…</span></div>
  <div id="meta"></div>
  <button id="btn">重新生成二维码</button>
</div>
<script>
(function () {
  var img = null, lastSig = '', busy = false, objUrl = null;
  var box = document.getElementById('qrbox'), ph = document.getElementById('ph');
  var dot = document.getElementById('dot'), st = document.getElementById('statustext'), meta = document.getElementById('meta');
  var btn = document.getElementById('btn');

  function say(kind, text, extra) {
    dot.className = 'dot' + (kind ? ' ' + kind : '');
    st.textContent = text;
    meta.textContent = extra || '';
  }

  function showQr(blob, sig) {
    if (objUrl) URL.revokeObjectURL(objUrl);
    objUrl = URL.createObjectURL(blob);
    if (!img) {
      img = document.createElement('img');
      img.alt = '微信登录二维码';
      box.innerHTML = '';
      box.appendChild(img);
    }
    img.src = objUrl;
    lastSig = sig;
  }

  async function tick() {
    var s;
    try {
      var r = await fetch('/wechat-channel/status', { cache: 'no-store' });
      s = await r.json();
    } catch (e) {
      say('err', '连不上 DSH', String(e && e.message || e));
      return;
    }

    if (s.loggedIn) {
      say('on', '登录成功', s.userId ? ('本人 ' + s.userId) : '');
      btn.textContent = '已登录 · 重新扫一个';
      return;
    }
    if (s.error) { say('err', '登录失败', s.error); }
    else if (s.scanned) { say('warn', '已扫码 — 请在手机上确认', ''); }
    else if (s.qrReady) { say('warn', '等待扫码', '这张码是当前有效的,过期会自动换新'); }
    else { say('', '还没有二维码', '点下面的按钮生成'); }
    btn.textContent = s.qrReady ? '重新生成二维码' : '生成二维码';

    // 二维码变了才换图(用 ETag 判定),所以页面不会闪
    try {
      var pr = await fetch('/wechat-channel/qr.png', { cache: 'no-store' });
      if (pr.status === 404) return;
      var sig = pr.headers.get('etag') || String((await pr.clone().blob()).size);
      if (sig === lastSig) return;
      showQr(await pr.blob(), sig);
    } catch (e) { /* 下一轮再试 */ }
  }

  btn.addEventListener('click', async function () {
    if (busy) return;
    busy = true; btn.disabled = true;
    say('', '正在申请新二维码…', '');
    try {
      await fetch('/wechat-channel/login', { method: 'POST' });
      lastSig = '';
      await tick();
    } catch (e) {
      say('err', '申请失败', String(e && e.message || e));
    } finally {
      busy = false; btn.disabled = false;
    }
  });

  tick();
  setInterval(tick, 1500);
})();
</script>
</body>
</html>`

const send = (res, status, type, body, extraHeaders = {}) => {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    ...extraHeaders,
  })
  res.end(body)
}

/**
 * 找出这个 web 服务器对外可访问的 origin。
 *
 * 试这么多路是因为没有一条稳定可用的公开接口:config 不一定挂在服务对象上,
 * 端口也可能是 0(让系统分配)之后才定下来。全都失败就返回 null,调用方
 * 退回相对路径 —— 页面照样能开,只是链接不能直接贴给人。
 */
function resolveOrigin({ webServer, webStartup, log }) {
  const attempts = [
    ['webStartup.port', () => webStartup?.port],
    ['webServer.config.port', () => webServer?.config?.port],
    ['webServer.ctx.config.port', () => webServer?.ctx?.config?.port],
    ['webServer.server.address()', () => webServer?.server?.address?.()?.port],
    ['webServer.listeningPort', () => webServer?.listeningPort],
  ]
  const host = webStartup?.host ?? webServer?.config?.host ?? '127.0.0.1'
  for (const [label, get] of attempts) {
    let port
    try { port = get() } catch { port = undefined }
    if (typeof port === 'number' && port > 0) {
      log.info(`实时二维码页面地址来自 ${label}:port=${port}`)
      return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
    }
  }
  // 一条都没成:把服务对象上看起来像端口的字段打出来,方便下次定位
  try {
    const keys = []
    for (let p = webServer; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const k of Object.getOwnPropertyNames(p)) keys.push(k)
    }
    log.warn(`读不到 webServer 端口,退回相对路径。它身上有:${[...new Set(keys)].slice(0, 40).join(', ')}`)
  } catch { /* 忽略 */ }
  return null
}

/**
 * 注册实时二维码页面。
 *
 * @returns {{ url: string|null, dispose: () => void }}
 */
export function createQrPage({ webServer, webStartup, settings, log, stateDir, qrDir, client, getStatus, startLogin }) {
  if (!webServer?.register) {
    log.warn('webServer 服务不可用 —— 实时二维码页面没注册(wechat_login 仍会返回图片路径)')
    return { url: null, dispose: () => {} }
  }

  const qrFile = join(qrDir, 'login-qr.png')
  const disposers = []

  const route = (kind, path, handler) => {
    try {
      disposers.push(webServer.register({ kind, path, handler }))
    } catch (error) {
      log.warn(`注册路由 ${path} 失败:${error?.message ?? error}`)
    }
  }

  route('exact', `${BASE}/qr`, (req, res) => {
    send(res, 200, 'text/html; charset=utf-8', PAGE)
  })

  route('exact', `${BASE}/qr.png`, (req, res) => {
    try {
      if (!existsSync(qrFile)) {
        send(res, 404, 'text/plain; charset=utf-8', '还没有二维码,先调 wechat_login 或点页面上的按钮')
        return
      }
      const stat = statSync(qrFile)
      const etag = `"${stat.size}-${stat.mtimeMs}"`
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-store' })
        res.end()
        return
      }
      send(res, 200, 'image/png', readFileSync(qrFile), { ETag: etag })
    } catch (error) {
      send(res, 500, 'text/plain; charset=utf-8', String(error?.message ?? error))
    }
  })

  route('exact', `${BASE}/status`, (req, res) => {
    try {
      const status = getStatus()
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(status))
    } catch (error) {
      send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: String(error?.message ?? error) }))
    }
  })

  route('exact', `${BASE}/login`, (req, res) => {
    if (req.method !== 'POST') {
      send(res, 405, 'text/plain; charset=utf-8', '用 POST')
      return
    }
    try {
      startLogin()
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }))
    } catch (error) {
      send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    }
  })

  // 监听地址要问运行时 —— 端口不一定是默认值,也可能是系统分配的
  const origin = resolveOrigin({ webServer, webStartup, log })
  const url = origin ? `${origin}${BASE}/qr` : `${BASE}/qr`

  log.info(`实时二维码页面已注册:${url}`)
  return {
    url,
    dispose: () => { for (const d of disposers) { try { d() } catch { /* 忽略 */ } } },
  }
}
