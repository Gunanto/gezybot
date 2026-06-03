/**
 * Shared subprocess helpers used by every host feature that spawns child
 * processes (MCP stdio servers, custom-tool scripts, dependency installers).
 *
 *  - `augmentedPath`: a PATH that also includes common node/python install
 *    locations (nvm, /usr/local/bin) so children launched by a snap-installed
 *    Bun (restricted PATH / sandboxed HOME) can still find their interpreters.
 *  - `killProcessTree`: kill a process AND all its descendants (pip/npm/node
 *    fork grandchildren that a plain `proc.kill()` would orphan).
 */

import { readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '@/server/logger'

const log = createLogger('process-utils')

/** PATH augmented with common node/python install locations. Computed once. */
export const augmentedPath = (() => {
  const basePath = process.env.PATH ?? ''
  const extraPaths: string[] = []

  // Use SNAP_REAL_HOME if running inside snap, otherwise fall back to os.homedir()
  const realHome = process.env.SNAP_REAL_HOME || homedir()

  // NVM: ~/.nvm/versions/node/*/bin (use the latest)
  const nvmDir = join(realHome, '.nvm', 'versions', 'node')
  if (existsSync(nvmDir)) {
    try {
      const versions = readdirSync(nvmDir).sort().reverse()
      for (const v of versions) {
        const binDir = join(nvmDir, v, 'bin')
        if (existsSync(binDir)) {
          extraPaths.push(binDir)
          break // only use the latest
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Common system paths
  for (const p of ['/usr/local/bin', '/usr/bin']) {
    if (!basePath.includes(p)) extraPaths.push(p)
  }

  if (extraPaths.length === 0) return basePath
  const result = [...extraPaths, ...basePath.split(':')].join(':')
  log.debug({ extraPaths }, 'Augmented PATH for child processes')
  return result
})()

/**
 * Kill a process and all its descendants. Uses `pgrep -P` to walk the tree and
 * kills bottom-up (SIGTERM, then SIGKILL survivors after a grace period) so
 * re-parenting can't keep a grandchild alive.
 */
export async function killProcessTree(pid: number): Promise<void> {
  try {
    const descendants = await getDescendantPids(pid)
    const allPids = [...descendants.reverse(), pid]

    for (const p of allPids) {
      try {
        process.kill(p, 'SIGTERM')
      } catch {
        /* already dead */
      }
    }

    await new Promise((r) => setTimeout(r, 2000))
    for (const p of allPids) {
      try {
        process.kill(p, 'SIGKILL')
      } catch {
        /* already dead */
      }
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already dead */
    }
  }
}

/** Recursively collect all descendant PIDs of a process (Linux, via pgrep). */
async function getDescendantPids(pid: number): Promise<number[]> {
  try {
    const proc = Bun.spawn(['pgrep', '-P', String(pid)], { stdout: 'pipe', stderr: 'pipe' })
    const output = await new Response(proc.stdout).text()
    await proc.exited

    const childPids = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number)
      .filter((n) => !isNaN(n))
    const allDescendants: number[] = []

    for (const childPid of childPids) {
      allDescendants.push(childPid)
      const grandchildren = await getDescendantPids(childPid)
      allDescendants.push(...grandchildren)
    }

    return allDescendants
  } catch {
    return []
  }
}
