/**
 * Validate model-emitted tool arguments against the tool's declared schema before the
 * tool runs. A small or self-hosted model that produced the wrong shape (missing a
 * required field, wrong type, or the `{ _raw }` salvage from a broken JSON stream) then
 * gets a precise, correctable error as its tool result instead of the tool failing deep
 * inside `execute` on an undefined field. The agent loop already re-prompts after a tool
 * error, so a rejected call becomes a bounded repair-retry through the normal step loop
 * (capped by `config.tools.maxSteps`) with no separate retry machinery.
 *
 * Only Zod schemas are checked — every native tool declares one. Tools declared with a
 * plain JSON Schema (MCP servers, custom tools) are treated as valid here: they validate
 * their own input and the host ships no JSON-Schema validator.
 */

interface ZodLike {
  safeParse: (value: unknown) => { success: boolean; error?: { issues?: ZodIssueLike[] } }
}

interface ZodIssueLike {
  path?: Array<string | number>
  message?: string
}

export interface ToolArgValidation {
  ok: boolean
  /** Set when `ok` is false: a model-facing explanation of what to correct. */
  message?: string
}

/** Cap the issue list so one badly-shaped call can't flood the context. */
const MAX_ISSUES = 8

export function validateToolArgs(
  inputSchema: unknown,
  args: unknown,
  toolName: string,
): ToolArgValidation {
  if (!isZodLike(inputSchema)) return { ok: true }

  const result = inputSchema.safeParse(args)
  if (result.success) return { ok: true }

  const issues = (result.error?.issues ?? []).slice(0, MAX_ISSUES).map(describeIssue)
  const detail =
    issues.length > 0 ? issues.join('; ') : 'arguments did not match the expected schema'
  return {
    ok: false,
    message:
      `Invalid arguments for tool "${toolName}": ${detail}. ` +
      'Re-call the tool with corrected arguments that match its parameters.',
  }
}

function isZodLike(value: unknown): value is ZodLike {
  return value != null && typeof (value as ZodLike).safeParse === 'function'
}

function describeIssue(issue: ZodIssueLike): string {
  const path = issue.path && issue.path.length > 0 ? issue.path.join('.') : '(root)'
  return `${path}: ${issue.message ?? 'invalid'}`
}
