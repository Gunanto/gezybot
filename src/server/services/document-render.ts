/**
 * Document rendering — markdown (with LaTeX math) → PDF.
 *
 * Pipeline:
 *   markdown string
 *     → unified (remark-parse + remark-gfm + remark-math) → MDAST
 *     → manual walk → HTML string (standard HTML, not Telegram-specific)
 *     → wrap in a printable HTML template
 *     → Playwright headless Chromium page.pdf() → PDF buffer
 *
 * Why a manual MDAST walker instead of remark-rehype + rehype-stringify?
 * The unified-node packaging emits self-referencing subpath imports
 * (`unist-util-visit-parents/do-not-use-color`) that Bun's global install cache
 * cannot resolve server-side, so the remark-rehype/rehype-katex stack throws at
 * import time. The plain-parse stack (unified + remark-parse + remark-gfm +
 * remark-math) works fine (already used by telegram-rich.ts), and KaTeX's
 * `katex` package imports cleanly on its own — so we parse to MDAST, walk it
 * ourselves, and call `katex.renderToString` directly for math nodes.
 *
 * Math is rendered as **pure MathML** (`output: 'mathml'`). Chromium renders
 * MathML natively in `page.pdf()`, so no KaTeX CSS or web-font files are needed
 * — the whole HTML is self-contained and works fully offline in the container.
 */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import katex from 'katex'
import type {
  Root,
  RootContent,
  Paragraph,
  Heading,
  List,
  ListItem,
  Code,
  Blockquote,
  Table,
  TableRow,
  TableCell,
  Link,
  Image,
  Strong,
  Emphasis,
  Delete,
  InlineCode,
  Text,
  ThematicBreak,
  Html,
  PhrasingContent,
  ListContent,
} from 'mdast'
import { playwrightManager } from '@/server/services/playwright-manager'
import { createLogger } from '@/server/logger'

const log = createLogger('document-render')

// ─── Public API ─────────────────────────────────────────────────────────────

export interface PdfOptions {
  format?: 'A4' | 'Letter'
  landscape?: boolean
  margin?: { top?: string; bottom?: string; left?: string; right?: string }
}

/** Result of {@link markdownToPdf}: the PDF buffer plus the rendered HTML (for
 *  debugging/testing the template without a browser). */
export interface MarkdownToPdfResult {
  buffer: Buffer
  html: string
}

/**
 * Convert a markdown string (with `$...$` / `$$...$$` / ```math``` LaTeX) into
 * a PDF buffer via headless Chromium. Pure server-side; no network needed.
 */
export async function markdownToPdf(
  md: string,
  title: string | undefined,
  opts: PdfOptions = {},
): Promise<MarkdownToPdfResult> {
  const html = buildPdfHtml(md, title)
  const buffer = await playwrightManager.renderPdf(html, opts)
  log.debug({ bytes: buffer.length, format: opts.format ?? 'A4' }, 'PDF rendered')
  return { buffer, html }
}

// ─── HTML template ──────────────────────────────────────────────────────────

const PRINT_CSS = `
  @page { size: A4; margin: 20mm 18mm; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
    font-size: 11pt;
    line-height: 1.55;
    color: #1a1a1a;
    margin: 0;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.6em; font-weight: 600; }
  h1 { font-size: 1.9em; border-bottom: 1px solid #ddd; padding-bottom: 0.2em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #eee; padding-bottom: 0.15em; }
  h3 { font-size: 1.2em; }
  h4, h5, h6 { font-size: 1.05em; }
  p { margin: 0.6em 0; }
  a { color: #2563eb; text-decoration: none; }
  ul, ol { margin: 0.5em 0; padding-left: 1.6em; }
  li { margin: 0.2em 0; }
  blockquote {
    margin: 0.8em 0; padding: 0.3em 1em;
    border-left: 3px solid #cbd5e1; color: #475569; background: #f8fafc;
  }
  code {
    font-family: "SFMono-Regular", "Menlo", "Consolas", monospace;
    font-size: 0.88em; background: #f1f5f9; padding: 0.12em 0.35em; border-radius: 4px;
  }
  pre {
    background: #0f172a; color: #e2e8f0; padding: 1em 1.2em; border-radius: 8px;
    overflow-x: auto; margin: 0.9em 0; font-size: 0.82em; line-height: 1.5;
  }
  pre code { background: transparent; color: inherit; padding: 0; font-size: inherit; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.95em; }
  th, td { border: 1px solid #cbd5e1; padding: 0.45em 0.7em; text-align: left; }
  th { background: #f1f5f9; font-weight: 600; }
  tr:nth-child(even) td { background: #f8fafc; }
  hr { border: none; border-top: 1px solid #ddd; margin: 1.5em 0; }
  img { max-width: 100%; height: auto; }
  /* KaTeX MathML blocks: center block-level equations, keep inline inline. */
  .math-block { display: block; text-align: center; margin: 0.9em 0; }
  /* Force MathML to render visibly even without KaTeX CSS. */
  math { font-size: 1.05em; }
  math[display="block"] { display: block; text-align: center; margin: 0.9em 0; }
`

