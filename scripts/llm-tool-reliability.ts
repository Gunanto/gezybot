/**
 * Diagnostic: how reliably does a given (usually small / self-hosted) model emit
 * tool calls, and how much do R1 (tolerant parsing) and R2 (schema validation)
 * recover? Calls an OpenAI-compatible endpoint directly to capture the RAW
 * tool-call argument string the model produced, then classifies each call through
 * the exact helpers Hivekeep ships:
 *
 *   NONE       model answered in prose, no native tool call  -> only R5 fixes this
 *   VALID      raw arguments parsed and matched the schema
 *   REPAIRED   raw arguments were broken but R1 recovered valid args
 *   INVALID    parsed, but failed schema validation -> R2 rejects + loop retries
 *   RAW        unparseable even after R1 -> R2 rejects with a "not JSON" message
 *
 * Run against several temperatures to see R6's effect. This is the measurement
 * that decides whether R5 (a prompt-based protocol) is actually needed.
 *
 * Setup (no key needed for local servers; Groq's free tier works too):
 *   TEST_BASE_URL=https://api.groq.com/openai/v1 TEST_API_KEY=gsk_... \
 *   TEST_MODEL=gemma2-9b-it bun scripts/llm-tool-reliability.ts
 *
 * Env:
 *   TEST_BASE_URL   required, e.g. http://localhost:11434/v1 (Ollama) or a cloud /v1
 *   TEST_API_KEY    optional (local servers usually need none)
 *   TEST_MODEL      required, the model id as the server lists it
 *   TEST_RUNS       samples per prompt per temperature (default 3)
 *   TEST_TEMPS      comma list of temperatures (default "0,0.8")
 *   TEST_MODE       "native" (default, OpenAI tools API) or "prompt" (R5-style:
 *                   tools described in the system prompt, model emits
 *                   <tool_call>{...}</tool_call>, parsed from the text). Use
 *                   "prompt" for models whose backend rejects native tools.
 */
import OpenAI from 'openai'
import { z } from 'zod'
import { parseToolArguments, isRawToolArgs } from '@/server/llm/core/parse-tool-args'
import { validateToolArgs } from '@/server/services/tool-arg-validation'

const baseURL = process.env.TEST_BASE_URL
const model = process.env.TEST_MODEL
if (!baseURL || !model) {
  console.error('Set TEST_BASE_URL and TEST_MODEL (see the header of this file).')
  process.exit(1)
}
const runs = Number(process.env.TEST_RUNS ?? 3)
const temps = (process.env.TEST_TEMPS ?? '0,0.8').split(',').map((t) => Number(t.trim()))
const mode = process.env.TEST_MODE === 'prompt' ? 'prompt' : 'native'

const client = new OpenAI({ apiKey: process.env.TEST_API_KEY || 'sk-no-key', baseURL })

// Three tools with a range of argument shapes (enum, optional number, a query that
// invites embedded quotes), mirroring how native tools are declared.
const TOOLS = {
  get_weather: z.object({
    city: z.string(),
    units: z.enum(['celsius', 'fahrenheit']).optional(),
  }),
  read_file: z.object({
    path: z.string(),
    offset: z.number().optional(),
  }),
  web_search: z.object({
    query: z.string(),
    max_results: z.number().optional(),
  }),
} as const

const openaiTools = Object.entries(TOOLS).map(([name, schema]) => ({
  type: 'function' as const,
  function: { name, parameters: z.toJSONSchema(schema) as Record<string, unknown> },
}))

const PROMPTS = [
  'What is the weather in Paris, in celsius?',
  'Read the file /etc/hosts starting at line 10.',
  'Search the web for the latest Bun release notes and return 3 results.',
  'Search the web for \'gemma "12b" tool reliability\' and return 5 results.',
]

type Outcome = 'NONE' | 'VALID' | 'REPAIRED' | 'INVALID' | 'RAW'

