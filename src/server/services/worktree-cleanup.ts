/**
 * Periodic sweep for stale sub-task worktrees.
 *
 * A sub-task that ends in `failed` (or `completed` with a rebase conflict
 * / push error) leaves its worktree on disk so a human can debug or
 * finish the rebase by hand. This sweeper walks resolved ticket
 * sub-tasks older than `config.repos.worktreeKeepFailedSec` and removes
 * any leftover worktree dirs.
 *
 * Source of truth is the DB (task.updatedAt), not the FS — that way the
 * sweeper still runs after a restart and catches worktrees from past
 * crashes that the in-process finalize step never got to.
 */

import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { tasks, tickets, projects } from '@/server/db/schema'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { getWorktreePath, getWorktreeBranch, deleteWorktree } from '@/server/services/worktree'

const log = createLogger('worktree-cleanup')

let sweepInterval: ReturnType<typeof setInterval> | null = null

function shortenTaskId(taskId: string): string {
  return taskId.replace(/-/g, '').slice(0, 8)
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const { access } = await import('node:fs/promises')
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Single sweep pass. Exported so tests / ops can trigger it manually. */
export async function sweepStaleWorktrees(): Promise<void> {
  const ttlMs = config.repos.worktreeKeepFailedSec * 1000
  const cutoff = new Date(Date.now() - ttlMs)

  // Pull resolved ticket sub-tasks whose updatedAt is past the TTL. We
  // include `cancelled` so a manually cancelled task also gets its
  // worktree reclaimed. `completed` clean-rebase tasks are already
  // gone (finalize deletes them inline) so this query mostly matches
  // failed/conflicted ones.
  const rows = db
    .select({
      taskId: tasks.id,
      ticketNumber: tickets.number,
      projectId: projects.id,
      projectSlug: projects.slug,
      githubRepo: projects.githubRepo,
    })
    .from(tasks)
    .innerJoin(tickets, eq(tickets.id, tasks.ticketId))
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(
      and(
        inArray(tasks.status, ['completed', 'failed', 'cancelled']),
        isNotNull(tasks.ticketId),
        isNotNull(projects.githubRepo),
        lt(tasks.updatedAt, cutoff),
      ),
    )
    .all()

  let removed = 0
  for (const row of rows) {
    if (!row.projectSlug || typeof row.ticketNumber !== 'number') continue
    const shortId = shortenTaskId(row.taskId)
    const wtPath = getWorktreePath(row.projectSlug, shortId)
    if (!(await dirExists(wtPath))) continue
    const branch = getWorktreeBranch(row.projectSlug, row.ticketNumber, shortId)
    try {
      await deleteWorktree({
        projectId: row.projectId,
        path: wtPath,
        branch,
        force: true,
      })
      removed++
    } catch (err) {
      log.warn(
        { taskId: row.taskId, wtPath, err: err instanceof Error ? err.message : err },
        'Failed to remove stale worktree (will retry next sweep)',
      )
    }
  }

  if (removed > 0) {
    log.info({ removed, candidates: rows.length, ttlSec: config.repos.worktreeKeepFailedSec }, 'Swept stale worktrees')
  }
}

/**
 * Start the periodic sweep. Safe to call multiple times — the second
 * call is a no-op so `bun --hot` reloads don't stack intervals.
 */
export function startStaleWorktreeCleanup(): void {
  if (sweepInterval) return
  const intervalMin = Math.max(1, config.repos.worktreeSweepIntervalMin)
  const intervalMs = intervalMin * 60 * 1000

  // Run once on startup so worktrees orphaned by a crash get reclaimed
  // without waiting a full interval.
  sweepStaleWorktrees().catch((err) => log.error({ err }, 'Initial worktree sweep failed'))

  sweepInterval = setInterval(() => {
    sweepStaleWorktrees().catch((err) => log.error({ err }, 'Worktree sweep failed'))
  }, intervalMs)

  log.info({ intervalMin, ttlSec: config.repos.worktreeKeepFailedSec }, 'Stale worktree cleanup started')
}

export function stopStaleWorktreeCleanup(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval)
    sweepInterval = null
  }
}
