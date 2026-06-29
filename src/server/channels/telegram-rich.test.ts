import { describe, it, expect } from 'bun:test'
import {
  markdownToTelegramHtml,
  markdownHasRichBlocks,
} from '@/server/channels/telegram-rich'

// ─── markdownToTelegramHtml — block-level ───────────────────────────────────

describe('markdownToTelegramHtml — headings', () => {
  it('renders h1–h6', () => {
    const r = markdownToTelegramHtml('# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6')
    expect(r.hasBlocks).toBe(true)
    expect(r.pages[0]).toContain('<h1>H1</h1>')
    expect(r.pages[0]).toContain('<h2>H2</h2>')
    expect(r.pages[0]).toContain('<h3>H3</h3>')
    expect(r.pages[0]).toContain('<h4>H4</h4>')
    expect(r.pages[0]).toContain('<h5>H5</h5>')
    expect(r.pages[0]).toContain('<h6>H6</h6>')
  })

  it('treats 7+ # as a paragraph (CommonMark max depth is 6)', () => {
    // `####### Deep` is NOT a valid heading in CommonMark (max 6 #) — remark
    // parses it as a paragraph literal. This is correct markdown behaviour;
    // we just confirm we don't crash or mis-render.
    const r = markdownToTelegramHtml('####### Deep')
    expect(r.pages[0]).toContain('Deep')
    expect(r.hasBlocks).toBe(false)
  })
})

describe('markdownToTelegramHtml — paragraphs', () => {
  it('wraps a plain paragraph in <p>', () => {
    const r = markdownToTelegramHtml('Hello world')
    expect(r.hasBlocks).toBe(false)
    expect(r.pages[0]).toBe('<p>Hello world</p>')
  })

  it('escapes HTML special chars in text', () => {
    const r = markdownToTelegramHtml('Use <b> & > safely')
    expect(r.pages[0]).toContain('&lt;b&gt;')
    expect(r.pages[0]).toContain('&amp;')
    expect(r.pages[0]).toContain('&gt;')
  })
})

describe('markdownToTelegramHtml — lists', () => {
  it('renders unordered list', () => {
    const r = markdownToTelegramHtml('- one\n- two\n- three')
    expect(r.hasBlocks).toBe(true)
    expect(r.pages[0]).toContain('<ul>')
    expect(r.pages[0]).toContain('<li>one</li>')
    expect(r.pages[0]).toContain('<li>two</li>')
    expect(r.pages[0]).toContain('<li>three</li>')
    expect(r.pages[0]).toContain('</ul>')
  })

  it('renders ordered list with start=1 (no start attr)', () => {
    const r = markdownToTelegramHtml('1. first\n2. second')
    expect(r.pages[0]).toContain('<ol>')
    expect(r.pages[0]).not.toContain('start=')
    expect(r.pages[0]).toContain('<li>first</li>')
  })

  it('renders ordered list with start=5', () => {
    const r = markdownToTelegramHtml('5. fifth\n6. sixth')
    expect(r.pages[0]).toContain('<ol start="5">')
  })

  it('renders GFM task list with checked/unchecked attrs', () => {
    const r = markdownToTelegramHtml('- [x] done\n- [ ] todo')
    expect(r.pages[0]).toContain('<li checked="">done</li>')
    expect(r.pages[0]).toContain('<li unchecked="">todo</li>')
  })

  it('renders nested list inside list item', () => {
    const r = markdownToTelegramHtml('- top\n  - nested')
    expect(r.pages[0]).toContain('<ul><li>top<ul><li>nested</li></ul></li></ul>')
  })
})

describe('markdownToTelegramHtml — code blocks', () => {
  it('renders fenced code with language class', () => {
    const r = markdownToTelegramHtml('```ts\nconst x = 1\n```')
    expect(r.hasBlocks).toBe(true)
    expect(r.pages[0]).toContain('<pre><code class="language-ts">const x = 1</code></pre>')
  })

  it('renders fenced code without language', () => {
    const r = markdownToTelegramHtml('```\nplain\n```')
    expect(r.pages[0]).toContain('<pre><code>plain</code></pre>')
    expect(r.pages[0]).not.toContain('class=')
  })

  it('escapes HTML inside code blocks', () => {
    const r = markdownToTelegramHtml('```html\n<div>text</div>\n```')
    expect(r.pages[0]).toContain('&lt;div&gt;')
  })
})

