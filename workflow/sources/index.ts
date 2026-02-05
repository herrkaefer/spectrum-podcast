import type { SourceConfig } from './types'

import { loadSourceConfig } from './config'
import { fetchGmailItems } from './gmail'
import { fetchRssItems } from './rss'

function isEnabled(source: SourceConfig) {
  return source.enabled !== false
}

function getLookbackDays(source: SourceConfig, defaultLookbackDays: number) {
  return source.lookbackDays ?? defaultLookbackDays
}

export async function getStoriesFromSources(options?: { now?: Date, env?: CloudflareEnv, window?: { start: Date, end: Date, timeZone: string } }) {
  const now = options?.now ?? new Date()
  const { sources, lookbackDays } = await loadSourceConfig()
  const enabledSources = sources.filter(isEnabled)

  const groups = await Promise.all(
    enabledSources.map(async (source) => {
      const days = getLookbackDays(source, lookbackDays)
      switch (source.type) {
        case 'rss': {
          return await fetchRssItems(source, now, days, options?.window)
        }
        case 'gmail': {
          if (!options?.env) {
            console.warn('gmail source requires env, skip', source)
            return []
          }
          return await fetchGmailItems(source, now, days, options.env, options?.window)
        }
        case 'url':
          return [
            {
              id: source.id,
              title: source.name,
              url: source.url,
              hackerNewsUrl: source.url,
              sourceName: source.name,
              sourceUrl: source.url,
            },
          ]
        default:
          console.warn('unknown source type', source)
          return []
      }
    }),
  )

  return groups.flat()
}
