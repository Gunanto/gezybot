import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { kins, tasks, tickets } from '@/server/db/schema'
import { createLogger } from '@/server/logger'
import { config } from '@/server/config'
import {
  createProjectKnowledge,
  updateProjectKnowledge,
  deleteProjectKnowledge,
  setPinned,
  listProjectKnowledge,
  searchProjectKnowledge,
  getProjectKnowledge,
  PinCapExceededError,
} from '@/server/services/project-knowledge'
import type { ToolRegistration, ToolExecutionContext } from '@/server/tools/types'

const log = createLogger('tools:project-knowledge')

// ─── Gating ─────────────────────────────────────────────────────────────────

/**
 * Available to main Kins (no taskId) and to sub-Kins of ticket-bound tasks.
 * Free sub-Kins (task but no ticket) are filtered out — they have no project
 * context to act on.
 *
 * Mirrors the gate used by the existing project/ticket tools in
 * `project-tools.ts` so behavior is consistent.
 */
const mainOrTicketBoundCondition = (ctx: ToolExecutionContext): boolean =>
  !ctx.taskId || !!ctx.ticketId

// ─── Context resolution ────────────────────────────────────────────────────

interface ResolvedContext {
  projectId: string | null
  /** When called from a sub-Kin task, the Kin id stored on the task row (the
   *  spawned Kin's own id, which equals ctx.kinId at execution time). For main
   *  Kins it's still ctx.kinId. We surface it explicitly to make audit/author
   *  attribution explicit at the call site. */
  authorKinId: string
  /** Structured error code suitable for surfacing back to the LLM. */
  error?: 'NO_ACTIVE_PROJECT' | 'NO_PROJECT_CONTEXT'
}

/**
 * Resolve the project the tool should act on, based on the caller's context:
 * - Main Kin → `kins.active_project_id`
 * - Ticket-bound sub-Kin → `tickets.project_id` (looked up from `task.ticketId`)
 * - Free sub-Kin → blocked by the availability gate, but defended here too.
 *
 * Returns a typed error when no project can be resolved so the tool can
 * return a structured error to the agent.
 */
function resolveProjectContext(ctx: ToolExecutionContext): ResolvedContext {
  if (ctx.taskId) {
    if (!ctx.ticketId) {
      return { projectId: null, authorKinId: ctx.kinId, error: 'NO_PROJECT_CONTEXT' }
    }
    const ticket = db
      .select({ projectId: tickets.projectId })
      .from(tickets)
      .where(eq(tickets.id, ctx.ticketId))
      .get()
    if (!ticket) {
      return { projectId: null, authorKinId: ctx.kinId, error: 'NO_PROJECT_CONTEXT' }
    }
    return { projectId: ticket.projectId, authorKinId: ctx.kinId }
  }

  const kin = db
    .select({ activeProjectId: kins.activeProjectId })
    .from(kins)
    .where(eq(kins.id, ctx.kinId))
    .get()
  if (!kin?.activeProjectId) {
    return { projectId: null, authorKinId: ctx.kinId, error: 'NO_ACTIVE_PROJECT' }
  }
  return { projectId: kin.activeProjectId, authorKinId: ctx.kinId }
}

function pinCapMessage(): string {
  return `Cannot pin more than ${config.projectKnowledge.pinCap} entries per project. Unpin one with update_project_knowledge(id, pinned=false) first.`
}

// ─── Tools ──────────────────────────────────────────────────────────────────

const addDescription =
  'Capture a durable fact about the current project: an architectural decision, a convention, ' +
  'a gotcha, a domain rule. Visible to ALL Kins working on this project. ' +
  'Set pinned=true to inject the entry into the system prompt (capped at ' +
  '10 pins per project — unpin one first if full). Pinned entries are frozen ' +
  'into ticket sub-Kin snapshots at spawn time; live search via ' +
  'search_project_knowledge always reflects the latest state.'

