/**
 * Document rendering — markdown (with LaTeX math) → DOCX.
 *
 * Word has no native MathML rendering, so LaTeX equations are rasterized to PNG
 * (via the same headless Chromium used by generate_pdf — KaTeX MathML per
 * equation, screenshot per element, fully offline) and embedded as images in
 * the .docx. The rest of the markdown (headings, lists, tables, code, block-
 * quotes, inline formatting) is mapped to native Word structures with the
 * `docx` package so the document is editable in Word/Google Docs.
 *
 * Pipeline:
 *   markdown → unified (remark-parse + remark-gfm + remark-math) MDAST
 *   → collect math nodes, assign ids eq-0, eq-1, … (inline + block)
 *   → build one HTML page: each equation in <div id="eq-N"> with KaTeX MATHML
 *   → playwrightManager.screenshotHtmlElements(html, ids) → Map<id, PNG>
 *   → walk MDAST again → docx elements (Paragraph/TextRun/ImageRun/Table/…)
 *     inserting the equation PNGs as ImageRun at math nodes
 *   → Packer.toBuffer(doc) → .docx buffer
 */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import katex from 'katex'
import type {
  Root,
  RootContent,
  Heading,
  List,
  ListItem,
  Code,
  Blockquote,
  Link,
  Strong,
  Emphasis,
  Delete,
  InlineCode,
  Text,
  Html,
  PhrasingContent,
} from 'mdast'
import {
  Document,
  Paragraph as DocxParagraph,
  TextRun,
  ImageRun,
  Table as DocxTable,
  TableRow as DocxTableRow,
  TableCell as DocxTableCell,
  WidthType,
  AlignmentType,
  HeadingLevel,
  ExternalHyperlink,
  Packer,
  ShadingType,
} from 'docx'
import { playwrightManager } from '@/server/services/playwright-manager'
import { createLogger } from '@/server/logger'

const log = createLogger('document-render-docx')

// ─── Public API ─────────────────────────────────────────────────────────────

export async function markdownToDocxBuffer(md: string, title: string | undefined): Promise<Buffer> {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(md)

  // Collect math nodes in document order, assigning stable ids.
  const mathNodes: Array<{ id: string; latex: string; display: boolean }> = []
  let eqCounter = 0
  collectMath(tree, mathNodes, () => `eq-${eqCounter++}`)

  // Rasterize all equations in one Chromium session.
  const images = new Map<string, Buffer>()
  if (mathNodes.length > 0) {
    const html = buildEquationsHtml(mathNodes)
    const ids = mathNodes.map((m) => m.id)
    const buffers = await playwrightManager.screenshotHtmlElements(html, ids)
    for (const [id, buf] of buffers) images.set(id, buf)
  }

  const cursor = newMathCursor(mathNodes)
  const children: (DocxParagraph | DocxTable)[] = []
  for (const block of tree.children) {
    const el = renderBlock(block, images, cursor)
    if (el) children.push(el)
  }

  const doc = new Document({
    creator: 'Gezy',
    title: title ?? 'Document',
    sections: [{ properties: {}, children }],
  })

  const buffer = await Packer.toBuffer(doc)
  log.debug({ bytes: buffer.length, equations: mathNodes.length }, 'DOCX rendered')
  return buffer
}

// ─── Math collection + rasterization HTML ───────────────────────────────────

function collectMath(node: Root, out: Array<{ id: string; latex: string; display: boolean }>, nextId: () => string): void {
  for (const child of node.children) walkNode(child, out, nextId)
}

function walkNode(node: RootContent, out: Array<{ id: string; latex: string; display: boolean }>, nextId: () => string): void {
  if (node.type === 'math') {
    out.push({ id: nextId(), latex: (node as { value: string }).value, display: true })
    return
  }
  if (node.type === 'inlineMath') {
    out.push({ id: nextId(), latex: (node as { value: string }).value, display: false })
    return
  }
  if (node.type === 'code' && (node as Code).lang === 'math') {
    out.push({ id: nextId(), latex: (node as Code).value, display: true })
    return
  }
  const children = (node as { children?: unknown }).children
  if (Array.isArray(children)) {
    for (const c of children as RootContent[]) walkNode(c, out, nextId)
  }
}

function renderKatexMathml(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, { displayMode, throwOnError: false, output: 'mathml' })
  } catch (err) {
    log.warn({ err, latex }, 'KaTeX render failed in docx pipeline')
    return `<span>${escapeHtml(latex)}</span>`
  }
}

/** Build a single self-contained HTML page with one element per equation id.
 *  inline-block sizing makes each screenshot clip to its rendered math. */
