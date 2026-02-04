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

function extractLinks(html: string, rules?: LinkRules) {
  const $ = cheerio.load(html)
  const links = $('a[href]').map((_, el) => {
    const href = $(el).attr('href')?.trim() || ''
    const text = normalizeText($(el).text())
    const title = normalizeText($(el).attr('title') || '')
    const aria = normalizeText($(el).attr('aria-label') || '')
    const displayText = text || aria || title
    return { href, text: displayText }
  }).get()

  const filtered = links.filter((link) => {
    if (!link.href) {
      return false
    }

    const text = link.text || ''
    if (rules?.excludeText && matchesAny(text, rules.excludeText)) {
      return false
    }

    if (rules?.includeText && rules.includeText.length > 0) {
      return matchesAny(text, rules.includeText)
    }

    return true
  })

  const domainFiltered = filtered.filter((link) => {
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

  return domainFiltered
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
  const maxMessages = source.maxMessages || 50

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

    const links = extractLinks(html, source.linkRules)
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
      })
    })
  }

  return items
}
