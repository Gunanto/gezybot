/**
 * A provider-agnostic, prompt-based tool-calling protocol for models whose backend
 * does not support native function calling (e.g. Gemma on Ollama, which returns
 * HTTP 400 "does not support tools"). Tools are described in the system prompt and
 * the model is asked to emit `<tool_call>{...}</tool_call>` blocks, which are parsed
 * back into the canonical `tool-use` shape. Measured at 100% valid tool calls on a
 * real gemma3:12b (see `docs/dev-notes/light-model-reliability.md`).
 *
 * These functions are pure and depend only on the shared `HivekeepTool` shape and
 * strings, so any provider can adopt the protocol with a thin integration layer that
 * (1) merges `buildToolProtocolPrompt` into its system message, (2) serializes prior
 * tool calls / results with `renderToolCall` / `renderToolResult`, and (3) runs the
 * model's text output through `parseToolCallsFromText`. The format mirrors the Nous
 * Research "Hermes" convention.
 */
import type { HivekeepTool } from '@/server/llm/llm/types'
import { parseToolArguments, isRawToolArgs } from '@/server/llm/core/parse-tool-args'

/** System-prompt block teaching the model to call tools as text. Merge into the
 *  existing system prompt (append after the agent's own instructions). */
export function buildToolProtocolPrompt(tools: HivekeepTool[]): string {
  const signatures = tools
    .map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.inputSchema }))
    .join('\n')
  return [
    '# Tool calling',
    'You can call tools to look things up or take actions. Your available tools are listed below, one JSON signature per line:',
    '',
    '<tools>',
    signatures,
    '</tools>',
    '',
    'To call a tool, output a block of exactly this form:',
    '<tool_call>{"name": "<tool name>", "arguments": {<arguments as JSON>}}</tool_call>',
    '',
    'Rules:',
    '- Emit one <tool_call> block per call; emit several blocks to call several tools.',
    '- Use only the tool names listed above; never invent a tool name.',
    '- After a tool runs you receive its result in a <tool_response> block; continue from there.',
    '- When you have the final answer for the user, reply normally with no <tool_call> block.',
  ].join('\n')
}

/** Render a tool call as the assistant text to replay in history. */
export function renderToolCall(name: string, args: unknown): string {
  let argObj: unknown = args
  if (typeof args === 'string') {
    const parsed = parseToolArguments(args)
    argObj = isRawToolArgs(parsed) ? {} : parsed
  }
  return `<tool_call>${JSON.stringify({ name, arguments: argObj ?? {} })}</tool_call>`
}

/** Render a tool result as the text fed back to the model. */
export function renderToolResult(content: string, name?: string): string {
  const attr = name ? ` name="${name}"` : ''
  return `<tool_response${attr}>\n${content}\n</tool_response>`
}

export interface ParsedTextToolCall {
  name: string
  args: unknown
}

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)<\/tool_call>/gi

/**
 * Extract tool calls from a model's text response. Returns the calls plus the text
 * with the call blocks removed (what should be shown to the user). Each block is run
 * through the tolerant parser, so fenced or slightly-broken JSON is still recovered.
 */
export function parseToolCallsFromText(content: string): {
  text: string
  calls: ParsedTextToolCall[]
} {
  const calls: ParsedTextToolCall[] = []
  let sawTag = false
  const text = content
    .replace(TOOL_CALL_RE, (_match, inner: string) => {
      sawTag = true
      const call = toCall(inner)
      if (call) calls.push(call)
      return ''
    })
    .trim()

  // Some models skip the tags and emit a bare call object as the whole reply.
  // Only treat that as a call when it clearly has both `name` and `arguments`,
  // so ordinary prose is never misread as a tool call.
  if (!sawTag) {
    const parsed = parseToolArguments(content)
    if (!isRawToolArgs(parsed) && typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>
      if (typeof obj.name === 'string' && obj.name && 'arguments' in obj) {
        return { text: '', calls: [{ name: obj.name, args: obj.arguments ?? {} }] }
      }
    }
  }

  return { text, calls }
}

function toCall(blob: string): ParsedTextToolCall | null {
  const parsed = parseToolArguments(blob)
  if (isRawToolArgs(parsed) || typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.name !== 'string' || !obj.name) return null
  return { name: obj.name, args: obj.arguments ?? {} }
}
