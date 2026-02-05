import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers'
import type { AiEnv } from './ai'

import { WorkflowEntrypoint } from 'cloudflare:workers'

import { podcastTitle } from '@/config'
import { createResponseText, getAiProvider, getMaxTokens, getPrimaryModel, getThinkingModel } from './ai'
import { introPrompt, summarizeBlogPrompt, summarizePodcastPrompt, summarizeStoryPrompt } from './prompt'
import { getStoriesFromSources } from './sources'
import synthesize, { buildGeminiTtsPrompt, synthesizeGeminiTTS } from './tts'
import { concatAudioFiles, getStoryContent } from './utils'

interface Params {
  today?: string
  nowIso?: string
  windowMode?: 'calendar' | 'rolling'
  windowHours?: number
}

interface Env extends CloudflareEnv, AiEnv {
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
  WORKFLOW_TTS_INPUT?: string
}

function formatError(error: unknown) {
  const err = error as {
    name?: string
    message?: string
    stack?: string
    cause?: unknown
    status?: number
    statusText?: string
    response?: { status?: number, statusText?: string }
    data?: unknown
  }
  return {
    name: err?.name,
    message: err?.message,
    status: err?.status ?? err?.response?.status,
    statusText: err?.statusText ?? err?.response?.statusText,
    stack: err?.stack,
    cause: err?.cause,
    data: err?.data,
  }
}

function buildTimeWindow(
  now: Date,
  mode: Params['windowMode'] | undefined,
  hours: number,
  timeZone: string,
) {
  if (mode === 'rolling') {
    const end = now
    const start = new Date(now.getTime() - hours * 60 * 60 * 1000)
    return {
      windowStart: start,
      windowEnd: end,
      windowDateKey: getDateKeyInTimeZone(end, timeZone),
    }
  }

  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const dateKey = getDateKeyInTimeZone(yesterday, timeZone)
  return {
    windowStart: zonedTimeToUtc(dateKey, timeZone, 0, 0, 0),
    windowEnd: zonedTimeToUtc(dateKey, timeZone, 23, 59, 59),
    windowDateKey: dateKey,
  }
}

function getDateKeyInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)

  const year = parts.find(part => part.type === 'year')?.value || '0000'
  const month = parts.find(part => part.type === 'month')?.value || '01'
  const day = parts.find(part => part.type === 'day')?.value || '01'

  return `${year}-${month}-${day}`
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const timeZoneParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)

  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)

  const getValue = (parts: Intl.DateTimeFormatPart[], type: string) => Number(parts.find(part => part.type === type)?.value || '0')

  const tzTime = getValue(timeZoneParts, 'hour') * 3600
    + getValue(timeZoneParts, 'minute') * 60
    + getValue(timeZoneParts, 'second')
  const utcTime = getValue(dateParts, 'hour') * 3600
    + getValue(dateParts, 'minute') * 60
    + getValue(dateParts, 'second')

  return (utcTime - tzTime) * 1000
}

