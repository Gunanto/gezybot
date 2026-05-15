import { tool } from 'ai'
import { z } from 'zod'
import { resolve } from 'path'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('shell-tools')

const DEFAULT_TIMEOUT = 30_000
const MAX_TIMEOUT = 120_000

// ─── Bash-wrapper detection ──────────────────────────────────────────────────

// Map binaries that have a dedicated KinBot tool to the tool they should use
// instead. Sub-Kins have a strong incentive to fall back to `cat`/`head`/etc.
// because they know the shell; the prompt alone hasn't fully prevented this.
// Detect the pattern at execution time and refuse the call — the model retries
// with the dedicated tool.
const WRAPPER_SUGGESTIONS: Record<string, string> = {
  cat: 'read_file (use offset/limit for partial reads)',
  less: 'read_file (use offset/limit for partial reads)',
  more: 'read_file (use offset/limit for partial reads)',
  head: 'read_file with offset and limit',
  tail: 'read_file with offset and limit',
  wc: 'read_file (the response includes totalLines)',
  grep: 'grep',
  rg: 'grep',
  ripgrep: 'grep',
  ls: 'list_directory',
  sed: 'read_file (for inspection) or edit_file / multi_edit (for changes)',
  awk: 'read_file (for inspection) or edit_file / multi_edit (for changes)',
}

export interface ShellWrapperViolation {
  binary: string
  suggestion: string
}

/**
 * Detect a bare shell wrapper around a tool that has a dedicated KinBot
 * equivalent. Returns null when the command looks like a legitimate
 * pipeline / script / multi-step (in which case the wrapper is being used
 * as a filter rather than as an entrypoint).
 *
 * Exported for unit testing.
 */
export function detectShellWrapper(rawCommand: string): ShellWrapperViolation | null {
  let cmd = rawCommand.trim()
  if (!cmd) return null

  // Strip a leading `cd <path> && ` or `cd <path> ; ` — the agent often
  // prefixes its file-inspection commands with one (cosmetic, not a real
  // pipeline). This makes the detector see the actual entrypoint.
  const cdMatch = cmd.match(/^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/)
  if (cdMatch) cmd = cmd.slice(cdMatch[0].length).trim()

  // Anything that includes pipelines, redirections, command substitution, or
  // chained commands is treated as legitimate — `cat <(...)`, `... | grep`,
  // `head ... > out`, `cmd1 && cmd2` all have valid reasons to call into
  // these binaries as filters.
  if (/[|<>`]|\$\(|&&|\|\|/.test(cmd)) return null

  const firstWord = cmd.split(/\s+/)[0]?.toLowerCase() ?? ''
  const suggestion = WRAPPER_SUGGESTIONS[firstWord]
  if (!suggestion) return null

  return { binary: firstWord, suggestion }
}

// ─── run_shell tool ──────────────────────────────────────────────────────────

export const runShellTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  create: (ctx) =>
    tool({
      description:
        'Run a shell command (bash -c). Returns stdout, stderr, exit code. Use for: git, builds, tests, package managers, language tooling. **Never use for: cat, head, tail, sed, awk, grep, find, ls, wc, echo** — those have dedicated tools (`read_file` with offset/limit, `grep`, `list_directory`, `edit_file`, `multi_edit`) that integrate with the project context and cost fewer tokens. The runner refuses standalone wrappers around those binaries and asks you to retry with the dedicated tool. Never use `--no-verify`, `git push --force`, or `git reset --hard` without explicit authorization.',
      inputSchema: z.object({
        command: z.string(),
        cwd: z
          .string()
          .optional()
          .describe('Absolute path. Defaults to Kin workspace.'),
        timeout: z
          .number()
          .int()
          .min(1000)
          .max(MAX_TIMEOUT)
          .optional()
          .describe(`Ms. Default: ${DEFAULT_TIMEOUT}, max: ${MAX_TIMEOUT}`),
      }),
      execute: async ({ command, cwd, timeout }) => {
        const workspace = resolve(config.workspace.baseDir, ctx.kinId)
        const effectiveCwd = cwd ?? workspace
        const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT
        const start = Date.now()

        const violation = detectShellWrapper(command)
        if (violation) {
          log.warn(
            { kinId: ctx.kinId, command, binary: violation.binary },
            'Refused shell wrapper around dedicated tool',
          )
          return {
            success: false,
            output: '',
            error:
              `Refusing to run \`${violation.binary}\` through run_shell — use the dedicated tool: ${violation.suggestion}. ` +
              `run_shell is for git/builds/tests/package managers/language tooling, NOT for file inspection or text processing that has a dedicated tool. ` +
              `If you genuinely need this binary as part of a pipeline (e.g. piping output through grep), include the pipe — this check only fires on standalone wrappers.`,
            exitCode: -1,
            executionTime: 0,
          }
        }

        try {
          const proc = Bun.spawn(['bash', '-c', command], {
            cwd: effectiveCwd,
            stdout: 'pipe',
            stderr: 'pipe',
            env: {
              ...process.env,
              KINBOT_KIN_ID: ctx.kinId,
              KINBOT_WORKSPACE: workspace,
            },
          })

          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => {
              proc.kill()
              reject(new Error('Execution timeout'))
            }, effectiveTimeout),
          )

          const exitCode = await Promise.race([proc.exited, timeoutPromise])
          const stdout = await new Response(proc.stdout).text()
          const stderr = await new Response(proc.stderr).text()
          const executionTime = Date.now() - start

          log.info(
            { kinId: ctx.kinId, command, executionTime, exitCode, success: exitCode === 0 },
            'Shell command executed',
          )

          const trimmedStderr = stderr.trim() || undefined

          return {
            success: exitCode === 0,
            output: stdout.trim(),
            stderr: trimmedStderr,
            ...(exitCode !== 0 && trimmedStderr ? { error: trimmedStderr } : {}),
            exitCode,
            executionTime,
          }
        } catch (err) {
          const executionTime = Date.now() - start
          log.error({ kinId: ctx.kinId, command, err }, 'Shell command execution failed')

          return {
            success: false,
            output: '',
            error: err instanceof Error ? err.message : 'Execution failed',
            exitCode: -1,
            executionTime,
          }
        }
      },
    }),
}
