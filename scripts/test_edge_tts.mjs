#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { synthesize } from '@echristian/edge-tts'

async function sleep(ms) {
  return new Promise(resolveFn => setTimeout(resolveFn, ms))
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => {
        clearTimeout(timer)
        reject(new Error(`Edge TTS timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    }),
  ])
}

async function edgeTTS(text, gender, options = {}) {
  const voice = gender === '男' ? (options.manVoiceId || 'zh-CN-YunyangNeural') : (options.womanVoiceId || 'zh-CN-XiaoxiaoNeural')
  const rate = options.rate || '10%'
  const maxRetries = Number.isFinite(options.retries) ? options.retries : 2
  let delayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 1500
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20000

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const startedAt = Date.now()
      const { audio } = await withTimeout(synthesize({
        text,
        language: 'zh-CN',
        voice,
        rate,
      }), timeoutMs)
      const elapsedMs = Date.now() - startedAt
      return { audio, elapsedMs }
    }
    catch (error) {
      if (attempt >= maxRetries) {
        throw error
      }
      console.warn(`Edge TTS failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms`, error?.message || error)
      await sleep(delayMs)
      delayMs *= 2
    }
  }

  throw new Error('Edge TTS failed after retries')
}

async function main() {
  console.info('CWD:', process.cwd())
  const maleText = '这是一条测试男声的语音。'
  const femaleText = '这是一条测试女声的语音。'

  console.info('Generating male voice with Edge TTS...')
  const male = await edgeTTS(maleText, '男')
  console.info(`Male voice generated in ${male.elapsedMs}ms`)

  console.info('Generating female voice with Edge TTS...')
  const female = await edgeTTS(femaleText, '女')
  console.info(`Female voice generated in ${female.elapsedMs}ms`)

  const maleOut = resolve(process.cwd(), 'tmp-edge-male.mp3')
  const femaleOut = resolve(process.cwd(), 'tmp-edge-female.mp3')

  await writeFile(maleOut, male.audio)
  await writeFile(femaleOut, female.audio)

  console.info('Done.')
  console.info('Male:', maleOut)
  console.info('Female:', femaleOut)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
