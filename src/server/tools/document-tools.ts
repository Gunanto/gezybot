import { z } from 'zod'
import { tool } from '@/server/tools/tool-helper'
import { createLogger } from '@/server/logger'
import { createFileFromContent } from '@/server/services/file-storage'
import { markdownToPdf } from '@/server/services/document-render'
import { markdownToDocxBuffer } from '@/server/services/document-render-docx'
import { playwrightManager } from '@/server/services/playwright-manager'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:document')

/**
 * generate_pdf — render markdown (with LaTeX math via `$…$` / `$$…$$` /
 * ```math``` fences) into a shareable PDF document, returns a shareable URL.
 *
 * Rendering happens in a headless Chromium page (Playwright) — math is rendered
 * to MathML so Chromium's native MathML engine draws it in the PDF. Fully
 * offline (no external fonts/CDN). Available to main agents only.
 *
 * The tool always registers but returns a runtime error when no headless
 * browser is available (so the Agent knows the capability exists and can tell
 * the user to enable it).
 */
export const generatePdfTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Render markdown content (headings, lists, tables, code blocks, and LaTeX math with $...$ / $$...$$ / ```math``` fences) into a PDF document and get a shareable URL. Use this for substantial written deliverables (reports, study notes, physics/math solutions) instead of dumping long content in a chat message. Always share the URL with the user afterwards.',
      inputSchema: z.object({
        content: z
          .string()
          .describe('Markdown source of the document. Supports GFM tables, task lists, fenced code, and LaTeX math.'),
        title: z
          .string()
          .optional()
          .describe('Document title (used for the browser tab / PDF metadata and as filename fallback).'),
        filename: z
          .string()
          .optional()
          .describe('Shareable file name (without extension). Defaults to the title or "document".'),
        format: z
          .enum(['A4', 'Letter'])
          .optional()
          .describe('Page size. Default: A4.'),
        landscape: z
          .boolean()
          .optional()
          .describe('Landscape orientation. Default: false (portrait).'),
      }),
      execute: async (args) => {
        if (!playwrightManager.isEnabled) {
          return {
            error:
              'PDF generation unavailable — the headless browser is disabled. Ask the user to set WEB_BROWSING_HEADLESS_ENABLED=true and ensure Chromium is installed in the container.',
          }
        }

        const content = args.content?.trim()
        if (!content) return { error: 'content is required (markdown).' }

        try {
          const { buffer } = await markdownToPdf(content, args.title, {
            format: args.format,
            landscape: args.landscape,
          })

          const baseName = (args.filename || args.title || 'document')
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 80) || 'document'

          const stored = await createFileFromContent(ctx.agentId, baseName, buffer.toString('base64'), 'application/pdf', {
            isBase64: true,
            createdByAgentId: ctx.agentId,
            description: args.title,
          })

          log.info({ agentId: ctx.agentId, size: buffer.length }, 'PDF generated + stored')
          return stored
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to generate PDF'
          log.error({ error: err, agentId: ctx.agentId }, 'generate_pdf failed')
          return { error: message }
        }
      },
    }),
}

export const generateDocxTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Render markdown content (headings, lists, tables, code blocks, and LaTeX math with $...$ / $$...$$ / ```math``` fences) into a Word (.docx) document with native editable equations, and get a shareable URL. Use this for substantial written deliverables (reports, study notes, RPP, physics/math solutions) instead of dumping long content in a chat message. Always share the URL with the user afterwards.',
      inputSchema: z.object({
        content: z
          .string()
          .describe('Markdown source of the document. Supports GFM tables, task lists, fenced code, and LaTeX math.'),
        title: z
          .string()
          .optional()
          .describe('Document title (used for metadata and as filename fallback).'),
        filename: z
          .string()
          .optional()
          .describe('Shareable file name (without extension). Defaults to the title or "document".'),
      }),
      execute: async (args) => {
        const content = args.content?.trim()
        if (!content) return { error: 'content is required (markdown).' }

        try {
          const buffer = await markdownToDocxBuffer(content, args.title)

          const baseName = (args.filename || args.title || 'document')
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 80) || 'document'

          const stored = await createFileFromContent(ctx.agentId, baseName, buffer.toString('base64'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', {
            isBase64: true,
            createdByAgentId: ctx.agentId,
            description: args.title,
          })

          log.info({ agentId: ctx.agentId, size: buffer.length }, 'DOCX generated + stored')
          return stored
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to generate document'
          log.error({ error: err, agentId: ctx.agentId }, 'generate_docx failed')
          return { error: message }
        }
      },
    }),
}

