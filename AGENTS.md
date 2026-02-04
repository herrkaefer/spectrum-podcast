# AGENTS.md

**请始终使用简体中文和用户对话**

## 项目概述

Hacker Podcast - 基于 AI 的中文播客生成器，自动抓取 Hacker News 每日热门文章，生成中文摘要并转换为音频播客。

- **在线演示：** https://hacker-podcast.agi.li
- **RSS 订阅：** https://hacker-podcast.agi.li/rss.xml

## 技术栈

- Next.js 15 (App Router) + React 19 + Cloudflare Workers (OpenNext 适配器)
- TypeScript 严格模式 + Zod 运行时验证
- Tailwind CSS 4 + shadcn/ui
- pnpm 包管理器

## 开发命令

```bash
pnpm install                # 安装依赖
pnpm dev                    # Next.js 开发服务器 (端口 3000)
pnpm dev:worker             # Worker 开发服务器 (端口 8787)
pnpm build                  # 构建 Next.js 应用
pnpm deploy                 # 部署完整应用
pnpm lint:fix               # 自动修复 ESLint 问题 (优先使用)
pnpm tests                  # 运行集成测试 (需要远程环境)
curl -X POST http://localhost:8787  # 手动触发工作流
pnpm cf-typegen             # 生成 Cloudflare 类型定义
```

## 项目结构

```
├── app/                    # Next.js App Router 页面
│   ├── page.tsx            # 首页
│   ├── episode/[date]/     # 单集页面
│   └── rss.xml/            # RSS 订阅
├── worker/                 # Cloudflare Worker 入口
├── workflow/               # 工作流引擎 (抓取、AI、TTS)
├── components/             # React 组件
│   ├── ui/                 # shadcn/ui (ESLint 忽略)
│   └── podcast/            # 播客组件
├── types/                  # TypeScript 类型定义
├── lib/                    # 工具函数
└── config.ts               # 应用配置
```

## 代码风格规范

### ESLint (@antfu/eslint-config)

```typescript
// 禁止 console.log，允许 console.info/warn/error
console.info('allowed') // OK
```

### 导入规范

```typescript
// 导入顺序: 类型 -> 第三方库 -> 内部模块
import type { WorkflowEvent } from 'cloudflare:workers'

// 类型导入使用 type 关键字
import type { Episode, PodcastInfo } from '@/types/podcast'

import { generateText } from 'ai'
import { podcastTitle } from '@/config'
// 路径别名使用 @/
import { cn } from '@/lib/utils'
```

### TypeScript 规范

```typescript
// 严格模式启用，禁止 any/as any/@ts-ignore
interface Props {
  episodes: Episode[]
  currentPage: number
}

// 函数参数和返回类型明确
export function getPastDays(days: number): string[] {
  return Array.from({ length: days }, (_, index) => {
    return new Date(Date.now() - index * ONE_DAY).toISOString().split('T')[0]
  })
}

// 接口定义在 types/ 目录 (.d.ts 文件)
```

### React 组件规范

```tsx
// 客户端组件使用 'use client' 标记
'use client'

import type { Episode, PodcastInfo } from '@/types/podcast'

interface PodcastProps {
  episodes: Episode[]
  currentPage: number
}

// 导出命名函数 (页面组件除外使用默认导出)
export function Podcast({ episodes, currentPage }: PodcastProps) {
  return <div>{/* ... */}</div>
}
```

### 页面组件 (App Router)

```tsx
// app/page.tsx - 使用默认导出
import { getCloudflareContext } from '@opennextjs/cloudflare'

export const revalidate = 600 // ISR 重验证时间

export default async function Home({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { env } = await getCloudflareContext({ async: true })
  // ...
}
```

### 样式规范 (Tailwind CSS)

```tsx
// 使用 cn() 合并类名
import { cn } from '@/lib/utils'

<div className={cn('flex items-center gap-2', isActive && 'bg-primary')}></div>
```

### 错误处理

```typescript
// 使用 try-catch 并记录错误
try {
  const result = await someAsyncOperation()
}
catch (error) {
  console.error('操作失败', error)
  throw error
}

// 工作流使用重试配置
const retryConfig: WorkflowStepConfig = {
  retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
  timeout: '3 minutes',
}
```

## 重要注意事项

1. **本地 TTS 限制**：Edge TTS 在本地可能卡住，调试时注释掉 TTS 代码
2. **音频合并**：需要 Cloudflare 浏览器渲染，使用 `pnpm tests` 测试
3. **开发模式**：只处理 1 篇文章（生产 10 篇）
4. **构建忽略**：TypeScript 错误在构建时被忽略 (next.config.mjs)
5. **预提交钩子**：使用 simple-git-hooks + lint-staged 自动检查

## 环境变量

**Worker (worker/.env.local):**

```
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1
PODCAST_WORKER_URL=
PODCAST_R2_BUCKET_URL=
```

**Next.js (.env.local):**

```
NODE_ENV=development
NEXT_STATIC_HOST=http://localhost:3000/static
```
