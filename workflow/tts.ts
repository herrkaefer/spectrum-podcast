import { Buffer } from 'node:buffer'
import { synthesize } from '@echristian/edge-tts'
import { GoogleGenAI } from '@google/genai'
import { $fetch } from 'ofetch'

interface Env extends CloudflareEnv {
  TTS_PROVIDER?: string
  TTS_API_URL?: string
  TTS_API_ID?: string
  TTS_API_KEY?: string
  TTS_MODEL?: string
  GEMINI_API_KEY?: string
  MAN_VOICE_ID?: string
  WOMAN_VOICE_ID?: string
  AUDIO_SPEED?: string
}

interface GeminiAudioResult {
  audio: Blob
  extension: string
  mimeType: string
}

async function edgeTTS(text: string, gender: string, env: Env) {
  const { audio } = await synthesize({
    text,
    language: 'zh-CN',
    voice: gender === '男' ? (env.MAN_VOICE_ID || 'zh-CN-YunyangNeural') : (env.WOMAN_VOICE_ID || 'zh-CN-XiaoxiaoNeural'),
    rate: env.AUDIO_SPEED || '10%',
  })
  return audio
}

async function minimaxTTS(text: string, gender: string, env: Env) {
  const result = await $fetch<{ data: { audio: string }, base_resp: { status_msg: string } }>(`${env.TTS_API_URL || 'https://api.minimaxi.com/v1/t2a_v2'}?GroupId=${env.TTS_API_ID}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.TTS_API_KEY}`,
    },
    timeout: 30000,
    body: JSON.stringify({
      model: env.TTS_MODEL || 'speech-2.6-hd',
      text,
      timber_weights: [
        {
          voice_id: gender === '男' ? (env.MAN_VOICE_ID || 'Chinese (Mandarin)_Gentleman') : (env.WOMAN_VOICE_ID || 'Chinese (Mandarin)_Gentle_Senior'),
          weight: 100,
        },
      ],
      voice_setting: {
        voice_id: '',
        speed: Number(env.AUDIO_SPEED || 1.1),
        pitch: 0,
        vol: 1,
        latex_read: false,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
      },
      language_boost: 'Chinese',
    }),
  })

  if (result?.data?.audio) {
    const buffer = Buffer.from(result.data.audio, 'hex')
    return new Blob([buffer.buffer], { type: 'audio/mpeg' })
  }
  throw new Error(`Failed to fetch audio: ${result?.base_resp?.status_msg}`)
}

/**
 * murf.ai 语音合成服务每月$10的免费额度，相对于 minimax 收费，没有预算的用户可以使用
 * 使用 Murf 语音合成服务将文本转换为音频。
 * 根据 `gender` 选择不同的预设音色，并可通过环境变量调整语速等参数。
 *
 * @param text 要合成的文本内容
 * @param gender 性别标识：传入 `'男'` 使用男声，否则使用女声
 * @param env 运行环境配置，包含 `TTS_API_URL`、`TTS_API_KEY`、`TTS_MODEL`、`MAN_VOICE_ID`、`WOMAN_VOICE_ID`、`AUDIO_SPEED` 等
 * @returns 返回包含 MP3 数据的 `Blob`
 * @throws 当请求失败或服务返回非 2xx 状态码时抛出错误
 * @apiUrl https://murf.ai/api/docs/api-reference/text-to-speech/stream?explorer=true
 * @getKeyUrl https://murf.ai/api/api-keys
 */
