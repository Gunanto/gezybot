import { describe, expect, it, mock, beforeEach } from 'bun:test'
import { ProviderServerError } from '@/server/llm/core/types'

// Capture the calls/responses the production code makes against the
// mocked `openai` SDK. Reset before each test so assertions stay local.
const mockModelsList = mock(() => Promise.resolve({ data: [] as Array<{ id: string }> }))
const mockImagesGenerate = mock(() => Promise.resolve({ data: [{ b64_json: 'AAAA' }] }))
const mockImagesEdit = mock(() => Promise.resolve({ data: [{ b64_json: 'BBBB' }] }))

mock.module('openai', () => {
  class APIError extends Error {
    status: number
    headers: Record<string, string>
    constructor(status: number, message: string) {
      super(message)
      this.name = 'APIError'
      this.status = status
      this.headers = {}
    }
  }
  function OpenAI(_opts: { apiKey: string }) {
    return {
      models: { list: mockModelsList },
      images: { generate: mockImagesGenerate, edit: mockImagesEdit },
    }
  }
  return {
    default: OpenAI,
    APIError,
    toFile: async (data: Uint8Array, name: string, _opts?: { type?: string }) => ({ data, name }),
  }
})

// Import AFTER the module mock so the production code picks up our fakes.
const { openaiImageProvider } = await import('./openai')

beforeEach(() => {
  mockModelsList.mockReset()
  mockImagesGenerate.mockReset()
  mockImagesEdit.mockReset()
  mockModelsList.mockImplementation(() => Promise.resolve({ data: [] }))
  mockImagesGenerate.mockImplementation(() => Promise.resolve({ data: [{ b64_json: 'AAAA' }] }))
  mockImagesEdit.mockImplementation(() => Promise.resolve({ data: [{ b64_json: 'BBBB' }] }))
})

// ─── authenticate ────────────────────────────────────────────────────────────

describe('openaiImageProvider.authenticate', () => {
  it('returns valid:true when models.list resolves', async () => {
    const result = await openaiImageProvider.authenticate({ apiKey: 'sk-test' })
    expect(result.valid).toBe(true)
  })

  it('returns valid:false when models.list throws', async () => {
    mockModelsList.mockImplementation(() => Promise.reject(new Error('network down')))
    const result = await openaiImageProvider.authenticate({ apiKey: 'sk-test' })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('network down')
  })

  it('throws AuthError when apiKey is missing', async () => {
    const result = await openaiImageProvider.authenticate({})
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Missing OpenAI API key')
  })
})

// ─── listModels ──────────────────────────────────────────────────────────────

describe('openaiImageProvider.listModels', () => {
  it('keeps only image-capable model IDs from /v1/models', async () => {
    mockModelsList.mockImplementation(() => Promise.resolve({
      data: [
        { id: 'gpt-4o' },
        { id: 'text-embedding-3-small' },
        { id: 'gpt-image-1' },
        { id: 'dall-e-3' },
        { id: 'whisper-1' },
      ],
    }))
    const models = await openaiImageProvider.listModels({ apiKey: 'sk-test' })
    const ids = models.map((m) => m.id)
    expect(ids).toContain('gpt-image-1')
    expect(ids).toContain('dall-e-3')
    expect(ids).not.toContain('gpt-4o')
    expect(ids).not.toContain('text-embedding-3-small')
    expect(ids).not.toContain('whisper-1')
  })

  it('surfaces known models even when /v1/models lists none of them', async () => {
    // Some account types restrict /v1/models. The static fallback list
    // (gpt-image-1, dall-e-3, dall-e-2) must still surface in that case.
    mockModelsList.mockImplementation(() => Promise.resolve({ data: [] }))
    const models = await openaiImageProvider.listModels({ apiKey: 'sk-test' })
    const ids = models.map((m) => m.id)
    expect(ids).toContain('gpt-image-1')
    expect(ids).toContain('dall-e-3')
    expect(ids).toContain('dall-e-2')
  })

  it('does not duplicate models that appear in both the listing and the fallback', async () => {
    mockModelsList.mockImplementation(() => Promise.resolve({
      data: [{ id: 'gpt-image-1' }, { id: 'dall-e-3' }],
    }))
    const models = await openaiImageProvider.listModels({ apiKey: 'sk-test' })
    const gptImageEntries = models.filter((m) => m.id === 'gpt-image-1')
    expect(gptImageEntries).toHaveLength(1)
  })

  it('reports image-input support on the known models via maxImageInputs', async () => {
    mockModelsList.mockImplementation(() => Promise.resolve({ data: [] }))
    const models = await openaiImageProvider.listModels({ apiKey: 'sk-test' })
    const gptImage = models.find((m) => m.id === 'gpt-image-1')!
    const dalleThree = models.find((m) => m.id === 'dall-e-3')!
    const dalleTwo = models.find((m) => m.id === 'dall-e-2')!
    expect(gptImage.maxImageInputs).toBe(1)
    expect(dalleThree.maxImageInputs).toBe(0)
    expect(dalleTwo.maxImageInputs).toBe(1)
  })
})