/** Wrap rendered body HTML in a full printable document. */
export function buildPdfHtml(md: string, title: string | undefined): string {
  const body = markdownToHtml(md)
  const safeTitle = escapeHtml(title ?? '')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
${body}
</body>
</html>`
}

// ─── Markdown → HTML (MDAST walk) ────────────────────────────────────────────

/** Convert markdown to an HTML body fragment (no <html>/<head> wrapper). */
export function markdownToHtml(md: string): string {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(md)
  return tree.children.map(renderBlock).join('')
}

function renderBlock(node: RootContent): string {
  switch (node.type) {
    case 'heading':
      return renderHeading(node as Heading)
    case 'paragraph':
      return `<p>${renderInlineList((node as Paragraph).children)}</p>`
    case 'list':
      return renderList(node as List)
    case 'code':
      return renderCodeBlock(node as Code)
    case 'blockquote':
      return `<blockquote>${renderBlockList((node as Blockquote).children)}</blockquote>`
    case 'table':
      return renderTable(node as Table)
    case 'thematicBreak':
      return '<hr>'
    case 'html':
      // Pass raw HTML through as-is (matches CommonMark behaviour).
      return (node as Html).value
    case 'math':
      return renderMathBlock((node as { type: 'math'; value: string }).value)
    default:
      return ''
  }
}

function renderBlockList(nodes: RootContent[]): string {
  return nodes.map(renderBlock).join('')
}

function renderHeading(node: Heading): string {
  const level = Math.min(Math.max(node.depth, 1), 6)
  const inner = renderInlineList(node.children)
  const id = slugify(stripText(node.children))
  return `<h${level} id="${escapeAttr(id)}">${inner}</h${level}>`
}

function renderList(node: List): string {
  const tag = node.ordered ? 'ol' : 'ul'
  const start = node.ordered && node.start && node.start !== 1 ? ` start="${node.start}"` : ''
  const items = node.children.map(renderListItem).join('')
  return `<${tag}${start}>${items}</${tag}>`
}

function renderListItem(node: ListItem): string {
  // Task list checkboxes (GFM) → a textual [ ] / [x] marker.
  const checked = node.checked
  const marker = checked === true ? '[x] ' : checked === false ? '[ ] ' : ''
  return `<li>${marker}${renderBlockList((node as unknown as { children: RootContent[] }).children)}</li>`
}

function renderCodeBlock(node: Code): string {
  // ```math fenced block -> block equation. remark-gfm leaves it as a `code`
  // node with lang="math" (remark-math only converts $…$), so remap here.
  if (node.lang === 'math') return renderMathBlock(node.value)
  const lang = node.lang ? ` class="language-${escapeAttr(node.lang)}"` : ''
  return `<pre><code${lang}>${escapeHtml(node.value)}</code></pre>`
}

function renderTable(node: Table): string {
  const rows = node.children as TableRow[]
  if (rows.length === 0) return ''
  const head = rows[0]
  if (!head) return ''
  const body = rows.slice(1)
  const thead = `<thead><tr>${(head.children as TableCell[]).map((c) => `<th>${renderInlineList(c.children)}</th>`).join('')}</tr></thead>`
  const tbody = body
    .map((r) => `<tr>${(r.children as TableCell[]).map((c) => `<td>${renderInlineList(c.children)}</td>`).join('')}</tr>`)
    .join('')
  return `<table>${thead}<tbody>${tbody}</tbody></table>`
}

// ─── Math ─────────────────────────────────────────────────────────────────────

/** Block-level equation: render to centered MathML. */
function renderMathBlock(latex: string): string {
  const mathml = renderKatex(latex, true)
  return `<div class="math-block">${mathml}</div>`
}

function renderKatex(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, { displayMode, throwOnError: false, output: 'mathml' })
  } catch (err) {
    // Should not happen with throwOnError:false, but keep a safe fallback.
    log.warn({ err, latex }, 'KaTeX render failed — falling back to escaped text')
    return `<code>${escapeHtml(latex)}</code>`
  }
}

// ─── Inline ────────────────────────────────────────────────────────────────────

function renderInlineList(nodes: PhrasingContent[]): string {
  return nodes.map(renderInline).join('')
}

function renderInline(node: PhrasingContent): string {
  switch (node.type) {
    case 'text':
      return escapeHtml((node as Text).value)
    case 'strong':
      return `<strong>${renderInlineList((node as Strong).children)}</strong>`
    case 'emphasis':
      return `<em>${renderInlineList((node as Emphasis).children)}</em>`
    case 'delete':
      return `<del>${renderInlineList((node as Delete).children)}</del>`
    case 'inlineCode':
      return `<code>${escapeHtml((node as InlineCode).value)}</code>`
    case 'break':
      return '<br>'
    case 'link':
      return renderLink(node as Link)
    case 'image':
      return renderImage(node as Image)
    case 'inlineMath': {
      const expr = (node as { type: 'inlineMath'; value: string }).value
      return renderKatex(expr, false)
    }
    case 'html':
      // Inline raw HTML passthrough.
      return (node as Html).value
    default:
      return ''
  }
}

function renderLink(node: Link): string {
  const href = escapeAttr(node.url)
  const title = node.title ? ` title="${escapeAttr(node.title)}"` : ''
  return `<a href="${href}"${title}>${renderInlineList(node.children)}</a>`
}

function renderImage(node: Image): string {
  const src = escapeAttr(node.url)
  const alt = escapeAttr(node.alt ?? '')
  const title = node.title ? ` title="${escapeAttr(node.title)}"` : ''
  return `<img src="${src}" alt="${alt}"${title}>`
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Concatenate all text descendants of a phrasing list (for alt text / slug). */
function stripText(nodes: PhrasingContent[]): string {
  let out = ''
  for (const n of nodes) {
    if (n.type === 'text') out += (n as Text).value
    else if ('children' in n && Array.isArray((n as { children?: unknown }).children)) {
      out += stripText((n as unknown as { children: PhrasingContent[] }).children)
    } else if (n.type === 'inlineCode') out += (n as InlineCode).value
    else if (n.type === 'inlineMath') out += (n as { value: string }).value
  }
  return out
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
