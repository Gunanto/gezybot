import { describe, expect, it } from 'bun:test'
import {
  assistantMessage,
  inferContextWindow,
  inferThinking,
  mapModel,
  type DeepSeekModel,
} from './deepseek'

// Representative fixtures drawn from the live /models payload shape:
// the bare OpenAI listing `{object:'list', data:[{id, object, owned_by}]}`.

const v4Pro: DeepSeekModel = {
  id: 'deepseek-v4-pro',
  object: 'model',
  owned_by: 'deepseek',
}

const v4Flash: DeepSeekModel = {
  id: 'deepseek-v4-flash',
  object: 'model',
  owned_by: 'deepseek',
}

// ─── inferContextWindow ──────────────────────────────────────────────────────

describe('inferContextWindow', () => {
  it('maps the deepseek-v4 family to 1M tokens', () => {
    expect(inferContextWindow(v4Pro)).toBe(1_048_576)
    expect(inferContextWindow(v4Flash)).toBe(1_048_576)
  })

  it('falls back to the conservative 128k default when no family matches', () => {
    expect(inferContextWindow({ id: 'mystery-model' })).toBe(128_000)
  })
})

// ─── inferThinking ───────────────────────────────────────────────────────────

describe('inferThinking', () => {
  it('advertises the full low/medium/high/max range for the v4 family', () => {
    const t = inferThinking(v4Pro)
    expect(t).toBeDefined()
    expect(t!.efforts).toEqual(['low', 'medium', 'high', 'max'])
    expect(inferThinking(v4Flash)).toBeDefined()
  })

  it('returns undefined for an unrecognised (non-v4) id', () => {
    expect(inferThinking({ id: 'mystery-model' })).toBeUndefined()
  })
})

// ─── mapModel ────────────────────────────────────────────────────────────────

describe('mapModel', () => {
  it('classifies the v4 pro as a text-only, reasoning-capable llm', () => {
    const m = mapModel(v4Pro)!
    expect(m.id).toBe('deepseek-v4-pro')
    expect(m.name).toBe('deepseek-v4-pro')
    expect(m.contextWindow).toBe(1_048_576)
    expect(m.supportsPromptCaching).toBe(true)
    expect(m.supportsParallelTools).toBe(true)
    // Vision is never advertised — no modality metadata in /models.
    expect(m.supportsImageInput).toBeUndefined()
    // V4 is a dual-mode reasoning family.
    expect(m.thinking?.efforts).toEqual(['low', 'medium', 'high', 'max'])
  })

  it('maps the flash tier the same way', () => {
    const m = mapModel(v4Flash)!
    expect(m.id).toBe('deepseek-v4-flash')
    expect(m.contextWindow).toBe(1_048_576)
    expect(m.thinking?.efforts).toEqual(['low', 'medium', 'high', 'max'])
    expect(m.supportsImageInput).toBeUndefined()
  })

  it('returns null for entries without an id', () => {
    expect(mapModel({ id: '' })).toBeNull()
  })
})

// ─── assistantMessage (reasoning_content replay) ─────────────────────────────

describe('assistantMessage', () => {
  // DeepSeek (thinking on by default) 400s on a tool-call message that lacks
  // reasoning_content. The engine strips unsigned thinking, so it is usually
  // empty here — the empty string is what prevents the 400.
  it('sets reasoning_content (empty) on a tool-call message with no thinking', () => {
    const msg = assistantMessage([
      { type: 'tool-use', id: 'c1', name: 'get_weather', args: { city: 'Paris' } },
    ]) as { tool_calls?: unknown[]; reasoning_content?: string }
    expect(msg.tool_calls).toHaveLength(1)
    expect(msg.reasoning_content).toBe('')
  })

  it('replays real reasoning text when a thinking block is present', () => {
    const msg = assistantMessage([
      { type: 'thinking', text: 'I should call the weather tool.' },
      { type: 'tool-use', id: 'c1', name: 'get_weather', args: { city: 'Paris' } },
    ]) as { reasoning_content?: string }
    expect(msg.reasoning_content).toBe('I should call the weather tool.')
  })

  it('does NOT attach reasoning_content to a plain text message', () => {
    const msg = assistantMessage([{ type: 'text', text: 'Hi.' }]) as {
      content?: string
      reasoning_content?: string
    }
    expect(msg.content).toBe('Hi.')
    expect('reasoning_content' in msg).toBe(false)
  })
})

// ─── listModels payload parsing ──────────────────────────────────────────────

describe('listModels payload shape', () => {
  // The provider's listModels reads `payload.data` from the OpenAI-style
  // `{object:'list', data:[{id}]}` response. Verify mapModel handles the full
  // listing (including a degenerate id-less entry) the way listModels does.
  it('maps every model in a {data:[{id}]} listing, dropping id-less entries', () => {
    const payload: { object: string; data: DeepSeekModel[] } = {
      object: 'list',
      data: [v4Flash, v4Pro, { id: '' }],
    }
    const mapped = payload.data.map(mapModel).filter((m): m is NonNullable<typeof m> => m !== null)
    expect(mapped.map((m) => m.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
  })
})
