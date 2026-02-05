# 本地测试指南

## 1. 配置环境变量

### 编辑 `worker/.env.local`

**必需配置（二选一）：**

```bash
# 填入你的 OpenAI API Key
OPENAI_API_KEY=sk-your-actual-api-key-here

# 或者填入你的 Gemini API Key（未配置 OPENAI_API_KEY 时会使用 Gemini）
GEMINI_API_KEY=your-gemini-api-key
```

**可选配置：**

- `OPENAI_MODEL`: 默认使用 gpt-4o，可以改为 gpt-4o-mini 以降低成本
- `GEMINI_MODEL`: Gemini 模型名称，例如 gemini-2.0-flash
- `GEMINI_THINKING_MODEL`: Gemini 思考模型（可选，不填则使用 `GEMINI_MODEL`）
- `JINA_KEY`: 用于网页抓取，如果没有会使用备用方案
- `OPENAI_MAX_TOKENS`: 默认 4096，可根据需要调整
- `GEMINI_MAX_TOKENS`: 默认 4096，可根据需要调整
- `GMAIL_CLIENT_ID`: Gmail OAuth 客户端 ID（使用 Gmail newsletter 来源时需要）
- `GMAIL_CLIENT_SECRET`: Gmail OAuth 客户端密钥（使用 Gmail newsletter 来源时需要）
- `GMAIL_REFRESH_TOKEN`: Gmail OAuth refresh token（使用 Gmail newsletter 来源时需要）
- `GMAIL_USER_EMAIL`: Gmail 账号（可选，默认使用 `me`）

### 编辑 `.env.local`

通常不需要修改，保持默认即可。

### 获取 Gmail refresh token（使用 Gmail newsletter 来源时需要）

1. 在 Google Cloud Console 的 OAuth 客户端中配置：
   - Authorized redirect URIs：`http://localhost:3000/oauth2callback`
   - OAuth consent screen 若为 Testing，把你的 Gmail 加入 Test users
2. 启动本地回调服务：
   ```bash
   node scripts/oauth_callback_server.mjs
   ```
3. 打开授权链接（替换 `<CLIENT_ID>`）：
   ```
   https://accounts.google.com/o/oauth2/v2/auth?client_id=<CLIENT_ID>&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Foauth2callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly&access_type=offline&prompt=consent
   ```
4. 授权后回调页面会显示成功，终端会打印 `OAuth code: ...`
5. 用 code 换 refresh token（替换参数）：
   ```bash
   node scripts/get_gmail_token.mjs \
     --client-id <CLIENT_ID> \
     --client-secret <CLIENT_SECRET> \
     --redirect-uri http://localhost:3000/oauth2callback \
     --code <AUTH_CODE>
   ```
6. 将输出的 `refresh_token` 写入 `worker/.env.local`

## 2. 启动项目

### 方式一：只测试 Worker（推荐先用这个）

```bash
cd /Users/herrk/dev-local/spectrum-podcast
pnpm dev:worker
```

启动成功后，在另一个终端手动触发 workflow：

```bash
curl -X POST http://localhost:8787
```

### 方式二：同时启动 Worker 和 Web

**终端 1 - 启动 Worker：**

```bash
cd /Users/herrk/dev-local/spectrum-podcast
pnpm dev:worker
```

**终端 2 - 启动 Web：**

```bash
cd /Users/herrk/dev-local/spectrum-podcast
pnpm dev
```

然后访问：

- Web 界面：http://localhost:3000
- Worker API：http://localhost:8787

## 3. 重要注意事项

### ⚠️ TTS 可能会卡住

根据 README 说明：

> 本地运行工作流时，Edge TTS 转换音频可能会卡住。建议直接注释该部分代码进行调试。

如果遇到卡住的情况，需要：

1. **临时注释 TTS 代码**：编辑 `workflow/index.ts`，找到 TTS 相关的步骤并注释掉
2. **或者**：跳过音频生成，只测试文本总结功能

### ⚠️ 浏览器渲染功能

> 由于合并音频需要使用 CloudFlare 的浏览器端呈现，不支持本地开发，需要远程调试。

合并音频的功能在本地无法测试，只能在部署后测试。

## 4. 测试流程

### 最小化测试（推荐）

1. 启动 worker：`pnpm dev:worker`
2. 触发 workflow：`curl -X POST http://localhost:8787`
3. 观察控制台输出，确认：
   - ✓ 能够获取 Hacker News 数据
   - ✓ 能够调用 OpenAI 或 Gemini API 生成摘要
   - ⚠️ TTS 部分可能卡住（这是正常的，可以注释掉）

### 完整测试

1. 确保 worker 正常运行
2. 启动 web：`pnpm dev`
3. 访问 http://localhost:3000 查看界面
4. 检查是否能看到播客内容

## 5. 常见问题

### Worker 启动失败

检查：

- `OPENAI_API_KEY` / `GEMINI_API_KEY` 是否正确填写
- 端口 8787 是否被占用

### API 调用失败

检查：

- API key 是否有效
- API 额度是否充足
- 网络是否正常

### TTS 卡住

这是已知问题，解决方案：

- 注释掉 `workflow/tts.ts` 相关代码
- 或者设置超时跳过 TTS 步骤

### 开发模式下只处理 1 条数据

代码中有这个逻辑（`workflow/index.ts:61`）：

```typescript
topStories.length = Math.min(topStories.length, isDev ? 1 : 10)
```

开发环境下只处理 1 条 Hacker News 数据，这是为了加快测试速度。

## 6. 下一步

测试通过后，你可以：

1. 修改 workflow 逻辑以支持其他数据源（如 RSS）
2. 调整 AI 提示词以改变播客风格
3. 部署到 Cloudflare Workers 进行生产测试

## 7. 快速启动命令

```bash
# 1. 确保在项目目录
cd /Users/herrk/dev-local/spectrum-podcast

# 2. 编辑环境变量（填入你的 API key）
# 编辑 worker/.env.local 文件

# 3. 启动 worker
pnpm dev:worker

# 4. 在另一个终端触发 workflow
curl -X POST http://localhost:8787
```
