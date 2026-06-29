/**
 * Markdown → Telegram Rich Message HTML converter.
 *
 * Telegram Bot API 10.1 (June 2026) introduced `sendRichMessage` which accepts
 * an `InputRichMessage` with an `html` (or `markdown`) string — the Telegram
 * server parses it into `RichBlock[]` natively. This module converts the
 * CommonMark + GFM markdown that Gezy's LLMs produce into the **subset of HTML
 * tags** that Telegram's rich-message parser accepts, so headings, tables,
 * lists, blockquotes, code blocks, and inline formatting render natively in
 * Telegram instead of being sent as flat plain text.
 *
 * Pipeline: `remark-parse` (already a Gezy dependency) → MDAST tree → manual
 * traversal → HTML string. We traverse manually (rather than going through
 * `remark-rehype` + `rehype-stringify`) so we can:
 *  - emit only tags Telegram understands (allowlist, not blocklist);
 *  - map GFM task-list checkboxes to `<tg-task>` (or skip them);
 *  - collapse unsupported nodes to their text content;
 *  - escape HTML special chars everywhere except inside explicitly-emitted
 *    tags/attributes.
 *
 * Supported Telegram rich HTML tags (allowlist):
 *   <h1>..<h6> <p> <hr> <ul> <ol> <li> <blockquote> <blockquote expandable>
 *   <pre><code class="language-…"> <b> <i> <u> <s> <spoiler> <sub> <sup>
 *   <mark> <code> <a href="…"> <table> <tr> <th align valign colspan rowspan>
 *   <td align valign colspan rowspan> <caption> <tg-thinking> (draft only)
 *
 * Not supported (stripped to text): <img>, raw HTML in markdown, math blocks
 * (rendered as text — KaTeX/LaTeX blocks are out of scope for Fase 1),
 * footnotes, definition lists, HTML comments.
 */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type {
  Root,
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
  Strong,
  Emphasis,
  Delete,
  InlineCode,
  Text,
  ThematicBreak,
  Html,
  RootContent,
  PhrasingContent,
  ListContent,
  Parent,
} from 'mdast'

// ─── Public API ─────────────────────────────────────────────────────────────

/** Options for {@link markdownToTelegramHtml}. */
export interface TelegramRichOptions {
  /** When true, `<blockquote expandable>` is emitted for blockquotes instead of
   *  plain `<blockquote>`. Useful for long outputs so they collapse by
   *  default. Default: `false`. */
  expandableBlockquotes?: boolean
  /** Maximum number of top-level blocks before we start splitting into
   *  separate `sendRichMessage` calls. Telegram has a payload cap; splitting
   *  at block boundaries keeps each request under the limit. Default: `40`
   *  blocks per page (empirically safe for ~4096-char-equivalent content). */
  maxBlocksPerPage?: number
}

/** Result of a conversion: an array of HTML strings, one per "page" that
 *  should be sent as a separate `sendRichMessage` call. Each string is a
 *  self-contained sequence of top-level block tags ready for
 *  `InputRichMessage.html`. */
export interface TelegramRichResult {
  pages: string[]
  /** True when the input contained at least one block-level markdown element
   *  (heading / list / table / code fence / blockquote / thematic break).
   *  Callers use this to decide between `sendRichMessage` (rich) and the
   *  legacy `sendMessage` (plain text) — when `hasBlocks` is false, the rich
   *  path offers no visual benefit and the legacy path is lighter. */
  hasBlocks: boolean
}

/**
 * Convert a markdown string into one or more Telegram rich-message HTML
 * pages. Splits at top-level block boundaries when the block count exceeds
 * `maxBlocksPerPage`. Pure function (no I/O) — safe to unit-test and call
 * from the adapter directly.
 */
export function markdownToTelegramHtml(
  md: string,
  opts: TelegramRichOptions = {},
): TelegramRichResult {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(md)
  const expandable = opts.expandableBlockquotes ?? false
  const maxPerPage = opts.maxBlocksPerPage ?? 40

  const blocks = tree.children
  const hasBlocks = blocks.some(isBlockLevel) || blocks.some(hasInlineMath)

  const htmlPages: string[] = []
  for (let i = 0; i < blocks.length; i += maxPerPage) {
    const slice = blocks.slice(i, i + maxPerPage)!
    const html = slice.map((b) => renderBlock(b, expandable)).join('')
    if (html) htmlPages.push(html)
  }
  // If the input produced no block HTML (e.g. only whitespace), emit a single
  // empty page so callers can still send something.
  if (htmlPages.length === 0) htmlPages.push('')
  return { pages: htmlPages, hasBlocks }
}

/** Quick predicate: does this markdown contain any block-level element that
 *  would benefit from rich rendering? Exported so the adapter can decide
 *  rich-vs-plain without running the full converter. */
export function markdownHasRichBlocks(md: string): boolean {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(md)
  return tree.children.some(isBlockLevel) || tree.children.some(hasInlineMath)
}

