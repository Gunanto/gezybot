import { describe, it, expect } from 'bun:test'
import {
  parsePort,
  formatMessageId,
  parseMessageId,
  resolveFolder,
  buildImapSearch,
  structureHasAttachments,
} from '@/server/email/providers/imap'

describe('parsePort', () => {
  it('parses a valid port', () => {
    expect(parsePort('993', 143)).toBe(993)
  })
  it('falls back on empty / invalid / non-positive input', () => {
    expect(parsePort(undefined, 587)).toBe(587)
    expect(parsePort('', 587)).toBe(587)
    expect(parsePort('abc', 587)).toBe(587)
    expect(parsePort('0', 587)).toBe(587)
  })
})

describe('message id round-trip', () => {
  it('formats and parses a simple mailbox', () => {
    expect(parseMessageId(formatMessageId('INBOX', 42))).toEqual({ mailbox: 'INBOX', uid: 42 })
  })
  it('keeps a mailbox containing a colon (splits on the last colon)', () => {
    expect(parseMessageId(formatMessageId('[Gmail]/Sent', 7))).toEqual({ mailbox: '[Gmail]/Sent', uid: 7 })
  })
  it('throws on a malformed id', () => {
    expect(() => parseMessageId('no-uid')).toThrow()
    expect(() => parseMessageId('INBOX:nope')).toThrow()
  })
})

describe('resolveFolder', () => {
  it('defaults to INBOX', () => {
    expect(resolveFolder(undefined)).toBe('INBOX')
  })
  it('maps known aliases case-insensitively', () => {
    expect(resolveFolder('inbox')).toBe('INBOX')
    expect(resolveFolder('Sent')).toBe('Sent')
    expect(resolveFolder('JUNK')).toBe('Junk')
  })
  it('passes through an unknown folder verbatim', () => {
    expect(resolveFolder('Archive/2026')).toBe('Archive/2026')
  })
})

describe('buildImapSearch', () => {
  it('is empty for an undefined query', () => {
    expect(buildImapSearch(undefined)).toEqual({})
  })
  it('treats raw as a body search', () => {
    expect(buildImapSearch({ raw: 'invoice' })).toEqual({ body: 'invoice' })
  })
  it('maps structured fields, with unread → seen:false', () => {
    const c = buildImapSearch({ from: 'a@b', subject: 'Hi', text: 'x', unread: true })
    expect(c.from).toBe('a@b')
    expect(c.subject).toBe('Hi')
    expect(c.body).toBe('x')
    expect(c.seen).toBe(false)
  })
  it('maps date bounds to Date objects', () => {
    const after = Date.UTC(2026, 0, 1)
    const c = buildImapSearch({ after })
    expect(c.since).toBeInstanceOf(Date)
    expect(c.since?.getTime()).toBe(after)
  })
})

describe('structureHasAttachments', () => {
  it('is false for a plain message', () => {
    expect(structureHasAttachments({ disposition: 'inline' })).toBe(false)
    expect(structureHasAttachments(undefined)).toBe(false)
  })
  it('detects an attachment disposition anywhere in the tree', () => {
    expect(
      structureHasAttachments({
        childNodes: [{ disposition: 'inline' }, { childNodes: [{ disposition: 'attachment' }] }],
      }),
    ).toBe(true)
  })
})
