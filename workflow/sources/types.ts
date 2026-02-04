export type SourceType = 'rss' | 'url' | 'gmail'

export interface LinkRules {
  includeText?: string[]
  excludeText?: string[]
  includeDomains?: string[]
  excludeDomains?: string[]
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
