import type { Episode } from '@/types/podcast'

function buildAudioUrl(staticHost: string, audioPath: string, updatedAt?: number) {
  const normalizedHost = staticHost?.replace(/\/$/, '')
  if (/^https?:\/\//.test(audioPath)) {
    return updatedAt ? `${audioPath}?t=${updatedAt}` : audioPath
  }
  const cleanedPath = audioPath.replace(/^\//, '')
  const base = `${normalizedHost}/${cleanedPath}`
  return updatedAt ? `${base}?t=${updatedAt}` : base
}

function getAudioMimeType(audioPath: string): string {
  const normalized = (audioPath || '').split('?')[0].toLowerCase()
  if (normalized.endsWith('.wav')) {
    return 'audio/wav'
  }
  if (normalized.endsWith('.ogg')) {
    return 'audio/ogg'
  }
  if (normalized.endsWith('.webm')) {
    return 'audio/webm'
  }
  return 'audio/mpeg'
}

function buildReferencesSection(stories?: Story[]): string {
  if (!stories || stories.length === 0) {
    return ''
  }

  const items = stories
    .map((story) => {
      const title = story.title || story.url || story.hackerNewsUrl || ''
      const href = story.url || story.hackerNewsUrl || '#'
      if (!title || !href)
        return null
      return `- [${title}](${href})`
    })
    .filter(Boolean)

  if (items.length === 0) {
    return ''
  }

  return ['## 参考链接', ...items].join('\n')
}

export function buildEpisodeFromArticle(
  article: Article,
  staticHost: string,
): Episode {
  const description
    = article.introContent
      || article.podcastContent?.split('\n')?.[0]
      || article.blogContent?.split('\n')?.[0]
      || article.title

  const sections: string[] = []

  if (article.blogContent) {
    sections.push(article.blogContent)
  }

  if (article.podcastContent) {
    sections.push(`## 播客全文\n\n${article.podcastContent}`)
  }

  const references = buildReferencesSection(article.stories)
  if (references) {
    sections.push(references)
  }

  return {
    id: article.date,
    title: article.title,
    description,
    content: sections.join('\n\n'),
    published: article.date,
    audio: {
      src: buildAudioUrl(staticHost, article.audio, article.updatedAt),
      type: getAudioMimeType(article.audio),
    },
    summary: article.introContent,
    stories: article.stories,
  }
}

export function buildEpisodesFromArticles(
  articles: Article[],
  staticHost: string,
): Episode[] {
  return articles
    .map(article => buildEpisodeFromArticle(article, staticHost))
    .sort((a, b) => (a.published < b.published ? 1 : -1))
}