export const addProjectKnowledgeTool: ToolRegistration = {
  availability: ['main'],
  condition: mainOrTicketBoundCondition,
  create: (ctx) =>
    tool({
      description: addDescription,
      inputSchema: z.object({
        content: z.string().min(1).describe('A clear standalone fact or decision to remember.'),
        category: z
          .string()
          .optional()
          .describe('Optional free-text bucket (e.g. "arch", "decision", "gotcha", "convention").'),
        pinned: z
          .boolean()
          .optional()
          .describe('Default: false. Pinned entries appear in the system prompt for every Kin acting on this project.'),
      }),
      execute: async ({ content, category, pinned }) => {
        const resolved = resolveProjectContext(ctx)
        if (resolved.error) return { error: resolved.error }

        try {
          const created = await createProjectKnowledge({
            projectId: resolved.projectId!,
            content,
            category: category ?? null,
            pinned: pinned ?? false,
            authorKinId: resolved.authorKinId,
          })
          log.debug({ kinId: ctx.kinId, knowledgeId: created.id, pinned: created.pinned }, 'Knowledge added')
          return {
            knowledge: {
              id: created.id,
              content: created.content,
              category: created.category,
              pinned: created.pinned,
            },
          }
        } catch (e) {
          if (e instanceof PinCapExceededError) {
            return { error: 'PIN_CAP_EXCEEDED', message: pinCapMessage() }
          }
          throw e
        }
      },
    }),
}

export const searchProjectKnowledgeTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  condition: mainOrTicketBoundCondition,
  create: (ctx) =>
    tool({
      description:
        'Search the current project\'s knowledge base by semantic similarity + keyword match. ' +
        'Use this to retrieve facts/decisions/gotchas that are NOT already pinned in your prompt — ' +
        'the pinned set is capped at 10 entries per project, so the rest lives here.',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).optional().describe('Default: 10'),
      }),
      execute: async ({ query, limit }) => {
        const resolved = resolveProjectContext(ctx)
        if (resolved.error) return { error: resolved.error }
        const hits = await searchProjectKnowledge(resolved.projectId!, query, limit)
        return {
          results: hits.map((h) => ({
            id: h.id,
            content: h.content,
            category: h.category,
            pinned: h.pinned,
            authorKinName: h.authorKinName,
            score: h.score,
          })),
        }
      },
    }),
}

export const listProjectKnowledgeTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  condition: mainOrTicketBoundCondition,
  create: (ctx) =>
    tool({
      description:
        'List entries in the current project\'s knowledge base, optionally filtered. ' +
        'Prefer search_project_knowledge for "find by topic"; use this for "what do I have on X category" or "what is currently pinned".',
      inputSchema: z.object({
        category: z.string().optional(),
        pinned: z.boolean().optional().describe('Filter to pinned-only or unpinned-only.'),
        limit: z.number().int().min(1).max(100).optional().describe('Default: 50'),
        offset: z.number().int().min(0).optional().describe('Default: 0'),
      }),
      execute: async ({ category, pinned, limit, offset }) => {
        const resolved = resolveProjectContext(ctx)
        if (resolved.error) return { error: resolved.error }
        const entries = await listProjectKnowledge(resolved.projectId!, {
          category,
          pinned,
          limit: limit ?? 50,
          offset: offset ?? 0,
        })
        return {
          entries: entries.map((e) => ({
            id: e.id,
            content: e.content,
            category: e.category,
            pinned: e.pinned,
            authorKinName: e.authorKinName,
            updatedAt: e.updatedAt,
          })),
        }
      },
    }),
}

