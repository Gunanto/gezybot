/**
 * Document rendering — markdown (with LaTeX math) → DOCX.
 *
 * LaTeX equations are converted to native Word equation objects (OMML) via
 * KaTeX (LaTeX→MathML) + mathml2omml (MathML→OMML), then injected as raw XML
 * using the docx package's ImportedXmlComponent. Equations are editable in
 * Word — they are real equation objects, not rasterized images. Inline SVG
 * elements in the markdown are rasterized to PNG via headless Chromium and
 * embedded as images. The rest of the markdown (headings, lists, tables, code,
 * blockquotes, inline formatting) is mapped to native Word structures with
 * the `docx` package.
 *
 * Pipeline:
 *   markdown → unified (remark-parse + remark-gfm + remark-math) MDAST
 *   → walk MDAST → docx elements (Paragraph/TextRun/Table/…)
 *     math nodes: LaTeX → KaTeX(output:'mathml') → strip <annotation>
 *       → mml2omml() → OMML XML → ImportedXmlComponent.fromXmlString()
 *     SVG html nodes: screenshot via Playwright → ImageRun PNG
 *   → Packer.toBuffer(doc) → .docx buffer
 */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import katex from 'katex'
import { mml2omml } from 'mathml2omml'
import type {
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
  ImportedXmlComponent,
} from 'docx'
import { playwrightManager } from '@/server/services/playwright-manager'
import { createLogger } from '@/server/logger'

const log = createLogger('document-render-docx')

// ─── Public API ─────────────────────────────────────────────────────────────

export async function markdownToDocxBuffer(md: string, title: string | undefined): Promise<Buffer> {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(md)

  const children: (DocxParagraph | DocxTable)[] = []
  for (const block of tree.children) {
    const el = await renderBlock(block)
    if (el) children.push(el)
  }

  const doc = new Document({
    creator: 'Gezy',
    title: title ?? 'Document',
    sections: [{ properties: {}, children }],
  })

  const buffer = await Packer.toBuffer(doc)
  log.debug({ bytes: buffer.length }, 'DOCX rendered')
  return buffer
}

// ─── Math: LaTeX → OMML ─────────────────────────────────────────────────────

const MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math'

/** Convert a LaTeX string to an OMML XmlComponent for embedding in a docx
 *  paragraph. KaTeX renders LaTeX→MathML, mml2omml converts MathML→OMML.
 *  Display equations are wrapped in <m:oMathPara> so Word centers them.
 *
 *  We build ImportedXmlComponent objects manually instead of using
 *  fromXmlString() because the xml-js/sax parser bundled in the docx
 *  package doesn't extract namespace-prefixed element names (e.g. m:oMath)
 *  correctly in the Bun runtime — it returns rootKey "undefined", which
 *  produces invalid <undefined> wrapper tags in the document XML that
 *  prevent Word from rendering equations. */
function mathToXmlComponent(latex: string, display: boolean): ImportedXmlComponent | null {
  const omml = latexToOmml(latex, display)
  if (!omml) return null
  return parseOmml(omml)
}

/** Parse a well-formed OMML XML string into an ImportedXmlComponent tree.
 *  Handles namespace-prefixed element names, attributes, text content, and
 *  nested elements. Self-closing tags and CDATA are not expected in OMML
 *  output from mml2omml, so they are not handled. */
function parseOmml(xml: string): ImportedXmlComponent {
  const tokens = tokenizeXml(xml)
  const [comp] = buildTree(tokens, 0)
  return comp
}

interface XmlToken {
  kind: 'open' | 'close' | 'text'
  name?: string
  attrs?: Record<string, string>
  text?: string
}

