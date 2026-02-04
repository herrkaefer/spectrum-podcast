export type SourceType = 'rss' | 'url'

export interface SourceConfig {
  id: string
  name: string
  type: SourceType
  url: string
  enabled?: boolean
  lookbackDays?: number
}
