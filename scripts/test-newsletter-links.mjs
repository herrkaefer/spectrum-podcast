import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'

function normalizeText(text) {
  return text.replace(/\s+/g, ' ').trim()
}

function matchesAny(text, patterns = []) {
  if (!patterns.length) {
    return false
  }
  const lower = text.toLowerCase()
  return patterns.some(pattern => lower.includes(pattern.toLowerCase()))
}

const defaultExcludeText = [
  'unsubscribe',
  'subscribe',
  'privacy',
  'terms',
  'terms and conditions',
  'contact',
  'manage preferences',
  'preferences',
  'forward',
  'share',
  'tweet',
  'facebook',
  'twitter',
  'linkedin',
  'instagram',
  'youtube',
  'rss',
]

const defaultExcludePathKeywords = [
  '/webinar/',
  '/category/',
  '/unsubscribe',
  '/subscribe',
  '/privacy',
  '/terms',
  '/contact',
]

const trackingHostnames = [
  'list-manage.com',
  'campaign-archive.com',
  'mailchi.mp',
  'clicks',
  'links',
]

function unwrapTrackingUrl(href) {
  let url
  try {
    url = new URL(href)
  }
  catch {
    return { href, unwrapped: false }
  }

  const hostname = url.hostname.toLowerCase()
  const isTrackingHost = trackingHostnames.some(keyword => hostname.includes(keyword))
  const isTrackingPath = url.pathname.toLowerCase().includes('/track/')

  if (!isTrackingHost && !isTrackingPath) {
    return { href, unwrapped: false }
  }

  const candidates = ['url', 'u', 'redirect', 'link', 'r', 'destination']
  for (const key of candidates) {
    const value = url.searchParams.get(key)
    if (!value) {
      continue
    }
    const decoded = decodeURIComponent(value)
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
      return { href: decoded, unwrapped: true }
    }
  }

  return { href, unwrapped: false }
}

async function resolveTrackingRedirect(href, cache) {
  if (cache.has(href)) {
    return cache.get(href) || href
  }

  let url
  try {
    url = new URL(href)
  }
  catch {
    cache.set(href, href)
    return href
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    const response = await fetch(href, { redirect: 'manual', signal: controller.signal })
    clearTimeout(timeout)

    const location = response.headers.get('location')
    if (location) {
      const resolved = location.startsWith('http')
        ? location
        : new URL(location, url.origin).toString()
      cache.set(href, resolved)
      return resolved
    }
  }
  catch {
    // ignore and fall back to original
  }

  cache.set(href, href)
  return href
}

function normalizeUrlPath(pathname) {
  return pathname ? pathname.toLowerCase() : ''
}

function getUrlPathDepth(pathname) {
  return pathname.split('/').filter(Boolean).length
}

