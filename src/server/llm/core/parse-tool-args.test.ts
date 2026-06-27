import { describe, expect, it } from 'bun:test'
import { parseToolArguments } from './parse-tool-args'

describe('parseToolArguments', () => {
  it('parses already-valid JSON unchanged', () => {
    expect(parseToolArguments('{"path": "/tmp/a", "offset": 10}')).toEqual({
      path: '/tmp/a',
      offset: 10,
    })
  })

  it('returns {} for empty or whitespace-only input', () => {
    expect(parseToolArguments('')).toEqual({})
    expect(parseToolArguments('   \n ')).toEqual({})
  })

  it('strips a ```json fence wrapping the call', () => {
    const raw = '```json\n{"q": "weather"}\n```'
    expect(parseToolArguments(raw)).toEqual({ q: 'weather' })
  })

  it('strips a bare ``` fence with no language tag', () => {
    expect(parseToolArguments('```\n{"q": "weather"}\n```')).toEqual({ q: 'weather' })
  })

  it('extracts the object when the model adds leading prose', () => {
    expect(parseToolArguments('Sure, here you go: {"id": 7}')).toEqual({ id: 7 })
  })

  it('extracts the object when the model adds trailing prose', () => {
    expect(parseToolArguments('{"id": 7} — hope that helps!')).toEqual({ id: 7 })
  })

  it('does not stop at a closing brace that lives inside a string', () => {
    // The real closer is the final brace; the `}` inside the value must be ignored.
    expect(parseToolArguments('{"text": "a } b"} trailing')).toEqual({ text: 'a } b' })
  })

  it('drops a trailing comma in an object', () => {
    expect(parseToolArguments('{"a": 1, "b": 2,}')).toEqual({ a: 1, b: 2 })
  })

  it('drops a trailing comma in an array', () => {
    expect(parseToolArguments('[1, 2, 3,]')).toEqual([1, 2, 3])
  })

  it('closes an object truncated when the model ran out of tokens', () => {
    expect(parseToolArguments('{"a": {"b": 1')).toEqual({ a: { b: 1 } })
  })

  it('closes a string left open by truncation', () => {
    expect(parseToolArguments('{"command": "ls -la')).toEqual({ command: 'ls -la' })
  })

  it('preserves escaped quotes inside strings', () => {
    expect(parseToolArguments('{"msg": "say \\"hi\\""}')).toEqual({ msg: 'say "hi"' })
  })

  it('falls back to { _raw } when nothing is recoverable', () => {
    expect(parseToolArguments('not json at all')).toEqual({ _raw: 'not json at all' })
  })

  it('falls back to { _raw } for a structurally broken object', () => {
    // Missing value after the key: balancing cannot make this valid, so we keep the raw.
    const raw = '{"a": }'
    expect(parseToolArguments(raw)).toEqual({ _raw: raw })
  })

  it('keeps the original string verbatim in the _raw fallback', () => {
    const raw = '```json\n{oops\n```'
    const result = parseToolArguments(raw) as { _raw: string }
    expect(result._raw).toBe(raw)
  })
})
