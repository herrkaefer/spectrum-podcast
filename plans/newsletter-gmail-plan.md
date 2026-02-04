# Gmail Newsletter 内容源实施计划

## 摘要

新增一个 `gmail` 内容源类型：从 Gmail 中读取带有指定 label（如 `Spectrum`）的 newsletter 邮件，按“运行窗口（例如过去 7 天）”过滤，再从邮件 HTML 中提取链接，并用 Jina 抓取文章正文，与 RSS 内容合并后统一交给 AI 总结。本阶段不做去重、不做缓存。

## 目标与约束

- 目标：每次触发（如每周一次）只处理指定时间窗口内收到的邮件。
- 不看文章原始发布时间，只按“邮件收到时间”筛选。
- 多个链接统一抓取正文；若邮件是全文型，可选使用“View online”/主链接替代。
- 允许配置化规则来识别主链接或过滤噪声链接。

## 新增配置设计

**配置位置：**沿用 `workflow/sources/config.local.ts`（私有）与 `config.example.ts`（模板）

新增 `gmail` 来源配置字段建议：

- `type: 'gmail'`
- `label`: string（例：`Spectrum`）
- `maxMessages?`: number（每次最多处理多少封，避免爆量）
- `lookbackDays?`: number（覆盖全局）
- `linkRules?`：
  - `includeText?`: string[]（链接文字包含这些就优先）
  - `excludeText?`: string[]（过滤订阅/隐私/社交等）
  - `includeDomains?`: string[]
  - `excludeDomains?`: string[]
  - `preferOnlineVersion?`: boolean（优先“View online/Read online”链接）

**说明**

- `includeText`/`excludeText` 可以用来匹配你看到的 newsletter 中常见链接文案，实现“按链接文字筛选”的需求。
- 默认规则先做到“自动过滤常见噪声 + 抽正文链接”；特殊 newsletter 再加规则。

**初始白名单（按你的要求）**
在 `linkRules.includeText` 中先放这两条，后续可追加：

- `READ NOW`
- `View it in your browser`

## Gmail 访问与环境变量

**推荐做法：** OAuth2 + Refresh Token（专用 Gmail 账号）。

新增环境变量（Worker）：

- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`
- `GMAIL_USER_EMAIL`（或固定 `me`）

**说明**

- 通过 refresh token 获取 access token，再调用 Gmail API。
- 这些密钥必须放环境变量，不进仓库。

## 处理流程（数据流）

1. **计算时间窗口**

- 以 workflow 运行时间为 `end`（可沿用 `today` + 23:59:59Z），
- `start = end - lookbackDays`。

2. **Gmail 查询**

- 查询条件：`label:Spectrum after:YYYY/MM/DD before:YYYY/MM/DD` 或 epoch 秒。
- `users.messages.list` 获取 messageIds（可加 `maxResults`）。
- `users.messages.get` 拉取邮件详情（`format=full` 或 `raw`）。

3. **邮件 HTML 解析与链接提取**

- 解析 MIME，优先 `text/html`，无则用 `text/plain`。
- 使用 `cheerio` 提取 `a[href]`，过滤噪声链接：
  - 退订、偏好设置、隐私、社交、追踪像素、图片链接
- 若配置 `includeText`，优先筛选匹配文本的链接。
- 若 `preferOnlineVersion` 为 true，优先挑“view online/read online”链接。

4. **内容抓取**

- 对提取的链接用 Jina 抓正文（同 RSS）。
- 如果识别为“全文型”（正文很长且有效链接很少），可直接用邮件正文作为内容源。

5. **合并输出**

- 每个链接生成一条 `Story`（更利于摘要结构化）。
- `Story` 字段补全：`sourceName`/`sourceUrl`/`publishedAt`（用邮件日期）。
- 与 RSS 来源合并返回。

## 代码结构与新增文件

- `workflow/sources/types.ts`
  - 扩展 `SourceType` 加入 `gmail`。
- `workflow/sources/gmail.ts`
  - Gmail API 调用、token 刷新、邮件解析、链接过滤。
- `workflow/sources/index.ts`
  - 新增 `gmail` 分支。
- `workflow/utils.ts`
  - 可能新增 `extractLinksFromHtml()`/`decodeBase64Url()` 辅助函数。

## 测试策略

- 本地先用 1–2 封测试邮件：
  - label 设置为 `Spectrum`。
  - 设置 `maxMessages=3` + `lookbackDays=7`。
- 观察日志：
  - 邮件数量、链接数量、Jina 抓取成功率。
- 若“摘要型”邮件链接抓不到，增加 `linkRules.includeText`。

## 风险与问题

- Gmail API 鉴权复杂（refresh token 需手动获取），需要一次性配置流程。
- HTML 结构差异大，默认规则可能漏链接或抓到噪声。
- 目前不做去重，若频率变密可能重复处理。

## 后续可选增强

- 增加 per-newsletter 规则（按 `from`/`domain` 匹配）
- 增加去重（按 link hash 或 messageId）
- 解析 `List-Id` header 自动识别 newsletter 来源
