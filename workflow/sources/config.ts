import type { SourceConfig } from './types'

import { lookbackDays as defaultLookbackDays, sources as defaultSources } from './config.example'

interface SourceModule {
  lookbackDays?: number
  sources?: SourceConfig[]
}

async function loadLocalConfig() {
  try {
    return (await import('./config.local')) as SourceModule
  }
  catch {
    return null
  }
}

export async function loadSourceConfig() {
  const localConfig = await loadLocalConfig()
  return {
    lookbackDays: localConfig?.lookbackDays ?? defaultLookbackDays,
    sources: localConfig?.sources ?? defaultSources,
  }
}
