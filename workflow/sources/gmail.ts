import type { AiEnv } from '../ai'
import type { LinkRules, SourceConfig } from './types'

import { Buffer } from 'node:buffer'
import * as cheerio from 'cheerio'
import { $fetch } from 'ofetch'

import { createResponseText, getAiProvider, getPrimaryModel } from '../ai'
import { extractNewsletterLinksPrompt } from '../prompt'
import { getContentFromJinaWithRetry } from '../utils'

interface GmailAccessTokenResponse {
  access_token: string
  expires_in: number
  token_type: string
}

interface GmailMessageListResponse {
  messages?: { id: string }[]
}

interface GmailMessageHeader {
  name: string
  value: string
}

interface GmailMessagePartBody {
  data?: string
  size?: number
}

interface GmailMessagePart {
  mimeType?: string
  filename?: string
  headers?: GmailMessageHeader[]
  body?: GmailMessagePartBody
  parts?: GmailMessagePart[]
}

interface GmailMessage {
  id: string
  internalDate?: string
  payload?: GmailMessagePart
}

interface GmailEnv extends AiEnv {
  GMAIL_CLIENT_ID?: string
  GMAIL_CLIENT_SECRET?: string
  GMAIL_REFRESH_TOKEN?: string
  GMAIL_USER_EMAIL?: string
  JINA_KEY?: string
  NODE_ENV?: string
}

function decodeBase64Url(data: string) {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64').toString('utf8')
}

function getHeader(headers: GmailMessageHeader[] | undefined, name: string) {
  if (!headers) {
    return ''
  }
  const found = headers.find(header => header.name.toLowerCase() === name.toLowerCase())
  return found?.value || ''
}

function findPartByMimeType(part: GmailMessagePart | undefined, mimeType: string): GmailMessagePart | null {
  if (!part) {
    return null
  }
  if (part.mimeType === mimeType) {
    return part
  }
  if (!part.parts) {
    return null
  }
  for (const child of part.parts) {
    const result = findPartByMimeType(child, mimeType)
    if (result) {
      return result
    }
  }
  return null
}

function extractHtml(message: GmailMessage) {
  const payload = message.payload
  if (!payload) {
    return ''
  }

  const htmlPart = findPartByMimeType(payload, 'text/html')
  if (htmlPart?.body?.data) {
    return decodeBase64Url(htmlPart.body.data)
  }

  const textPart = findPartByMimeType(payload, 'text/plain')
  if (textPart?.body?.data) {
    return decodeBase64Url(textPart.body.data)
  }

  return ''
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

const trackingHostnames = [
  'list-manage.com',
  'campaign-archive.com',
  'mailchi.mp',
  'clicks',
  'links',
]

const CHICAGO_TIMEZONE = 'America/Chicago'
const ONE_DAY_MS = 24 * 60 * 60 * 1000

const archiveLinkKeywords = [
  'in your browser',
]

const MAX_NEWSLETTER_LINKS = 10

const newsletterLinkSchema = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      link: { type: 'STRING' },
      title: { type: 'STRING', nullable: true },
    },
    required: ['link'],
  },
} as const

function unwrapTrackingUrl(href: string) {
  let url: URL
  try {
    url = new URL(href)
  }
  catch {
    return { href, unwrapped: false }
  }

  const hostname = url.hostname.toLowerCase()
  const isTrackingHost = trackingHostnames.some(keyword => hostname.includes(keyword))
  const isTrackingPath = url.pathname.toLowerCase().includes('/track/')

  if (!isTrackingHost && !isTrackingPath) {
    return { href, unwrapped: false }
  }

  const candidates = ['url', 'u', 'redirect', 'link', 'r', 'destination']
  for (const key of candidates) {
    const value = url.searchParams.get(key)
    if (!value) {
      continue
    }
    const decoded = decodeURIComponent(value)
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
      return { href: decoded, unwrapped: true }
    }
  }

  return { href, unwrapped: false }
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
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)

  const get = (type: string) => parts.find(part => part.type === type)?.value || '00'
  const utcTime = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute')),
    Number(get('second')),
  )

  return utcTime - date.getTime()
}

function zonedTimeToUtc(
  dateKey: string,
  timeZone: string,
  hour = 0,
  minute = 0,
  second = 0,
) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second)
  const offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone)
  return new Date(utcGuess - offset)
}

function getYesterdayRangeInChicago(now: Date) {
  const yesterday = new Date(now.getTime() - ONE_DAY_MS)
  const dateKey = getDateKeyInTimeZone(yesterday, CHICAGO_TIMEZONE)
  const startUtc = zonedTimeToUtc(dateKey, CHICAGO_TIMEZONE, 0, 0, 0)
  const endUtc = zonedTimeToUtc(dateKey, CHICAGO_TIMEZONE, 23, 59, 59)
  return { dateKey, startUtc, endUtc }
}

