import { tool } from 'ai'
import { z } from 'zod'
import { resolve } from 'path'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('shell-tools')

const DEFAULT_TIMEOUT = 30_000
const MAX_TIMEOUT = 120_000

// Cap the rendered stdout/stderr at 30 KB so a one-off `tree`, `npm install
// --verbose`, or `bun test --verbose` doesn't flood the model's context with
// tens of thousands of irrelevant lines. The model can still re-run a command
// with narrower options if it really needs the full output.
const MAX_OUTPUT_LENGTH = 30_000

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

// Banned commands. These either have a dedicated KinBot tool that performs
// the same job with better integration (http_request, browse_url, …) or are
// network/interactive operations that don't belong in a headless task. The
// list is adapted from Claude Code's BashTool BANNED_COMMANDS.
const BANNED_SUGGESTIONS: Record<string, string> = {
  // HTTP clients — use http_request
  curl: 'http_request',
  curlie: 'http_request',
  wget: 'http_request',
  axel: 'http_request',
  aria2c: 'http_request',
  httpie: 'http_request',
  http: 'http_request',
  xh: 'http_request',
  'http-prompt': 'http_request',
  // Text browsers — use browse_url
  lynx: 'browse_url',
  w3m: 'browse_url',
  links: 'browse_url',
  // GUI browsers — pointless in a headless task
  chrome: 'browse_url or screenshot_url',
  'google-chrome': 'browse_url or screenshot_url',
  chromium: 'browse_url or screenshot_url',
  firefox: 'browse_url or screenshot_url',
  safari: 'browse_url or screenshot_url',
  // Raw socket tools — rarely needed in tasks, ask the user if you truly do
  nc: 'http_request (or ask the user before opening a raw socket)',
  netcat: 'http_request (or ask the user before opening a raw socket)',
  telnet: 'http_request (or ask the user before opening a raw socket)',
}

export interface ShellWrapperViolation {
  binary: string
  suggestion: string
  reason: 'wrapper' | 'banned'
}

/**
 * Detect a bare shell wrapper around a tool that has a dedicated KinBot
 * equivalent, OR a banned network/browser command. Returns null when the
 * command looks like a legitimate pipeline / script / multi-step (in which
 * case the binary is being used as a filter rather than as an entrypoint).
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
  const wrapperSuggestion = WRAPPER_SUGGESTIONS[firstWord]
  if (wrapperSuggestion) {
    return { binary: firstWord, suggestion: wrapperSuggestion, reason: 'wrapper' }
  }
  const bannedSuggestion = BANNED_SUGGESTIONS[firstWord]
  if (bannedSuggestion) {
    return { binary: firstWord, suggestion: bannedSuggestion, reason: 'banned' }
  }
  return null
}

/** Cap a stdout/stderr stream at MAX_OUTPUT_LENGTH characters. The trailing
 *  chunk is preserved (most useful for command tails like build errors). */
function truncateOutput(raw: string): { value: string; truncated: boolean; omitted: number } {
  if (raw.length <= MAX_OUTPUT_LENGTH) return { value: raw, truncated: false, omitted: 0 }
  const tail = raw.slice(raw.length - MAX_OUTPUT_LENGTH)
  const omitted = raw.length - MAX_OUTPUT_LENGTH
  return {
    value: `[…truncated ${omitted} chars from the head — showing the last ${MAX_OUTPUT_LENGTH}…]\n${tail}`,
    truncated: true,
    omitted,
  }
}

export const _SHELL_INTERNALS_FOR_TEST = { truncateOutput, MAX_OUTPUT_LENGTH }

// ─── run_shell tool ──────────────────────────────────────────────────────────

export const runShellTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  create: (ctx) =>
    tool({
      description:
        'Run a shell command (bash -c). Returns stdout, stderr, exit code. Use for: git, builds, tests, package managers, language tooling. **Never use for: cat, head, tail, sed, awk, grep, find, ls, wc, echo** — those have dedicated tools (`read_file` with offset/limit, `grep`, `list_directory`, `edit_file`, `multi_edit`). **Never use for: curl, wget, httpie, lynx, w3m, browsers, nc, telnet** — use `http_request` / `browse_url` / `screenshot_url` instead. The runner refuses standalone wrappers around those binaries and asks you to retry with the dedicated tool. Pass `cwd` as a parameter instead of `cd ... &&` prefixes. Output is capped at 30 KB — re-run with narrower options if you need more. Never use `--no-verify`, `git push --force`, or `git reset --hard` without explicit authorization.',
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
            { kinId: ctx.kinId, command, binary: violation.binary, reason: violation.reason },
            'Refused shell command',
          )
          const intro = violation.reason === 'wrapper'
            ? `Refusing to run \`${violation.binary}\` through run_shell — use the dedicated tool: ${violation.suggestion}.`
            : `\`${violation.binary}\` is banned through run_shell — use the dedicated tool: ${violation.suggestion}.`
          return {
            success: false,
            output: '',
            error:
              `${intro} ` +
              `run_shell is for git/builds/tests/package managers/language tooling. ` +
              `If you genuinely need this binary as part of a pipeline (e.g. piping its output through another command), include the pipe — this check only fires on standalone calls.`,
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
          const stdoutRaw = await new Response(proc.stdout).text()
          const stderrRaw = await new Response(proc.stderr).text()
          const executionTime = Date.now() - start

          const stdoutTrimmed = stdoutRaw.trim()
          const stderrTrimmed = stderrRaw.trim()
          const stdout = truncateOutput(stdoutTrimmed)
          const stderr = truncateOutput(stderrTrimmed)

          log.info(
            {
              kinId: ctx.kinId,
              command,
              executionTime,
              exitCode,
              success: exitCode === 0,
              truncated: stdout.truncated || stderr.truncated,
            },
            'Shell command executed',
          )

          const trimmedStderr = stderr.value || undefined

          return {
            success: exitCode === 0,
            output: stdout.value,
            stderr: trimmedStderr,
            ...(exitCode !== 0 && trimmedStderr ? { error: trimmedStderr } : {}),
            ...(stdout.truncated || stderr.truncated
              ? { truncated: true, omittedBytes: stdout.omitted + stderr.omitted }
              : {}),
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