function zonedTimeToUtc(dateKey: string, timeZone: string, hour: number, minute: number, second: number) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  const offset = getTimeZoneOffsetMs(utcDate, timeZone)
  return new Date(utcDate.getTime() + offset)
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
    const payloadNow = event.payload?.nowIso ? new Date(event.payload.nowIso) : null
    const todayFallback = event.payload?.today || new Date().toISOString().split('T')[0]
    const runDate = new Date(`${todayFallback}T23:59:59Z`)
    const now = payloadNow && !Number.isNaN(payloadNow.getTime())
      ? payloadNow
      : Number.isNaN(runDate.getTime()) ? new Date() : runDate
    const windowMode = event.payload?.windowMode
    const windowHours = event.payload?.windowHours ?? 24
    const timeZone = 'America/Chicago'
    const { windowStart, windowEnd, windowDateKey } = buildTimeWindow(now, windowMode, windowHours, timeZone)
    const today = event.payload?.today || windowDateKey || todayFallback
    const skipTTS = this.env.SKIP_TTS === 'true'
    const ttsProvider = (this.env.TTS_PROVIDER || '').trim().toLowerCase()
    const useGeminiTTS = ttsProvider === 'gemini'
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

        if (testStep === 'tts') {
          const sampleInput = this.env.WORKFLOW_TTS_INPUT
            || this.env.WORKFLOW_TEST_INPUT
            || [
              '女：Hello 大家好，欢迎收听测试播客。',
              '男：大家好，我是老冯。今天我们用一小段对话来测试 TTS。',
              '女：如果你能听到自然的男女声切换，说明流程是通的。',
            ].join('\n')

          console.info('TTS test input', {
            chars: sampleInput.length,
            preview: sampleInput.slice(0, 200),
          })

          if (skipTTS) {
            return 'skip TTS enabled, skip audio generation'
          }

          if (useGeminiTTS) {
            const lines = sampleInput
              .split('\n')
              .map(line => line.trim())
              .filter(Boolean)
            const prompt = buildGeminiTtsPrompt(lines)
            const { audio, extension } = await synthesizeGeminiTTS(prompt, this.env)
            if (!audio.size) {
              throw new Error('podcast audio size is 0')
            }
            const audioKey = `tmp:${event.instanceId}:tts-test.${extension}`
            await this.env.PODCAST_R2.put(audioKey, audio)
            const audioUrl = `${this.env.PODCAST_R2_BUCKET_URL}/${audioKey}?t=${Date.now()}`
            console.info('tts test audio url', audioUrl)
            return audioUrl
          }

          const conversations = sampleInput
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
          const audioUrls: string[] = []
          for (const [index, conversation] of conversations.entries()) {
            if (
              !(conversation.startsWith('男') || conversation.startsWith('女'))
              || !conversation.substring(2).trim()
            ) {
              console.warn('conversation is not valid', conversation)
              continue
            }
            const audio = await synthesize(conversation.substring(2), conversation[0], this.env)
            if (!audio.size) {
              throw new Error('podcast audio size is 0')
            }
            const audioKey = `tmp:${event.instanceId}:tts-test-${index}.mp3`
            await this.env.PODCAST_R2.put(audioKey, audio)
            const audioUrl = `${this.env.PODCAST_R2_BUCKET_URL}/${audioKey}?t=${Date.now()}`
            audioUrls.push(audioUrl)
          }
          return `Generated ${audioUrls.length} audio files`
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
      const topStories = await getStoriesFromSources({
        now,
        env: this.env,
        window: {
          start: windowStart,
          end: windowEnd,
          timeZone,
        },
      })

      if (!topStories.length) {
        console.warn('no stories found, skip workflow run')
        return []
      }

      return topStories
    })

    if (!stories.length) {
      console.info('no stories found after filtering, exit workflow run')
      return
    }

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
    const podcastKeyBase = `${today.replaceAll('-', '/')}/${runEnv}/hacker-podcast-${today}`
    let podcastKey = `${podcastKeyBase}.mp3`

    const ttsInputOverride = this.env.WORKFLOW_TTS_INPUT?.trim()
    if (ttsInputOverride) {
      console.info('TTS input overridden by WORKFLOW_TTS_INPUT')
    }
    const ttsSourceText = ttsInputOverride || podcastContent

    const conversations = ttsSourceText
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
    const dialogLines = conversations.filter(line => line.startsWith('男') || line.startsWith('女'))

    console.info('TTS input stats', {
      hasOverride: Boolean(ttsInputOverride),
      chars: ttsSourceText.length,
      lines: conversations.length,
      dialogLines: dialogLines.length,
      preview: ttsSourceText.slice(0, 200),
    })

    if (skipTTS) {
      console.info('skip TTS enabled, skip audio generation')
    }
    else if (useGeminiTTS) {
      const prompt = buildGeminiTtsPrompt(dialogLines)
      console.info('Gemini TTS input', {
        totalLines: dialogLines.length,
        promptChars: prompt.length,
      })
      try {
        const result = await step.do('create gemini podcast audio', { ...retryConfig, timeout: '5 minutes' }, async () => {
          const { audio, extension } = await synthesizeGeminiTTS(prompt, this.env)
          if (!audio.size) {
            throw new Error('podcast audio size is 0')
          }
          const finalKey = `${podcastKeyBase}.${extension}`
          try {
            await this.env.PODCAST_R2.put(finalKey, audio)
          }
          catch (error) {
            console.error('Gemini TTS upload to R2 failed', {
              key: finalKey,
              error: formatError(error),
            })
            throw error
          }
          const audioUrl = `${this.env.PODCAST_R2_BUCKET_URL}/${finalKey}?t=${Date.now()}`
          return { podcastKey: finalKey, audioUrl }
        })

        podcastKey = result.podcastKey
        console.info('podcast audio url', result.audioUrl)
      }
      catch (error) {
        console.error('Gemini TTS failed', {
          error: formatError(error),
          promptPreview: prompt.slice(0, 400),
        })
        throw error
      }
    }
    else {
      for (const [index, conversation] of conversations.entries()) {
        try {
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

            try {
              await this.env.PODCAST_R2.put(audioKey, audio)
            }
            catch (error) {
              console.error('TTS upload to R2 failed', {
                index,
                key: audioKey,
                error: formatError(error),
              })
              throw error
            }

            try {
              await this.env.PODCAST_KV.put(`tmp:${event.instanceId}:audio:${index}`, audioUrl, { expirationTtl: 3600 })
            }
            catch (error) {
              console.error('TTS write to KV failed', {
                index,
                key: `tmp:${event.instanceId}:audio:${index}`,
                error: formatError(error),
              })
              throw error
            }
            return audioUrl
          })
        }
        catch (error) {
          console.error('TTS line failed', {
            index,
            conversation,
            error: formatError(error),
          })
          throw error
        }
      }
    }

    const audioFiles = skipTTS || useGeminiTTS
      ? []
      : await step.do('collect all audio files', retryConfig, async () => {
          const audioUrls: string[] = []
          for (const [index] of conversations.entries()) {
            try {
              const audioUrl = await this.env.PODCAST_KV.get(`tmp:${event.instanceId}:audio:${index}`)
              if (audioUrl) {
                audioUrls.push(audioUrl)
              }
            }
            catch (error) {
              console.error('collect TTS audio url failed', {
                index,
                key: `tmp:${event.instanceId}:audio:${index}`,
                error: formatError(error),
              })
              throw error
            }
          }
          return audioUrls
        })

    if (!skipTTS && !useGeminiTTS) {
      await step.do('concat audio files', retryConfig, async () => {
        if (!this.env.BROWSER) {
          console.warn('browser is not configured, skip concat audio files')
          return
        }

        const blob = await concatAudioFiles(audioFiles, this.env.BROWSER, { workerUrl: this.env.PODCAST_WORKER_URL })
        try {
          await this.env.PODCAST_R2.put(podcastKey, blob)
        }
        catch (error) {
          console.error('concat audio upload to R2 failed', {
            key: podcastKey,
            error: formatError(error),
          })
          throw error
        }

        const podcastAudioUrl = `${this.env.PODCAST_R2_BUCKET_URL}/${podcastKey}?t=${Date.now()}`
        console.info('podcast audio url', podcastAudioUrl)
        return podcastAudioUrl
      })
    }

    console.info('save podcast to r2 success')

    await step.do('save content to kv', retryConfig, async () => {
      try {
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
      }
      catch (error) {
        console.error('save content to KV failed', {
          key: contentKey,
          error: formatError(error),
        })
        throw error
      }

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

      if (!skipTTS && !useGeminiTTS) {
        // Clean up audio temporary data
        for (const [index] of conversations.entries()) {
          const audioKey = `tmp:${event.instanceId}:audio:${index}`
          deletePromises.push(this.env.PODCAST_KV.delete(audioKey))
        }
      }

      await Promise.all(deletePromises).catch((error) => {
        console.error('cleanup kv failed', {
          error: formatError(error),
        })
      })

      if (!skipTTS && !useGeminiTTS) {
        for (const index of audioFiles.keys()) {
          try {
            await Promise.any([
              this.env.PODCAST_R2.delete(`tmp/${podcastKey}-${index}.mp3`),
              new Promise(resolve => setTimeout(resolve, 200)),
            ])
          }
          catch (error) {
            console.error('delete temp files failed', {
              key: `tmp/${podcastKey}-${index}.mp3`,
              error: formatError(error),
            })
          }
        }
      }

      return 'temporary data cleaned up'
    })
  }
}
