import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers'
import { GoogleGenAI } from '@google/genai'
import { WorkflowEntrypoint } from 'cloudflare:workers'
import { podcastTitle } from '@/config'
import { introPrompt, summarizeBlogPrompt, summarizePodcastPrompt, summarizeStoryPrompt } from './prompt'
import { getStoriesFromSources } from './sources'
import synthesize from './tts'
import { concatAudioFiles, getStoryContent } from './utils'

interface Params {
  today?: string
}

interface Env extends CloudflareEnv {
  OPENAI_BASE_URL?: string
  OPENAI_API_KEY?: string
  OPENAI_MODEL?: string
  OPENAI_THINKING_MODEL?: string
  OPENAI_MAX_TOKENS?: string
  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
  GEMINI_THINKING_MODEL?: string
  GEMINI_MAX_TOKENS?: string
  JINA_KEY?: string
  GMAIL_CLIENT_ID?: string
  GMAIL_CLIENT_SECRET?: string
  GMAIL_REFRESH_TOKEN?: string
  GMAIL_USER_EMAIL?: string
  NODE_ENV: string
  PODCAST_WORKER_URL: string
  PODCAST_R2_BUCKET_URL: string
  PODCAST_WORKFLOW: Workflow
  BROWSER: Fetcher
  SKIP_TTS?: string
  WORKFLOW_TEST_STEP?: string
  WORKFLOW_TEST_INPUT?: string
  WORKFLOW_TEST_INSTRUCTIONS?: string
}

interface ResponsesMessageContent {
  type?: string
  text?: string
}

interface ResponsesOutputItem {
  type?: string
  role?: string
  content?: ResponsesMessageContent[]
}

interface ResponsesBody {
  output_text?: string
  output?: ResponsesOutputItem[]
  usage?: unknown
  status?: string
  error?: { message?: string }
}

interface ResponseTextResult {
  text: string
  usage?: unknown
  finishReason?: string
}

type AiProvider = 'openai' | 'gemini'

const defaultOpenAIBaseUrl = 'https://api.openai.com/v1'

function getAiProvider(env: Env): AiProvider {
  const hasGeminiKey = Boolean(env.GEMINI_API_KEY?.trim())
  const hasOpenAIKey = Boolean(env.OPENAI_API_KEY?.trim())
  if (hasGeminiKey && !hasOpenAIKey) {
    return 'gemini'
  }
  return 'openai'
}

function getPrimaryModel(env: Env, provider: AiProvider): string {
  if (provider === 'gemini') {
    if (!env.GEMINI_MODEL) {
      throw new Error('GEMINI_MODEL is required when using Gemini API')
    }
    return env.GEMINI_MODEL
  }
  if (!env.OPENAI_MODEL) {
    throw new Error('OPENAI_MODEL is required when using OpenAI API')
  }
  return env.OPENAI_MODEL
}

function getThinkingModel(env: Env, provider: AiProvider): string {
  if (provider === 'gemini') {
    return env.GEMINI_THINKING_MODEL || getPrimaryModel(env, provider)
  }
  return env.OPENAI_THINKING_MODEL || getPrimaryModel(env, provider)
}

function getMaxTokens(env: Env, provider: AiProvider): number {
  const raw = provider === 'gemini' ? env.GEMINI_MAX_TOKENS : env.OPENAI_MAX_TOKENS
  const parsed = Number.parseInt(raw || '4096')
  return Number.isFinite(parsed) ? parsed : 4096
}

function buildResponsesUrl(baseUrl?: string): string {
  const normalized = (baseUrl || defaultOpenAIBaseUrl).replace(/\/$/, '')
  return `${normalized}/responses`
}

function extractOutputText(body: ResponsesBody): string {
  if (typeof body.output_text === 'string') {
    return body.output_text
  }
  if (!Array.isArray(body.output)) {
    return ''
  }
  const texts: string[] = []
  for (const item of body.output) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) {
      continue
    }
    for (const content of item.content) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        texts.push(content.text)
      }
      else if (content?.type === 'text' && typeof content.text === 'string') {
        texts.push(content.text)
      }
    }
  }
  return texts.join('')
}