describe('markdownToTelegramHtml — blockquotes', () => {
  it('renders blockquote (non-expandable by default)', () => {
    const r = markdownToTelegramHtml('> wisdom here')
    expect(r.hasBlocks).toBe(true)
    expect(r.pages[0]).toContain('<blockquote>')
    expect(r.pages[0]).not.toContain('expandable')
    expect(r.pages[0]).toContain('<p>wisdom here</p>')
  })

  it('renders expandable blockquote when option set', () => {
    const r = markdownToTelegramHtml('> long quote', { expandableBlockquotes: true })
    expect(r.pages[0]).toContain('<blockquote expandable="">')
  })
})

describe('markdownToTelegramHtml — thematic break', () => {
  it('renders <hr/> for ---', () => {
    const r = markdownToTelegramHtml('before\n\n---\n\nafter')
    expect(r.pages[0]).toContain('<hr/>')
  })
})

describe('markdownToTelegramHtml — tables (GFM)', () => {
  it('renders a GFM table with header row as <th>', () => {
    const md = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |'
    const r = markdownToTelegramHtml(md)
    expect(r.hasBlocks).toBe(true)
    expect(r.pages[0]).toContain('<table>')
    expect(r.pages[0]).toContain('<tr><th align="left" valign="middle" is_header="">Name</th><th align="left" valign="middle" is_header="">Age</th></tr>')
    expect(r.pages[0]).toContain('<td align="left" valign="middle">Alice</td>')
    expect(r.pages[0]).toContain('<td align="left" valign="middle">30</td>')
  })

  it('respects column alignment', () => {
    const md = '| L | C | R |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |'
    const r = markdownToTelegramHtml(md)
    expect(r.pages[0]).toContain('align="left"')
    expect(r.pages[0]).toContain('align="center"')
    expect(r.pages[0]).toContain('align="right"')
  })
})

// ─── Inline rendering ───────────────────────────────────────────────────────

describe('markdownToTelegramHtml — inline formatting', () => {
  it('renders bold, italic, strikethrough, inline code', () => {
    const r = markdownToTelegramHtml('**bold** *italic* ~~strike~~ `code`')
    expect(r.pages[0]).toContain('<b>bold</b>')
    expect(r.pages[0]).toContain('<i>italic</i>')
    expect(r.pages[0]).toContain('<s>strike</s>')
    expect(r.pages[0]).toContain('<code>code</code>')
  })

  it('renders http/https/tg links as <a href>', () => {
    const r = markdownToTelegramHtml('[Gezy](https://gezy.ai) and [bot](tg://user?id=1)')
    expect(r.pages[0]).toContain('<a href="https://gezy.ai">Gezy</a>')
    expect(r.pages[0]).toContain('<a href="tg://user?id=1">bot</a>')
  })

  it('collapses unsupported link schemes to text', () => {
    const r = markdownToTelegramHtml('[file](file:///etc/passwd)')
    expect(r.pages[0]).toContain('file')
    expect(r.pages[0]).not.toContain('<a href="file')
  })

  it('renders hard line break as <br/>', () => {
    const r = markdownToTelegramHtml('line one  \nline two')
    expect(r.pages[0]).toContain('<br/>')
  })

  it('renders image as alt-text + URL (no <img>)', () => {
    const r = markdownToTelegramHtml('![alt text](https://x.com/a.png)')
    expect(r.pages[0]).not.toContain('<img')
    expect(r.pages[0]).toContain('alt text')
    expect(r.pages[0]).toContain('https://x.com/a.png')
  })

  it('escapes raw inline HTML', () => {
    const r = markdownToTelegramHtml('text with <script>x</script> inside')
    expect(r.pages[0]).toContain('&lt;script&gt;')
    expect(r.pages[0]).not.toContain('<script>')
  })
})

// ─── Edge cases & splitting ─────────────────────────────────────────────────

