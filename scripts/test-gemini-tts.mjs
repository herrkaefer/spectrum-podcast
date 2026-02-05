import { Buffer } from 'node:buffer'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { GoogleGenAI } from '@google/genai'

await loadEnvFromLocal()

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  throw new Error('缺少 GEMINI_API_KEY，请先在环境变量中配置。')
}

const model = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts'
const outputPath = process.env.GEMINI_TTS_OUTPUT || 'tmp/gemini-tts-test.wav'

const prompt = [
  '女：Hello 大家好，欢迎收听 Agili 的 Hacker Podcast，我是小雅。',
  '男：我是老冯。今天这几篇文章拼在一起，还挺有“脑洞宇宙”的感觉：有被撤稿的自闭症用药实验，有科学家该不该用 AI 写论文的大讨论，还有把自己塞进核磁共振里反复拍脑子的研究，外加一只鼻子长得跟外星生物一样的星鼻鼹。',
  '女：对，还有几本今年讨论度很高的神经科学新书。今天就像一次“年度神经科学大串烧”，边聊新闻边聊一点幕后逻辑：科学到底是怎么被做出来的，又是怎么被做“歪”的。',
  '男：行，那先从最现实、也最让家长揪心的那个开始吧——叶酸钙和自闭症。',
  '女：这事我看完挺难受的。简单说，就是一篇关于叶酸钙（leucovorin、folinic acid）治疗自闭症的大型临床试验，被《European Journal of Pediatrics》撤稿了。原因不是观念之争，而是——数据对不上、统计分析复现不了。',
  '男：而且这篇不是“众多论文中的一篇”，而是：在自闭症人群里测试口服叶酸钙的随机对照试验，目前一共也就 5 项，这一篇还是样本量最大的，有 77 个孩子。它一撤，相当于本来就很薄的一层证据，又被掏掉一大块。',
  '女：更尴尬的是，美国 FDA 去年还刚宣布，要扩展叶酸钙在自闭症里的适应证。很多研究者当时就觉得：“你这是赌得有点大啊”，因为决策主要是基于 23 项“脑叶酸缺乏症”的儿童研究——那是个罕见遗传病，不是普通意义上的自闭症。',
  '男：对，你可以把它理解成：因为在一个非常罕见、机制比较清晰的病里，叶酸看起来有点希望，就顺手把那一套逻辑搬到自闭症上来了。但中间其实缺了非常多台阶。现在最大的一块“支持性证据”又撤稿了，整个楼就更晃了。',
  '女：这里有两个点我觉得得给非专业听众解释一下。第一，为什么有些医生、家长那么在乎叶酸钙？第二，撤稿到底意味着什么，是不是就代表“这药肯定没用”？',
  '男：先说为啥在乎。UCLA 的 Shafali Jeste 提到一个挺关键的线索：叶酸受体自身抗体。简单说，有一部分孩子（包括一些自闭症孩子），免疫系统会“误伤”叶酸受体，导致脑子里叶酸运不进去，这叫脑叶酸缺乏症（cerebral folate deficiency）。那直觉就来了：既然有这类抗体在自闭症里可能更常见，那给更多叶酸钙，能不能“顶一顶”？',
  '女：听上去很顺嘛，对不对',
].join('\n')

const ai = new GoogleGenAI({ apiKey })

const response = await ai.models.generateContent({
  model,
  contents: [{ parts: [{ text: prompt }] }],
  config: {
    responseModalities: ['AUDIO'],
    speechConfig: {
      multiSpeakerVoiceConfig: {
        speakerVoiceConfigs: [
          {
            speaker: '女',
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Zephyr' },
            },
          },
          {
            speaker: '男',
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Sadaltager' },
            },
          },
        ],
      },
    },
  },
})

const inlineData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData
if (!inlineData?.data) {
  throw new Error('未获取到音频数据，请检查返回内容。')
}

const mimeType = inlineData.mimeType || ''
const base64Data = inlineData.data
const rawBuffer = Buffer.from(base64Data, 'base64')

let outputBuffer = rawBuffer
let fileExtension = getExtensionFromMime(mimeType)

if (!fileExtension) {
  fileExtension = 'wav'
  outputBuffer = convertToWav(rawBuffer, mimeType)
}

const finalPath = outputPath.endsWith(`.${fileExtension}`)
  ? outputPath
  : `${outputPath}.${fileExtension}`

const outputDir = dirname(finalPath)
if (outputDir && outputDir !== '.') {
  await mkdir(outputDir, { recursive: true })
}

await writeFile(finalPath, outputBuffer)
console.info(`Gemini TTS 已生成：${finalPath}`)

function getExtensionFromMime(mimeType) {
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

function convertToWav(buffer, mimeType) {
  const options = parseMimeType(mimeType)
  const wavHeader = createWavHeader(buffer.length, options)
  return Buffer.concat([wavHeader, buffer])
}

function parseMimeType(mimeType) {
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

function createWavHeader(dataLength, options) {
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

async function loadEnvFromLocal() {
  const candidates = [
    resolve(process.cwd(), 'worker/.env.local'),
    resolve(process.cwd(), '.env.local'),
  ]

  for (const envPath of candidates) {
    try {
      const content = await readFile(envPath, 'utf8')
      const entries = parseEnv(content)
      for (const [key, value] of entries) {
        if (process.env[key] === undefined) {
          process.env[key] = value
        }
      }
    }
    catch (error) {
      if (error && error.code === 'ENOENT') {
        continue
      }
      throw error
    }
  }
}

function parseEnv(content) {
  const lines = content.split(/\r?\n/)
  const entries = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const index = trimmed.indexOf('=')
    if (index === -1) {
      continue
    }
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1)
    }
    if (key) {
      entries.push([key, value])
    }
  }
  return entries
}