function getLastPathSegment(pathname) {
  const parts = pathname.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

function scoreArticleLink(link, rules) {
  const minTextLength = rules.minTextLength ?? 8
  let url
  try {
    url = new URL(link.href)
  }
  catch {
    return -1
  }

  const path = normalizeUrlPath(url.pathname)
  const text = link.text || ''
  let score = 0

  if (getUrlPathDepth(path) >= 2) {
    score += 1
  }

  const lastSegment = getLastPathSegment(path)
  if (lastSegment.length >= 10 && /[-_]/.test(lastSegment)) {
    score += 1
  }

  if (rules.includePathKeywords?.length) {
    if (rules.includePathKeywords.some(keyword => path.includes(keyword.toLowerCase()))) {
      score += 1
    }
  }

  if (text.length >= minTextLength) {
    score += 1
  }

  return score
}

async function extractArticleLinks(html, rules) {
  const $ = cheerio.load(html)
  const links = $('a[href]').map((_, el) => {
    const rawHref = $(el).attr('href')?.trim() || ''
    const { href, unwrapped } = unwrapTrackingUrl(rawHref)
    const text = normalizeText($(el).text())
    const imageAlt = normalizeText($(el).find('img').attr('alt') || '')
    const title = normalizeText($(el).attr('title') || '')
    const aria = normalizeText($(el).attr('aria-label') || '')
    const displayText = text || imageAlt || aria || title
    return { href, text: displayText, unwrapped, rawHref }
  }).get()

  const resolveTrackingLinks = rules.resolveTrackingLinks !== false
  const trackingCache = new Map()
  const resolvedLinks = resolveTrackingLinks
    ? await Promise.all(links.map(async (link) => {
        const rawUrl = link.href
        let resolvedHref = rawUrl
        if (!link.unwrapped) {
          const hostname = (() => {
            try {
              return new URL(rawUrl).hostname.toLowerCase()
            }
            catch {
              return ''
            }
          })()
          const isTrackingHost = trackingHostnames.some(keyword => hostname.includes(keyword))
          if (isTrackingHost) {
            resolvedHref = await resolveTrackingRedirect(rawUrl, trackingCache)
          }
        }
        return { ...link, href: resolvedHref }
      }))
    : links

  const filtered = resolvedLinks.filter((link) => {
    if (!link.href) {
      return false
    }

    const href = link.href.toLowerCase()
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) {
      return false
    }

    const text = link.text || ''
    const excludeText = [...defaultExcludeText, ...(rules.excludeText || [])]
    if (matchesAny(text, excludeText)) {
      return false
    }

    return true
  })

  const uniqueByHref = new Map()
  for (const link of filtered) {
    const existing = uniqueByHref.get(link.href)
    if (!existing || (link.text && link.text.length > (existing.text || '').length)) {
      uniqueByHref.set(link.href, link)
    }
  }
  const deduped = Array.from(uniqueByHref.values())

  const domainFiltered = deduped.filter((link) => {
    if (!rules.includeDomains?.length && !rules.excludeDomains?.length) {
      return true
    }
    try {
      const hostname = new URL(link.href).hostname
      if (rules.includeDomains?.length) {
        if (!rules.includeDomains.some(domain => hostname.includes(domain))) {
          return false
        }
      }
      if (rules.excludeDomains?.length) {
        if (rules.excludeDomains.some(domain => hostname.includes(domain))) {
          return false
        }
      }
      return true
    }
    catch {
      return false
    }
  })

  const pathFiltered = domainFiltered.filter((link) => {
    const excludePathKeywords = [...defaultExcludePathKeywords, ...(rules.excludePathKeywords || [])]
    if (!excludePathKeywords.length) {
      return true
    }
    try {
      const pathname = new URL(link.href).pathname.toLowerCase()
      return !excludePathKeywords.some(keyword => pathname.includes(keyword.toLowerCase()))
    }
    catch {
      return false
    }
  })

  const minScore = rules.minArticleScore ?? 2
  return pathFiltered
    .map(link => ({ ...link, score: scoreArticleLink(link, rules) }))
    .filter(link => link.score >= minScore)
}

function parseArgs(argv) {
  const args = { url: '', file: '', rules: {}, sourceId: '', configPath: '', printRules: false, debugConfig: false }
  const flags = argv.slice(2)
  if (flags.length === 0) {
    return args
  }

  if (!flags[0].startsWith('--')) {
    args.url = flags[0]
  }
  for (let i = args.url ? 1 : 0; i < flags.length; i += 1) {
    const flag = flags[i]
    const value = flags[i + 1]
    if (flag === '--print-rules') {
      args.printRules = true
      continue
    }
    if (flag === '--debug-config') {
      args.debugConfig = true
      continue
    }
    if (!value || value.startsWith('--')) {
      continue
    }
    switch (flag) {
      case '--file':
        args.file = value
        i += 1
        break
      case '--config':
        args.configPath = value
        i += 1
        break
      case '--source-id':
        args.sourceId = value
        i += 1
        break
      case '--exclude-text':
        args.rules.excludeText = [...(args.rules.excludeText || []), value]
        i += 1
        break
      case '--exclude-domain':
        args.rules.excludeDomains = [...(args.rules.excludeDomains || []), value]
        i += 1
        break
      case '--include-domain':
        args.rules.includeDomains = [...(args.rules.includeDomains || []), value]
        i += 1
        break
      case '--exclude-path':
        args.rules.excludePathKeywords = [...(args.rules.excludePathKeywords || []), value]
        i += 1
        break
      case '--include-path':
        args.rules.includePathKeywords = [...(args.rules.includePathKeywords || []), value]
        i += 1
        break
      case '--min-score':
        args.rules.minArticleScore = Number.parseInt(value, 10)
        i += 1
        break
      case '--min-text-length':
        args.rules.minTextLength = Number.parseInt(value, 10)
        i += 1
        break
      default:
        break
    }
  }
  return args
}