describe('markdownToTelegramHtml — edge cases', () => {
  it('handles empty input', () => {
    const r = markdownToTelegramHtml('')
    expect(r.pages).toEqual([''])
    expect(r.hasBlocks).toBe(false)
  })

  it('handles whitespace-only input', () => {
    const r = markdownToTelegramHtml('   \n\n  \n')
    expect(r.pages.length).toBeGreaterThanOrEqual(1)
  })

  it('hasBlocks is false for pure paragraph text', () => {
    expect(markdownHasRichBlocks('just a paragraph')).toBe(false)
  })

  it('hasBlocks is true for heading', () => {
    expect(markdownHasRichBlocks('# Title')).toBe(true)
  })

  it('hasBlocks is true for table', () => {
    expect(markdownHasRichBlocks('| a | b |\n| - | - |\n| 1 | 2 |')).toBe(true)
  })

  it('hasBlocks is true for code fence', () => {
    expect(markdownHasRichBlocks('```\ncode\n```')).toBe(true)
  })

  it('hasBlocks is true for blockquote', () => {
    expect(markdownHasRichBlocks('> quote')).toBe(true)
  })

  it('hasBlocks is true for list', () => {
    expect(markdownHasRichBlocks('- item')).toBe(true)
  })
})

describe('markdownToTelegramHtml — pagination', () => {
  it('splits blocks across pages when exceeding maxBlocksPerPage', () => {
    const blocks = Array.from({ length: 50 }, (_, i) => `<p>para ${i}</p>`).join('\n\n')
    const md = blocks.replace(/<p>|<\/p>/g, '')
    const r = markdownToTelegramHtml(md, { maxBlocksPerPage: 10 })
    expect(r.pages.length).toBe(5)
    expect(r.pages[0]).toContain('para 0')
    expect(r.pages[0]).not.toContain('para 10')
    expect(r.pages[1]).toContain('para 10')
  })

  it('single page when under limit', () => {
    const r = markdownToTelegramHtml('one\n\ntwo\n\nthree', { maxBlocksPerPage: 40 })
    expect(r.pages.length).toBe(1)
  })
})

// ─── Nested structures ──────────────────────────────────────────────────────

describe('markdownToTelegramHtml — nested structures', () => {
  it('renders bold inside link inside list', () => {
    const r = markdownToTelegramHtml('- [**bold link**](https://x.com)')
    expect(r.pages[0]).toContain('<li><a href="https://x.com"><b>bold link</b></a></li>')
  })

  it('renders code inside bold', () => {
    const r = markdownToTelegramHtml('**bold `code` here**')
    expect(r.pages[0]).toContain('<b>bold <code>code</code> here</b>')
  })

  it('renders blockquote with nested list', () => {
    const r = markdownToTelegramHtml('> - nested item')
    expect(r.pages[0]).toContain('<blockquote>')
    expect(r.pages[0]).toContain('<ul>')
    expect(r.pages[0]).toContain('<li>nested item</li>')
  })
})

// ─── Math / LaTeX (Fase 1c) ─────────────────────────────────────────────────

describe('markdownToTelegramHtml — inline math', () => {
  it('renders $…$ as <tg-math> (raw LaTeX, no escape)', () => {
    const r = markdownToTelegramHtml('The formula $x^2 + y^2$ is nice')
    expect(r.hasBlocks).toBe(true) // inline math triggers rich path
    expect(r.pages[0]).toContain('<tg-math>x^2 + y^2</tg-math>')
    // The LaTeX content must NOT be HTML-escaped (Telegram treats it as raw)
    expect(r.pages[0]).not.toContain('&gt;')
    expect(r.pages[0]).not.toContain('&lt;')
  })

  it('does not escape <, >, & inside inline math', () => {
    const r = markdownToTelegramHtml('$x < y \\& z > 0$')
    expect(r.pages[0]).toContain('<tg-math>x < y \\& z > 0</tg-math>')
  })

  it('renders LaTeX with \\frac, \\sum, sub/sup', () => {
    const r = markdownToTelegramHtml('$\\frac{a}{b}$ and $\\sum_{i=1}^{n} x_i$')
    expect(r.pages[0]).toContain('<tg-math>\\frac{a}{b}</tg-math>')
    expect(r.pages[0]).toContain('<tg-math>\\sum_{i=1}^{n} x_i</tg-math>')
  })

  it('renders inline math inside a paragraph with surrounding text', () => {
    const r = markdownToTelegramHtml('For $n \\geq 1$, let $a_n = n^2$.')
    expect(r.pages[0]).toContain('<tg-math>n \\geq 1</tg-math>')
    expect(r.pages[0]).toContain('<tg-math>a_n = n^2</tg-math>')
    expect(r.pages[0]).toContain('For ')
    expect(r.pages[0]).toContain(', let ')
  })

  it('guards against literal </tg-math> in expression (falls back to escaped text)', () => {
    const r = markdownToTelegramHtml('$x </tg-math evil$')
    expect(r.pages[0]).not.toContain('<tg-math>x </tg-math')
    expect(r.pages[0]).toContain('&lt;/tg-math')
  })
})

