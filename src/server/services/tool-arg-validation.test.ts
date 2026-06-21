import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { validateToolArgs } from './tool-arg-validation'

describe('validateToolArgs', () => {
  const schema = z.object({
    path: z.string(),
    offset: z.number().optional(),
  })

  it('accepts arguments that match the schema', () => {
    expect(validateToolArgs(schema, { path: '/tmp/a' }, 'read_file')).toEqual({ ok: true })
    expect(validateToolArgs(schema, { path: '/tmp/a', offset: 10 }, 'read_file')).toEqual({
      ok: true,
    })
  })

  it('rejects a missing required field and names it', () => {
    const result = validateToolArgs(schema, { offset: 10 }, 'read_file')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('read_file')
    expect(result.message).toContain('path')
    expect(result.message).toContain('Re-call the tool')
  })

  it('rejects a wrong type', () => {
    const result = validateToolArgs(schema, { path: 42 }, 'read_file')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('path')
  })

  it('rejects the { _raw } salvage shape (no required fields present)', () => {
    const result = validateToolArgs(schema, { _raw: '{path: broken' }, 'read_file')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('path')
  })

  it('reports a nested path with dots', () => {
    const nested = z.object({ filter: z.object({ name: z.string() }) })
    const result = validateToolArgs(nested, { filter: {} }, 'search')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('filter.name')
  })

  it('ignores extra keys (zod strips them by default)', () => {
    expect(validateToolArgs(schema, { path: '/tmp/a', extra: true }, 'read_file')).toEqual({
      ok: true,
    })
  })

  it('skips validation for a non-zod (plain JSON Schema) inputSchema', () => {
    const jsonSchema = { type: 'object', properties: { path: { type: 'string' } } }
    expect(validateToolArgs(jsonSchema, { anything: 1 }, 'mcp_tool')).toEqual({ ok: true })
  })

  it('skips validation when there is no schema', () => {
    expect(validateToolArgs(undefined, { path: 1 }, 'x')).toEqual({ ok: true })
    expect(validateToolArgs(null, { path: 1 }, 'x')).toEqual({ ok: true })
  })
})
