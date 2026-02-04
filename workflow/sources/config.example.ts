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
    id: 'example-gmail',
    name: 'Example Gmail',
    type: 'gmail',
    url: 'gmail://Spectrum',
    label: 'Spectrum',
    maxMessages: 20,
    linkRules: {
      includeText: [
        'READ NOW',
        'View it in your browser',
      ],
    },
    enabled: false,
  },
  {
    id: 'example-site',
    name: 'Example Site',
    type: 'url',
    url: 'https://example.com',
    enabled: false,
  },
]