/** Tokenize an XML string into opening tags, closing tags, and text nodes. */
function tokenizeXml(xml: string): XmlToken[] {
  const tokens: XmlToken[] = []
  let i = 0
  while (i < xml.length) {
    if (xml[i] === '<') {
      const end = xml.indexOf('>', i)
      if (end === -1) break
      const tagContent = xml.slice(i + 1, end)
      if (tagContent.startsWith('/')) {
        tokens.push({ kind: 'close', name: tagContent.slice(1).trim() })
      } else if (tagContent.endsWith('/')) {
        // Self-closing tag — treat as open + immediate close
        const { name, attrs } = parseTag(tagContent.slice(0, -1))
        tokens.push({ kind: 'open', name, attrs })
        tokens.push({ kind: 'close', name })
      } else {
        const { name, attrs } = parseTag(tagContent)
        tokens.push({ kind: 'open', name, attrs })
      }
      i = end + 1
    } else {
      const lt = xml.indexOf('<', i)
      const textEnd = lt === -1 ? xml.length : lt
      const text = xml.slice(i, textEnd)
      if (text.trim()) tokens.push({ kind: 'text', text })
      i = textEnd
    }
  }
  return tokens
}

/** Parse a tag's content string into element name + attributes. */
function parseTag(tagContent: string): { name: string; attrs?: Record<string, string> } {
  // name = everything up to the first space
  const spaceIdx = tagContent.indexOf(' ')
  if (spaceIdx === -1) return { name: tagContent.trim() }
  const name = tagContent.slice(0, spaceIdx).trim()
  const attrStr = tagContent.slice(spaceIdx + 1).trim()
  if (!attrStr) return { name }
  // parse attributes: key="value" pairs
  const attrs: Record<string, string> = {}
  const re = /([w:.-]+)s*=s*"([^"]*)"/g
  let m
  while ((m = re.exec(attrStr)) !== null) {
    attrs[m[1]!] = m[2]!
  }
  return { name, attrs }
}

/** Recursively build an ImportedXmlComponent tree from tokens. */
function buildTree(tokens: XmlToken[], startIdx: number): [ImportedXmlComponent, number] {
  const token = tokens[startIdx]!
  const comp = new ImportedXmlComponent(token.name!, token.attrs)
  let i = startIdx + 1
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t.kind === 'close') {
      return [comp, i + 1]
    }
    if (t.kind === 'text') {
      comp.push(t.text!)
      i++
    } else if (t.kind === 'open') {
      const [child, nextIdx] = buildTree(tokens, i)
      comp.push(child)
      i = nextIdx
    } else {
      i++
    }
  }
  return [comp, i]
}

function latexToOmml(latex: string, display: boolean): string | null {
  try {
    const html = katex.renderToString(latex, {
      displayMode: display,
      throwOnError: false,
      output: 'mathml',
    })
    const mathMatch = html.match(/<math[\s\S]*?<\/math>/)
    if (!mathMatch) return null
    // Strip <annotation> — KaTeX includes the raw LaTeX as a semantic
    // annotation; mml2omml warns "Type not supported: annotation" if left in.
    const mathml = mathMatch[0].replace(/<annotation[\s\S]*?<\/annotation>/g, '')
    const omml = mml2omml(mathml)
    // mml2omml already wraps in <m:oMath>; for display (block) equations, add
    // <m:oMathPara> so Word treats them as centered block equations.
    if (display) {
      return `<m:oMathPara xmlns:m="${MATH_NS}">${omml}</m:oMathPara>`
    }
    return omml
  } catch (err) {
    log.warn({ err, latex }, 'LaTeX to OMML conversion failed')
    return null
  }
}

// ─── SVG rendering ──────────────────────────────────────────────────────────

/** Check if an HTML string contains an inline <svg> element. */
function isSvgHtml(htmlString: string): boolean {
  return /<svg[\s>]/i.test(htmlString)
}

/** Rasterize an inline SVG to a PNG ImageRun via headless Chromium.
 *  Returns null if Playwright is unavailable or the screenshot fails. */
