import { describe, it, expect } from 'bun:test'
import { z } from 'zod'
import { resolve, relative } from 'node:path'

// NOTE: these mirror the pure helpers in custom-tools.ts. We do NOT import the
// real module here on purpose: another test (custom-tool-tools.test.ts) uses
// `mock.module('@/server/services/custom-tools', …)`, which replaces the module
// globally for the whole `bun test` process — importing the real exports here
// would resolve to that (partial) mock and break. Mirroring keeps this unit
// test hermetic and is the same convention the original file used.

// ─── resolveTimeout ──────────────────────────────────────────────────────────

function resolveTimeout(timeoutMs?: number | null, def = 30_000, max = 300_000): number {
  const value = timeoutMs ?? def
  return Math.max(1_000, Math.min(value, max))
}

describe('resolveTimeout', () => {
  it('returns default when no override', () => {
    expect(resolveTimeout()).toBe(30_000)
    expect(resolveTimeout(null)).toBe(30_000)
  })
  it('uses an in-bounds override', () => {
    expect(resolveTimeout(60_000)).toBe(60_000)
  })
  it('clamps to max', () => {
    expect(resolveTimeout(999_999_999)).toBe(300_000)
  })
  it('clamps to a 1s minimum', () => {
    expect(resolveTimeout(100)).toBe(1_000)
    expect(resolveTimeout(0)).toBe(1_000)
    expect(resolveTimeout(-5_000)).toBe(1_000)
  })
})

// ─── validateToolPath (mirror of the global-dir traversal guard) ─────────────

function validateToolPath(baseDir: string, slug: string, relPath: string): string {
  if (relPath.startsWith('/') || relPath.startsWith('\\')) throw new Error('Path must be relative')
  const dir = resolve(baseDir, slug)
  const resolved = resolve(dir, relPath)
  const rel = relative(dir, resolved)
  if (rel.startsWith('..') || resolve(resolved) !== resolved) {
    throw new Error('Path traversal detected — file must stay within the tool directory')
  }
  return resolved
}

describe('validateToolPath', () => {
  const base = '/tmp/custom-tools'
  const slug = 'weather'
  const dir = resolve(base, slug)

  it('accepts a relative file in the tool dir', () => {
    expect(validateToolPath(base, slug, 'main.py')).toBe(resolve(dir, 'main.py'))
  })
  it('accepts a nested relative file', () => {
    expect(validateToolPath(base, slug, 'lib/util.py')).toBe(resolve(dir, 'lib/util.py'))
  })
  it('rejects absolute paths', () => {
    expect(() => validateToolPath(base, slug, '/etc/passwd')).toThrow('Path must be relative')
    expect(() => validateToolPath(base, slug, '\\etc\\passwd')).toThrow('Path must be relative')
  })
  it('rejects path traversal', () => {
    expect(() => validateToolPath(base, slug, '../../etc/passwd')).toThrow('Path traversal detected')
    expect(() => validateToolPath(base, slug, 'lib/../../escape')).toThrow('Path traversal detected')
  })
  it('allows .. that stays within the dir', () => {
    expect(validateToolPath(base, slug, 'lib/../main.py')).toBe(resolve(dir, 'main.py'))
  })
})

// ─── interpreter resolution (mirror of language/extension precedence) ────────

function interpreterForLanguage(lang: string, entry: string): string[] {
  switch (lang.toLowerCase()) {
    case 'python':
    case 'py':
      return ['python3', entry]
    case 'node':
    case 'javascript':
    case 'js':
      return ['node', entry]
    case 'bun':
    case 'typescript':
    case 'ts':
      return ['bun', entry]
    case 'bash':
      return ['bash', entry]
    case 'sh':
      return ['sh', entry]
    case 'deno':
      return ['deno', 'run', '-A', entry]
    default:
      return [lang, entry]
  }
}

function interpreterForExtension(entry: string): string[] {
  if (entry.endsWith('.py')) return ['python3', entry]
  if (entry.endsWith('.js') || entry.endsWith('.mjs') || entry.endsWith('.cjs')) return ['node', entry]
  if (entry.endsWith('.ts')) return ['bun', entry]
  if (entry.endsWith('.sh')) return ['bash', entry]
  return ['bun', entry]
}

