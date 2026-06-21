/**
 * Tolerant parsing of streamed tool-call argument JSON.
 *
 * Small / self-hosted models (Gemma, local Ollama / llama.cpp builds, and similar)
 * routinely emit argument JSON that a strict `JSON.parse` rejects: wrapped in a
 * ```json fence, prefixed or suffixed with prose, truncated mid-object when the model
 * runs out of tokens, or carrying a trailing comma. Every OpenAI-compatible provider
 * used to wrap such a string in `{ _raw: ... }`, which then reached the tool as
 * arguments with none of the fields it expected. This recovers the common,
 * unambiguous breakage before giving up.
 *
 * Recovery is deliberately conservative: it only applies transforms that cannot change
 * the meaning of already-valid JSON (strip a fence, extract the first balanced
 * container, drop trailing commas, close unterminated strings and unclosed brackets).
 * It never rewrites quote characters or values, so it cannot silently turn one valid
 * call into a different one. When recovery does not yield parseable JSON it falls back
 * to the original `{ _raw }` behaviour rather than guessing.
 */

/** The `{ _raw }` shape handed to a tool when arguments could not be recovered. */
export interface RawToolArgs {
  _raw: string
}

/** True for the exact `{ _raw }` fallback shape produced by `parseToolArguments`. */
export function isRawToolArgs(value: unknown): value is RawToolArgs {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)._raw === 'string' &&
    Object.keys(value).length === 1
  )
}

/**
 * Parse accumulated tool-call arguments into a value to hand to the tool.
 * Returns `{}` for empty input, the parsed value on success (direct or recovered),
 * or `{ _raw: <original> }` when even recovery fails.
 */
export function parseToolArguments(raw: string): unknown {
  if (raw.trim().length === 0) return {}

  const direct = tryParse(raw.trim())
  if (direct.ok) return direct.value

  const candidate = extractJsonCandidate(raw.trim())
  if (candidate !== null) {
    const parsed = tryParse(candidate)
    if (parsed.ok) return parsed.value

    const repaired = repairJson(candidate)
    if (repaired !== null) {
      const reparsed = tryParse(repaired)
      if (reparsed.ok) return reparsed.value
    }
  }

  return { _raw: raw } satisfies RawToolArgs
}

type ParseResult = { ok: true; value: unknown } | { ok: false }

function tryParse(s: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(s) }
  } catch {
    return { ok: false }
  }
}

/**
 * Pull a JSON container out of a noisy string: strip a surrounding markdown fence,
 * then return the first balanced `{...}` / `[...]` span. If the container never
 * closes (truncated output) the tail from the opener is returned so `repairJson` can
 * balance it. Returns null when there is no container at all.
 */
function extractJsonCandidate(input: string): string | null {
  let s = input
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1] != null) s = fence[1].trim()

  const start = s.search(/[{[]/)
  if (start === -1) return null
  return balancedSpan(s, start)
}

/** Substring from `start` to the matching closer, or to end if it never closes. */
function balancedSpan(s: string, start: number): string {
  const open = s[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === open) depth++
    else if (ch === close && --depth === 0) return s.slice(start, i + 1)
  }
  return s.slice(start)
}

/**
 * Repair the two breakages that survive extraction: a trailing comma, and a string
 * or container the model left open when it was cut off. Returns null when the input
 * is structurally impossible (a stray closer), in which case the caller gives up.
 */
function repairJson(s: string): string | null {
  let out = s.trim().replace(/,(\s*)$/, '$1').replace(/,(\s*[}\]])/g, '$1')
  const closers = pendingClosers(out)
  if (closers === null) return null
  return out + closers
}

/**
 * The sequence of closing tokens needed to balance `s` (plus a closing quote if it
 * ends inside a string). Null if a closer appears with no matching opener.
 */
function pendingClosers(s: string): string | null {
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null
    }
  }
  let suffix = inStr ? '"' : ''
  while (stack.length > 0) suffix += stack.pop()
  return suffix
}