async function renderSvgImage(svgHtml: string): Promise<ImageRun | null> {
  if (!playwrightManager.isEnabled) return null
  try {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { margin: 0; padding: 4px; display: inline-block; }
      svg { max-width: 500px; height: auto; }
    </style></head><body>${svgHtml}</body></html>`
    const buffers = await playwrightManager.screenshotHtmlElements(html, ['svg-target'])
    const buf = buffers.get('svg-target')
    if (!buf) return null
    const dims = pngDims(buf)
    const maxW = 450
    const scale = dims.width > maxW ? maxW / dims.width : 1
    const w = Math.max(1, Math.round(dims.width * scale))
    const h = Math.max(1, Math.round(dims.height * scale))
    return new ImageRun({ type: 'png', data: buf, transformation: { width: w, height: h } })
  } catch (err) {
    log.warn({ err }, 'SVG rasterization failed in DOCX pipeline')
    return null
  }
}

/** Parse a PNG buffer's IHDR chunk for its pixel dimensions. */
function pngDims(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') {
    return { width: 100, height: 30 }
  }
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  return { width: width || 100, height: height || 30 }
}

// ─── MDAST → docx elements ──────────────────────────────────────────────────

interface FormatCtx {
  bold?: boolean
  italics?: boolean
  strike?: boolean
}

type InlineResult = TextRun | ImportedXmlComponent | ImageRun

async function renderBlock(node: RootContent): Promise<DocxParagraph | DocxTable | undefined> {
  switch (node.type) {
    case 'heading':
      return renderHeading(node as Heading)
    case 'paragraph':
      return new DocxParagraph({
        children: await renderInlineList((node as { children: PhrasingContent[] }).children, {}),
      })
    case 'list':
      return await renderList(node as List)
    case 'blockquote':
      return new DocxParagraph({
        children: await renderBlockquoteRuns((node as Blockquote).children),
        indent: { left: 720 },
      })
    case 'code':
      // ```math fenced block -> block equation.
      if ((node as Code).lang === 'math') {
        return renderMathParagraph((node as Code).value, true)
      }
      return renderCodeBlock(node as Code)
    case 'table':
      return await renderTable(node as { children: unknown[] })
    case 'thematicBreak':
      return new DocxParagraph({
        children: [new TextRun({ text: '────────────────────────' })],
        alignment: AlignmentType.CENTER,
      })
    case 'html': {
      const htmlVal = (node as Html).value
      if (isSvgHtml(htmlVal)) {
        const img = await renderSvgImage(htmlVal)
        if (img) return new DocxParagraph({ alignment: AlignmentType.CENTER, children: [img] })
      }
      return new DocxParagraph({ children: [new TextRun({ text: stripTags(htmlVal) })] })
    }
    case 'math':
      return renderMathParagraph((node as { value: string }).value, true)
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
  return new DocxParagraph({
    heading,
    children: [new TextRun({ text: inlineText(node.children), bold: level <= 2 })],
  })
}

async function renderList(node: List): Promise<DocxParagraph> {
  // v1: textual bullet/number markers (Word's real numbering config is heavier
  // and out of scope here; the result is still readable + editable).
  const runs: TextRun[] = []
  const items = (node as unknown as { children: ListItem[] }).children
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx]!
    const marker = node.ordered ? `${(node.start ?? 1) + idx}. ` : '• '
    runs.push(new TextRun({ text: marker }))
    const itemRuns = await renderBlockquoteRuns(
      (item as unknown as { children: RootContent[] }).children,
    )
    runs.push(...itemRuns)
    runs.push(new TextRun({ text: '', break: 1 }))
  }
  return new DocxParagraph({ children: runs })
}

function renderCodeBlock(node: Code): DocxParagraph {
  const lines = node.value.split('\n')
  const runs: TextRun[] = []
  lines.forEach((ln, i) => {
    runs.push(
      new TextRun({
        text: ln,
        font: { name: 'Consolas' },
        shading: { type: ShadingType.SOLID, color: 'auto', fill: 'F1F5F9' },
      }),
    )
    if (i < lines.length - 1) runs.push(new TextRun({ text: '', break: 1 }))
  })
  return new DocxParagraph({ children: runs })
}

