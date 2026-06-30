import { describe, it, expect, mock, beforeEach } from 'bun:test'
import {
  markdownToHtml,
  buildPdfHtml,
  markdownToPdf,
} from '@/server/services/document-render'

// ─── Mocks ───────────────────────────────────────────────────────────────────
//
// markdownToPdf delegates to playwrightManager.renderPdf — we never want to
// launch a real browser in unit tests. We capture the HTML it's called with so
// we can assert the wiring, and return a small fixed buffer.

const mockRenderPdf = mock((html: string, _opts?: any) =>
  Promise.resolve(Buffer.from('%PDF-1.4 fake')),
)

mock.module('@/server/services/playwright-manager', () => ({
  playwrightManager: { renderPdf: mockRenderPdf, isEnabled: true },
}))

// ─── markdownToHtml (pure) ───────────────────────────────────────────────────

describe('markdownToHtml', () => {
  it('renders inline math to KaTeX MathML', () => {
    const html = markdownToHtml('Inline $x^2 + y^2$ here.')
    expect(html).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML"')
    expect(html).toContain('<mi>x</mi>')
    expect(html).toContain('<mn>2</mn>')
    expect(html).toContain('<p>')
  })

  it('renders block math ($$…$$) centered', () => {
    const html = markdownToHtml('$$\nE = mc^2\n$$')
    expect(html).toContain('class="math-block"')
    expect(html).toContain('display="block"')
    expect(html).toContain('<mi>E</mi>')
  })

  it('renders a ```math fence as a block equation', () => {
    const html = markdownToHtml('```math\n\\frac{a}{b}\n```')
    expect(html).toContain('class="math-block"')
    expect(html).toContain('<mfrac>')
  })

  it('renders valid LaTeX fractions and operators inline', () => {
    const html = markdownToHtml('$\\frac{a}{b}$ and $1 \\leq x \\leq 2$')
    expect(html).toContain('<mfrac>')
    expect(html).toContain('<mi>a</mi>')
    // \leq renders as a MathML <mo> element (operator).
    expect(html).toContain('<mo>≤</mo>')
  })

  it('escapes HTML special characters in text', () => {
    const html = markdownToHtml('a < b & c > d')
    expect(html).toContain('a &lt; b &amp; c &gt; d')
  })

  it('renders headings with slugged ids', () => {
    const html = markdownToHtml('# Hello World')
    expect(html).toContain('<h1 id="hello-world">Hello World</h1>')
  })

  it('renders an unordered list (items wrapped in <p>)', () => {
    const html = markdownToHtml('- one\n- two\n- three')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li><p>one</p></li>')
    expect(html).toContain('<li><p>three</p></li>')
  })

  it('renders an ordered list with a non-1 start', () => {
    const html = markdownToHtml('3. first\n4. second')
    expect(html).toContain('<ol start="3">')
    expect(html).toContain('<li><p>first</p></li>')
  })

  it('renders GFM task-list checkboxes', () => {
    const html = markdownToHtml('- [x] done\n- [ ] todo')
    expect(html).toContain('<li>[x] <p>done</p></li>')
    expect(html).toContain('<li>[ ] <p>todo</p></li>')
  })

  it('renders a GFM table with header row', () => {
    const html = markdownToHtml('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<thead>')
    expect(html).toContain('<th>a</th>')
    expect(html).toContain('<td>1</td>')
  })

  it('renders fenced code with a language class and escapes content', () => {
    const html = markdownToHtml('```ts\nconst a = "<b>"\n```')
    expect(html).toContain('<pre><code class="language-ts">')
    expect(html).toContain('&lt;b&gt;')
  })

  it('renders blockquotes', () => {
    const html = markdownToHtml('> a quote')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('a quote')
  })

  it('render inline formatting: strong, em, del, code', () => {
    const html = markdownToHtml('**bold** _em_ ~~del~~ `code`')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>em</em>')
    expect(html).toContain('<del>del</del>')
    expect(html).toContain('<code>code</code>')
  })

  it('renders links with escaped href and optional title', () => {
    const html = markdownToHtml('[ex](https://x.com/?a=1&b=2 "title")')
    expect(html).toContain('<a href="https://x.com/?a=1&amp;b=2" title="title">ex</a>')
  })

  it('renders images with alt text', () => {
    const html = markdownToHtml('![alt text](https://x.com/img.png)')
    expect(html).toContain('<img src="https://x.com/img.png" alt="alt text">')
  })

  it('mixes math with other block elements', () => {
    const html = markdownToHtml('# Title\n\n$\\alpha$\n\n- $\\beta$\n- item')
    expect(html).toContain('<h1')
    expect(html).toContain('<math')
    expect(html).toContain('<mi>α</mi>')
    expect(html).toContain('<ul>')
  })

  it('does not emit a literal backslash-n inside rendered MathML', () => {
    const html = markdownToHtml('$x^2$')
    // Regression guard for template bugs — the two-char sequence \n must not
    // leak into the mathml output.
    expect(html).not.toContain('\\n')
  })
})

// ─── buildPdfHtml (pure) ────────────────────────────────────────────────────

describe('buildPdfHtml', () => {
  it('wraps body in a full HTML document with print CSS and title', () => {
    const html = buildPdfHtml('# Hi', 'My Doc')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<title>My Doc</title>')
    expect(html).toContain('@page')
    expect(html).toContain('<h1 id="hi">Hi</h1>')
  })

  it('escapes the title', () => {
    const html = buildPdfHtml('# x', 'a < b & c')
    expect(html).toContain('<title>a &lt; b &amp; c</title>')
  })
})

// ─── markdownToPdf (mocked browser) ───────────────────────────────────────────

describe('markdownToPdf', () => {
  beforeEach(() => mockRenderPdf.mockClear())

  it('passes the built HTML + options to renderPdf and returns its buffer', async () => {
    const { buffer, html } = await markdownToPdf('$$E=mc^2$$', 'Title', { format: 'Letter' })
    expect(mockRenderPdf).toHaveBeenCalledTimes(1)
    const [passedHtml, opts] = mockRenderPdf.mock.calls[0]!
    expect(passedHtml).toContain('<!DOCTYPE html>')
    expect(passedHtml).toContain('<mi>E</mi>')
    expect(opts.format).toBe('Letter')
    expect(buffer.length).toBeGreaterThan(0)
    expect(html).toBe(passedHtml)
  })

  it('forwards format/landscape options (defaulting happens inside renderPdf)', async () => {
    await markdownToPdf('x', undefined, { format: 'Letter', landscape: true })
    const opts = mockRenderPdf.mock.calls[0]![1]!
    expect(opts.format).toBe('Letter')
    expect(opts.landscape).toBe(true)
  })
})
