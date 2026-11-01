# dsh-wechat-channel

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-5b6cff.svg)](https://github.com/topics/dsh-plugin)

DeepSeek Harness（DSH）插件。将 agent 接入**微信单聊**：扫码授权出一个机器人身份，
支持文本、图片、语音、文件的收发，并把微信用户映射为 DSH 会话。

通信走**腾讯官方 iLink Bot API**（即微信官方 ClawBot 通道），不是客户端逆向：
不模拟登录、不读取通讯录与朋友圈，只做「一个能收发消息的机器人」。

---

## 目录

- [1. 功能](#1-功能)
- [2. 兼容性与依赖](#2-兼容性与依赖)
- [3. 安装](#3-安装)
- [4. 登录](#4-登录)
- [5. 工具参考](#5-工具参考)
- [6. 配置](#6-配置)
- [7. 安全模型](#7-安全模型)
- [8. 工作原理](#8-工作原理)
- [9. 运维与故障排查](#9-运维与故障排查)
- [10. 已知限制](#10-已知限制)
- [11. 合规与风险](#11-合规与风险)
- [12. 开发](#12-开发)
- [13. 第三方代码](#13-第三方代码)
- [14. 许可证](#14-许可证)
- [English Overview](#english-overview)

---

## 1. 功能

| 能力 | 说明 |
| --- | --- |
| 扫码登录 | 生成二维码 PNG，用微信扫码授权；凭证落盘，重启免扫 |
| 入站消息 | 长轮询接收文本、图片、语音、文件、视频；消息 ID 去重 |
| 图片处理 | 入站图片经 DSH `attachments` 服务转为原生图片块，直接进入模型视野 |
| 语音转写 | 优先使用平台自带转写文本，不依赖外部 ASR 服务 |
| 出站消息 | 文本按句子边界自动切分；图片与文件按扩展名路由 |
| 会话映射 | 微信用户与 DSH 会话确定性映射，重启后可续接上下文 |
| 白名单 | 默认仅放行登录者本人；名单为空时不会退化为放行所有人 |
| 工具收口 | 微信会话可见的工具面被限制为白名单内的若干项（默认 26 个） |
| 插件页二维码 | 在 DSH 界面内直接显示登录二维码，无需翻找文件 |

---

## 2. 兼容性与依赖

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| DSH | 宿主包 `^0.1.0-rc.6` 或 `^0.2.0-rc.1` | 见 `peerDependencies` |
| Node.js | `>= 22` | 使用内置 `fetch`、`node:crypto` 等 |
| 微信 | 已开通 ClawBot / iLink Bot 通道的微信号 | 登录时由服务端下发二维码 |
| `@deepseek-ai/schemastery` | `^3.18.1` | 配置校验 |
| `silk-wasm` | 可选 | 解码 SILK 语音；未安装时落盘为原始 SILK（不影响转写文本） |
| Python | 可选 | 仅用于二维码解码对照测试（`tools/qr-suite-check.py`） |

---

## 3. 安装

### 3.1 通过 DSH CLI 安装（推荐）

```bash
# 从 npm 安装
dsh plugin --profile web add dsh-wechat-channel

# 或从源码安装
dsh plugin --profile web add github:ChencLi819/dsh-wechat-channel

# Desktop 版
dsh plugin --profile desktop add dsh-wechat-channel
```

安装完成后重启 DSH。

### 3.2 通过仓库脚本 / link 安装

以 `link:` 方式安装（改源码即时生效）时，需要在插件目录补一层指向宿主包的链接：

```powershell
cd <你的 profile 目录>
pnpm add link:<本仓库路径>

# 补依赖链接：插件用 link 装进来时是 junction，Node 会解析成真实路径，
# 于是去真实路径下找 @deepseek-ai/*，找不到会报 ERR_MODULE_NOT_FOUND
$src = "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai"
$dst = "<本仓库路径>\node_modules\@deepseek-ai"
New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
New-Item -ItemType Junction -Path $dst -Target $src
```

然后在 profile 的 `package.json` 的 `dsh.profile.bundles` 中加入 `dsh-wechat-channel`，重启 DSH。
插件会写入体检文件 `~/.dsh/wechat-channel/diagnostic.json`。

### 3.3 升级与卸载

| 操作 | 步骤 |
| --- | --- |
| 升级 | 重新执行 CLI 安装命令；`link:` 方式更新源码后重启 DSH |
| 卸载 | 从 `dsh.profile.bundles` 中移除，并卸载依赖；如不再使用，删除 `~/.dsh/wechat-channel` |

---

## 4. 登录

1. 调用 `wechat_login`（`action=start`）申请二维码，返回 PNG 路径
   （默认 `~/.dsh/wechat-channel/login-qr.png`）
2. 用微信扫码
3. 若手机提示输入配对码，调用 `wechat_login`（`action=verify`，`code=<配对码>`）

凭证保存在 `~/.dsh/wechat-channel/sdk/`，之后启动自动登录。

`action=logout` 会停止轮询并**删除凭证目录**——仅清理内存不够，凭证留在磁盘上时
下次启动会自动登录回来。

> **二维码必须实时轮询。** 二维码存在有效期，且扫码后需要插件在轮询中接收服务端下发的
> 凭证。因此不要用截图代替插件自身发起的登录流程，也不要关掉进程后再扫。

---

## 5. 工具参考

插件注册 3 个工具。所有工具的输出均为 `{ text: string }`。

### 5.1 `wechat_login`

管理登录状态。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | string | 是 | `start` 生成二维码 / `verify` 提交配对码 / `logout` 清除登录状态 |
| `code` | string | 否 | 配对码，`action=verify` 时必填 |

### 5.2 `wechat_status`

查询渠道状态：登录情况、二维码位置、收发计数、白名单。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `selftest` | boolean | `false` | 为 `true` 时真实建立一次会话，校验工具收口名单的有效性 |

`selftest` 会给出权威结论：哪些工具名有效、哪些不存在。日常无需开启。

### 5.3 `wechat_send`

向微信发送内容。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `userId` | string | 当前会话对端 | 目标微信用户 ID |
| `text` | string | — | 文本内容 |
| `file` | string | — | http(s) 链接（插件自行下载）或本地绝对路径 |

回复当前会话不需要调用此工具，正文会自动发送。`text` 与 `file` 同时提供时拆为两条消息发送
（微信不支持图文混合单条消息）。

---

## 6. 配置

默认值定义于 `lib/config.js`。在 profile 的 `cordis.patch.yml` 中按需覆盖，配置为深合并：

```yaml
- id: wechat-channel
  config:
    allow:
      users: ['wxid_xxxxxxxx']     # 留空 = 只放行登录者本人
    send:
      maxPerMinute: 6
    session:
      resetCommand: '/new'
    tools:
      restrict: true
      allow: [wechat_login, wechat_status, wechat_send]
```

| 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 插件总开关 |
| `stateDir` | string | `~/.dsh/wechat-channel` | 状态目录：凭证、context token、日志、媒体 |
| `baseUrl` | string | `https://ilinkai.weixin.qq.com` | iLink Bot API 基址 |
| `botAgent` | string | `DSH-WeChat-Channel/0.1` | 请求中携带的调用方标识 |
| `login.autoLogin` | boolean | `true` | 启动时使用已有凭证自动登录 |
| `login.qrDir` | string | 空（用 `stateDir`） | 二维码 PNG 落盘目录 |
| `login.qrScale` / `login.qrQuiet` | number | `8` / `4` | 二维码渲染参数 |
| `login.timeoutMs` | number | `180000` | 扫码等待时长 |
| `login.expiredCooldownMs` | number | `3600000` | 会话过期后的冷却时长 |
| `allow.users` | string[] | `[]` | 白名单；**留空退化为只放行登录者本人** |
| `allow.selfOnly` | boolean | `true` | 仅放行登录者本人（忽略 `users`） |
| `allow.silentDrop` | boolean | `true` | 非白名单消息静默丢弃 |
| `session.prefix` | string | `wechat` | 会话 key 前缀 |
| `session.resetCommand` | string | `/new` | 重置会话的指令，留空则不启用 |
| `session.preset` | string | 空 | 可选的 agent preset；留空见下文说明 |
| `model.provider` / `model.model` | string | 空 | 微信会话的模型路由，留空则由宿主解析 |
| `tts.apiKeyEnv` | string | `DASHSCOPE_API_KEY` | 语音合成凭据的环境变量名 |
| `tts.apiKey` | string | 空 | 直接提供凭据（留空则按 `apiKeyEnv` 查找） |
| `tts.model` / `tts.voice` | string | `qwen3-tts-flash` / `Cherry` | 合成模型与音色 |
| `send.maxChars` | number | `2000` | 单条文本上限，超出按句子边界切分 |
| `send.typing` | boolean | `true` | 发送前显示「正在输入」 |
| `send.maxPerMinute` | number | `12` | 出站限流（0 = 不限） |
| `receive.poll` | boolean | `true` | 是否开启长轮询收消息 |
| `receive.dedupeSize` | number | `500` | 去重窗口大小 |
| `tools.enabled` | boolean | `true` | 是否注册 `wechat_*` 工具 |
| `tools.restrict` | boolean | `true` | 是否对微信会话启用工具收口 |
| `tools.allow` / `tools.deny` | string[] | 见 [7.3](#73-默认放行的工具26-个) | 收口后的工具白/黑名单 |

---

## 7. 安全模型

### 7.1 三道边界

| 边界 | 机制 | 默认 |
| --- | --- | --- |
| 谁能触发 | 白名单：仅处理指定微信用户的消息 | 仅登录者本人 |
| 能做什么 | 工具收口：限制微信会话可见的工具面 | 26 项（无 shell / 文件 / 子代理） |
| 能聊什么 | 仅单聊；协议本身不提供群聊能力 | 不可配置 |

**默认拒绝**：白名单为空时退化为「只放行扫码登录的那个微信号」，不会因为列表为空而放行所有人。

> 即便有上述边界，插件背后仍是一个具备工具调用能力的 agent。**不要把该渠道暴露给不可信的人。**

### 7.2 工具收口的实现

会话装配时调用 `tools.restrict({ allow })`，把该 agent 作用域可见的全局工具面限制为
`tools.allow` 中的项。这是**过滤继承面**，不是「可见但禁止调用」——模型侧这些工具根本不存在，
因此诱导其执行命令无效。

### 7.3 默认放行的工具（26 个）

| 分类 | 工具 |
| --- | --- |
| 渠道与状态 | `wechat_login` `wechat_status` `wechat_send` `mood_now` `mood_feel` `mood_diary` |
| 联网检索 | `advanced_search` `multi_search` `research` `cache_search` `platform_search` `domain_search` `image_search` `video_search` `grab_image` |
| 内容聚合 | `feed_scroll` `feed_read` `feed_share` `feed_history` `feed_watch` |
| 表情图库 | `meme_list` `meme_update` `learn_meme` |
| 图像理解 | `qqbot_describe_image` |
| 实用 | `weather` `qqbot_time` |

**故意不放行**：`pwsh` `write` `edit` `subagent` `workflow` `send_message`（任意命令、文件修改、派生 agent）；
`qqbot_say` `qqbot_send_file` `qqbot_voice_call`（QQ 专用发送类）；`send_meme`（输出其他渠道的标记格式）；
`present` `exit_plan_mode`（GUI 卡片）。

### 7.4 收口的失效模式

`dsh-tools` 的 `restrict()` 遇到**不认识**的工具名会抛错，而不是忽略该项。
抛错会导致收口未装上、工具面全开——「看起来只是少了个功能，实际是把整面放开」。

插件对此的处理是**向安全方向回退**：按原样尝试一次，抛错后从报错信息中取出问题名、
移除后重试。因此写错一个名字的后果是「该项不放行」，而不是「全部放行」。

不要在外部预先用 `tools.view(undefined).restrictableNames` 校验名单：该调用的作用域与
`restrict()` 内部使用的不是同一个，会误判十余个正常工具为「不存在」。权威清单来自
`restrict()` 自身的报错信息，或 `wechat_status({ selftest: true })`。

### 7.5 收口的能力边界

`restrict()` 只能在 agent **已继承到的工具面**内过滤，无法授予原本不在其中的工具。
部分工具（`web_search` `web_fetch` `read` `glob` `grep` `write` `edit` `pwsh`
`schedule_*` `todo_write` `skill` `ask_user_question` `read_image` `present`）不在该继承链上，
写入 `allow` 也会被剔除；这些工具在微信会话中本就不可见。联网能力由
`advanced_search` / `multi_search` / `research` 提供。

---

## 8. 工作原理

### 8.1 处理链路

```
登录    wechat_login → 申请二维码 → 扫码 → 配对码 → 凭证落盘
入站    长轮询 → 去重 → 白名单 → 记录 context token → 媒体落盘 / attachments → 投递到 DSH 会话
出站    session/event → 文本切分 → 限流 → 发送（回带 context token）
```

**context token 必须持久化**：iLink 要求每条出站消息回带最近一次入站消息的
`context_token`。插件重启后若丢失该 token，将无法再发送消息。

**会话 key 不含 accountId**：`accountId` 是每次扫码登录时服务端新建的机器人身份，
重新扫码即更换。若将其纳入会话 key，重新登录等同于换了一个人，聊天上下文全部丢失。
身份区分依靠微信 `userId`。

### 8.2 入站媒体

| 类型 | 处理方式 |
| --- | --- |
| 图片 | 交给 DSH `attachments` 服务，转为原生图片块进入模型视野（不依赖工具，收口后仍可用） |
| 语音 | 优先使用平台转写文本；音频落盘至 `~/.dsh/wechat-channel/media/<用户>/` |
| 文件 / 视频 | 落盘并在正文中附带路径 |

`attachments` 服务不可用时回退为「落盘 + 正文路径」，功能不丢失；启动日志会说明实际路径。

### 8.3 二维码

插件内置零依赖二维码编码器（`lib/qr.js`），支持版本 1–10（内容 ≤ 213 字节）。
iLink 登录链接约 89 字节，对应版本 6。

### 8.4 状态文件

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/wechat-channel/sdk/` | 登录凭证（`logout` 时整体删除） |
| `~/.dsh/wechat-channel/state.json` | context token、去重窗口、登录元信息（原子写） |
| `~/.dsh/wechat-channel/diagnostic.json` | 体检信息：登录状态、轮询状态、计数、异常标记 |
| `~/.dsh/wechat-channel/media/<用户>/` | 入站媒体文件 |
| `~/.dsh/wechat-channel/login-qr.png` | 登录二维码 |

---

## 9. 运维与故障排查

```powershell
node tools/run-tests.mjs         # 全部 6 套测试
node tools/selftest.mjs          # 纯逻辑自测
node tools/e2e.mjs               # 端到端集成（假宿主）
node tools/probe-login.mjs       # 登录链路探测
node tools/probe-poll-timing.mjs # 长轮询时序探测
node tools/probe-storage.mjs     # SDK 存储目录探测
node tools/verify-qr.mjs         # 二维码校验
```

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 工具未注册 | 插件未安装或未重载 | 检查 profile 的 `bundles` 与 `cordis.patch.yml`，重启 DSH |
| `ERR_MODULE_NOT_FOUND`（`@deepseek-ai/*`） | `link:` 安装缺少依赖链接 | 按 [3.2](#32-通过仓库脚本--link-安装) 补一层 junction |
| 二维码扫了没反应 | 登录轮询中断；二维码过期 | 重新调用 `wechat_login`；确保进程在轮询（不要用截图代替） |
| 收不到消息 | 长轮询关闭；会话已过期（服务端返回 `-14`） | 检查 `receive.poll`；重新扫码登录 |
| 发不出消息 | 缺少 context token（重启后丢失） | 等待一次入站消息以刷新 token |
| 陌生人消息被丢弃 | 白名单生效（预期行为） | 如需放行，在 `allow.users` 中显式添加 |
| 语音只有文件没有文字 | 平台未提供转写文本 | 属预期；可自行接入 ASR 处理落盘文件 |

---

## 10. 已知限制

- **仅支持单聊。** 微信机器人协议不提供群聊能力，这不是配置项。
- **出站语音不可用（协议层限制）。** TTS、SILK 编码、CDN 上传、`VoiceItem` 字段填充
  均已验证通过，服务端返回 `message_id` 且无错误码，但对端收不到消息。
  详见 [12.3](#123-验证方法)。**入站语音正常。**
- **会话过期需重新扫码。** 服务端返回 `-14` 时会话作废；插件会记录日志并在 `diagnostic.json` 中标记。
- **落盘语音为原始 SILK。** 未安装 `silk-wasm` 时不做格式转换；模型本身不解析音频，
  实际可用的是平台转写文本，该路径不依赖 `silk-wasm`。
- **二维码仅支持版本 1–10**（内容 ≤ 213 字节）。
- **`session.preset` 默认留空。** preset 依赖 `dsh-agent-presets` 扫描用户 preset 根目录；
  若部署未扫描该目录（只列出随附 preset），填写后只会持续报警告。
  工具收口由 `tools.restrict` 负责，不依赖目录发现。

---

## 11. 合规与风险

- **使用官方接口。** 通信走腾讯官方 iLink Bot API，不涉及客户端逆向、不模拟登录、
  不读取通讯录与朋友圈。
- **需要本人扫码授权。** 登录凭证属于扫码的微信号，插件以该身份收发消息；
  凭证保存在本地状态目录，`wechat_login action=logout` 可清除。
- **非官方项目。** 本插件由社区维护，与腾讯、DeepSeek 均无隶属关系。
- **使用前请自行确认**符合微信平台的相关条款与所在地区的适用规定；由使用者承担使用风险。
- **数据流向**：消息内容与媒体经 iLink 服务端传输；使用云端 TTS 时文本会发送至所配置的
  合成服务（默认阿里云百炼）。如不允许外发，请勿启用语音合成。
- **不要暴露给不可信的人**：渠道背后是具备工具调用能力的 agent，尽管已有白名单与工具收口。

---

## 12. 开发

### 12.1 目录结构

```
index.js           插件入口：name / inject / Config / apply
lib/config.js      配置默认值与深合并
lib/log.js         日志（落盘 + 宿主 logger）
lib/store.js       context token / 去重窗口 / 登录元信息（原子写）
lib/qr.js          零依赖二维码编码器
lib/client.js      iLink 客户端封装（SDK + 扫码出图 + 限流）
lib/session.js     微信用户 ↔ DSH 会话映射与投递
lib/inbound.js     入站：去重 → 白名单 → 存 token → 媒体落盘 → 投递
lib/outbound.js    出站：session/event → 切分 → 发送
client/ui.js       客户端插件：插件页内的二维码展示
vendor/wechatbot/  内置 SDK（MIT，见第 13 节）
tools/             测试与探测脚本
```

### 12.2 测试

```powershell
node tools/run-tests.mjs
```

包含 6 套：纯逻辑自测、回归测试、插件加载、端到端集成、二维码验收、二维码解码对照。

### 12.3 验证方法

原则：**自洽的实现可以同时是错的**，只有外部证据才算数。
（项目曾出现二维码「格式信息副本 2」写反的问题——编码器与解码器同为自己所写，一起错、互相验证通过。）

| 验证对象 | 外部证据 |
| --- | --- |
| 二维码 | ISO/IEC 18004 测试向量 + OpenCV 独立解码（非自研解码器） |
| 入站媒体解密 | FIPS-197 C.1 的 AES-128 标准向量（首块逐字节比对） |
| 工具收口 | 真实建立一次会话，检查 agent 视角实际可见的工具（`wechat_status selftest`） |
| 端到端 | 真实微信收发 |

---

## 13. 第三方代码

`vendor/wechatbot/` 是 [@wechatbot/wechatbot](https://github.com/corespeed-io/wechatbot) 2.2.0
的副本（`dist/` 运行时代码与 `types/` 类型声明），MIT 许可，作者 corespeed-io。
原始许可文本见 [`vendor/NOTICE.md`](vendor/NOTICE.md)。

内置而非 `npm install` 的原因：离线可用、版本锁定，避免上游发布新版本导致行为变更。
该 SDK 是 iLink 协议的第三方 MIT 实现，与本插件为直接依赖关系。

---

## 14. 许可证

[MIT](LICENSE)

---

## English Overview

**dsh-wechat-channel** connects a DeepSeek Harness agent to **WeChat one-to-one chats** through
Tencent's official iLink Bot API (the ClawBot channel). It performs QR-code authorization to obtain
a bot identity, then sends and receives text, images, voice and files, mapping each WeChat user to a
DSH session.

It is not a client-side reverse engineering project: no login emulation, no contact-list or
Moments access. Three tools are registered — `wechat_login`, `wechat_status` and `wechat_send` —
and the plugin ships with a default-deny whitelist (only the scanning account is allowed by default)
plus a tool restriction that limits what a WeChat session can invoke (26 tools by default, no shell,
no file access, no sub-agents).

```bash
dsh plugin --profile web add dsh-wechat-channel
```

Known limitations: group chats are not supported by the protocol, and outbound voice messages are
accepted by the server but not delivered to the recipient (documented in section 10).
Requires Node.js `>= 22`. Licensed under the MIT License; bundled third-party SDK is MIT
(see section 13). This is a community project, not affiliated with Tencent or DeepSeek.
