import type { LinkRules, SourceConfig } from './types'

import { Buffer } from 'node:buffer'
import * as cheerio from 'cheerio'
import { $fetch } from 'ofetch'

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

interface GmailEnv {
  GMAIL_CLIENT_ID?: string
  GMAIL_CLIENT_SECRET?: string
  GMAIL_REFRESH_TOKEN?: string
  GMAIL_USER_EMAIL?: string
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

function matchesAny(text: string, patterns?: string[]) {
  if (!patterns || patterns.length === 0) {
    return false
  }
  const lower = text.toLowerCase()
  return patterns.some(pattern => lower.includes(pattern.toLowerCase()))
}

const trackingHostnames = [
  'list-manage.com',
  'campaign-archive.com',
  'mailchi.mp',
  'clicks',
  'links',
]

const defaultExcludeText = [
  'unsubscribe',
  'subscribe',
  'privacy',
  'terms',
  'terms and conditions',
  'contact',
  'manage preferences',
  'preferences',
  'forward',
  'share',
  'tweet',
  'facebook',
  'twitter',
  'linkedin',
  'instagram',
  'youtube',
  'rss',
]

const defaultExcludePathKeywords = [
  '/webinar/',
  '/category/',
  '/unsubscribe',
  '/subscribe',
  '/privacy',
  '/terms',
  '/contact',
]

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

function normalizeUrlPath(pathname: string) {
  return pathname ? pathname.toLowerCase() : ''
}

function getUrlPathDepth(pathname: string) {
  return pathname.split('/').filter(Boolean).length
}

function getLastPathSegment(pathname: string) {
  const parts = pathname.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

function scoreArticleLink(link: { href: string, text: string }, rules?: LinkRules) {
  const minTextLength = rules?.minTextLength ?? 8
  let url: URL

  try {
    url = new URL(link.href)
  }
  catch {
    return -1
  }

  const path = normalizeUrlPath(url.pathname)
  const text = link.text || ''
  let score = 0

  if (getUrlPathDepth(path) >= 2) {
    score += 1
  }

  const lastSegment = getLastPathSegment(path)
  if (lastSegment.length >= 10 && /[-_]/.test(lastSegment)) {
    score += 1
  }

  if (rules?.includePathKeywords && rules.includePathKeywords.length > 0) {
    if (rules.includePathKeywords.some(keyword => path.includes(keyword.toLowerCase()))) {
      score += 1
    }
  }

  if (text.length >= minTextLength) {
    score += 1
  }

  return score
}

async function extractLinks(html: string, rules?: LinkRules, debug?: { subject?: string, messageId?: string }) {
  const $ = cheerio.load(html)
  const links = $('a[href]').map((_, el) => {
    const rawHref = $(el).attr('href')?.trim() || ''
    const { href, unwrapped } = unwrapTrackingUrl(rawHref)
    const text = normalizeText($(el).text())
    const imageAlt = normalizeText($(el).find('img').attr('alt') || '')
    const title = normalizeText($(el).attr('title') || '')
    const aria = normalizeText($(el).attr('aria-label') || '')
    const displayText = text || imageAlt || aria || title
    return { href, text: displayText, unwrapped, rawHref }
  }).get()

  const resolveTrackingLinks = rules?.resolveTrackingLinks !== false
  const trackingCache = new Map<string, string>()
  let resolvedCount = 0
  let failedResolveCount = 0

  const resolvedLinks = resolveTrackingLinks
    ? await Promise.all(links.map(async (link) => {
        const rawUrl = link.href
        let resolvedHref = rawUrl
        if (!link.unwrapped) {
          const hostname = (() => {
            try {
              return new URL(rawUrl).hostname.toLowerCase()
            }
            catch {
              return ''
            }
          })()
          const isTrackingHost = trackingHostnames.some(keyword => hostname.includes(keyword))
          if (isTrackingHost) {
            resolvedHref = await resolveTrackingRedirect(rawUrl, trackingCache)
            if (resolvedHref !== rawUrl) {
              resolvedCount += 1
            }
            else {
              failedResolveCount += 1
            }
          }
        }
        return { ...link, href: resolvedHref }
      }))
    : links

  const filtered = resolvedLinks.filter((link) => {
    if (!link.href) {
      return false
    }

    const text = link.text || ''
    const excludeText = [...defaultExcludeText, ...(rules?.excludeText || [])]
    if (matchesAny(text, excludeText)) {
      return false
    }

    return true
  })

  const uniqueByHref = new Map<string, typeof filtered[number]>()
  for (const link of filtered) {
    const existing = uniqueByHref.get(link.href)
    if (!existing || (link.text && link.text.length > (existing.text || '').length)) {
      uniqueByHref.set(link.href, link)
    }
  }
  const deduped = Array.from(uniqueByHref.values())

  const domainFiltered = deduped.filter((link) => {
    if (!rules?.includeDomains && !rules?.excludeDomains) {
      return true
    }
    try {
      const hostname = new URL(link.href).hostname
      if (rules.includeDomains && rules.includeDomains.length > 0) {
        if (!rules.includeDomains.some(domain => hostname.includes(domain))) {
          return false
        }
      }
      if (rules.excludeDomains && rules.excludeDomains.length > 0) {
        if (rules.excludeDomains.some(domain => hostname.includes(domain))) {
          return false
        }
      }
      return true
    }
    catch {
      return false
    }
  })

  const pathFiltered = domainFiltered.filter((link) => {
    const excludePathKeywords = [...defaultExcludePathKeywords, ...(rules?.excludePathKeywords || [])]
    if (!excludePathKeywords.length) {
      return true
    }
    try {
      const pathname = new URL(link.href).pathname.toLowerCase()
      return !excludePathKeywords.some(keyword => pathname.includes(keyword.toLowerCase()))
    }
    catch {
      return false
    }
  })

  const minScore = rules?.minArticleScore ?? 2
  const scored = pathFiltered.map(link => ({
    ...link,
    score: scoreArticleLink(link, rules),
  }))

  const kept = scored.filter(link => link.score >= minScore)

  if (rules?.debug) {
    const maxLinks = rules.debugMaxLinks ?? 20
    console.info('newsletter link debug', {
      subject: debug?.subject,
      messageId: debug?.messageId,
      total: links.length,
      unwrapped: links.filter(link => link.unwrapped).length,
      trackingResolved: resolvedCount,
      trackingResolveFailed: failedResolveCount,
      afterTextFilter: filtered.length,
      afterDedup: deduped.length,
      afterDomainFilter: domainFiltered.length,
      afterPathFilter: pathFiltered.length,
      afterScoreFilter: kept.length,
      minScore,
    })
    kept.slice(0, maxLinks).forEach((link) => {
      console.info('newsletter link kept', {
        text: link.text,
        href: link.href,
        score: link.score,
        unwrapped: link.unwrapped,
      })
    })
  }

  return kept
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
) {
  if (!source.label) {
    console.warn('gmail source missing label', source)
    return []
  }

  const userId = env.GMAIL_USER_EMAIL || 'me'
  const token = await fetchAccessToken(env)
  const windowStart = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
  const query = buildGmailQuery(source.label, windowStart, now)
  let maxMessages = source.maxMessages || 50
  if (env.NODE_ENV && env.NODE_ENV !== 'production') {
    maxMessages = Math.min(maxMessages, 2)
  }

  const messageRefs = await listMessages(userId, query, maxMessages, token)

  const messages = await Promise.all(
    messageRefs.map(ref => getMessage(userId, ref.id, token)),
  )

  const items = [] as Story[]

  for (const message of messages) {
    const html = extractHtml(message)
    if (!html) {
      console.warn('gmail message missing html body', message.id)
      continue
    }

    const subject = getHeader(message.payload?.headers, 'Subject')
    const receivedAt = message.internalDate ? new Date(Number(message.internalDate)) : now
    if (receivedAt < windowStart || receivedAt > now) {
      continue
    }

    const links = await extractLinks(html, source.linkRules, { subject, messageId: message.id })
    if (links.length === 0) {
      console.warn('gmail message has no matching links', { id: message.id, subject })
      continue
    }

    links.forEach((link, index) => {
      items.push({
        id: `${message.id}:${index}`,
        title: link.text || subject,
        url: link.href,
        hackerNewsUrl: link.href,
        sourceName: source.name,
        sourceUrl: source.url,
        publishedAt: receivedAt.toISOString(),
        sourceItemId: message.id,
        sourceItemTitle: subject,
      })
    })
  }

  return items
}