function classify(name: string, rawArgs: string): Outcome {
  const schema = TOOLS[name as keyof typeof TOOLS]
  if (!schema) return 'INVALID' // unknown tool name the model invented
  const wasValidJson = (() => {
    try {
      JSON.parse(rawArgs)
      return true
    } catch {
      return false
    }
  })()
  const parsed = parseToolArguments(rawArgs)
  if (isRawToolArgs(parsed)) return 'RAW'
  if (!validateToolArgs(schema, parsed, name).ok) return 'INVALID'
  return wasValidJson ? 'VALID' : 'REPAIRED'
}

// R5-style: tools described in the prompt, the model replies with a delimited block.
const PROMPT_SYSTEM =
  'You can call tools to answer. Available tools (JSON Schema):\n' +
  openaiTools.map((t) => JSON.stringify(t.function)).join('\n') +
  '\n\nTo call a tool, reply with EXACTLY one line and nothing else:\n' +
  '<tool_call>{"name": "<tool name>", "arguments": { ... }}</tool_call>'

function classifyPrompt(content: string): Outcome {
  const tagged = content.match(/<tool_call>\s*([\s\S]*?)<\/tool_call>/i)
  const blob = (tagged?.[1] ?? content).trim()
  let wasValidJson = true
  try {
    JSON.parse(blob)
  } catch {
    wasValidJson = false
  }
  const parsed = parseToolArguments(blob)
  if (isRawToolArgs(parsed) || typeof parsed !== 'object' || parsed === null) return 'NONE'
  const obj = parsed as Record<string, unknown>
  if (typeof obj.name !== 'string') return 'NONE'
  if (!(obj.name in TOOLS)) return 'INVALID'
  const schema = TOOLS[obj.name as keyof typeof TOOLS]
  if (!validateToolArgs(schema, obj.arguments ?? {}, obj.name).ok) return 'INVALID'
  return wasValidJson ? 'VALID' : 'REPAIRED'
}

async function callOnce(prompt: string, temperature: number): Promise<Outcome> {
  if (mode === 'prompt') {
    const resp = await client.chat.completions.create({
      model: model!,
      temperature,
      messages: [
        { role: 'system', content: PROMPT_SYSTEM },
        { role: 'user', content: prompt },
      ],
    })
    return classifyPrompt(resp.choices[0]?.message?.content ?? '')
  }
  const resp = await client.chat.completions.create({
    model: model!,
    temperature,
    tools: openaiTools,
    messages: [
      { role: 'system', content: 'Use a tool to answer. Do not ask follow-up questions.' },
      { role: 'user', content: prompt },
    ],
  })
  const call = resp.choices[0]?.message?.tool_calls?.[0]
  if (!call || call.type !== 'function') return 'NONE'
  return classify(call.function.name, call.function.arguments ?? '')
}

const ORDER: Outcome[] = ['VALID', 'REPAIRED', 'INVALID', 'RAW', 'NONE']

console.log(`\nModel: ${model}  endpoint: ${baseURL}  mode: ${mode}`)
console.log(`Samples: ${runs} per prompt, temperatures: ${temps.join(', ')}\n`)

for (const temperature of temps) {
  const tally: Record<Outcome, number> = { NONE: 0, VALID: 0, REPAIRED: 0, INVALID: 0, RAW: 0 }
  let total = 0
  for (const prompt of PROMPTS) {
    for (let i = 0; i < runs; i++) {
      let outcome: Outcome
      try {
        outcome = await callOnce(prompt, temperature)
      } catch (err) {
        console.error(`  request failed (temp ${temperature}): ${(err as Error).message}`)
        continue
      }
      tally[outcome]++
      total++
    }
  }
  const usable = tally.VALID + tally.REPAIRED
  const pct = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : 'n/a')
  console.log(`temperature ${temperature}:`)
  for (const o of ORDER) console.log(`  ${o.padEnd(9)} ${String(tally[o]).padStart(3)}  ${pct(tally[o])}`)
  console.log(`  -> usable after R1: ${usable}/${total} (${pct(usable)}); R1 rescued ${tally.REPAIRED}, R2 would reject ${tally.INVALID + tally.RAW}, R5-only (no native call) ${tally.NONE}\n`)
}