async function createResponseText(params: {
  env: Env
  model: string
  instructions: string
  input: string
  maxOutputTokens?: number
}): Promise<ResponseTextResult> {
  const { env, model, instructions, input, maxOutputTokens } = params
  const provider = getAiProvider(env)

  if (provider === 'gemini') {
    if (!env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is required when using Gemini API')
    }
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, vertexai: false })
    const config: Record<string, unknown> = {
      systemInstruction: instructions,
    }
    if (typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens)) {
      config.maxOutputTokens = maxOutputTokens
    }
    const response = await ai.models.generateContent({
      model,
      contents: input,
      config,
    })
    const text = response.text
    if (!text) {
      throw new Error('Gemini generateContent returned empty output')
    }
    return {
      text,
      usage: (response as { usageMetadata?: unknown }).usageMetadata,
    }
  }

  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when using OpenAI API')
  }
  const url = buildResponsesUrl(env.OPENAI_BASE_URL)
  const body: Record<string, unknown> = {
    model,
    instructions,
    input,
  }
  if (typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens)) {
    body.max_output_tokens = maxOutputTokens
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenAI Responses API error: ${response.status} ${response.statusText} ${errorText}`)
  }

  const data = (await response.json()) as ResponsesBody
  if (data.error?.message) {
    throw new Error(`OpenAI Responses API error: ${data.error.message}`)
  }

  const text = extractOutputText(data)
  if (!text) {
    throw new Error('OpenAI Responses API returned empty output')
  }

  return {
    text,
    usage: data.usage,
    finishReason: data.status,
  }
}

const retryConfig: WorkflowStepConfig = {
  retries: {
    limit: 5,
    delay: '10 seconds',
    backoff: 'exponential',
  },
  timeout: '3 minutes',
}

export class HackerNewsWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    console.info('trigged event: HackerNewsWorkflow', event)

    const runEnv = this.env.NODE_ENV || 'production'
    const isDev = runEnv !== 'production'
    const breakTime = isDev ? '2 seconds' : '5 seconds'
    const today = event.payload?.today || new Date().toISOString().split('T')[0]
    const runDate = new Date(`${today}T23:59:59Z`)
    const now = Number.isNaN(runDate.getTime()) ? new Date() : runDate
    const skipTTS = this.env.SKIP_TTS === 'true'
    const aiProvider = getAiProvider(this.env)
    const maxTokens = getMaxTokens(this.env, aiProvider)
    const primaryModel = getPrimaryModel(this.env, aiProvider)
    const thinkingModel = getThinkingModel(this.env, aiProvider)
    const testStep = (this.env.WORKFLOW_TEST_STEP || '').trim().toLowerCase()

    if (testStep) {
      const fallbackInput = 'Summarize the following in one sentence: This is a short test input.'
      const fallbackInstructions = 'You are a concise assistant.'
      const testInput = this.env.WORKFLOW_TEST_INPUT || fallbackInput
      const testInstructions = this.env.WORKFLOW_TEST_INSTRUCTIONS || fallbackInstructions

      const text = await step.do(`workflow test step: ${testStep}`, retryConfig, async () => {
        if (testStep === 'openai' || testStep === 'responses') {
          return (await createResponseText({
            env: this.env,
            model: primaryModel,
            instructions: testInstructions,
            input: testInput,
            maxOutputTokens: maxTokens,
          })).text
        }

        if (testStep === 'story') {
          const stories = await getStoriesFromSources({ now, env: this.env })
          const story = stories[0]
          if (!story) {
            throw new Error('workflow test step "story": no stories found')
          }
          const storyResponse = await getStoryContent(story, maxTokens, this.env)
          return (await createResponseText({
            env: this.env,
            model: primaryModel,
            instructions: summarizeStoryPrompt,
            input: storyResponse,
          })).text
        }

        if (testStep === 'podcast') {
          const sampleStories = [
            '<story>这是一条测试摘要，讨论了一个新工具如何提升开发效率。</story>',
            '<story>另一条摘要聚焦隐私与数据安全的最新争议与观点。</story>',
          ].join('\n\n---\n\n')
          return (await createResponseText({
            env: this.env,
            model: thinkingModel,
            instructions: summarizePodcastPrompt,
            input: this.env.WORKFLOW_TEST_INPUT || sampleStories,
            maxOutputTokens: maxTokens,
          })).text
        }

        if (testStep === 'blog') {
          const sampleStories = [
            '<story>这是一条测试摘要，讨论了一个新工具如何提升开发效率。</story>',
            '<story>另一条摘要聚焦隐私与数据安全的最新争议与观点。</story>',
          ].join('\n\n---\n\n')
          const sampleInput = `<stories>[]</stories>\n\n---\n\n${sampleStories}`
          return (await createResponseText({
            env: this.env,
            model: thinkingModel,
            instructions: summarizeBlogPrompt,
            input: this.env.WORKFLOW_TEST_INPUT || sampleInput,
            maxOutputTokens: maxTokens,
          })).text
        }

        if (testStep === 'intro') {
          const sampleInput = this.env.WORKFLOW_TEST_INPUT || '女：Hello 大家好，欢迎收听测试播客。\n男：大家好，我是老冯。'
          return (await createResponseText({
            env: this.env,
            model: primaryModel,
            instructions: introPrompt,
            input: sampleInput,
            maxOutputTokens: maxTokens,
          })).text
        }

        throw new Error(`workflow test step "${testStep}" is not supported`)
      })

      console.info(`workflow test step "${testStep}" result`, {
        text: isDev ? text : text.slice(0, 200),
      })
      return
    }

    const stories = await step.do(`get stories ${today}`, retryConfig, async () => {
      const topStories = await getStoriesFromSources({ now, env: this.env })

      if (!topStories.length) {
        throw new Error('no stories found')
      }

      if (!isDev) {
        return topStories
      }

      const sourceFirstItem = new Map<string, Story>()
      for (const story of topStories) {
        const key = story.sourceName || story.sourceUrl || story.url || 'unknown'
        if (!sourceFirstItem.has(key)) {
          sourceFirstItem.set(key, story)
        }
      }

      const allowedSourceItems = new Map<string, string>()
      for (const [key, story] of sourceFirstItem.entries()) {
        if (story.sourceItemId) {
          allowedSourceItems.set(key, story.sourceItemId)
        }
      }

      return topStories.filter((story) => {
        const key = story.sourceName || story.sourceUrl || story.url || 'unknown'
        if (!allowedSourceItems.has(key)) {
          return sourceFirstItem.get(key) === story
        }
        return story.sourceItemId === allowedSourceItems.get(key)
      })
    })

    console.info('top stories', isDev ? stories : JSON.stringify(stories))
    console.info(`total stories: ${stories.length}`)

    const storyGroups = new Map<string, { count: number, label: string }>()
    for (const story of stories) {
      const sourceLabel = story.sourceItemTitle || story.sourceName || story.sourceUrl || 'unknown'
      const groupKey = story.sourceItemId || sourceLabel
      const existing = storyGroups.get(groupKey)
      if (existing) {
        existing.count += 1
      }
      else {
        storyGroups.set(groupKey, { count: 1, label: sourceLabel })
      }
    }

    for (const [groupKey, group] of storyGroups.entries()) {
      console.info(`newsletter: ${group.label} (${groupKey}) -> ${group.count} articles`)
    }

    for (const story of stories) {
      const storyResponse = await step.do(`get story ${story.id}: ${story.title}`, retryConfig, async () => {
        return await getStoryContent(story, maxTokens, this.env)
      })

      console.info(`get story ${story.id} content success`)

      const text = await step.do(`summarize story ${story.id}: ${story.title}`, retryConfig, async () => {
        const { text, usage, finishReason } = await createResponseText({
          env: this.env,
          model: primaryModel,
          instructions: summarizeStoryPrompt,
          input: storyResponse,
        })

        console.info(`get story ${story.id} summary success`, { text, usage, finishReason })
        return text
      })

      await step.do(`store story ${story.id} summary`, retryConfig, async () => {
        const storyKey = `tmp:${event.instanceId}:story:${story.id}`
        await this.env.PODCAST_KV.put(storyKey, `<story>${text}</story>`, { expirationTtl: 3600 })
        return storyKey
      })

      await step.sleep('Give AI a break', breakTime)
    }

    const allStories = await step.do('collect all story summaries', retryConfig, async () => {
      const summaries: string[] = []
      for (const story of stories) {
        const storyKey = `tmp:${event.instanceId}:story:${story.id}`
        const summary = await this.env.PODCAST_KV.get(storyKey)
        if (summary) {
          summaries.push(summary)
        }
      }
      return summaries
    })

    const podcastContent = await step.do('create podcast content', retryConfig, async () => {
      const { text, usage, finishReason } = await createResponseText({
        env: this.env,
        model: thinkingModel,
        instructions: summarizePodcastPrompt,
        input: allStories.join('\n\n---\n\n'),
        maxOutputTokens: maxTokens,
      })

      console.info(`create hacker podcast content success`, { text, usage, finishReason })

      return text
    })

    console.info('podcast content:\n', isDev ? podcastContent : podcastContent.slice(0, 100))

    await step.sleep('Give AI a break', breakTime)

    const blogContent = await step.do('create blog content', retryConfig, async () => {
      const { text, usage, finishReason } = await createResponseText({
        env: this.env,
        model: thinkingModel,
        instructions: summarizeBlogPrompt,
        input: `<stories>${JSON.stringify(stories)}</stories>\n\n---\n\n${allStories.join('\n\n---\n\n')}`,
        maxOutputTokens: maxTokens,
      })

      console.info(`create hacker daily blog content success`, { text, usage, finishReason })

      return text
    })

    console.info('blog content:\n', isDev ? blogContent : blogContent.slice(0, 100))

    await step.sleep('Give AI a break', breakTime)

    const introContent = await step.do('create intro content', retryConfig, async () => {
      const { text, usage, finishReason } = await createResponseText({
        env: this.env,
        model: primaryModel,
        instructions: introPrompt,
        input: podcastContent,
      })

      console.info(`create intro content success`, { text, usage, finishReason })

      return text
    })

    const contentKey = `content:${runEnv}:hacker-podcast:${today}`
    const podcastKey = `${today.replaceAll('-', '/')}/${runEnv}/hacker-podcast-${today}.mp3`

    const conversations = podcastContent.split('\n').filter(Boolean)

    if (skipTTS) {
      console.info('skip TTS enabled, skip audio generation')
    }
    else {
      for (const [index, conversation] of conversations.entries()) {
        await step.do(`create audio ${index}: ${conversation.substring(0, 20)}...`, { ...retryConfig, timeout: '5 minutes' }, async () => {
          if (
            !(conversation.startsWith('男') || conversation.startsWith('女'))
            || !conversation.substring(2).trim()
          ) {
            console.warn('conversation is not valid', conversation)
            return conversation
          }

          console.info('create conversation audio', conversation)
          const audio = await synthesize(conversation.substring(2), conversation[0], this.env)

          if (!audio.size) {
            throw new Error('podcast audio size is 0')
          }

          const audioKey = `tmp/${podcastKey}-${index}.mp3`
          const audioUrl = `${this.env.PODCAST_R2_BUCKET_URL}/${audioKey}?t=${Date.now()}`

          await this.env.PODCAST_R2.put(audioKey, audio)

          this.env.PODCAST_KV.put(`tmp:${event.instanceId}:audio:${index}`, audioUrl, { expirationTtl: 3600 })
          return audioUrl
        })
      }
    }

    const audioFiles = skipTTS
      ? []
      : await step.do('collect all audio files', retryConfig, async () => {
          const audioUrls: string[] = []
          for (const [index] of conversations.entries()) {
            const audioUrl = await this.env.PODCAST_KV.get(`tmp:${event.instanceId}:audio:${index}`)
            if (audioUrl) {
              audioUrls.push(audioUrl)
            }
          }
          return audioUrls
        })

    if (!skipTTS) {
      await step.do('concat audio files', retryConfig, async () => {
        if (!this.env.BROWSER) {
          console.warn('browser is not configured, skip concat audio files')
          return
        }

        const blob = await concatAudioFiles(audioFiles, this.env.BROWSER, { workerUrl: this.env.PODCAST_WORKER_URL })
        await this.env.PODCAST_R2.put(podcastKey, blob)

        const podcastAudioUrl = `${this.env.PODCAST_R2_BUCKET_URL}/${podcastKey}?t=${Date.now()}`
        console.info('podcast audio url', podcastAudioUrl)
        return podcastAudioUrl
      })
    }

    console.info('save podcast to r2 success')

    await step.do('save content to kv', retryConfig, async () => {
      await this.env.PODCAST_KV.put(contentKey, JSON.stringify({
        date: today,
        title: `${podcastTitle} ${today}`,
        stories,
        podcastContent,
        blogContent,
        introContent,
        audio: skipTTS ? '' : podcastKey,
        updatedAt: Date.now(),
      }))

      return introContent
    })

    console.info('save content to kv success')

    await step.do('clean up temporary data', retryConfig, async () => {
      const deletePromises = []

      // Clean up story temporary data
      for (const story of stories) {
        const storyKey = `tmp:${event.instanceId}:story:${story.id}`
        deletePromises.push(this.env.PODCAST_KV.delete(storyKey))
      }

      if (!skipTTS) {
        // Clean up audio temporary data
        for (const [index] of conversations.entries()) {
          const audioKey = `tmp:${event.instanceId}:audio:${index}`
          deletePromises.push(this.env.PODCAST_KV.delete(audioKey))
        }
      }

      await Promise.all(deletePromises).catch(console.error)

      if (!skipTTS) {
        for (const index of audioFiles.keys()) {
          try {
            await Promise.any([
              this.env.PODCAST_R2.delete(`tmp/${podcastKey}-${index}.mp3`),
              new Promise(resolve => setTimeout(resolve, 200)),
            ])
          }
          catch (error) {
            console.error('delete temp files failed', error)
          }
        }
      }

      return 'temporary data cleaned up'
    })
  }
}
