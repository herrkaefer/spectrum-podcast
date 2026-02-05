#!/usr/bin/env node
import { Buffer } from 'node:buffer'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

function parseEnvFile(filePath) {
  const env = {}
  const content = readFileSync(filePath, 'utf8')
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) {
      continue
    }
    const key = line.slice(0, eqIndex).trim()
    let value = line.slice(eqIndex + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

function loadEnv() {
  const rootEnvPath = resolve(process.cwd(), '.env.local')
  const workerEnvPath = resolve(process.cwd(), 'worker/.env.local')

  const rootEnv = existsSync(rootEnvPath) ? parseEnvFile(rootEnvPath) : {}
  const workerEnv = existsSync(workerEnvPath) ? parseEnvFile(workerEnvPath) : {}

  if (!Object.keys(rootEnv).length && !Object.keys(workerEnv).length) {
    throw new Error('No .env.local or worker/.env.local found.')
  }

  if (!Object.keys(rootEnv).length) {
    console.warn('Using worker/.env.local because .env.local was not found.')
  }

  return { ...rootEnv, ...workerEnv }
}

async function minimaxTTS(text, gender, env) {
  const apiUrl = env.TTS_API_URL || 'https://api.minimaxi.com/v1/t2a_v2'
  const groupId = env.TTS_API_ID
  const apiKey = env.TTS_API_KEY

  if (!groupId || !apiKey) {
    throw new Error('Missing TTS_API_ID or TTS_API_KEY in .env.local')
  }

  const response = await fetch(`${apiUrl}?GroupId=${groupId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: env.TTS_MODEL || 'speech-2.6-hd',
      text,
      timber_weights: [
        {
          voice_id: gender === '男'
            ? (env.MAN_VOICE_ID || 'Chinese (Mandarin)_Gentleman')
            : (env.WOMAN_VOICE_ID || 'Chinese (Mandarin)_Gentle_Senior'),
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

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`MiniMax TTS failed: ${response.status} ${response.statusText} ${errorText}`)
  }

  const result = await response.json()
  if (result?.data?.audio) {
    const buffer = Buffer.from(result.data.audio, 'hex')
    return Buffer.from(buffer.buffer)
  }

  throw new Error(`MiniMax TTS failed: ${result?.base_resp?.status_msg || 'unknown error'}`)
}

async function main() {
  const env = loadEnv()

  const maleText = '男：这是一条测试男声的语音。'
  const femaleText = '女：这是一条测试女声的语音。'

  console.info('Generating male voice...')
  const maleAudio = await minimaxTTS(maleText.slice(2), '男', env)
  console.info('Generating female voice...')
  const femaleAudio = await minimaxTTS(femaleText.slice(2), '女', env)

  const maleOut = resolve(process.cwd(), 'tmp-minimax-male.mp3')
  const femaleOut = resolve(process.cwd(), 'tmp-minimax-female.mp3')

  await writeFile(maleOut, maleAudio)
  await writeFile(femaleOut, femaleAudio)

  console.info('Done.')
  console.info('Male:', maleOut)
  console.info('Female:', femaleOut)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
