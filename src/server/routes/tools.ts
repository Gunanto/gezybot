import { Hono } from 'hono'
import { toolRegistry } from '@/server/tools/index'
import { HARD_EXCLUDED_FROM_SUBKIN } from '@/server/services/tasks'
import type { AppVariables } from '@/server/app'
import type { ToolDomain } from '@/shared/types'

/**
 * Tool-level metadata routes. Currently exposes the registry's
 * `name → domain` map so the UI can render tool-call badges and tool
 * settings without duplicating the map on the client. The domain is
 * declared once, at registration time in `src/server/tools/register.ts`.
 */
export const toolsRoutes = new Hono<{ Variables: AppVariables }>()

// GET /api/tools/domains — full registry snapshot of name → domain.
// Plugin tools (registered dynamically) are included so the rendering
// layer can colour their badges correctly too. Cheap call; safe to fetch
// once at app boot and cache for the session.
toolsRoutes.get('/domains', (c) => {
  const map: Record<string, ToolDomain> = {}
  for (const t of toolRegistry.list()) map[t.name] = t.domain
  return c.json(map)
})

// GET /api/tools/catalog — Kin-agnostic catalog of every NATIVE tool, used to
// populate the toolbox editor. Unlike GET /api/kins/:id/tools this carries no
// per-Kin enabled state — it is a pure metadata listing of what a toolbox can
// reference. Nothing is filtered out (it is a catalog); each entry instead
// carries `hardExcludedFromSubKin` so the UI can warn that the tool can never
// run inside a task even if a toolbox lists it (see HARD_EXCLUDED_FROM_SUBKIN
// in services/tasks.ts). `label` is the author-supplied (possibly locale-keyed)
// display label; `description` is the LLM-facing description, best-effort
// extracted from the tool factory (may be absent for some tools).
const HARD_EXCLUDED_SET = new Set<string>(HARD_EXCLUDED_FROM_SUBKIN)

toolsRoutes.get('/catalog', (c) => {
  const tools = toolRegistry.list().map((t) => ({
    name: t.name,
    domain: t.domain,
    label: t.label ?? null,
    description: toolRegistry.describe(t.name) ?? null,
    defaultDisabled: t.defaultDisabled,
    readOnly: t.readOnly,
    destructive: t.destructive,
    hardExcludedFromSubKin: HARD_EXCLUDED_SET.has(t.name),
  }))
  return c.json({ tools })
})