function findArchiveLink(html: string) {
  const $ = cheerio.load(html)
  const anchors = $('a[href]').map((_, el) => {
    const rawHref = $(el).attr('href')?.trim() || ''
    const text = normalizeText($(el).text()).toLowerCase()
    return { rawHref, text }
  }).get()

  const match = anchors.find(anchor =>
    anchor.text && archiveLinkKeywords.some(keyword => anchor.text.includes(keyword)),
  )

  if (!match?.rawHref) {
    return ''
  }

  const { href } = unwrapTrackingUrl(match.rawHref)
  return href
}

async function fetchHtml(url: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    return await response.text()
  }
  finally {
    clearTimeout(timeout)
  }
}

async function resolveTrackingRedirect(href: string, cache: Map<string, string>) {
  if (cache.has(href)) {
    return cache.get(href) || href
  }

  let url: URL
  try {
    url = new URL(href)
  }
  catch {
    cache.set(href, href)
    return href
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    const response = await fetch(href, { redirect: 'manual', signal: controller.signal })
    clearTimeout(timeout)

    const location = response.headers.get('location')
    if (location) {
      const resolved = location.startsWith('http')
        ? location
        : new URL(location, url.origin).toString()
      cache.set(href, resolved)
      return resolved
    }
  }
  catch {
    // ignore and fall back to original
  }

  cache.set(href, href)
  return href
}

interface NewsletterLinkCandidate {
  title?: string
  link: string
}

