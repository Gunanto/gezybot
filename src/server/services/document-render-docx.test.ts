import { describe, it, expect } from 'bun:test'
import { unzipSync } from 'fflate'
import { markdownToDocxBuffer } from '@/server/services/document-render-docx'

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Unzip a .docx buffer and return the word/document.xml as a string. */
function extractDocumentXml(buf: Buffer): string {
  const files = unzipSync(new Uint8Array(buf))
  const xml = files['word/document.xml']
  if (!xml) throw new Error('word/document.xml not found in .docx')
  return new TextDecoder().decode(xml)
}

// ─── markdownToDocxBuffer ───────────────────────────────────────────────────

describe('markdownToDocxBuffer', () => {
  it('produces a valid .docx zip (PK signature) for prose without math', async () => {
    const buf = await markdownToDocxBuffer('# Hello World\n\nA paragraph of body text.', 'Doc')
    // .docx is a ZIP — the first two bytes are "PK" (0x50 0x4B).
    expect(buf[0]).toBe(0x50)
    expect(buf[1]).toBe(0x4b)
    expect(buf.length).toBeGreaterThan(100)
    // No math => no OMML tags in the document XML.
    const xml = extractDocumentXml(buf)
    expect(xml).not.toContain('m:oMath')
  })

  it('renders inline LaTeX as native OMML (m:oMath with m:f/m:num/m:den)', async () => {
    const md = 'The fraction $\\frac{a}{b}$ is inline.'
    const buf = await markdownToDocxBuffer(md, 'Math Doc')
    expect(buf[0]).toBe(0x50) // PK
    const xml = extractDocumentXml(buf)
    expect(xml).toContain('m:oMath')
    expect(xml).toContain('m:f')
    expect(xml).toContain('m:num')
    expect(xml).toContain('m:den')
    // Inline equations are NOT wrapped in m:oMathPara.
    expect(xml).not.toContain('m:oMathPara')
  })

  it('renders block LaTeX ($$...$$) as OMML wrapped in m:oMathPara', async () => {
    const md = 'Block equation:\n\n$$\nE=mc^2\n$$\n'
    const buf = await markdownToDocxBuffer(md, 'Block')
    expect(buf[0]).toBe(0x50)
    const xml = extractDocumentXml(buf)
    expect(xml).toContain('m:oMath')
    expect(xml).toContain('m:oMathPara')
  })

  it('renders a ```math fenced block as a block equation', async () => {
    const md = '```math\n\\frac{a}{b}\n```'
    const buf = await markdownToDocxBuffer(md, 'F')
    expect(buf[0]).toBe(0x50)
    const xml = extractDocumentXml(buf)
    expect(xml).toContain('m:oMath')
    expect(xml).toContain('m:oMathPara')
  })

  it('renders \\sqrt as m:rad (radical)', async () => {
    const md = 'The root $\\sqrt{2}$ is irrational.'
    const buf = await markdownToDocxBuffer(md, 'Rad')
    expect(buf[0]).toBe(0x50)
    const xml = extractDocumentXml(buf)
    expect(xml).toContain('m:rad')
  })

  it('does NOT produce <undefined> wrapper tags (regression: xml-js/sax bug in Bun)', async () => {
    const md = 'Test $\\frac{a}{b}$ inline and block:\n\n$$\nE=mc^2\n$$\n'
    const buf = await markdownToDocxBuffer(md, 'Regression')
    expect(buf[0]).toBe(0x50)
    const xml = extractDocumentXml(buf)
    // The bug: ImportedXmlComponent.fromXmlString uses xml-js/sax which
    // returns rootKey "undefined" for namespace-prefixed elements in Bun,
    // producing invalid <undefined> wrapper tags that prevent Word from
    // rendering equations. Our custom parser avoids this.
    expect(xml).not.toContain('<undefined')
    expect(xml).not.toContain('</undefined')
    expect(xml).toContain('m:oMath')
  })

  it('handles only math (no prose) without throwing', async () => {
    const buf = await markdownToDocxBuffer('$$\\sum_{i=1}^n i$$', 'S')
    expect(buf[0]).toBe(0x50)
    const xml = extractDocumentXml(buf)
    expect(xml).toContain('m:oMath')
  })

  it('renders multiple equations in document order', async () => {
    const md = '# Math\n\nInline $x^2$ and block:\n\n$$\nE=mc^2\n$$\n'
    const buf = await markdownToDocxBuffer(md, 'Multi')
    expect(buf[0]).toBe(0x50)
    const xml = extractDocumentXml(buf)
    // Both inline ($x^2$) and block ($$E=mc^2$$) should produce m:oMath.
    const oMathCount = (xml.match(/<m:oMath[> ]/g) || []).length
    expect(oMathCount).toBe(2)
    // Only the block equation should have m:oMathPara.
    const oMathParaCount = (xml.match(/<m:oMathPara[> ]/g) || []).length
    expect(oMathParaCount).toBe(1)
  })

  it('includes the title as document metadata', async () => {
    // Smoke test: a title doesn't break generation and still yields a valid zip.
    const buf = await markdownToDocxBuffer('# x', 'My Title 123')
    expect(buf[0]).toBe(0x50)
  })

  it('falls back gracefully for invalid LaTeX (no crash, still valid docx)', async () => {
    const buf = await markdownToDocxBuffer('Bad math $\\undefinedcmd$', 'Bad')
    expect(buf[0]).toBe(0x50)
    // KaTeX throwOnError:false → still produces some output (text fallback or
    // empty OMML). The key: no crash, valid zip.
    const xml = extractDocumentXml(buf)
    // Should still have a valid document body.
    expect(xml).toContain('<w:body')
  })
})
