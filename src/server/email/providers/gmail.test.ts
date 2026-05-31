import { describe, it, expect } from 'bun:test'
import {
  buildGmailQuery,
  buildMimeMessage,
  parseAddressList,
  formatAddress,
  extractBodyAndAttachments,
} from '@/server/email/providers/gmail'

describe('buildGmailQuery', () => {
  it('returns raw passthrough when set', () => {
    expect(buildGmailQuery({ raw: 'is:starred from:x' })).toBe('is:starred from:x')
  })

  it('maps structured fields to Gmail operators', () => {
    const q = buildGmailQuery({ from: 'a@b.com', subject: 'Hi there', unread: true, hasAttachment: true, text: 'invoice' })
    expect(q).toContain('from:a@b.com')
    expect(q).toContain('subject:(Hi there)')
    expect(q).toContain('is:unread')
    expect(q).toContain('has:attachment')
    expect(q).toContain('invoice')
  })

  it('formats dates as YYYY/MM/DD (UTC)', () => {
    expect(buildGmailQuery({ after: Date.UTC(2026, 0, 15) })).toBe('after:2026/01/15')
  })

  it('is empty for an undefined query', () => {
    expect(buildGmailQuery(undefined)).toBe('')
  })
})

describe('parseAddressList', () => {
  it('parses name + email', () => {
    expect(parseAddressList('Alice <alice@x.com>')).toEqual([{ name: 'Alice', email: 'alice@x.com' }])
  })

  it('parses a bare email and a list', () => {
    expect(parseAddressList('a@x.com, Bob <b@y.com>')).toEqual([
      { email: 'a@x.com' },
      { name: 'Bob', email: 'b@y.com' },
    ])
  })

  it('is empty for undefined', () => {
    expect(parseAddressList(undefined)).toEqual([])
  })
})

describe('formatAddress', () => {
  it('includes the name only when present', () => {
    expect(formatAddress({ name: 'Al', email: 'a@x' })).toBe('Al <a@x>')
    expect(formatAddress({ email: 'a@x' })).toBe('a@x')
  })
})

describe('buildMimeMessage', () => {
  it('builds a plain-text message with a base64 body', () => {
    const mime = buildMimeMessage({ to: [{ email: 'a@x.com' }], subject: 'Hi', body: 'hello' }, 'me@x.com')
    expect(mime).toContain('To: a@x.com')
    expect(mime).toContain('From: me@x.com')
    expect(mime).toContain('Subject: Hi')
    expect(mime).toContain('Content-Type: text/plain')
    expect(mime).toContain(Buffer.from('hello', 'utf8').toString('base64'))
  })

  it('RFC 2047-encodes a non-ASCII subject', () => {
    const mime = buildMimeMessage({ to: [{ email: 'a@x' }], subject: 'Réunion', body: 'x' }, 'me@x')
    expect(mime).toContain('Subject: =?UTF-8?B?')
  })

  it('uses multipart/alternative when HTML is provided', () => {
    const mime = buildMimeMessage({ to: [{ email: 'a@x' }], subject: 'H', body: 't', bodyHtml: '<b>t</b>' }, 'me@x')
    expect(mime).toContain('multipart/alternative')
    expect(mime).toContain('text/html')
  })
})

describe('extractBodyAndAttachments', () => {
  it('extracts the text body and attachment metadata', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('hello', 'utf8').toString('base64url') } },
        { mimeType: 'application/pdf', filename: 'doc.pdf', body: { attachmentId: 'att1', size: 1234 } },
      ],
    }
    const { text, attachments } = extractBodyAndAttachments(payload)
    expect(text).toBe('hello')
    expect(attachments).toEqual([{ id: 'att1', filename: 'doc.pdf', mimeType: 'application/pdf', size: 1234 }])
  })
})