function stripCodeFences(text: string) {
  return text.replace(/```(?:json)?/gi, '').trim()
}

function extractJsonArray(text: string) {
  const trimmed = text.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
  }
  const match = trimmed.match(/\[[\s\S]*\]/)
  return match ? match[0] : ''
}

function parseNewsletterLinks(text: string): NewsletterLinkCandidate[] {
  const cleaned = stripCodeFences(text)
  const json = extractJsonArray(cleaned)
  if (!json) {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  }
  catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }
  const results: NewsletterLinkCandidate[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const record = item as Record<string, unknown>
    const link = typeof record.link === 'string'
      ? record.link
      : typeof record.url === 'string'
        ? record.url
        : ''
    if (!link) {
      continue
    }
    const title = typeof record.title === 'string' ? record.title : undefined
    results.push({
      link: link.trim(),
      title: title?.trim(),
    })
  }
  return results
}

function normalizeUrl(input: string) {
  const trimmed = input.trim().replace(/[),.\]]+$/, '')
  if (!/^https?:\/\//i.test(trimmed)) {
    return ''
  }
  try {
    return new URL(trimmed).toString()
  }
  catch {
    return ''
  }
}

function getUrlKey(input: string) {
  try {
    const url = new URL(input)
    url.hash = ''
    return url.toString()
  }
  catch {
    return input
  }
}

async function htmlToPlainText(html: string) {
  const sanitizedHtml = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
  const out: string[] = []
  const rewriter = new HTMLRewriter()
    .on('script, style, noscript, img, svg, footer, head', {
      element(element) {
        element.remove()
      },
    })
    .on('a', {
      element(element) {
        const href = element.getAttribute('href')?.trim() || ''
        const { href: unwrapped } = unwrapTrackingUrl(href)
        if (unwrapped && /^https?:\/\//i.test(unwrapped)) {
          out.push(` (${unwrapped})`)
        }
      },
      text(text) {
        if (text.text) {
          out.push(text.text)
        }
      },
    })
    .on('h1, h2, h3', {
      element() {
        out.push('\n\n')
      },
      text(text) {
        if (text.text) {
          out.push(text.text.toUpperCase())
        }
      },
    })
    .on('p, li, blockquote', {
      element() {
        out.push('\n\n')
      },
      text(text) {
        if (text.text) {
          out.push(text.text)
        }
      },
    })
    .on('br', {
      element() {
        out.push('\n')
      },
    })
    .on('*', {
      text(text) {
        if (text.text) {
          out.push(text.text)
        }
      },
    })
  await rewriter.transform(new Response(sanitizedHtml)).text()
  const text = out.join('').replace(/\s+/g, ' ').trim()
  return text.replace(/[.#]?[\w-]+[^{}]{0,80}\{[^}]{1,200}\}/g, ' ').replace(/\s+/g, ' ').trim()
}

function buildNewsletterInput(params: {
  subject: string
  content: string
  rules?: LinkRules
}) {
  const { subject, content, rules } = params
  const lines: string[] = []
  lines.push(`【邮件主题】${subject || '（无主题）'}`)
  if (rules?.includeDomains && rules.includeDomains.length > 0) {
    lines.push(`【仅允许域名】${rules.includeDomains.join(', ')}`)
  }
  if (rules?.excludeDomains && rules.excludeDomains.length > 0) {
    lines.push(`【排除域名】${rules.excludeDomains.join(', ')}`)
  }
  if (rules?.excludePathKeywords && rules.excludePathKeywords.length > 0) {
    lines.push(`【排除路径关键词】${rules.excludePathKeywords.join(', ')}`)
  }
  if (rules?.excludeText && rules.excludeText.length > 0) {
    lines.push(`【额外排除文本】${rules.excludeText.join(', ')}`)
  }
  lines.push('【内容】')
  lines.push(content)
  return lines.join('\n')
}

async function extractNewsletterLinksWithAi(params: {
  subject: string
  content: string
  source: SourceConfig
  env: GmailEnv
  messageId: string
  receivedAt: string
}) {
  const { subject, content, source, env, messageId, receivedAt } = params
  const rules = source.linkRules
  const provider = getAiProvider(env)
  const model = getPrimaryModel(env, provider)
  const input = buildNewsletterInput({ subject, content, rules })
  const maxOutputTokens = 4096

  const response = await createResponseText({
    env,
    model,
    instructions: extractNewsletterLinksPrompt,
    input,
    maxOutputTokens,
    responseMimeType: 'application/json',
    responseSchema: newsletterLinkSchema,
  })

  if (rules?.debug) {
    console.info('newsletter ai raw response', {
      subject,
      messageId,
      receivedAt,
      provider,
      model,
      outputLength: response.text.length,
      finishReason: response.finishReason,
      output: response.text,
    })
  }

  let rawCandidates = parseNewsletterLinks(response.text)
  if (rawCandidates.length === 0 && response.text.trim()) {
    const retryInstructions = `${extractNewsletterLinksPrompt}\n\n【重要】上一次输出不是有效 JSON，请仅输出完整 JSON 数组，不要代码块或多余文字。`
    const retryResponse = await createResponseText({
      env,
      model,
      instructions: retryInstructions,
      input,
      maxOutputTokens,
      responseMimeType: 'application/json',
      responseSchema: newsletterLinkSchema,
    })
    if (rules?.debug) {
      console.info('newsletter ai retry response', {
        subject,
        messageId,
        receivedAt,
        provider,
        model,
        outputLength: retryResponse.text.length,
        finishReason: retryResponse.finishReason,
        output: retryResponse.text,
      })
    }
    rawCandidates = parseNewsletterLinks(retryResponse.text)
  }
  const trackingCache = new Map<string, string>()
  const resolveTrackingLinks = rules?.resolveTrackingLinks !== false
  let resolvedCount = 0
  let failedResolveCount = 0

  const normalizedCandidates = await Promise.all(rawCandidates.map(async (candidate) => {
    const normalizedLink = normalizeUrl(candidate.link)
    if (!normalizedLink) {
      return null
    }
    const { href, unwrapped } = unwrapTrackingUrl(normalizedLink)
    let resolved = href
    if (resolveTrackingLinks && !unwrapped) {
      const hostname = (() => {
        try {
          return new URL(href).hostname.toLowerCase()
        }
        catch {
          return ''
        }
      })()
      const isTrackingHost = trackingHostnames.some(keyword => hostname.includes(keyword))
      if (isTrackingHost) {
        resolved = await resolveTrackingRedirect(href, trackingCache)
        if (resolved !== href) {
          resolvedCount += 1
        }
        else {
          failedResolveCount += 1
        }
      }
    }
    return {
      title: candidate.title ? normalizeText(candidate.title) : undefined,
      link: resolved,
    }
  }))

  const filtered = normalizedCandidates.filter((candidate): candidate is NewsletterLinkCandidate => {
    if (!candidate?.link) {
      return false
    }
    try {
      return Boolean(new URL(candidate.link))
    }
    catch {
      return false
    }
  })

  const deduped = new Map<string, NewsletterLinkCandidate>()
  for (const candidate of filtered) {
    const key = getUrlKey(candidate.link)
    if (!deduped.has(key)) {
      deduped.set(key, candidate)
    }
  }

  const results = Array.from(deduped.values()).slice(0, MAX_NEWSLETTER_LINKS)

  if (rules?.debug) {
    console.info('newsletter ai link debug', {
      subject,
      messageId,
      receivedAt,
      inputLength: content.length,
      rawCount: rawCandidates.length,
      trackingResolved: resolvedCount,
      trackingResolveFailed: failedResolveCount,
      afterFilter: filtered.length,
      afterDedup: deduped.size,
      finalCount: results.length,
      provider,
      model,
    })
  }

  return results
}

async function fetchAccessToken(env: GmailEnv) {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    throw new Error('Gmail env vars are not configured')
  }

  const response = await $fetch<GmailAccessTokenResponse>('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  })

  return response.access_token
}

function buildGmailQuery(label: string, start: Date, end: Date) {
  const startSec = Math.floor(start.getTime() / 1000)
  const endSec = Math.floor(end.getTime() / 1000)
  return `label:"${label}" after:${startSec} before:${endSec}`
}

async function listMessages(userId: string, query: string, maxResults: number, token: string) {
  const result = await $fetch<GmailMessageListResponse>(`https://gmail.googleapis.com/gmail/v1/users/${userId}/messages`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    query: {
      q: query,
      maxResults,
    },
  })
  return result.messages ?? []
}