describe('markdownToTelegramHtml — block math', () => {
  it('renders $$…$$ as <tg-math-block> (raw LaTeX)', () => {
    const r = markdownToTelegramHtml('$$\nE = mc^2\n$$')
    expect(r.hasBlocks).toBe(true)
    expect(r.pages[0]).toContain('<tg-math-block>')
    expect(r.pages[0]).toContain('E = mc^2')
    expect(r.pages[0]).not.toContain('&gt;')
  })

  it('renders ```math fenced block as <tg-math-block>', () => {
    const r = markdownToTelegramHtml('```math\n\\int_0^1 x^2 dx = \\frac{1}{3}\n```')
    expect(r.hasBlocks).toBe(true)
    expect(r.pages[0]).toContain('<tg-math-block>')
    expect(r.pages[0]).toContain('\\int_0^1 x^2 dx')
  })

  it('does not escape <, > inside block math', () => {
    const r = markdownToTelegramHtml('$$\na < b > c\n$$')
    expect(r.pages[0]).toContain('<tg-math-block>a < b > c</tg-math-block>')
  })

  it('guards against literal </tg-math-block> in expression', () => {
    const r = markdownToTelegramHtml('$$\nx </tg-math-block evil\n$$')
    expect(r.pages[0]).not.toContain('<tg-math-block>x </tg-math-block')
    expect(r.pages[0]).toContain('&lt;/tg-math-block')
  })
})

describe('markdownToTelegramHtml — math + other blocks combined', () => {
  it('renders heading + block math + paragraph', () => {
    const md = '# Trigonometri\n\n$$\n\\sin^2\\theta + \\cos^2\\theta = 1\n$$\n\nRumus dasar.'
    const r = markdownToTelegramHtml(md)
    expect(r.hasBlocks).toBe(true)
    expect(r.pages[0]).toContain('<h1>Trigonometri</h1>')
    expect(r.pages[0]).toContain('<tg-math-block>')
    expect(r.pages[0]).toContain('\\sin^2\\theta')
    expect(r.pages[0]).toContain('<p>Rumus dasar.</p>')
  })

  it('renders inline math inside list item', () => {
    const r = markdownToTelegramHtml('- Item with $x^2$ math')
    expect(r.pages[0]).toContain('<li>Item with <tg-math>x^2</tg-math> math</li>')
  })

  it('renders inline math inside table cell', () => {
    const md = '| Rumus | Hasil |\n| --- | --- |\n| $a^2$ | $b^2$ |'
    const r = markdownToTelegramHtml(md)
    expect(r.pages[0]).toContain('<tg-math>a^2</tg-math>')
    expect(r.pages[0]).toContain('<tg-math>b^2</tg-math>')
  })
})

describe('markdownHasRichBlocks — math detection', () => {
  it('returns true for inline math only', () => {
    expect(markdownHasRichBlocks('just $x^2$ inline math')).toBe(true)
  })

  it('returns true for block math only', () => {
    expect(markdownHasRichBlocks('$$\nE=mc^2\n$$')).toBe(true)
  })

  it('returns true for ```math fence', () => {
    expect(markdownHasRichBlocks('```math\nx\n```')).toBe(true)
  })

  it('returns false for plain paragraph without math', () => {
    expect(markdownHasRichBlocks('just a plain paragraph')).toBe(false)
  })
})