describe('interpreter resolution', () => {
  it('maps explicit languages', () => {
    expect(interpreterForLanguage('python', 'a.py')).toEqual(['python3', 'a.py'])
    expect(interpreterForLanguage('node', 'a.js')).toEqual(['node', 'a.js'])
    expect(interpreterForLanguage('bun', 'a.ts')).toEqual(['bun', 'a.ts'])
    expect(interpreterForLanguage('deno', 'a.ts')).toEqual(['deno', 'run', '-A', 'a.ts'])
  })
  it('falls back to extension, default bun', () => {
    expect(interpreterForExtension('a.py')).toEqual(['python3', 'a.py'])
    expect(interpreterForExtension('a.mjs')).toEqual(['node', 'a.mjs'])
    expect(interpreterForExtension('a.bin')).toEqual(['bun', 'a.bin'])
  })
})

// ─── slug validation (mirror of SLUG_RE) ─────────────────────────────────────

const SLUG_RE = /^[a-z][a-z0-9_]*$/

describe('custom tool slug', () => {
  it('accepts lowercase identifiers', () => {
    for (const s of ['scrape', 'scrape_url', 'a', 'tool_2']) expect(SLUG_RE.test(s)).toBe(true)
  })
  it('rejects invalid slugs', () => {
    for (const s of ['Scrape', '2tool', 'my-tool', 'my tool', '', 'a/b']) expect(SLUG_RE.test(s)).toBe(false)
  })
})

// ─── jsonSchemaToZod (mirror) ────────────────────────────────────────────────

function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodType {
  const desc = (prop.description as string) ?? undefined
  switch (prop.type) {
    case 'string':
      if (prop.enum) return z.enum(prop.enum as [string, ...string[]]).describe(desc ?? '')
      return desc ? z.string().describe(desc) : z.string()
    case 'number':
    case 'integer':
      return desc ? z.number().describe(desc) : z.number()
    case 'boolean':
      return desc ? z.boolean().describe(desc) : z.boolean()
    case 'array':
      if (prop.items) return z.array(jsonSchemaPropertyToZod(prop.items as Record<string, unknown>))
      return z.array(z.unknown())
    case 'object':
      return jsonSchemaToZod(prop)
    default:
      return z.unknown()
  }
}

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  if (schema.type === 'object' && schema.properties) {
    const props = schema.properties as Record<string, Record<string, unknown>>
    const required = (schema.required as string[]) ?? []
    const shape: Record<string, z.ZodType> = {}
    for (const [key, prop] of Object.entries(props)) {
      let field = jsonSchemaPropertyToZod(prop)
      if (!required.includes(key)) field = field.optional() as any
      shape[key] = field
    }
    return z.object(shape)
  }
  return z.object({}).passthrough()
}

describe('jsonSchemaToZod', () => {
  it('required vs optional fields', () => {
    const s = jsonSchemaToZod({ type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } }, required: ['name'] })
    expect(s.safeParse({ name: 'A', age: 1 }).success).toBe(true)
    expect(s.safeParse({ name: 'A' }).success).toBe(true)
    expect(s.safeParse({ age: 1 }).success).toBe(false)
    expect(s.safeParse({ name: 1 }).success).toBe(false)
  })
  it('enums and arrays', () => {
    const e = jsonSchemaToZod({ type: 'object', properties: { c: { type: 'string', enum: ['r', 'g'] } }, required: ['c'] })
    expect(e.safeParse({ c: 'r' }).success).toBe(true)
    expect(e.safeParse({ c: 'x' }).success).toBe(false)
    const a = jsonSchemaToZod({ type: 'object', properties: { t: { type: 'array', items: { type: 'string' } } }, required: ['t'] })
    expect(a.safeParse({ t: ['a'] }).success).toBe(true)
    expect(a.safeParse({ t: [1] }).success).toBe(false)
  })
  it('passthrough for non-object schemas', () => {
    expect(jsonSchemaToZod({ type: 'string' }).safeParse({ anything: 1 }).success).toBe(true)
  })
})