// ─── generate ────────────────────────────────────────────────────────────────

describe('openaiImageProvider.generate', () => {
  it('calls images.generate when no imageInput is provided', async () => {
    const result = await openaiImageProvider.generate(
      { id: 'gpt-image-1', name: 'GPT Image 1' },
      { prompt: 'a cat' },
      { apiKey: 'sk-test' },
    )
    expect(mockImagesGenerate).toHaveBeenCalledTimes(1)
    expect(mockImagesEdit).not.toHaveBeenCalled()
    expect(result.mediaType).toBe('image/png')
    // 'AAAA' decoded as base64 → 3 bytes
    expect(result.data.length).toBe(3)
  })

  it('calls images.edit when imageInputs is provided', async () => {
    const result = await openaiImageProvider.generate(
      { id: 'gpt-image-1', name: 'GPT Image 1', maxImageInputs: 1 },
      {
        prompt: 'transform this',
        imageInputs: [{ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }],
      },
      { apiKey: 'sk-test' },
    )
    expect(mockImagesEdit).toHaveBeenCalledTimes(1)
    expect(mockImagesGenerate).not.toHaveBeenCalled()
    expect(result.mediaType).toBe('image/png')
    expect(result.data.length).toBe(3)
  })

  it('takes only the first imageInputs entry on single-image models', async () => {
    await openaiImageProvider.generate(
      { id: 'gpt-image-1', name: 'GPT Image 1', maxImageInputs: 1 },
      {
        prompt: 'transform',
        imageInputs: [
          { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
          { data: new Uint8Array([4, 5, 6]), mediaType: 'image/png' },
        ],
      },
      { apiKey: 'sk-test' },
    )
    // Single .edit call — the second input is silently dropped (with a
    // log warning that isn't asserted here).
    expect(mockImagesEdit).toHaveBeenCalledTimes(1)
  })

  it('merges request.params into the upstream call', async () => {
    await openaiImageProvider.generate(
      { id: 'gpt-image-1', name: 'GPT Image 1' },
      { prompt: 'a cat', params: { quality: 'high', background: 'transparent' } },
      { apiKey: 'sk-test' },
    )
    expect(mockImagesGenerate).toHaveBeenCalledTimes(1)
    const call = (mockImagesGenerate.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]
    expect(call?.['quality']).toBe('high')
    expect(call?.['background']).toBe('transparent')
  })

  it('describeModel returns the per-family static schema', async () => {
    const gptSchema = await openaiImageProvider.describeModel!(
      { id: 'gpt-image-1', name: 'GPT Image 1' },
      { apiKey: 'sk-test' },
    )
    expect(Object.keys(gptSchema.params)).toContain('quality')
    expect(Object.keys(gptSchema.params)).toContain('background')
    expect(Object.keys(gptSchema.params)).toContain('output_format')

    const dalleSchema = await openaiImageProvider.describeModel!(
      { id: 'dall-e-3', name: 'DALL-E 3' },
      { apiKey: 'sk-test' },
    )
    expect(Object.keys(dalleSchema.params)).toEqual(['quality', 'style'])

    const unknownSchema = await openaiImageProvider.describeModel!(
      { id: 'mystery-model', name: 'Mystery' },
      { apiKey: 'sk-test' },
    )
    expect(unknownSchema.params).toEqual({})
  })

  it('passes response_format=b64_json for dall-e family', async () => {
    await openaiImageProvider.generate(
      { id: 'dall-e-3', name: 'DALL-E 3' },
      { prompt: 'something' },
      { apiKey: 'sk-test' },
    )
    const args = (mockImagesGenerate.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>
    expect(args.response_format).toBe('b64_json')
  })

  it('does not send response_format for gpt-image family', async () => {
    await openaiImageProvider.generate(
      { id: 'gpt-image-1', name: 'GPT Image 1' },
      { prompt: 'something' },
      { apiKey: 'sk-test' },
    )
    const args = (mockImagesGenerate.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>
    expect(args.response_format).toBeUndefined()
  })

  it('honours request.size', async () => {
    await openaiImageProvider.generate(
      { id: 'gpt-image-1', name: 'GPT Image 1' },
      { prompt: 'something', size: '1536x1024' },
      { apiKey: 'sk-test' },
    )
    const args = (mockImagesGenerate.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>
    expect(args.size).toBe('1536x1024')
  })

  it('throws ProviderServerError when no b64 data comes back', async () => {
    mockImagesGenerate.mockImplementation(() => Promise.resolve({ data: [] }))
    await expect(
      openaiImageProvider.generate(
        { id: 'gpt-image-1', name: 'GPT Image 1' },
        { prompt: 'x' },
        { apiKey: 'sk-test' },
      ),
    ).rejects.toBeInstanceOf(ProviderServerError)
  })
})
