import { Hono } from 'hono'
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
} from '@/server/services/projects'
import {
  listProjectTags,
  createTag,
} from '@/server/services/project-tags'
import {
  listTickets,
  createTicket,
} from '@/server/services/tickets'
import {
  createProjectKnowledge,
  updateProjectKnowledge,
  deleteProjectKnowledge,
  listProjectKnowledge,
  searchProjectKnowledge,
  getProjectKnowledge,
  countProjectKnowledge,
  PinCapExceededError,
} from '@/server/services/project-knowledge'
import { config } from '@/server/config'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'
import { TICKET_STATUSES } from '@/shared/constants'
import type { TicketStatus, KinThinkingConfig, KinThinkingEffort } from '@/shared/types'

const log = createLogger('routes:projects')

export const projectRoutes = new Hono<{ Variables: AppVariables }>()

// ─── Projects CRUD ────────────────────────────────────────────────────────────

projectRoutes.get('/', async (c) => {
  const projects = await listProjects()
  return c.json({ projects })
})

projectRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const project = await getProject(id)
  if (!project) {
    return c.json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } }, 404)
  }
  return c.json({ project })
})

projectRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'title is required' } }, 400)
  }
  const description = typeof body.description === 'string' ? body.description : undefined
  const githubUrl = typeof body.githubUrl === 'string' ? body.githubUrl : undefined
  const project = await createProject({ title, description, githubUrl })
  return c.json({ project }, 201)
})

const VALID_EFFORTS: readonly KinThinkingEffort[] = ['low', 'medium', 'high', 'max']

projectRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const update: {
    title?: string
    description?: string
    githubUrl?: string | null
    model?: string | null
    providerId?: string | null
    thinkingConfig?: KinThinkingConfig | null
  } = {}
  if (typeof body.title === 'string') update.title = body.title
  if (typeof body.description === 'string') update.description = body.description
  if (body.githubUrl === null) update.githubUrl = null
  else if (typeof body.githubUrl === 'string') update.githubUrl = body.githubUrl
  // Model + providerId are tightly coupled: clearing one clears both.
  if (body.model === null || body.providerId === null) {
    update.model = null
    update.providerId = null
  } else if (typeof body.model === 'string' && typeof body.providerId === 'string') {
    update.model = body.model
    update.providerId = body.providerId
  }
  // thinkingConfig: null clears (inherit from Kin); object validates shape.
  if (body.thinkingConfig === null) {
    update.thinkingConfig = null
  } else if (body.thinkingConfig && typeof body.thinkingConfig === 'object') {
    const cfg = body.thinkingConfig as Record<string, unknown>
    const enabled = cfg.enabled === true
    const effort = typeof cfg.effort === 'string' && (VALID_EFFORTS as readonly string[]).includes(cfg.effort)
      ? (cfg.effort as KinThinkingEffort)
      : null
    update.thinkingConfig = { enabled, ...(effort !== null ? { effort } : {}) }
  }
  const project = await updateProject(id, update)
  if (!project) {
    return c.json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } }, 404)
  }
  return c.json({ project })
})

projectRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const ok = await deleteProject(id)
  if (!ok) {
    return c.json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } }, 404)
  }
  return c.json({ success: true })
})

// ─── Project tags ─────────────────────────────────────────────────────────────

projectRoutes.get('/:projectId/tags', async (c) => {
  const projectId = c.req.param('projectId')
  const tags = await listProjectTags(projectId)
  return c.json({ tags })
})

projectRoutes.post('/:projectId/tags', async (c) => {
  const projectId = c.req.param('projectId')
  const body = await c.req.json().catch(() => ({}))
  const label = typeof body.label === 'string' ? body.label.trim() : ''
  const color = typeof body.color === 'string' ? body.color.trim() : ''
  if (!label || !color) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'label and color are required' } }, 400)
  }
  try {
    const tag = await createTag({ projectId, label, color })
    return c.json({ tag }, 201)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg === 'TAG_LABEL_TAKEN') {
      return c.json({ error: { code: 'TAG_LABEL_TAKEN', message: 'A tag with this label already exists in this project' } }, 409)
    }
    if (msg === 'PROJECT_NOT_FOUND') {
      return c.json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } }, 404)
    }
    log.warn({ err }, 'createTag failed')
    return c.json({ error: { code: 'INTERNAL', message: msg } }, 500)
  }
})

// ─── Project tickets ──────────────────────────────────────────────────────────

projectRoutes.get('/:projectId/tickets', async (c) => {
  const projectId = c.req.param('projectId')
  const status = c.req.query('status') as TicketStatus | undefined
  const tagId = c.req.query('tagId') ?? undefined
  const limit = Number(c.req.query('limit') ?? 100)
  const offset = Number(c.req.query('offset') ?? 0)
  const result = await listTickets(projectId, {
    status: status && (TICKET_STATUSES as readonly string[]).includes(status) ? status : undefined,
    tagId,
    limit: Number.isFinite(limit) ? limit : 100,
    offset: Number.isFinite(offset) ? offset : 0,
  })
  return c.json(result)
})

