import { describe, expect, it } from 'bun:test'
import type { HivekeepTool } from '@/server/llm/llm/types'
import {
  buildToolProtocolPrompt,
  renderToolCall,
  renderToolResult,
  parseToolCallsFromText,
} from './prompt-tool-protocol'

const TOOLS: HivekeepTool[] = [
  {
    name: 'get_weather',
    description: 'Get the weather for a city',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
  {
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
]

describe('buildToolProtocolPrompt', () => {
  it('lists every tool name and teaches the <tool_call> format', () => {
    const prompt = buildToolProtocolPrompt(TOOLS)
    expect(prompt).toContain('get_weather')
    expect(prompt).toContain('read_file')
    expect(prompt).toContain('Get the weather for a city')
    expect(prompt).toContain('<tool_call>')
    expect(prompt).toContain('never invent a tool name')
  })
})

describe('renderToolCall / renderToolResult', () => {
  it('renders a call that round-trips back through the parser', () => {
    const rendered = renderToolCall('get_weather', { city: 'Paris' })
    const { calls } = parseToolCallsFromText(rendered)
    expect(calls).toEqual([{ name: 'get_weather', args: { city: 'Paris' } }])
  })

  it('accepts arguments already serialized as a JSON string', () => {
    const rendered = renderToolCall('read_file', '{"path":"/etc/hosts"}')
    const { calls } = parseToolCallsFromText(rendered)
    expect(calls).toEqual([{ name: 'read_file', args: { path: '/etc/hosts' } }])
  })

  it('labels a tool response with the tool name', () => {
    expect(renderToolResult('22C and sunny', 'get_weather')).toBe(
      '<tool_response name="get_weather">\n22C and sunny\n</tool_response>',
    )
  })
})

describe('parseToolCallsFromText', () => {
  it('extracts a single call and strips it from the visible text', () => {
    const { text, calls } = parseToolCallsFromText(
      'Let me check. <tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>',
    )
    expect(calls).toEqual([{ name: 'get_weather', args: { city: 'Paris' } }])
    expect(text).toBe('Let me check.')
  })

  it('extracts multiple calls', () => {
    const { calls } = parseToolCallsFromText(
      '<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>' +
        '<tool_call>{"name":"read_file","arguments":{"path":"/tmp/a"}}</tool_call>',
    )
    expect(calls.map((c) => c.name)).toEqual(['get_weather', 'read_file'])
  })

  it('recovers a fenced / slightly broken block via the tolerant parser', () => {
    const { calls } = parseToolCallsFromText(
      '<tool_call>```json\n{"name":"get_weather","arguments":{"city":"Paris"}}\n```</tool_call>',
    )
    expect(calls).toEqual([{ name: 'get_weather', args: { city: 'Paris' } }])
  })

  it('treats an untagged bare call object as a single call', () => {
    const { calls } = parseToolCallsFromText('{"name":"read_file","arguments":{"path":"/tmp/a"}}')
    expect(calls).toEqual([{ name: 'read_file', args: { path: '/tmp/a' } }])
  })

  it('returns no calls for ordinary prose and keeps the text', () => {
    const { text, calls } = parseToolCallsFromText('The capital of France is Paris.')
    expect(calls).toEqual([])
    expect(text).toBe('The capital of France is Paris.')
  })

  it('does not misread a JSON object without name+arguments as a call', () => {
    const { calls } = parseToolCallsFromText('Here is some data: {"city":"Paris","temp":22}')
    expect(calls).toEqual([])
  })
})