async function renderTable(node: { children: unknown[] }): Promise<DocxTable> {
  const rows = node.children as Array<{ children: Array<{ children: PhrasingContent[] }> }>
  const tableRows: DocxTableRow[] = []
  for (const row of rows) {
    const cells: DocxTableCell[] = []
    for (const cell of row.children) {
      const runs = (await renderInlineList(cell.children, {})) as TextRun[]
      cells.push(new DocxTableCell({ children: [new DocxParagraph({ children: runs })] }))
    }
    tableRows.push(new DocxTableRow({ children: cells }))
  }
  return new DocxTable({ rows: tableRows, width: { size: 100, type: WidthType.PERCENTAGE } })
}

async function renderBlockquoteRuns(blocks: RootContent[]): Promise<TextRun[]> {
  const runs: TextRun[] = []
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      runs.push(...((await renderInlineList((block as { children: PhrasingContent[] }).children, {})) as TextRun[]))
    } else {
      const children = (block as { children?: PhrasingContent[] }).children
      const txt = children ? inlineText(children) : ''
      if (txt) runs.push(new TextRun({ text: txt, italics: true }))
    }
  }
  return runs
}

function renderMathParagraph(latex: string, display: boolean): DocxParagraph | undefined {
  const comp = mathToXmlComponent(latex, display)
  if (!comp) return new DocxParagraph({ children: [new TextRun({ text: '[equation]' })] })
  return new DocxParagraph({
    alignment: display ? AlignmentType.CENTER : undefined,
    children: [comp as unknown as TextRun],
  })
}

// ─── inline ──────────────────────────────────────────────────────────────────

async function renderInlineList(
  nodes: PhrasingContent[],
  ctx: FormatCtx,
): Promise<InlineResult[]> {
  const out: InlineResult[] = []
  for (const n of nodes) {
    const r = await renderInline(n, ctx)
    if (r) out.push(...r)
  }
  return out
}

async function renderInline(
  node: PhrasingContent,
  ctx: FormatCtx,
): Promise<InlineResult[] | undefined> {
  switch (node.type) {
    case 'text':
      return [new TextRun({ text: (node as Text).value, ...ctx })]
    case 'strong':
      return await renderInlineList((node as Strong).children, { ...ctx, bold: true })
    case 'emphasis':
      return await renderInlineList((node as Emphasis).children, { ...ctx, italics: true })
    case 'delete':
      return await renderInlineList((node as Delete).children, { ...ctx, strike: true })
    case 'inlineCode':
      return [new TextRun({ text: (node as InlineCode).value, font: { name: 'Consolas' }, ...ctx })]
    case 'break':
      return [new TextRun({ text: '', break: 1 })]
    case 'link': {
      const link = node as Link
      const text = inlineText(link.children)
      return [
        new ExternalHyperlink({
          link: link.url,
          children: [new TextRun({ text, style: 'Hyperlink' })],
        }),
      ] as unknown as TextRun[]
    }
    case 'inlineMath': {
      const comp = mathToXmlComponent((node as { value: string }).value, false)
      if (!comp) return [new TextRun({ text: (node as { value: string }).value })]
      return [comp]
    }
    case 'html': {
      const htmlVal = (node as Html).value
      if (isSvgHtml(htmlVal)) {
        const img = await renderSvgImage(htmlVal)
        if (img) return [img]
      }
      return [new TextRun({ text: stripTags(htmlVal) })]
    }
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
    else if ('children' in n)
      out += inlineText((n as unknown as { children: PhrasingContent[] }).children)
  }
  return out
}

function stripTags(htmlString: string): string {
  return htmlString.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}