/** Does this top-level block contain an `inlineMath` node anywhere in its
 *  phrasing content? Inline math (`$…$`) requires the rich path because
 *  `<tg-math>` is only supported in `sendRichMessage`, not legacy
 *  `sendMessage`. */
function hasInlineMath(node: RootContent): boolean {
  if (node.type === 'paragraph') {
    return (node as Paragraph).children.some((c) => c.type === 'inlineMath')
  }
  // Block math already caught by isBlockLevel; other block types (list,
  // blockquote, table) may contain inline math in their cells/items — be
  // conservative and treat them as rich-triggering via isBlockLevel already.
  return false
}

// ─── Block-level rendering ──────────────────────────────────────────────────

function isBlockLevel(node: RootContent): boolean {
  return (
    node.type === 'heading' ||
    node.type === 'list' ||
    node.type === 'table' ||
    node.type === 'code' ||
    node.type === 'blockquote' ||
    node.type === 'thematicBreak' ||
    node.type === 'html' ||
    node.type === 'math' // remark-math block-level ($$…$$ or ```math)
  )
}

function renderBlock(node: RootContent, expandable: boolean): string {
  switch (node.type) {
    case 'heading':
      return renderHeading(node as Heading)
    case 'paragraph':
      return `<p>${renderInlineList((node as Paragraph).children)}</p>`
    case 'list':
      return renderList(node as List)
    case 'table':
      return renderTable(node as Table)
    case 'code':
      return renderCodeBlock(node as Code)
    case 'math':
      // remark-math block-level ($$…$$ or ```math fence). Telegram rich HTML
      // tag: <tg-math-block>. The content is RAW LaTeX — do NOT escape (docs:
      // "Formula source is treated as raw LaTeX"). Guard against the literal
      // closing tag as a paranoia check (almost never in LLM output).
      return renderMathBlock((node as { type: 'math'; value: string }).value)
    case 'blockquote':
      return renderBlockquote(node as Blockquote, expandable)
    case 'thematicBreak':
      return '<hr/>'
    case 'html':
      // Raw HTML in markdown: pass through ONLY if it's a tag Telegram
      // understands; otherwise collapse to its text content. For safety we
      // collapse ALL raw HTML to its (escaped) text — the LLM rarely emits
      // raw HTML, and passing through arbitrary tags risks 400 errors.
      return renderHtmlAsText(node as Html)
    default:
      // Unknown block (footnoteDefinition, etc.) — collapse to text.
      return `<p>${escapeHtml(textOf(node))}</p>`
  }
}

function renderHeading(node: Heading): string {
  const depth = Math.min(Math.max(node.depth, 1), 6)
  const inner = renderInlineList(node.children)
  return `<h${depth}>${inner}</h${depth}>`
}

function renderList(node: List): string {
  const tag = node.ordered ? 'ol' : 'ul'
  const startAttr = node.ordered && node.start != null && node.start !== 1
    ? ` start="${node.start}"`
    : ''
  const items = (node.children as ListContent[]).map((item) => renderListItem(item as ListItem)).join('')
  return `<${tag}${startAttr}>${items}</${tag}>`
}

function renderListItem(node: ListItem): string {
  // GFM task list: listItem.checked is true/false/undefined
  const checked = node.checked
  const checkboxAttr = checked === true ? ' checked=""' : checked === false ? ' unchecked=""' : ''
  // A listItem's children are typically a single paragraph, but can include
  // nested lists, blockquotes, etc. Flatten: render paragraph children inline
  // within the <li>, and nested blocks after.
  const parts: string[] = []
  for (const child of node.children) {
    if (child.type === 'paragraph') {
      parts.push(renderInlineList((child as Paragraph).children))
    } else {
      // Nested list / blockquote / etc. — render as a block inside the <li>.
      parts.push(renderBlock(child, false))
    }
  }
  return `<li${checkboxAttr}>${parts.join('')}</li>`
}

function renderCodeBlock(node: Code): string {
  // ```math fenced block → Telegram rich <tg-math-block>. remark-math only
  // converts $$…$$ to a `math` MDAST node; a ```math fence stays a `code`
  // node with lang="math", so we remap it here.
  if (node.lang === 'math') {
    return renderMathBlock(node.value)
  }
  const lang = node.lang ? ` class="language-${escapeAttr(node.lang)}"` : ''
  // Code content is raw text — escape it but do NOT treat it as inline HTML.
  return `<pre><code${lang}>${escapeHtml(node.value)}</code></pre>`
}

/** Render a block-level LaTeX math node. The content is raw LaTeX — Telegram
 *  treats the inside of `<tg-math-block>` as raw LaTeX (not HTML), so we do
 *  NOT escape `<`, `>`, `&`. We only guard against the literal closing tag
 *  `</tg-math-block>` appearing inside the expression (almost never in real
 *  LaTeX output); in that pathological case we fall back to escaped text so
 *  the Telegram parser doesn't break. */
function renderMathBlock(value: string): string {
  if (value.includes('</tg-math')) {
    return `<p>${escapeHtml(value)}</p>`
  }
  return `<tg-math-block>${value}</tg-math-block>`
}