function buildEquationsHtml(eqs: Array<{ id: string; latex: string; display: boolean }>): string {
  const items = eqs
    .map(
      (e) =>
        `<div id="${e.id}" style="display:inline-block;padding:2px 4px;line-height:1">${renderKatexMathml(e.latex, e.display)}</div>`,
    )
    .join('\n')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; font-size: 16pt; margin: 0; }
    math { font-size: 1.05em; }
  </style></head><body>${items}</body></html>`
}

// ─── MDAST → docx elements ──────────────────────────────────────────────────

interface FormatCtx {
  bold?: boolean
  italics?: boolean
  strike?: boolean
}

/** Cursor over collected math ids, advanced in document order as math nodes
 *  are encountered during the second walk (same order as collectMath). */
function newMathCursor(mathNodes: Array<{ id: string; latex: string; display: boolean }>) {
  let i = 0
  return {
    next(): { id: string; display: boolean } | undefined {
      const m = mathNodes[i++]
      return m ? { id: m.id, display: m.display } : undefined
    },
  }
}
type Cursor = ReturnType<typeof newMathCursor>

function renderBlock(node: RootContent, images: Map<string, Buffer>, cursor: Cursor): DocxParagraph | DocxTable | undefined {
  switch (node.type) {
    case 'heading':
      return renderHeading(node as Heading)
    case 'paragraph':
      return new DocxParagraph({ children: renderInlineList((node as { children: PhrasingContent[] }).children, images, cursor, {}) })
    case 'list':
      return renderList(node as List, images, cursor)
    case 'blockquote':
      return new DocxParagraph({
        children: renderBlockquoteRuns((node as Blockquote).children, images, cursor),
        indent: { left: 720 },
      })
    case 'code':
      // ```math fenced block -> block equation (mirror collectMath's remap).
      if ((node as Code).lang === 'math') {
        const m = cursor.next()
        return m ? renderMathParagraph(m.id, images, m.display) : undefined
      }
      return renderCodeBlock(node as Code)
    case 'table':
      return renderTable(node as { children: unknown[] }, images, cursor)
    case 'thematicBreak':
      return new DocxParagraph({ children: [new TextRun({ text: '────────────────────────' })], alignment: AlignmentType.CENTER })
    case 'html':
      return new DocxParagraph({ children: [new TextRun({ text: stripTags((node as Html).value) })] })
    case 'math': {
      const m = cursor.next()
      return m ? renderMathParagraph(m.id, images, m.display) : undefined
    }
    default:
      return undefined
  }
}

function renderHeading(node: Heading): DocxParagraph {
  const level = Math.min(Math.max(node.depth, 1), 6)
  const heading =
    level === 1 ? HeadingLevel.HEADING_1
      : level === 2 ? HeadingLevel.HEADING_2
        : level === 3 ? HeadingLevel.HEADING_3
          : level === 4 ? HeadingLevel.HEADING_4
            : level === 5 ? HeadingLevel.HEADING_5 : HeadingLevel.HEADING_6
  return new DocxParagraph({ heading, children: [new TextRun({ text: inlineText(node.children), bold: level <= 2 })] })
}

function renderList(node: List, images: Map<string, Buffer>, cursor: Cursor): DocxParagraph {
  // v1: textual bullet/number markers (Word's real numbering config is heavier
  // and out of scope here; the result is still readable + editable).
  const runs: TextRun[] = []
  const items = (node as unknown as { children: ListItem[] }).children
  items.forEach((item, idx) => {
    const marker = node.ordered ? `${(node.start ?? 1) + idx}. ` : '• '
    runs.push(new TextRun({ text: marker }))
    const itemRuns = renderBlockquoteRuns(
      (item as unknown as { children: RootContent[] }).children,
      images,
      cursor,
    )
    runs.push(...itemRuns)
    runs.push(new TextRun({ text: '', break: 1 }))
  })
  return new DocxParagraph({ children: runs })
}

function renderCodeBlock(node: Code): DocxParagraph {
  const lines = node.value.split('\n')
  const runs: TextRun[] = []
  lines.forEach((ln, i) => {
    runs.push(new TextRun({ text: ln, font: { name: 'Consolas' }, shading: { type: ShadingType.SOLID, color: 'auto', fill: 'F1F5F9' } }))
    if (i < lines.length - 1) runs.push(new TextRun({ text: '', break: 1 }))
  })
  return new DocxParagraph({ children: runs })
}

