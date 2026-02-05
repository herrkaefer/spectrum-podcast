import process from 'node:process'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import markdownit from 'markdown-it'
import { NextResponse } from 'next/server'
import { Podcast } from 'podcast'
import { podcast } from '@/config'
import { getPastDays } from '@/lib/utils'

const md = markdownit()

export const revalidate = 3600

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

export async function GET() {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? ''

  // 如果没有缓存，生成新的响应
  const feed = new Podcast({
    title: podcast.base.title,
    description: podcast.base.description,
    feedUrl: `${baseUrl}/rss.xml`,
    siteUrl: baseUrl,
    imageUrl: `${baseUrl}/logo.png`,
    language: 'zh-CN',
    pubDate: new Date(),
    ttl: 60,
    generator: podcast.base.title,
    author: podcast.base.title,
    categories: ['technology', 'news'],
    itunesImage: `${baseUrl}/logo.png`,
    itunesCategory: [{ text: 'Technology' }, { text: 'News' }],
    itunesOwner: {
      name: podcast.base.title,
      email: 'hacker-podcast@agi.li',
    },
    managingEditor: 'hacker-podcast@agi.li',
    webMaster: 'hacker-podcast@agi.li',
  })

  const { env } = await getCloudflareContext({ async: true })
  const runEnv = env.NODE_ENV || 'production'
  const pastDays = getPastDays(10)
  const posts = (await Promise.all(
    pastDays.map(async (day) => {
      const post = await env.PODCAST_KV.get(`content:${runEnv}:hacker-podcast:${day}`, 'json')
      return post as unknown as Article
    }),
  )).filter(Boolean)

  const audioInfos = await Promise.all(
    posts.map(post => env.PODCAST_R2.head(post.audio)),
  )

  posts.forEach((post, index) => {
    const audioInfo = audioInfos[index]

    const links = post.stories
      .map(s => `<li><a href="${s.hackerNewsUrl || s.url || ''}" title="${s.title || ''}">${s.title || ''}</a></li>`)
      .join('')
    const linkContent = `<p><b>相关链接：</b></p><ul>${links}</ul>`
    const blogContentHtml = md.render(post.blogContent || '')
    const finalContent = `
      <div>${blogContentHtml}<hr/>${linkContent}</div>
      ${env.NEXT_TRACKING_IMAGE ? `<img src="${env.NEXT_TRACKING_IMAGE}/${post.date}" alt="${post.title}" width="1" height="1" loading="lazy" aria-hidden="true" style="opacity: 0;pointer-events: none;" />` : ''}
    `

    feed.addItem({
      title: post.title || '',
      description: post.introContent || post.podcastContent || '',
      content: finalContent,
      url: `${baseUrl}/episode/${post.date}`,
      guid: `/episode/${post.date}`,
      date: new Date(post.updatedAt || post.date),
      enclosure: {
        url: `${env.NEXT_STATIC_HOST}/${post.audio}?t=${post.updatedAt}`,
        type: getAudioMimeType(post.audio),
        size: audioInfo?.size,
      },
    })
  })

  const response = new NextResponse(feed.buildXml(), {
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': `public, max-age=${revalidate}, s-maxage=${revalidate}`,
    },
  })

  return response
}
