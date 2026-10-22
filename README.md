# MangoWrite Browser Extension · 芒果写作浏览器扩展

[English](#english) · [中文](#中文)

## English

Browser extension for [MangoWrite](https://mangowrite.com) — an AI research-writing
workspace for scholars. It captures the paper you are viewing (CNKI, Wanfang,
CQVIP, Baidu Scholar, NCPSSD, IEEE, arXiv, DSpace, Web of Science, and more) and
files it into your own MangoWrite library, **PDF first** with an HTML snapshot
fallback.

- Two capture modes: manual capture from the toolbar popup, or import tasks
  dispatched from your MangoWrite library page.
- PDF-first: the extension looks for downloadable PDF candidates on the page and
  uploads the PDF; only when none is reachable does it fall back to the page HTML.
- No background monitoring: nothing runs unless you trigger an import. The
  extension never reads your browsing history, website cookies, or executes
  remote code.
- Anonymous metadata lookups: a manual import may query
  [OpenAlex](https://openalex.org) with the paper's DOI or title only — no API
  key, no email, no account information is ever sent to third parties.

**Install**: see the [extension guide page](https://mangowrite.com/zh-CN/extension)
(store listing is pending review; the guide also covers the self-distributed ZIP
for users who cannot reach the store).

**Build from source**:

```bash
pnpm install
pnpm build   # generates build info, type-checks, emits dist/ and bundles scripts
pnpm test
```

Then load it unpacked: `chrome://extensions` → enable Developer mode →
*Load unpacked* → select this repository root. Build flags:
`MW_EXT_API_BASE_URL` (backend base URL, default `https://mangowrite.com`) and
`MW_EXT_STORE=1` (store-style build without the `declarativeNetRequest` helper).

**Privacy**: see [PRIVACY.md](PRIVACY.md).
**Support**: open a [GitHub Issue](https://github.com/aidenchen8/mangowrite-extension/issues).

## 中文

[芒果写作](https://mangowrite.com)（面向科研人员的 AI 写作平台）的浏览器插件：
把正在看的论文页（知网、万方、维普、百度学术、NCPSSD、IEEE、arXiv、DSpace、
Web of Science 等）一键采集进你的芒果写作文库，**PDF 优先**，抓不到 PDF 才回退
网页快照。

- 两种采集方式：弹窗手动「导入当前页面」；或在芒果写作文库页点「用插件取原文」
  派发任务。
- 只在你触发时工作：不后台轮询、不读浏览历史、不读网站 cookie、不执行远程代码。
- 题录补全只会把 DOI/标题匿名发给 OpenAlex，不带任何账号信息。

**安装与使用指引**见[扩展引导页](https://mangowrite.com/zh-CN/extension)（商店
上架审核中；引导页也提供商店不可达用户的自分发 ZIP 安装方式）。从源码构建同上
（`pnpm install && pnpm build`）。

**隐私政策**见 [PRIVACY.md](PRIVACY.md)（含中文摘要）；问题反馈请开
[Issue](https://github.com/aidenchen8/mangowrite-extension/issues)。

## Repository policy · 仓库说明

This repository publishes **source snapshots** of the extension at each store
release (current snapshot: v0.1.18). Issues and bug reports are welcome; pull
requests are not merged directly — changes are integrated by the maintainer and
shipped with the next snapshot.

本仓库按商店发布版本**快照式更新**（当前快照 v0.1.18）。欢迎提 Issue 反馈问题；
PR 不直接合并，由维护者整合后随下一版快照发布。

## License

Code and assets in this repository are licensed under
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) — free for
personal, academic and other non-commercial use. **Commercial use requires the
author's separate written permission.**
本仓库代码与素材采用 CC BY-NC 4.0 协议：个人与学术等非商业用途可自由使用；商用
需另行取得作者书面授权。

Copyright © 2026 aidenchen
