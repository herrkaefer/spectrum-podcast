export type SourceType = 'rss' | 'url' | 'gmail'

export interface LinkRules {
  excludeText?: string[]
  includeDomains?: string[]
  excludeDomains?: string[]
  includePathKeywords?: string[]
  excludePathKeywords?: string[]
  minArticleScore?: number
  minTextLength?: number
  debug?: boolean
  debugMaxLinks?: number
  resolveTrackingLinks?: boolean
  preferOnlineVersion?: boolean
}

export interface SourceConfig {
  id: string
  name: string
  type: SourceType
  url: string
  enabled?: boolean
  lookbackDays?: number
  label?: string
  maxMessages?: number
  linkRules?: LinkRules
}