export const updateProjectKnowledgeTool: ToolRegistration = {
  availability: ['main'],
  condition: mainOrTicketBoundCondition,
  create: (ctx) =>
    tool({
      description:
        'Update an existing project knowledge entry — content, category, or pinned state. ' +
        'Re-embeds the content if changed.',
      inputSchema: z.object({
        id: z.string(),
        content: z.string().min(1).optional(),
        category: z.string().nullable().optional(),
        pinned: z.boolean().optional(),
      }),
      execute: async ({ id, content, category, pinned }) => {
        const resolved = resolveProjectContext(ctx)
        if (resolved.error) return { error: resolved.error }

        // Cross-project guardrail: an entry must belong to the project the
        // caller is currently acting on. Without it, a Kin with an active
        // project could be tricked into editing another project's entries.
        const existing = await getProjectKnowledge(id)
        if (!existing) return { error: 'KNOWLEDGE_NOT_FOUND' }
        if (existing.projectId !== resolved.projectId) {
          return { error: 'WRONG_PROJECT', message: 'This knowledge entry belongs to a different project.' }
        }

        try {
          const updated = await updateProjectKnowledge(id, {
            content,
            category: category === undefined ? undefined : category,
            pinned,
          })
          if (!updated) return { error: 'KNOWLEDGE_NOT_FOUND' }
          return {
            knowledge: {
              id: updated.id,
              content: updated.content,
              category: updated.category,
              pinned: updated.pinned,
            },
          }
        } catch (e) {
          if (e instanceof PinCapExceededError) {
            return { error: 'PIN_CAP_EXCEEDED', message: pinCapMessage() }
          }
          throw e
        }
      },
    }),
}

export const deleteProjectKnowledgeTool: ToolRegistration = {
  availability: ['main'],
  destructive: true,
  condition: mainOrTicketBoundCondition,
  create: (ctx) =>
    tool({
      description:
        'Delete a project knowledge entry permanently. Use when an entry is outdated or contradicts ' +
        'newer entries you\'ve added.',
      inputSchema: z.object({
        id: z.string(),
      }),
      execute: async ({ id }) => {
        const resolved = resolveProjectContext(ctx)
        if (resolved.error) return { error: resolved.error }

        const existing = await getProjectKnowledge(id)
        if (!existing) return { error: 'KNOWLEDGE_NOT_FOUND' }
        if (existing.projectId !== resolved.projectId) {
          return { error: 'WRONG_PROJECT', message: 'This knowledge entry belongs to a different project.' }
        }

        const ok = await deleteProjectKnowledge(id)
        return { deleted: ok }
      },
    }),
}

// Tiny escape hatch: `setPinned` is reachable via update_project_knowledge,
// but exposing the dedicated action keeps the most common operation cheap and
// self-documenting for the agent. It also lets us mark this readOnly=false
// without forcing the agent to also pass `pinned: ...` through a generic update.
export const pinProjectKnowledgeTool: ToolRegistration = {
  availability: ['main'],
  condition: mainOrTicketBoundCondition,
  create: (ctx) =>
    tool({
      description:
        'Pin or unpin a project knowledge entry. Pinned entries appear in the system prompt for ' +
        `every Kin acting on this project (cap: ${config.projectKnowledge.pinCap} pins per project).`,
      inputSchema: z.object({
        id: z.string(),
        pinned: z.boolean(),
      }),
      execute: async ({ id, pinned }) => {
        const resolved = resolveProjectContext(ctx)
        if (resolved.error) return { error: resolved.error }

        const existing = await getProjectKnowledge(id)
        if (!existing) return { error: 'KNOWLEDGE_NOT_FOUND' }
        if (existing.projectId !== resolved.projectId) {
          return { error: 'WRONG_PROJECT', message: 'This knowledge entry belongs to a different project.' }
        }

        try {
          const updated = await setPinned(id, pinned)
          if (!updated) return { error: 'KNOWLEDGE_NOT_FOUND' }
          return { knowledge: { id: updated.id, pinned: updated.pinned } }
        } catch (e) {
          if (e instanceof PinCapExceededError) {
            return { error: 'PIN_CAP_EXCEEDED', message: pinCapMessage() }
          }
          throw e
        }
      },
    }),
}
