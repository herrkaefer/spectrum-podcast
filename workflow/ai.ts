import { GoogleGenAI } from '@google/genai'

export type AiProvider = 'openai' | 'gemini'

export interface AiEnv {
  OPENAI_BASE_URL?: string
  OPENAI_API_KEY?: string
  OPENAI_MODEL?: string
  OPENAI_THINKING_MODEL?: string
  OPENAI_MAX_TOKENS?: string
  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
  GEMINI_THINKING_MODEL?: string
  GEMINI_MAX_TOKENS?: string
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

const defaultOpenAIBaseUrl = 'https://api.openai.com/v1'

export function getAiProvider(env: AiEnv): AiProvider {
  const hasGemini = Boolean(env.GEMINI_API_KEY?.trim()) && Boolean(env.GEMINI_MODEL?.trim())
  const hasOpenAI = Boolean(env.OPENAI_API_KEY?.trim()) && Boolean(env.OPENAI_MODEL?.trim())
  if (hasGemini) {
    return 'gemini'
  }
  if (hasOpenAI) {
    return 'openai'
  }
  return 'openai'
}

export function getPrimaryModel(env: AiEnv, provider: AiProvider): string {
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

export function getThinkingModel(env: AiEnv, provider: AiProvider): string {
  if (provider === 'gemini') {
    return env.GEMINI_THINKING_MODEL || getPrimaryModel(env, provider)
  }
  return env.OPENAI_THINKING_MODEL || getPrimaryModel(env, provider)
}

export function getMaxTokens(env: AiEnv, provider: AiProvider): number {
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

export async function createResponseText(params: {
  env: AiEnv
  model: string
  instructions: string
  input: string
  maxOutputTokens?: number
  responseMimeType?: string
  responseSchema?: unknown
}): Promise<ResponseTextResult> {
  const { env, model, instructions, input, maxOutputTokens, responseMimeType, responseSchema } = params
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
    if (responseMimeType) {
      config.responseMimeType = responseMimeType
    }
    if (responseSchema) {
      config.responseSchema = responseSchema
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
    const candidate = (response as { candidates?: { finishReason?: string, finishMessage?: string }[] }).candidates?.[0]
    return {
      text,
      usage: (response as { usageMetadata?: unknown }).usageMetadata,
      finishReason: candidate?.finishReason || candidate?.finishMessage,
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
