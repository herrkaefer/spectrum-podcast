import type { SourceConfig } from './types'

import * as cheerio from 'cheerio'
import { $fetch } from 'ofetch'

interface RssItem {
  title: string
  link: string
  guid?: string
  pubDate?: string
}

function parseDate(dateText: string | undefined) {
  if (!dateText) {
    return null
  }
  const parsed = new Date(dateText)
  return Number.isNaN(parsed.getTime()) ? null : parsed
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

function isWithinLookback(publishedAt: Date, now: Date, lookbackDays: number) {
  const windowStart = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
  return publishedAt >= windowStart && publishedAt <= now
}

function isSameDayInTimeZone(publishedAt: Date, now: Date, timeZone: string) {
  return getDateKeyInTimeZone(publishedAt, timeZone) === getDateKeyInTimeZone(now, timeZone)
}

function isWithinWindow(publishedAt: Date, start: Date, end: Date) {
  return publishedAt >= start && publishedAt <= end
}

function extractRssItems(xml: string) {
  const $ = cheerio.load(xml, { xmlMode: true })
  const items = $('item')
  return items.map((_, el) => {
    const title = $(el).find('title').first().text().trim()
    const link = $(el).find('link').first().text().trim()
    const guid = $(el).find('guid').first().text().trim()
    const pubDate = $(el).find('pubDate').first().text().trim()
    return { title, link, guid, pubDate } satisfies RssItem
  }).get()
}

function extractAtomItems(xml: string) {
  const $ = cheerio.load(xml, { xmlMode: true })
  const entries = $('entry')
  return entries.map((_, el) => {
    const title = $(el).find('title').first().text().trim()
    const linkEl = $(el).find('link[rel="alternate"]').first()
    const link = linkEl.attr('href')
      || $(el).find('link').first().attr('href')
      || $(el).find('link').first().text().trim()
    const guid = $(el).find('id').first().text().trim()
    const pubDate = $(el).find('published').first().text().trim()
      || $(el).find('updated').first().text().trim()
    return { title, link: link || '', guid, pubDate } satisfies RssItem
  }).get()
}

function normalizeItem(item: RssItem) {
  const url = item.link || item.guid || ''
  if (!url) {
    return null
  }
  return { ...item, link: url }
}

export async function fetchRssItems(
  source: SourceConfig,
  now: Date,
  lookbackDays: number,
  window?: { start: Date, end: Date, timeZone: string },
) {
  const timeZone = 'America/Chicago'

  try {
    const xml = await $fetch<string>(source.url, {
      timeout: 30000,
      parseResponse: txt => txt,
    })

    const rssItems = extractRssItems(xml)
    const items = rssItems.length ? rssItems : extractAtomItems(xml)

    return items
      .map(normalizeItem)
      .filter((item): item is RssItem => Boolean(item))
      .filter((item) => {
        const publishedAt = parseDate(item.pubDate)
        if (!publishedAt) {
          console.warn('rss item missing pubDate', { source: source.name, title: item.title })
          return false
        }
        if (window) {
          return isWithinWindow(publishedAt, window.start, window.end)
        }
        return isSameDayInTimeZone(publishedAt, now, timeZone)
          && isWithinLookback(publishedAt, now, lookbackDays)
      })
      .map(item => ({
        id: item.guid || item.link,
        title: item.title,
        url: item.link,
        hackerNewsUrl: item.link,
        sourceName: source.name,
        sourceUrl: source.url,
        publishedAt: item.pubDate,
      }))
  }
  catch (error) {
    console.error('fetch rss items failed', { source: source.name, error })
    return []
  }
}