function renderTable(node: { children: unknown[] }, images: Map<string, Buffer>, cursor: Cursor): DocxTable {
  const rows = node.children as Array<{ children: Array<{ children: PhrasingContent[] }> }>
  const tableRows = rows.map((row) => {
    const cells = row.children.map((cell) => {
      const runs = renderInlineList(cell.children, images, cursor, {}) as TextRun[]
      return new DocxTableCell({ children: [new DocxParagraph({ children: runs })] })
    })
    return new DocxTableRow({ children: cells })
  })
  return new DocxTable({ rows: tableRows, width: { size: 100, type: WidthType.PERCENTAGE } })
}

function renderBlockquoteRuns(blocks: RootContent[], images: Map<string, Buffer>, cursor: Cursor): TextRun[] {
  const runs: TextRun[] = []
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      runs.push(...(renderInlineList((block as { children: PhrasingContent[] }).children, images, cursor, {}) as TextRun[]))
    } else {
      const children = (block as { children?: PhrasingContent[] }).children
      const txt = children ? inlineText(children) : ''
      if (txt) runs.push(new TextRun({ text: txt, italics: true }))
    }
  }
  return runs
}

function renderMathParagraph(id: string, images: Map<string, Buffer>, display: boolean): DocxParagraph | undefined {
  const buf = images.get(id)
  if (!buf) return new DocxParagraph({ children: [new TextRun({ text: '[equation]' })] })
  const dims = pngDims(buf)
  const maxW = display ? 400 : 200
  const scale = dims.width > maxW ? maxW / dims.width : 1
  const w = Math.max(1, Math.round(dims.width * scale))
  const h = Math.max(1, Math.round(dims.height * scale))
  return new DocxParagraph({
    alignment: AlignmentType.CENTER,
    children: [new ImageRun({ type: 'png', data: buf, transformation: { width: w, height: h } })],
  })
}

// ─── inline ──────────────────────────────────────────────────────────────────

function renderInlineList(
  nodes: PhrasingContent[],
  images: Map<string, Buffer>,
  cursor: Cursor,
  ctx: FormatCtx,
): (TextRun | ImageRun)[] {
  const out: (TextRun | ImageRun)[] = []
  for (const n of nodes) {
    const r = renderInline(n, images, cursor, ctx)
    if (r) out.push(...r)
  }
  return out
}

function renderInline(
  node: PhrasingContent,
  images: Map<string, Buffer>,
  cursor: Cursor,
  ctx: FormatCtx,
): (TextRun | ImageRun)[] | undefined {
  switch (node.type) {
    case 'text':
      return [new TextRun({ text: (node as Text).value, ...ctx })]
    case 'strong':
      return renderInlineList((node as Strong).children, images, cursor, { ...ctx, bold: true })
    case 'emphasis':
      return renderInlineList((node as Emphasis).children, images, cursor, { ...ctx, italics: true })
    case 'delete':
      return renderInlineList((node as Delete).children, images, cursor, { ...ctx, strike: true })
    case 'inlineCode':
      return [new TextRun({ text: (node as InlineCode).value, font: { name: 'Consolas' }, ...ctx })]
    case 'break':
      return [new TextRun({ text: '', break: 1 })]
    case 'link': {
      const link = node as Link
      const text = inlineText(link.children)
      return [new ExternalHyperlink({ link: link.url, children: [new TextRun({ text, style: 'Hyperlink' })] })] as unknown as TextRun[]
    }
    case 'inlineMath': {
      const m = cursor.next()
      if (!m) return [new TextRun({ text: '' })]
      const buf = images.get(m.id)
      if (!buf) return [new TextRun({ text: '' })]
      const dims = pngDims(buf)
      const maxW = 100
      const scale = dims.width > maxW ? maxW / dims.width : 1
      const w = Math.max(1, Math.round(dims.width * scale))
      const h = Math.max(1, Math.round(dims.height * scale))
      return [new ImageRun({ type: 'png', data: buf, transformation: { width: w, height: h } })]
    }
    case 'html':
      return [new TextRun({ text: stripTags((node as Html).value) })]
    default:
      return undefined
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function inlineText(nodes: PhrasingContent[]): string {
  let out = ''
  for (const n of nodes) {
    if (n.type === 'text') out += (n as Text).value
    else if (n.type === 'inlineCode') out += (n as InlineCode).value
    else if (n.type === 'inlineMath') out += (n as { value: string }).value
    else if ('children' in n) out += inlineText((n as unknown as { children: PhrasingContent[] }).children)
  }
  return out
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Parse a PNG buffer's IHDR chunk for its pixel dimensions. */
function pngDims(buf: Buffer): { width: number; height: number } {
  // PNG: 8-byte signature, then IHDR chunk: [len 4][type 4][width 4][height 4]…
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') {
    return { width: 100, height: 30 }
  }
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  return { width: width || 100, height: height || 30 }
}
