/**
 * Resolve the "scout" model — the cheap model a Kin (or one of its sub-tasks)
 * delegates read-only exploration to via the `scout` tool, mirroring how
 * Claude Code hands heavy exploration to a Haiku sub-agent instead of burning
 * Opus steps.
 *
 * The model is resolved through a fallback chain, most-specific first:
 *
 *   1. per-spawn override   (explicit { modelId, providerId } passed at call)
 *   2. Kin scout            (kins.scout_model / kins.scout_provider_id)
 *   3. project scout        (projects.scout_model / projects.scout_provider_id)
 *   4. global scout default (app_settings default_scout_model / _provider_id)
 *   5. Kin's own main model (kins.model / kins.provider_id) — the safety net
 *
 * A scout/main model pair is "set" only when its model is a non-empty string.
 * The providerId is allowed to be null at every tier (null = auto-resolve, the
 * same convention used everywhere else for model/provider pairs). This means a
 * scout-less install — no scout columns, no global default — transparently
 * runs scouts on the Kin's main model, so the feature is purely additive.
 */

import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { kins, projects } from '@/server/db/schema'
import { getDefaultScoutModel, getDefaultScoutProviderId } from '@/server/services/app-settings'

/** A resolved model target. `providerId` may be null (auto-resolve at call). */
export interface ResolvedScoutModel {
  modelId: string
  providerId: string | null
}

/** A model/provider override candidate. A candidate "counts" only when its
 *  `modelId` is a non-empty string; the providerId is optional/nullable. */
export interface ScoutModelOverride {
  modelId?: string | null
  providerId?: string | null
}

export interface ResolveScoutModelOptions {
  /** Kin that owns the scout (the parent Kin of the task, or the main Kin). */
  kinId: string
  /** Active/ticket project, when the scout is spawned in a project context. */
  projectId?: string | null
  /** Highest-priority per-spawn override (e.g. an explicit scout tool arg). */
  override?: ScoutModelOverride | null
}

function asTier(
  modelId: string | null | undefined,
  providerId: string | null | undefined,
): ResolvedScoutModel | null {
  if (typeof modelId === 'string' && modelId.trim() !== '') {
    return { modelId: modelId.trim(), providerId: providerId ?? null }
  }
  return null
}

/**
 * Resolve the effective scout model for a Kin (optionally within a project),
 * honoring an optional per-spawn override. Always returns a concrete model —
 * it falls back to the Kin's own main model, which is `notNull` in the schema.
 *
 * Throws only if the Kin does not exist (programmer error — callers already
 * hold a valid kinId).
 */
export async function resolveScoutModel(
  opts: ResolveScoutModelOptions,
): Promise<ResolvedScoutModel> {
  const { kinId, projectId, override } = opts

  // 1. Per-spawn override.
  const fromOverride = asTier(override?.modelId, override?.providerId)
  if (fromOverride) return fromOverride

  const kin = db
    .select({
      model: kins.model,
      providerId: kins.providerId,
      scoutModel: kins.scoutModel,
      scoutProviderId: kins.scoutProviderId,
    })
    .from(kins)
    .where(eq(kins.id, kinId))
    .get()
  if (!kin) throw new Error(`resolveScoutModel: kin not found: ${kinId}`)

  // 2. Kin-level scout model.
  const fromKin = asTier(kin.scoutModel, kin.scoutProviderId)
  if (fromKin) return fromKin

  // 3. Project-level scout model.
  if (projectId) {
    const project = db
      .select({ scoutModel: projects.scoutModel, scoutProviderId: projects.scoutProviderId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get()
    const fromProject = asTier(project?.scoutModel, project?.scoutProviderId)
    if (fromProject) return fromProject
  }

  // 4. Global scout default (k/v app setting).
  const [globalModel, globalProviderId] = await Promise.all([
    getDefaultScoutModel(),
    getDefaultScoutProviderId(),
  ])
  const fromGlobal = asTier(globalModel, globalProviderId)
  if (fromGlobal) return fromGlobal

  // 5. Safety net: the Kin's own main model (notNull in schema).
  return { modelId: kin.model, providerId: kin.providerId ?? null }
}