projectRoutes.post('/:projectId/tickets', async (c) => {
  const projectId = c.req.param('projectId')
  const body = await c.req.json().catch(() => ({}))
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'title is required' } }, 400)
  }
  const description = typeof body.description === 'string' ? body.description : undefined
  const status = (typeof body.status === 'string' && (TICKET_STATUSES as readonly string[]).includes(body.status))
    ? (body.status as TicketStatus)
    : undefined
  const tagIds = Array.isArray(body.tagIds) ? body.tagIds.filter((t: unknown): t is string => typeof t === 'string') : undefined

  // Reporter = the session user who triggered the create (UI path)
  const sessionUser = c.get('user') as { id: string } | undefined
  const reporter = sessionUser ? ({ type: 'user' as const, id: sessionUser.id }) : null

  try {
    const ticket = await createTicket({ projectId, title, description, status, tagIds, reporter })
    return c.json({ ticket }, 201)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg === 'PROJECT_NOT_FOUND') {
      return c.json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } }, 404)
    }
    log.warn({ err }, 'createTicket failed')
    return c.json({ error: { code: 'INTERNAL', message: msg } }, 500)
  }
})

// ─── Project knowledge ────────────────────────────────────────────────────────
//
// Entries created here have `authorKinId = null`, marking them as user-authored
// (vs. entries created by Kin tool calls). UI/prompt rendering shows `by user`
// for these.

projectRoutes.get('/:projectId/knowledge', async (c) => {
  const projectId = c.req.param('projectId')
  const project = await getProject(projectId)
  if (!project) {
    return c.json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } }, 404)
  }

  const q = c.req.query('q')?.trim()
  const category = c.req.query('category')?.trim() || undefined
  const pinnedParam = c.req.query('pinned')
  const pinned = pinnedParam === 'true' ? true : pinnedParam === 'false' ? false : undefined
  const limit = Number(c.req.query('limit') ?? 50)
  const offset = Number(c.req.query('offset') ?? 0)
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50
  const safeOffset = Number.isFinite(offset) ? Math.max(offset, 0) : 0

  if (q) {
    // Search path: ignore pinned/category/offset (the search ranking governs
    // what comes back). UI can filter the result client-side if needed.
    const results = await searchProjectKnowledge(projectId, q, Math.min(safeLimit, config.projectKnowledge.maxSearchResults))
    const total = await countProjectKnowledge(projectId)
    return c.json({ entries: results, total, mode: 'search' as const })
  }

  const entries = await listProjectKnowledge(projectId, { category, pinned, limit: safeLimit, offset: safeOffset })
  const total = await countProjectKnowledge(projectId)
  return c.json({ entries, total, mode: 'list' as const })
})

projectRoutes.post('/:projectId/knowledge', async (c) => {
  const projectId = c.req.param('projectId')
  const project = await getProject(projectId)
  if (!project) {
    return c.json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } }, 404)
  }
  const body = await c.req.json().catch(() => ({}))
  const content = typeof body.content === 'string' ? body.content.trim() : ''
  if (!content) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'content is required' } }, 400)
  }
  const category = typeof body.category === 'string' ? body.category.trim() || null : null
  const pinned = body.pinned === true

  try {
    const entry = await createProjectKnowledge({ projectId, content, category, pinned, authorKinId: null })
    return c.json({ entry }, 201)
  } catch (err) {
    if (err instanceof PinCapExceededError) {
      return c.json({ error: { code: 'PIN_CAP_EXCEEDED', message: err.message } }, 409)
    }
    const msg = err instanceof Error ? err.message : 'Unknown error'
    log.warn({ err }, 'createProjectKnowledge failed')
    return c.json({ error: { code: 'INTERNAL', message: msg } }, 500)
  }
})

projectRoutes.patch('/:projectId/knowledge/:id', async (c) => {
  const projectId = c.req.param('projectId')
  const id = c.req.param('id')
  const existing = await getProjectKnowledge(id)
  if (!existing || existing.projectId !== projectId) {
    return c.json({ error: { code: 'KNOWLEDGE_NOT_FOUND', message: 'Knowledge entry not found' } }, 404)
  }

  const body = await c.req.json().catch(() => ({}))
  const updates: { content?: string; category?: string | null; pinned?: boolean } = {}
  if (typeof body.content === 'string') {
    const trimmed = body.content.trim()
    if (!trimmed) {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'content cannot be empty' } }, 400)
    }
    updates.content = trimmed
  }
  if (body.category === null) updates.category = null
  else if (typeof body.category === 'string') updates.category = body.category.trim() || null
  if (typeof body.pinned === 'boolean') updates.pinned = body.pinned

  try {
    const entry = await updateProjectKnowledge(id, updates)
    if (!entry) {
      return c.json({ error: { code: 'KNOWLEDGE_NOT_FOUND', message: 'Knowledge entry not found' } }, 404)
    }
    return c.json({ entry })
  } catch (err) {
    if (err instanceof PinCapExceededError) {
      return c.json({ error: { code: 'PIN_CAP_EXCEEDED', message: err.message } }, 409)
    }
    const msg = err instanceof Error ? err.message : 'Unknown error'
    log.warn({ err }, 'updateProjectKnowledge failed')
    return c.json({ error: { code: 'INTERNAL', message: msg } }, 500)
  }
})

projectRoutes.delete('/:projectId/knowledge/:id', async (c) => {
  const projectId = c.req.param('projectId')
  const id = c.req.param('id')
  const existing = await getProjectKnowledge(id)
  if (!existing || existing.projectId !== projectId) {
    return c.json({ error: { code: 'KNOWLEDGE_NOT_FOUND', message: 'Knowledge entry not found' } }, 404)
  }
  const ok = await deleteProjectKnowledge(id)
  if (!ok) {
    return c.json({ error: { code: 'KNOWLEDGE_NOT_FOUND', message: 'Knowledge entry not found' } }, 404)
  }
  return c.json({ success: true })
})
