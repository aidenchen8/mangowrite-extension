# Privacy Policy · 隐私政策

MangoWrite Browser Extension — last updated: 2026-10-22

## English

**What the extension does.** It captures the paper page you are viewing — on
your explicit action (the toolbar popup's import button, or an import task you
started from the MangoWrite web app) — and uploads it into your own MangoWrite
account. It never monitors browsing in the background and never records your
browsing history.

**What is read and sent.**

- The current tab's URL, title and page HTML at the moment you trigger a
  capture, plus the PDF file bytes when a downloadable PDF candidate is found on
  the page. These go only to the MangoWrite backend (`mangowrite.com`) and only
  into your own account, after you have paired the extension with it.
- Bibliographic metadata of the captured page (DOI, arXiv id, title, authors…).
  A manual import may send **only the DOI or title** to the OpenAlex API to
  complete the citation. Those queries are anonymous: no API key, no email, no
  account identifier is attached.
- A random device id (a UUID generated on first run, stored locally) and a
  long-lived device token issued when you pair the extension with your account.
  The token and device id are sent only to the MangoWrite backend and exist so
  that your "connected devices" list shows one row per browser. The device id is
  not a hardware fingerprint and contains no device characteristics.

**Auto-connect.** While you are logged in to mangowrite.com, the web app can
pair the extension automatically the first time it detects it — no extra click
needed. You can disconnect at any time from the extension popup; after a
deliberate disconnect the extension **stays** disconnected and will not
auto-connect again until you explicitly press "Connect" on the web page.

**What is never done.** No analytics or telemetry SDKs, no ads, no selling or
sharing of data with third parties, no reading of website cookies, no execution
of remote code. The only third-party requests are the anonymous OpenAlex
lookups described above, and they fire only on manual imports.

**Storage and deletion.** The device token, device id and pairing state live in
`chrome.storage.local` on your machine. Uninstalling the extension removes them;
the log-out button in the popup clears them; and you can revoke the device token
permanently from your MangoWrite account settings ("已连接设备" / connected
devices). Captured papers live in your MangoWrite library — delete them there at
any time; deleting your account removes everything.

**Contact.** Questions or data-removal requests: open a
[GitHub Issue](https://github.com/aidenchen8/mangowrite-extension/issues).

Developer: aidenchen

## 中文摘要

插件只在你显式操作（弹窗导入按钮、或从网页端派发的导入任务）时读取当前论文页
的 URL、标题、页面 HTML 与可下载的 PDF，并仅上传到你自己的芒果写作账号。
题录补全只会把 DOI/标题匿名发送给 OpenAlex，不含任何账号信息。首次运行生成的
随机设备 UUID 与配对设备令牌只发往芒果写作服务端，用于「已连接设备」列表去重
展示，不是硬件指纹、不含设备特征。登录状态下网页端可自动完成首次配对；你在
弹窗主动断开后不会被自动重连，除非你在网页端再次显式点「连接」。无统计/遥测
SDK、无广告、不读网站 cookie、不执行远程代码、不向任何第三方出售或共享数据。
令牌与设备信息存储在本地 `chrome.storage.local`：卸载插件即清除、弹窗退出登录
即清除、也可在网页端「已连接设备」中永久吊销；已采集的文献可随时在文库中删除，
注销账号将删除全部数据。联系方式：GitHub Issues。
