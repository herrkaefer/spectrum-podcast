# RSS 内容源模块实施计划

## 摘要

将当前硬编码的 Hacker News 来源替换为“来源配置模块 + RSS 解析模块”的结构。配置文件中同时支持 RSS 与普通 URL（无 RSS）来源，并加入可配置的时间窗口 `lookbackDays`（单位：天，用于筛选“向前几天内”的内容）。本阶段不做缓存与去重，仅实现最小可用。

## 现状要点

- 来源是硬编码：`workflow/utils.ts` 中 `getHackerNewsTopStories` / `getHackerNewsStory`。
- `workflow/index.ts` 直接调用 HN 方法。
- `Story` 类型包含 `hackerNewsUrl`，对来源有强耦合。

## 目标范围

- 新增独立模块用于内容源配置（含 RSS 与普通 URL）。
- RSS 解析：从 feed 中取条目并按“向前几天”筛选。
- workflow 改为读取配置模块并按来源类型获取内容。
- 不做缓存、不做去重、不改主题/文案。

## 配置设计

在 `workflow/sources/config.ts` 中集中配置：

- `lookbackDays`：全局默认回溯窗口（单位：天）。
- `sources`：来源列表，结构类似：
  - `id`: string
  - `name`: string
  - `type`: 'rss' | 'url'
  - `url`: string
  - `enabled?`: boolean
  - `lookbackDays?`: number（可覆盖全局）

## 实施步骤

1. 新建来源配置模块

- 新增 `workflow/sources/config.ts`，定义 `Source` 类型与 `sources` 列表。
- 加入全局 `lookbackDays` 默认值。
- 预置 1 个 RSS 来源（`https://www.thetransmitter.org/feed/`）。
- 可加入 1 个 `url` 示例（可先 `enabled: false`）。

2. 新增 RSS 解析模块

- 新增 `workflow/sources/rss.ts`：
  - 使用 `ofetch` 获取 XML。
  - 使用 `cheerio` 的 `xmlMode` 解析 `item`。
  - 抽取 `title`、`link`、`guid`、`pubDate`。
  - 用 `lookbackDays` 做筛选（`now - lookbackDays` 到 `now`）。
  - 生成通用 `Story` 对象，附带 `sourceName` / `sourceUrl` / `publishedAt`。

3. 新增来源调度入口

- 新增 `workflow/sources/index.ts`：
  - 读取 `sources`，按 `type` 分发。
  - `rss` -> 走 RSS 解析。
  - `url` -> 生成最小 `Story`（仅 `url` + `title` 兜底或空）。
  - 合并并返回 `Story[]`。

4. 调整 Story 类型为通用来源

- 修改 `types/story.d.ts`：
  - 将 `hackerNewsUrl` 改为可选。
  - 增加 `sourceName?`、`sourceUrl?`、`publishedAt?`。

5. 替换 HN 获取逻辑

- 修改 `workflow/index.ts`：
  - 用新的 `getStoriesFromSources()` 替换 `getHackerNewsTopStories()`。
  - 保留开发环境只处理 1 条的逻辑。

6. 新增通用正文抓取函数

- 修改 `workflow/utils.ts`：
  - 保留并导出 `getContentFromJina` / `getContentFromFirecrawl`。
  - 新增 `getStoryContent(story, maxTokens, env)`：仅抓正文，不抓 HN 评论。
  - `workflow/index.ts` 使用该函数。

## 测试策略

- 本地：`pnpm dev:worker` + `curl -X POST http://localhost:8787`。
- 确认日志：
  - RSS 解析输出条目数。
  - 只处理 1 条（开发模式）。
  - 总结流程可跑通（可继续用 `SKIP_TTS=true`）。

## 风险与问题

- RSS `pubDate` 缺失或格式异常，可能导致过滤不准。
- `url` 类型目前无去重，会重复处理同一链接。
- 未改 prompt 与文案，后续需要独立步骤处理。