function renderBlockquote(node: Blockquote, expandable: boolean): string {
  const inner = node.children.map((b) => renderBlock(b, expandable)).join('')
  const attr = expandable ? ' expandable=""' : ''
  return `<blockquote${attr}>${inner}</blockquote>`
}

function renderTable(node: Table): string {
  const rows = node.children as TableRow[]
  // Column alignment lives on the Table node as a per-column array
  // (`node.align`), NOT on individual cells (which have `align: undefined`).
  // Fall back to 'left' when missing.
  const colAligns = (node.align ?? []).map((a) => (a ?? 'left') as 'left' | 'center' | 'right')
  const rowsHtml = rows.map((row, rowIdx) => {
    const cells = row.children as TableCell[]
    const cellTag = rowIdx === 0 ? 'th' : 'td'
    const cellsHtml = cells.map((cell, colIdx) => {
      const align = colAligns[colIdx] ?? 'left'
      const valign = 'middle'
      const alignAttr = ` align="${align}" valign="${valign}"`
      const headerAttr = rowIdx === 0 ? ' is_header=""' : ''
      const inner = renderInlineList(cell.children)
      return `<${cellTag}${alignAttr}${headerAttr}>${inner}</${cellTag}>`
    }).join('')
    return `<tr>${cellsHtml}</tr>`
  }).join('')
  return `<table>${rowsHtml}</table>`
}

function renderHtmlAsText(node: Html): string {
  // Collapse raw HTML to escaped text so it shows literally without risking
  // Telegram parser errors. The LLM rarely emits raw HTML in markdown.
  return `<p>${escapeHtml(node.value)}</p>`
}

// ─── Inline rendering ───────────────────────────────────────────────────────

function renderInlineList(nodes: PhrasingContent[]): string {
  return nodes.map(renderInline).join('')
}

function renderInline(node: PhrasingContent): string {
  switch (node.type) {
    case 'text':
      return escapeHtml((node as Text).value)
    case 'strong':
      return `<b>${renderInlineList((node as Strong).children)}</b>`
    case 'emphasis':
      return `<i>${renderInlineList((node as Emphasis).children)}</i>`
    case 'delete':
      return `<s>${renderInlineList((node as Delete).children)}</s>`
    case 'inlineCode':
      return `<code>${escapeHtml((node as InlineCode).value)}</code>`
    case 'inlineMath': {
      // remark-math inline ($…$). Telegram rich HTML tag: <tg-math>. The
      // content is raw LaTeX — do NOT escape. Guard against literal closing
      // tag (paranoia; almost never in real LaTeX).
      const expr = (node as { type: 'inlineMath'; value: string }).value
      if (expr.includes('</tg-math')) {
        return escapeHtml(expr)
      }
      return `<tg-math>${expr}</tg-math>`
    }
    case 'link': {
      const link = node as Link
      const href = link.url
      const inner = renderInlineList(link.children)
      // Telegram only accepts http(s) and tg:// links in rich messages.
      if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('tg://')) {
        return `<a href="${escapeAttr(href)}">${inner}</a>`
      }
      // Unsupported scheme: render as text (no link).
      return inner
    }
    case 'image':
      // Inline images aren't supported in Telegram rich HTML text — collapse
      // to alt text + URL. Media blocks (photo/video) are top-level only and
      // handled separately in Fase 1b.
      return renderImageAsText(node)
    case 'break':
      return '<br/>'
    case 'html':
      // Inline raw HTML — collapse to escaped text.
      return escapeHtml((node as Html).value)
    case 'linkReference':
    case 'imageReference':
      // Reference nodes: remark-parse leaves them unresolved without
      // remark-reference-links; collapse to text.
      return escapeHtml(textOf(node))
    default:
      // Unknown phrasing node — collapse to text.
      return escapeHtml(textOf(node))
  }
}

function renderImageAsText(node: { alt?: string | null; url: string }): string {
  const alt = node.alt ?? ''
  const url = node.url
  if (!alt && !url) return ''
  if (!alt) return escapeHtml(url)
  return `${escapeHtml(alt)} (${escapeHtml(url)})`
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** HTML-escape a string for use in element text content. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** HTML-escape a string for use inside a double-quoted attribute value. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Best-effort extraction of plain text from any MDAST node (for fallback
 *  rendering of unsupported nodes). Walks children if present. */
function textOf(node: RootContent | PhrasingContent): string {
  if (node.type === 'text') return (node as Text).value
  if (node.type === 'inlineCode') return (node as InlineCode).value
  if (node.type === 'code') return (node as Code).value
  if (node.type === 'html') return (node as Html).value
  if (node.type === 'image') return (node as { alt?: string }).alt ?? ''
  if (node.type === 'link') return (node as Link).url
  // Parent nodes: recurse into children.
  const parent = node as unknown as { children?: Array<{ type: string }> }
  if (parent.children && Array.isArray(parent.children)) {
    return (parent.children as Array<RootContent | PhrasingContent>).map(textOf).join('')
  }
  return ''
}
