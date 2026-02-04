import type { SourceConfig } from './types'

export const lookbackDays = 7

export const sources: SourceConfig[] = [
  {
    id: 'example-rss',
    name: 'Example RSS',
    type: 'rss',
    url: 'https://example.com/rss.xml',
  },
  {
    id: 'example-site',
    name: 'Example Site',
    type: 'url',
    url: 'https://example.com',
    enabled: false,
  },
]
