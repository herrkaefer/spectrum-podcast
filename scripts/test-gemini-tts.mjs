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

const prompt = `
女：Hello 大家好，欢迎收听本期播客，我是小雅。

男：大家好，我是老冯。

女：老冯，我最近在看一些关于教育和心理学的文章，发现一个挺扎心的现象。很多家长和老师觉得孩子调皮、不听课，第一反应就是这孩子是不是 ADHD，也就是咱们常说的多动症。但实际上，情况可能比这复杂得多。

男：确实，现在 ADHD 快成了一个万能标签了。但我看最近的技术讨论里提到一个词，叫 Comorbidity，翻译过来就是“共病性”。简单说就是 ADHD 经常和 LD，也就是学习障碍，是成对出现的。

女：这就好比手机系统出故障了，你以为是处理器 CPU 的问题，其实可能是内存条或者是触控屏的驱动不对。

男：这个比喻挺恰当。统计数据挺惊人的，大概有 30% 到 50% 的 ADHD 患者同时也有学习障碍。最麻烦的是误诊。你想啊，一个孩子如果是因为读不懂题、跟不上进度才表现得坐立难安、东张西望，老师很容易觉得他是注意力不集中，直接贴个 ADHD 的标签，但其实他是 LD 导致的焦虑。

女：那我们怎么区分呢？总不能全靠猜吧。

男：有个挺简单的观察维度，就是看这个行为是不是“全天候”的。如果孩子在任何场合都分心，那大概率是 ADHD；但如果他只是在特定科目，比如四年级数学变难了，或者只有在需要独立写作业时才“发作”，那就要高度怀疑是不是 LD 在作弊了。

女：说到写作业，我看到一个特别有意思的观点。说对于 ADHD 的孩子，完成作业其实只成功了一半，最难的那一半竟然是“把作业交上去”。

男：哈哈，这个我有发言权。作为工程师，我太理解这种“执行功能”缺失的感觉了。这事儿跟大脑的前额叶（Frontal lobes）有关。你可以把前额叶想象成公司的运营总监，负责计划、排期、管理文件。ADHD 孩子的前额叶活跃度低，他们的“运营总监”经常翘班。

女：对，文章里说这叫“心理失序”。孩子辛辛苦苦把题做完了，结果塞进书包就成了“黑洞”，或者换个教室的功夫，脑子里关于“交作业”的指令就丢了。很多老师觉得这是孩子懒、态度不好，甚至直接给打零分，这真的太打击积极性了。

男：这种惩罚其实是南辕北辙。你惩罚一个视力不好的人不戴眼镜看清字，那是没用的。这种时候得靠“代偿机制”。比如在书包里专门搞个颜色鲜艳的“作业专用夹”，或者把大任务拆解成 Chunking，就是一小块一小块的，做完一步勾掉一个。

女：而且现在的学校评价体系对这些孩子真的不太友好。我看到那个叫 DIBELS 的标准化测试，听着就让人压力大。

男：那个测试确实挺硬核的，也挺死板。它要求一年级的孩子在一分钟内读完长长的段落，还得流利、有感情。如果孩子读错了一个词，只有 3 秒钟自纠，超过 3 秒就判定错误。

女：这也太卷了吧！一分钟时间，大人面对老板做汇报可能也就这压力了。

男：关键是这种“唯速度论”完全忽略了神经多样性。很多 ADHD 的孩子其实是完美主义者，或者他大脑处理信息的路径比较长。当他拼命关注发音准不准、速度够不够快的时候，他的执行功能已经过载了，根本没余力去理解这个故事讲了什么。最后测出来的结果就是：这孩子阅读理解不行。但其实，他只是被计时器吓坏了。

女：这让我想起一个词，叫“合规性检查”。现在的教育有时候像是在工厂质检，而不是在培养人。

男：没错。所以现在有些比较前卫的教室管理策略，我觉得挺值得推广。比如老师不再问“你能打开书吗？”，而是直接说“请打开历史书”。

女：诶？这有什么讲究吗？

男：因为对于语言加工有障碍的孩子，疑问句会让他们产生误解，觉得这是一个可以拒绝的选项。直接的指令能降低他们的认知负荷。还有就是“公开表扬”，不是那种空泛的“你真棒”，而是具体到“我看到你刚才准确地把活页夹放回去了，做得好”。

女：这其实就是把对特定孩子的干预，变成了一种全班通用的规则。就像路口的无障碍坡道，本来是给轮椅设计的，但推婴儿车的人、拉行李箱的人都受益了。

男：这个比喻极好。这种“普适性设计”能减少这些孩子的挫败感。与其事后补救，不如在环境设计之初就考虑到大脑的多样性。

女：聊到这儿，我感觉咱们不只是在聊 ADHD，其实是在聊如何理解每一个“不一样”的人。

男：对，别轻易下结论，多看看那些行为背后的“硬件限制”和“环境压力”。

女：好了，今天的话题就聊到这里。如果你觉得身边的朋友或者家长可能需要这些信息，欢迎转发给他们。

男：也欢迎大家在评论区分享你的看法。

女：感谢收听 Any Podcast，建议大家使用泛用型播客客户端订阅我们，咱们下期再见。

男：再见。
`

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
