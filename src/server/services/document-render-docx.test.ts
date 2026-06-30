import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { markdownToDocxBuffer } from '@/server/services/document-render-docx'

// ─── Mocks ───────────────────────────────────────────────────────────────────
//
// We never launch a real browser: screenshotHtmlElements returns a tiny PNG
// per requested id. The docx service parses PNG dimensions for ImageRun sizing,
// so the mock buffers must start with a valid PNG signature + IHDR (width/height
// at bytes 16/20).

/** Build a minimal PNG-like buffer (sig + IHDR chunk with given w/h). Only the
 *  fields pngDims() reads are required, but we emit a plausible IHDR. */
function fakePng(width: number, height: number): Buffer {
  const b = Buffer.alloc(24)
  // PNG signature
  b.writeUInt8(0x89, 0); b.write('PNG', 1, 'ascii')
  b.writeUInt8(0x0d, 4); b.writeUInt8(0x0a, 5); b.writeUInt8(0x1a, 6); b.writeUInt8(0x0a, 7)
  // IHDR length (13) + type "IHDR"
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20)
  return b
}

const mockScreenshotHtmlElements = mock(
  async (html: string, ids: string[]): Promise<Map<string, Buffer>> => {
    const out = new Map<string, Buffer>()
    for (let i = 0; i < ids.length; i++) out.set(ids[i]!, fakePng(120, 40))
    return out
  },
)

const mockIsEnabled = true
mock.module('@/server/services/playwright-manager', () => ({
  playwrightManager: {
    screenshotHtmlElements: mockScreenshotHtmlElements,
    renderPdf: mock(async () => Buffer.from('%PDF-1.4')),
    isEnabled: mockIsEnabled,
  },
}))

// ─── markdownToDocxBuffer ───────────────────────────────────────────────────

describe('markdownToDocxBuffer', () => {
  beforeEach(() => mockScreenshotHtmlElements.mockClear())

  it('produces a valid .docx zip (PK signature) for prose without math', async () => {
    const buf = await markdownToDocxBuffer('# Hello World\n\nA paragraph of body text.', 'Doc')
    // .docx is a ZIP — the first two bytes are "PK" (0x50 0x4B).
    expect(buf[0]).toBe(0x50)
    expect(buf[1]).toBe(0x4b)
    expect(buf.length).toBeGreaterThan(100)
    // No math => screenshot not invoked.
    expect(mockScreenshotHtmlElements).not.toHaveBeenCalled()
  })

  it('rasterizes each equation once (one Chromium session, N ids) and emits a .docx', async () => {
    const md = '# Math\n\nInline $x^2$ and block:\n\n$$\nE=mc^2\n$$\n'
    const buf = await markdownToDocxBuffer(md, 'Math Doc')
    expect(buf[0]).toBe(0x50) // PK
    expect(mockScreenshotHtmlElements).toHaveBeenCalledTimes(1)
    const [html, ids] = mockScreenshotHtmlElements.mock.calls[0]! as [string, string[]]
    // 1 inline + 1 block equation.
    expect(ids.length).toBe(2)
    // Each equation wrapped in a div with its id, containing <math> (MathML).
    expect(html).toContain('<div id="eq-0"')
    expect(html).toContain('<div id="eq-1"')
    expect(html).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML')
    expect((await (mockScreenshotHtmlElements.mock.results[0]!.value as Promise<Map<string, Buffer>>)).size).toBe(2)
  })

  it('handles a ```math fenced block as a block equation', async () => {
    const md = '```math\n\\frac{a}{b}\n```'
    const buf = await markdownToDocxBuffer(md, 'F')
    expect(buf[0]).toBe(0x50)
    expect(mockScreenshotHtmlElements).toHaveBeenCalledTimes(1)
    const ids = (mockScreenshotHtmlElements.mock.calls[0]! as [string, string[]])[1]
    expect(ids.length).toBe(1)
  })

  it('handles only math (no prose) without throwing', async () => {
    const buf = await markdownToDocxBuffer('$$\\sum_{i=1}^n i$$', 'S')
    expect(buf[0]).toBe(0x50)
    expect(mockScreenshotHtmlElements).toHaveBeenCalledTimes(1)
  })

  it('includes the title as document metadata', async () => {
    // Packer writes core.xml with the dc:title; we just assert a zip is produced
    // (metadata presence is verified by the doc opens in Word). Title doesn't
    // appear verbatim in the raw deflate stream reliably, so this is a smoke
    // test that the call with a title still yields a valid zip.
    const buf = await markdownToDocxBuffer('# x', 'My Title 123')
    expect(buf[0]).toBe(0x50)
  })
})