function parseStringArray(block, key) {
  const regex = new RegExp(`${key}\\s*:\\s*\\[([\\s\\S]*?)\\]`, 'm')
  const match = block.match(regex)
  if (!match) {
    return undefined
  }
  const raw = match[1]
  const values = raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map((value) => {
      const cleaned = value.replace(/^['"]|['"]$/g, '')
      return cleaned.trim()
    })
    .filter(Boolean)
  return values.length ? values : undefined
}

function parseNumber(block, key) {
  const regex = new RegExp(`${key}\\s*:\\s*(\\d+)`, 'm')
  const match = block.match(regex)
  if (!match) {
    return undefined
  }
  return Number.parseInt(match[1], 10)
}

function parseBoolean(block, key) {
  const regex = new RegExp(`${key}\\s*:\\s*(true|false)`, 'm')
  const match = block.match(regex)
  if (!match) {
    return undefined
  }
  return match[1] === 'true'
}

function parseLinkRulesFromBlock(block) {
  return {
    excludeText: parseStringArray(block, 'excludeText'),
    includeDomains: parseStringArray(block, 'includeDomains'),
    excludeDomains: parseStringArray(block, 'excludeDomains'),
    includePathKeywords: parseStringArray(block, 'includePathKeywords'),
    excludePathKeywords: parseStringArray(block, 'excludePathKeywords'),
    minArticleScore: parseNumber(block, 'minArticleScore'),
    minTextLength: parseNumber(block, 'minTextLength'),
    debugMaxLinks: parseNumber(block, 'debugMaxLinks'),
    debug: parseBoolean(block, 'debug'),
    resolveTrackingLinks: parseBoolean(block, 'resolveTrackingLinks'),
  }
}

function extractSourceBlock(content, sourceId) {
  if (!sourceId) {
    return content
  }
  const escaped = sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`\\{[\\s\\S]*?id\\s*:\\s*['"]${escaped}['"][\\s\\S]*?\\}`, 'm')
  const match = content.match(regex)
  return match ? match[0] : content
}

function loadConfigRules({ configPath, sourceId, debug }) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const projectRoot = path.resolve(scriptDir, '..')
  const candidates = []
  if (configPath) {
    candidates.push(path.resolve(process.cwd(), configPath))
  }
  else {
    candidates.push(path.resolve(projectRoot, 'workflow/sources/config.local.ts'))
    candidates.push(path.resolve(projectRoot, 'workflow/sources/config.example.ts'))
  }

  for (const candidate of candidates) {
    if (debug) {
      console.info('CONFIG: try', candidate)
    }
    if (!fs.existsSync(candidate)) {
      if (debug) {
        console.info('CONFIG: missing', candidate)
      }
      continue
    }
    const raw = fs.readFileSync(candidate, 'utf-8')
    const block = extractSourceBlock(raw, sourceId)
    const rulesMatch = block.match(/linkRules\\s*:\\s*\\\{([\\sS]*?)\\\}/)
    if (!rulesMatch) {
      if (debug) {
        console.info('CONFIG: missing linkRules', candidate)
      }
      continue
    }
    const rulesBlock = rulesMatch[1]
    const parsed = parseLinkRulesFromBlock(rulesBlock)
    if (debug) {
      console.info('CONFIG: loaded', candidate)
    }
    return parsed
  }
  return null
}

async function main() {
  const { url, file, rules, sourceId, configPath, printRules, debugConfig } = parseArgs(process.argv)
  if (!url && !file) {
    console.error('Usage: node scripts/test-newsletter-links.mjs <url> [--file newsletter.html --config workflow/sources/config.local.ts --source-id example-gmail]')
    process.exit(1)
  }

  const configRules = loadConfigRules({ configPath, sourceId, debug: debugConfig })
  const mergedRules = {
    ...configRules,
    ...rules,
    excludeText: [...(configRules?.excludeText || []), ...(rules.excludeText || [])],
    excludeDomains: [...(configRules?.excludeDomains || []), ...(rules.excludeDomains || [])],
    includeDomains: [...(configRules?.includeDomains || []), ...(rules.includeDomains || [])],
    excludePathKeywords: [...(configRules?.excludePathKeywords || []), ...(rules.excludePathKeywords || [])],
    includePathKeywords: [...(configRules?.includePathKeywords || []), ...(rules.includePathKeywords || [])],
  }

  if (printRules) {
    console.info('RULES', JSON.stringify(mergedRules, null, 2))
  }

  let html = ''
  if (file) {
    html = fs.readFileSync(file, 'utf-8')
  }
  else {
    const response = await fetch(url)
    if (!response.ok) {
      console.error(`Failed to fetch url: ${response.status} ${response.statusText}`)
      process.exit(1)
    }
    html = await response.text()
  }
  const links = await extractArticleLinks(html, mergedRules)

  const unique = new Map()
  for (const link of links) {
    if (!unique.has(link.href) || (link.text || '').length > (unique.get(link.href).text || '').length) {
      unique.set(link.href, link)
    }
  }

  const output = Array.from(unique.values())
  console.info(`TOTAL ${output.length}`)
  output.forEach((link, index) => {
    const title = link.text || '(no title)'
    console.info(`${index + 1}. ${title}`)
    console.info(`   ${link.href}`)
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
