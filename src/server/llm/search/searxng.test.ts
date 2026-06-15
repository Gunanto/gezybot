import { describe, expect, it } from 'bun:test'
import {
  buildAuthHeaders,
  mapFreshness,
  buildSearchParams,
  mapResults,
} from './searxng'
import type { SearchRequest } from '@/server/llm/search/types'

// ─── buildAuthHeaders ────────────────────────────────────────────────────────

describe('buildAuthHeaders', () => {
  it('sends no headers for a public instance (no key)', () => {
    expect(buildAuthHeaders({ baseUrl: 'https://s.example' })).toEqual({})
    expect(buildAuthHeaders({ apiKey: '   ' })).toEqual({})
  })

  it('defaults to Authorization: Bearer <key>', () => {
    expect(buildAuthHeaders({ apiKey: 'abc' })).toEqual({ Authorization: 'Bearer abc' })
  })

  it('passes an already-schemed Authorization value through verbatim', () => {
    expect(buildAuthHeaders({ apiKey: 'Basic Zm9vOmJhcg==' })).toEqual({
      Authorization: 'Basic Zm9vOmJhcg==',
    })
    expect(buildAuthHeaders({ apiKey: 'Bearer xyz' })).toEqual({ Authorization: 'Bearer xyz' })
  })

  it('sends the raw key under a custom header name', () => {
    expect(buildAuthHeaders({ apiKey: 'secret', authHeader: 'X-API-Key' })).toEqual({
      'X-API-Key': 'secret',
    })
  })

  it('treats a blank authHeader as Authorization', () => {
    expect(buildAuthHeaders({ apiKey: 'abc', authHeader: '  ' })).toEqual({
      Authorization: 'Bearer abc',
    })
  })
})

// ─── mapFreshness ────────────────────────────────────────────────────────────

describe('mapFreshness', () => {
  it('maps day/week/month/year 1-to-1', () => {
    expect(mapFreshness('day')).toBe('day')
    expect(mapFreshness('week')).toBe('week')
    expect(mapFreshness('month')).toBe('month')
    expect(mapFreshness('year')).toBe('year')
  })

  it('omits the filter for "all" or missing', () => {
    expect(mapFreshness('all')).toBeUndefined()
    expect(mapFreshness(undefined)).toBeUndefined()
  })
})

// ─── buildSearchParams ───────────────────────────────────────────────────────

describe('buildSearchParams', () => {
  const base = (q: string, extra: Partial<SearchRequest> = {}): SearchRequest => ({
    query: q,
    ...extra,
  })

  it('always sets q and format=json', () => {
    const p = buildSearchParams(base('cats'), {})
    expect(p.get('q')).toBe('cats')
    expect(p.get('format')).toBe('json')
  })

  it('prefers request.lang over the config default', () => {
    const p = buildSearchParams(base('x', { lang: 'fr' }), { language: 'en' })
    expect(p.get('language')).toBe('fr')
  })

  it('falls back to the config language when the request omits it', () => {
    const p = buildSearchParams(base('x'), { language: 'de' })
    expect(p.get('language')).toBe('de')
  })

  it('maps freshness to time_range and omits it for "all"', () => {
    expect(buildSearchParams(base('x', { freshness: 'week' }), {}).get('time_range')).toBe('week')
    expect(buildSearchParams(base('x', { freshness: 'all' }), {}).has('time_range')).toBe(false)
  })

  it('passes categories and safesearch from config', () => {
    const p = buildSearchParams(base('x'), { categories: 'general,news', safesearch: '2' })
    expect(p.get('categories')).toBe('general,news')
    expect(p.get('safesearch')).toBe('2')
  })

  it('appends domain include/exclude as site: operators', () => {
    const p = buildSearchParams(base('rust', { domains: { include: ['a.com'], exclude: ['b.com'] } }), {})
    expect(p.get('q')).toBe('rust site:a.com -site:b.com')
  })

  it('ORs multiple include domains', () => {
    const p = buildSearchParams(base('rust', { domains: { include: ['a.com', 'b.com'] } }), {})
    expect(p.get('q')).toBe('rust (site:a.com OR site:b.com)')
  })
})

// ─── mapResults ──────────────────────────────────────────────────────────────

describe('mapResults', () => {
  it('maps title/url/snippet/publishedAt/domain and drops engine', () => {
    const entries = mapResults({
      results: [
        {
          title: 'Hello',
          url: 'https://example.com/page',
          content: 'a snippet',
          engine: 'google',
          publishedDate: '2024-01-02T00:00:00Z',
        },
      ],
    })
    expect(entries).toHaveLength(1)
    const [first] = entries
    expect(first).toMatchObject({
      title: 'Hello',
      url: 'https://example.com/page',
      snippet: 'a snippet',
      domain: 'example.com',
    })
    expect(first!.publishedAt).toBe(Date.parse('2024-01-02T00:00:00Z'))
    expect('engine' in first!).toBe(false)
  })

  it('omits optional fields when absent or null', () => {
    const [entry] = mapResults({ results: [{ title: 'T', url: 'not a url', publishedDate: null }] })
    expect(entry!.snippet).toBeUndefined()
    expect(entry!.publishedAt).toBeUndefined()
    expect(entry!.domain).toBeUndefined()
  })

  it('clamps to count when provided', () => {
    const data = { results: [{ url: 'https://a.com' }, { url: 'https://b.com' }, { url: 'https://c.com' }] }
    expect(mapResults(data, 2)).toHaveLength(2)
    expect(mapResults(data)).toHaveLength(3)
  })

  it('tolerates a missing results array', () => {
    expect(mapResults({})).toEqual([])
  })
})
