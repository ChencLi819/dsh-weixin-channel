# 第三方代码

## vendor/wechatbot/

本目录是 **[@wechatbot/wechatbot](https://github.com/corespeed-io/wechatbot) 2.2.0**
的副本：

- `dist/` —— 运行时代码（去掉了 sourcemap）
- `types/` —— TypeScript 类型声明（`.d.ts`），是 iLink 协议最完整的文档：
  读 `types/protocol/types.d.ts` 能看到每个接口字段的确切含义

- 许可：MIT
- 作者：corespeed-io
- 零运行时依赖、ESM、Node >= 22
- 用途：实现微信 iLink Bot API 的传输层（鉴权、扫码、长轮询、媒体加解密、SILK 语音）

**为什么内置而不是 `npm install`**：让插件离线可用、版本锁定，避免装包时联网失败或
上游发新版把行为改掉。

**为什么这不是 OpenClaw**：OpenClaw 是另一个独立项目；`@wechatbot/wechatbot` 是
腾讯官方 iLink 协议的第三方 MIT 实现，与本插件是直接依赖关系，不经过 OpenClaw。

## 原始许可文本

上游仓库为 MIT 许可。如上游 `LICENSE` 文件内容与下述惯例条款有出入，以上游仓库为准：

```
MIT License

Copyright (c) corespeed-io

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