async function murfTTS(text: string, gender: string, env: Env) {
  const result = await $fetch(`${env.TTS_API_URL || 'https://api.murf.ai/v1/speech/stream'}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': `${env.TTS_API_KEY}`,
    },
    timeout: 30000,
    // en-UK-ruby 女声1
    // zh-CN-wei 女声2
    // en-US-ken 男声1
    // zh-CN-tao 男声2
    // pl-PL-jacek 男声3
    body: JSON.stringify({
      text,
      voiceId: gender === '男' ? env.MAN_VOICE_ID || 'en-US-ken' : env.WOMAN_VOICE_ID || 'en-UK-ruby',
      model: env.TTS_MODEL || 'GEN2',
      multiNativeLocale: 'zh-CN',
      style: 'Conversational',
      rate: Number(env.AUDIO_SPEED || -8),
      pitch: 0,
      format: 'MP3',
    }),
  })

  if (result.ok) {
    const body = await result.arrayBuffer()
    const buffer = Buffer.from(body)
    return new Blob([buffer.buffer], { type: 'audio/mpeg' })
  }
  throw new Error(`Failed to fetch audio: ${result.statusText}`)
}

export function buildGeminiTtsPrompt(lines: string[]): string {
  const cleaned = lines
    .map(line => line.trim())
    .filter(line => line && (line.startsWith('男') || line.startsWith('女')))
  if (!cleaned.length) {
    throw new Error('Gemini TTS prompt is empty: no valid speaker lines found')
  }
  return [
    '请用中文播报以下播客对话，语气自然、节奏流畅、音量稳定。',
    ...cleaned,
  ].join('\n')
}

export async function synthesizeGeminiTTS(text: string, env: Env): Promise<GeminiAudioResult> {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required when using Gemini TTS')
  }

  const model = env.TTS_MODEL || 'gemini-2.5-flash-preview-tts'
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY })
  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: [
            {
              speaker: '女',
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: env.WOMAN_VOICE_ID || 'Zephyr',
                },
              },
            },
            {
              speaker: '男',
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: env.MAN_VOICE_ID || 'Puck',
                },
              },
            },
          ],
        },
      },
    },
  })

  const inlineData = extractInlineData(response)
  if (!inlineData?.data) {
    throw new Error('Gemini TTS returned empty audio data')
  }

  const mimeType = inlineData.mimeType || 'audio/wav'
  let buffer = Buffer.from(inlineData.data, 'base64')
  let extension = getExtensionFromMime(mimeType)
  let finalMimeType = mimeType

  if (!extension) {
    extension = 'wav'
    buffer = convertToWav(buffer, mimeType)
    finalMimeType = 'audio/wav'
  }

  const audio = new Blob([buffer], { type: finalMimeType })
  return { audio, extension, mimeType: finalMimeType }
}

export default function (text: string, gender: string, env: Env) {
  console.info('TTS_PROVIDER', env.TTS_PROVIDER)
  switch (env.TTS_PROVIDER) {
    case 'minimax':
      return minimaxTTS(text, gender, env)
    case 'murf':
      return murfTTS(text, gender, env)
    case 'gemini':
      throw new Error('Gemini TTS only supports full podcast synthesis, not per-line synthesis')
    default:
      return edgeTTS(text, gender, env)
  }
}

function extractInlineData(response: { candidates?: { content?: { parts?: { inlineData?: { data?: string, mimeType?: string } }[] } }[] }) {
  const parts = response.candidates?.[0]?.content?.parts
  if (!parts) {
    return null
  }
  for (const part of parts) {
    if (part?.inlineData?.data) {
      return part.inlineData
    }
  }
  return null
}

function getExtensionFromMime(mimeType: string) {
  const [fileType] = mimeType.split(';').map(part => part.trim())
  if (!fileType) {
    return ''
  }
  const [, subtype] = fileType.split('/')
  if (!subtype) {
    return ''
  }
  if (subtype === 'wav' || subtype === 'x-wav') {
    return 'wav'
  }
  if (subtype === 'mpeg') {
    return 'mp3'
  }
  if (subtype === 'ogg') {
    return 'ogg'
  }
  if (subtype === 'webm') {
    return 'webm'
  }
  return ''
}

function convertToWav(buffer: Buffer, mimeType: string) {
  const options = parseMimeType(mimeType)
  const wavHeader = createWavHeader(buffer.length, options)
  return Buffer.concat([wavHeader, buffer])
}

function parseMimeType(mimeType: string) {
  const [fileType, ...params] = mimeType.split(';').map(part => part.trim())
  const [, format] = fileType.split('/')

  const options = {
    numChannels: 1,
    sampleRate: 24000,
    bitsPerSample: 16,
  }

  if (format && format.startsWith('L')) {
    const bits = Number.parseInt(format.slice(1), 10)
    if (!Number.isNaN(bits)) {
      options.bitsPerSample = bits
    }
  }

  for (const param of params) {
    const [key, value] = param.split('=').map(part => part.trim())
    if (key === 'rate') {
      const rate = Number.parseInt(value, 10)
      if (!Number.isNaN(rate)) {
        options.sampleRate = rate
      }
    }
  }

  return options
}

function createWavHeader(dataLength: number, options: { numChannels: number, sampleRate: number, bitsPerSample: number }) {
  const { numChannels, sampleRate, bitsPerSample } = options
  const byteRate = sampleRate * numChannels * bitsPerSample / 8
  const blockAlign = numChannels * bitsPerSample / 8
  const buffer = Buffer.alloc(44)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataLength, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataLength, 40)

  return buffer
}