async function getMessage(userId: string, id: string, token: string) {
  return await $fetch<GmailMessage>(`https://gmail.googleapis.com/gmail/v1/users/${userId}/messages/${id}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    query: {
      format: 'full',
    },
  })
}

export async function fetchGmailItems(
  source: SourceConfig,
  now: Date,
  lookbackDays: number,
  env: GmailEnv,
  window?: { start: Date, end: Date, timeZone: string },
) {
  if (!source.label) {
    console.warn('gmail source missing label', source)
    return []
  }

  const userId = env.GMAIL_USER_EMAIL || 'me'
  const token = await fetchAccessToken(env)
  const { dateKey: targetDateKey, startUtc, endUtc } = getYesterdayRangeInChicago(now)
  const windowStart = window?.start || startUtc || new Date(now.getTime() - Math.max(lookbackDays, 2) * ONE_DAY_MS)
  const windowEnd = window?.end || endUtc || now
  const query = buildGmailQuery(source.label, windowStart, windowEnd)
  let maxMessages = source.maxMessages || 50
  if (env.NODE_ENV && env.NODE_ENV !== 'production') {
    maxMessages = Math.min(maxMessages, 3)
  }

  const messageRefs = await listMessages(userId, query, maxMessages, token)

  const messages = await Promise.all(
    messageRefs.map(ref => getMessage(userId, ref.id, token)),
  )

  const items = [] as Story[]

  for (const message of messages) {
    const html = extractHtml(message)
    if (!html) {
      console.warn('gmail message missing html body', { id: message.id })
      continue
    }

    const subject = getHeader(message.payload?.headers, 'Subject')
    const receivedAt = message.internalDate ? new Date(Number(message.internalDate)) : now
    const receivedAtIso = receivedAt.toISOString()
    if (receivedAt < windowStart || receivedAt > windowEnd) {
      continue
    }

    if (!window) {
      const receivedDateKey = getDateKeyInTimeZone(receivedAt, CHICAGO_TIMEZONE)
      if (receivedDateKey !== targetDateKey) {
        continue
      }
    }

    const archiveLink = findArchiveLink(html)
    let newsletterContent = ''
    if (archiveLink) {
      try {
        newsletterContent = await getContentFromJinaWithRetry(archiveLink, 'markdown', {}, env.JINA_KEY)
      }
      catch (error) {
        console.warn('newsletter archive jina failed', { error, id: message.id, subject, receivedAt: receivedAtIso, archiveLink })
      }

      if (!newsletterContent) {
        try {
          const archiveHtml = await fetchHtml(archiveLink)
          newsletterContent = await htmlToPlainText(archiveHtml)
        }
        catch (error) {
          console.warn('failed to fetch archive html, fallback to email html', { error, id: message.id, subject, receivedAt: receivedAtIso })
        }
      }
    }
    else {
      console.info('newsletter missing archive link, use email html', { id: message.id, subject, receivedAt: receivedAtIso })
    }

    if (!newsletterContent) {
      newsletterContent = await htmlToPlainText(html)
      if (source.linkRules?.debug) {
        console.info('newsletter html cleaned content', {
          subject,
          messageId: message.id,
          receivedAt: receivedAtIso,
          length: newsletterContent.length,
          content: newsletterContent,
        })
      }
    }

    if (!newsletterContent) {
      console.warn('newsletter content is empty, skip message', { id: message.id, subject, receivedAt: receivedAtIso })
      continue
    }

    try {
      const links = await extractNewsletterLinksWithAi({
        subject,
        content: newsletterContent,
        source,
        env,
        messageId: message.id,
        receivedAt: receivedAtIso,
      })
      if (links.length === 0) {
        console.warn('newsletter has no matching links', { id: message.id, subject, receivedAt: receivedAtIso })
        continue
      }
      links.forEach((link, index) => {
        items.push({
          id: `${message.id}:${index}`,
          title: link.title || subject,
          url: link.link,
          hackerNewsUrl: link.link,
          sourceName: source.name,
          sourceUrl: source.url,
          publishedAt: receivedAt.toISOString(),
          sourceItemId: message.id,
          sourceItemTitle: subject,
        })
      })
    }
    catch (error) {
      console.warn('newsletter ai extraction failed, skip message', { error, id: message.id, subject, receivedAt: receivedAtIso })
    }
  }

  return items
}
