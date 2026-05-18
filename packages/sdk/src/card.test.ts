import { describe, it, expect } from 'bun:test'
import { card, type PluginCardPrimitive } from './index'

describe('card builders', () => {
  it('header() returns a typed header primitive', () => {
    const h = card.header({ title: 'Hello', icon: 'Sparkles', accent: 'primary' })
    expect(h).toEqual({ type: 'header', title: 'Hello', icon: 'Sparkles', accent: 'primary' })
  })

  it('infoGrid() includes the items array unchanged', () => {
    const g = card.infoGrid({
      columns: 2,
      items: [
        { label: 'Status', value: 'OK', variant: 'success' },
        { label: 'Latency', value: '42ms' },
      ],
    })
    expect(g.type).toBe('info-grid')
    expect(g.items).toHaveLength(2)
    expect(g.items[0]?.variant).toBe('success')
  })

  it('statusBanner() carries label + animation', () => {
    const b = card.statusBanner({
      label: 'Working…',
      animated: 'pulse',
      variant: 'primary',
    })
    expect(b).toEqual({
      type: 'status-banner',
      label: 'Working…',
      animated: 'pulse',
      variant: 'primary',
    })
  })

  it('progress() defaults to no args (indeterminate ribbon)', () => {
    const p = card.progress()
    expect(p).toEqual({ type: 'progress' })
  })

  it('progress() forwards every field', () => {
    const p = card.progress({ value: 30, max: 100, indeterminate: false, label: 'Loading' })
    expect(p).toEqual({ type: 'progress', value: 30, max: 100, indeterminate: false, label: 'Loading' })
  })

  it('collapsible() accepts a single primitive or an array as content', () => {
    const single = card.collapsible({
      label: 'Details',
      content: card.markdown('# hi'),
    })
    expect(single.content).toEqual({ type: 'markdown', content: '# hi' })

    const many = card.collapsible({
      label: 'Details',
      content: [card.markdown('line 1'), card.divider(), card.markdown('line 2')],
    })
    expect(Array.isArray(many.content)).toBe(true)
    expect((many.content as PluginCardPrimitive[]).length).toBe(3)
  })

  it('logStream() preserves the lines order and options', () => {
    const l = card.logStream({ lines: ['a', 'b', 'c'], autoscroll: true, maxHeight: 200 })
    expect(l).toEqual({ type: 'log-stream', lines: ['a', 'b', 'c'], autoscroll: true, maxHeight: 200 })
  })

  it('actionRow() takes the actions array directly (sugar)', () => {
    const r = card.actionRow([
      { id: 'cancel', label: 'Cancel', variant: 'destructive' },
      { id: 'retry', label: 'Retry' },
    ])
    expect(r.type).toBe('action-row')
    expect(r.actions).toHaveLength(2)
    expect(r.actions[0]?.id).toBe('cancel')
  })

  it('markdown() takes the content string directly', () => {
    expect(card.markdown('# Title')).toEqual({ type: 'markdown', content: '# Title' })
  })

  it('spinner() with and without label', () => {
    expect(card.spinner()).toEqual({ type: 'spinner' })
    expect(card.spinner('Loading models…')).toEqual({ type: 'spinner', label: 'Loading models…' })
  })

  it('badge() carries text + optional variant/icon', () => {
    expect(card.badge({ text: 'new' })).toEqual({ type: 'badge', text: 'new' })
    expect(card.badge({ text: 'paid', variant: 'success', icon: 'Check' })).toEqual({
      type: 'badge',
      text: 'paid',
      variant: 'success',
      icon: 'Check',
    })
  })

  it('divider() with and without label', () => {
    expect(card.divider()).toEqual({ type: 'divider' })
    expect(card.divider('— or —')).toEqual({ type: 'divider', label: '— or —' })
  })

  it('a full layout type-checks as PluginCardPrimitive[]', () => {
    const layout: PluginCardPrimitive[] = [
      card.header({ title: 'Run' }),
      card.statusBanner({ label: 'Working', animated: 'pulse' }),
      card.progress({ indeterminate: true }),
      card.infoGrid({
        items: [
          { label: 'Started', value: '12:01' },
          { label: 'Step', value: 'fetch' },
        ],
      }),
      card.divider(),
      card.actionRow([{ id: 'cancel', label: 'Cancel', variant: 'destructive' }]),
    ]
    // Compile-time check is the assertion; this runtime test just ensures
    // the helpers produce values an array literal accepts.
    expect(layout).toHaveLength(6)
  })
})
