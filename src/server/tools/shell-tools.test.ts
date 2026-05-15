import { describe, it, expect, beforeEach, mock, afterEach, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { fullMockConfig } from '../../test-helpers'
import type { ToolRegistration } from '@/server/tools/types'

// ─── Mocks ───────────────────────────────────────────────────────────────────

const WORKSPACE_BASE = '/tmp/test-workspace-shell'

mock.module('@/server/config', () => ({
  config: {
    ...fullMockConfig,
    workspace: { baseDir: WORKSPACE_BASE },
  },
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}))

// Import after mocks
const { runShellTool, detectShellWrapper } = await import('./shell-tools')

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CTX = { kinId: 'test-kin-shell' } as any

function createTool() {
  return (runShellTool as ToolRegistration).create(CTX)
}

async function execute(params: Record<string, unknown>) {
  const t = createTool()
  // Access the execute function through the tool
  return (t as any).execute(params, { messages: [], toolCallId: 'test' })
}

// ─── Setup ───────────────────────────────────────────────────────────────────

const KIN_DIR = `${WORKSPACE_BASE}/test-kin-shell`

beforeAll(() => {
  mkdirSync(KIN_DIR, { recursive: true })
})

afterAll(() => {
  rmSync(WORKSPACE_BASE, { recursive: true, force: true })
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runShellTool', () => {
  describe('metadata', () => {
    it('has correct availability', () => {
      expect((runShellTool as ToolRegistration).availability).toEqual(['main', 'sub-kin'])
    })

    it('creates a tool with description', () => {
      const t = createTool() as any
      expect(t.description).toContain('shell')
    })
  })

  describe('successful execution', () => {
    it('runs a simple echo command', async () => {
      const result = await execute({ command: 'echo "hello world"' })
      expect(result.success).toBe(true)
      expect(result.output).toBe('hello world')
      expect(result.exitCode).toBe(0)
      expect(result.executionTime).toBeGreaterThanOrEqual(0)
    })

    it('returns trimmed output', async () => {
      const result = await execute({ command: 'echo "  padded  "' })
      expect(result.success).toBe(true)
      expect(result.output).toBe('padded')
    })

    it('returns multi-line output', async () => {
      const result = await execute({ command: 'echo "line1"; echo "line2"' })
      expect(result.success).toBe(true)
      expect(result.output).toContain('line1')
      expect(result.output).toContain('line2')
    })

    it('uses kin workspace as default cwd', async () => {
      const result = await execute({ command: 'pwd' })
      expect(result.success).toBe(true)
      expect(result.output).toBe(`${WORKSPACE_BASE}/test-kin-shell`)
    })

    it('uses custom cwd when provided', async () => {
      const result = await execute({ command: 'pwd', cwd: '/tmp' })
      expect(result.success).toBe(true)
      expect(result.output).toBe('/tmp')
    })

    it('sets KINBOT_KIN_ID environment variable', async () => {
      const result = await execute({ command: 'echo $KINBOT_KIN_ID' })
      expect(result.success).toBe(true)
      expect(result.output).toBe('test-kin-shell')
    })

    it('sets KINBOT_WORKSPACE environment variable', async () => {
      const result = await execute({ command: 'echo $KINBOT_WORKSPACE' })
      expect(result.success).toBe(true)
      expect(result.output).toBe(`${WORKSPACE_BASE}/test-kin-shell`)
    })
  })

  describe('failed commands', () => {
    it('returns success=false for non-zero exit code', async () => {
      const result = await execute({ command: 'exit 1' })
      expect(result.success).toBe(false)
      expect(result.exitCode).toBe(1)
    })

    it('captures stderr on failure', async () => {
      const result = await execute({ command: 'echo "error msg" >&2; exit 1' })
      expect(result.success).toBe(false)
      expect(result.stderr).toBe('error msg')
      expect(result.error).toBe('error msg')
    })

    it('does not include error field when stderr is empty on failure', async () => {
      const result = await execute({ command: 'exit 42' })
      expect(result.success).toBe(false)
      expect(result.exitCode).toBe(42)
      expect(result.error).toBeUndefined()
    })

    it('captures stderr even on success', async () => {
      const result = await execute({ command: 'echo "warn" >&2; echo "ok"' })
      expect(result.success).toBe(true)
      expect(result.output).toBe('ok')
      expect(result.stderr).toBe('warn')
    })

    it('handles command not found', async () => {
      const result = await execute({ command: 'nonexistent_command_xyz_123' })
      expect(result.success).toBe(false)
      expect(result.exitCode).toBe(127)
    })
  })

  describe('timeout handling', () => {
    it('kills process that exceeds timeout', async () => {
      const result = await execute({ command: 'sleep 30', timeout: 1000 })
      expect(result.success).toBe(false)
      expect(result.error).toContain('timeout')
      expect(result.exitCode).toBe(-1)
      expect(result.executionTime).toBeLessThan(5000)
    })

    it('succeeds within timeout', async () => {
      const result = await execute({ command: 'echo fast', timeout: 5000 })
      expect(result.success).toBe(true)
      expect(result.output).toBe('fast')
    })
  })

  describe('edge cases', () => {
    it('handles empty output', async () => {
      const result = await execute({ command: 'true' })
      expect(result.success).toBe(true)
      expect(result.output).toBe('')
    })

    it('handles binary-like output gracefully', async () => {
      const result = await execute({ command: 'printf "\\x00\\x01\\x02"' })
      expect(result.success).toBe(true)
      // Should not crash
    })

    it('handles large output', async () => {
      const result = await execute({ command: 'seq 1 1000' })
      expect(result.success).toBe(true)
      expect(result.output).toContain('1000')
    })

    it('handles pipe commands', async () => {
      const result = await execute({ command: 'echo "hello world" | wc -w' })
      expect(result.success).toBe(true)
      expect(result.output).toContain('2')
    })

    it('handles special characters in command', async () => {
      const result = await execute({ command: "echo 'quoted' && echo done" })
      expect(result.success).toBe(true)
      expect(result.output).toContain('quoted')
      expect(result.output).toContain('done')
    })

    it('handles subshell', async () => {
      const result = await execute({ command: 'X=$(echo nested); echo $X' })
      expect(result.success).toBe(true)
      expect(result.output).toBe('nested')
    })
  })

  describe('bash-wrapper detection', () => {
    it('refuses bare cat with a useful suggestion', async () => {
      const result = await execute({ command: 'cat package.json' })
      expect(result.success).toBe(false)
      expect(result.exitCode).toBe(-1)
      expect(result.error).toContain('read_file')
      expect(result.error).toContain('cat')
    })

    it('refuses head, tail, less, more', async () => {
      for (const bin of ['head', 'tail', 'less', 'more']) {
        const result = await execute({ command: `${bin} src/index.ts` })
        expect(result.success).toBe(false)
        expect(result.error).toContain('read_file')
      }
    })

    it('refuses ls', async () => {
      const result = await execute({ command: 'ls -la src' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('list_directory')
    })

    it('refuses bare grep/rg', async () => {
      for (const bin of ['grep', 'rg', 'ripgrep']) {
        const result = await execute({ command: `${bin} -n foo src/` })
        expect(result.success).toBe(false)
        expect(result.error).toContain('grep')
      }
    })

    it('refuses wc/sed/awk', async () => {
      for (const bin of ['wc', 'sed', 'awk']) {
        const result = await execute({ command: `${bin} src/index.ts` })
        expect(result.success).toBe(false)
      }
    })

    it('strips a leading `cd ... &&` before detection', async () => {
      const result = await execute({ command: 'cd kinbot-dev && cat src/index.ts' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('read_file')
    })

    it('allows the binary when it is part of a pipeline', async () => {
      // `bun test | grep error` is a legit composition — bun-test output piped through grep.
      // Detector should not refuse it (it only fires on standalone wrappers).
      expect(detectShellWrapper('bun test | grep error')).toBeNull()
      expect(detectShellWrapper('echo hi | wc -l')).toBeNull()
      expect(detectShellWrapper('git diff | head -5')).toBeNull()
    })

    it('allows redirections and command substitution', async () => {
      expect(detectShellWrapper('cat <(diff a b)')).toBeNull()
      expect(detectShellWrapper('cat > out.txt')).toBeNull()
      expect(detectShellWrapper('head $(ls -t | head -1)')).toBeNull()
    })

    it('allows chained commands', async () => {
      expect(detectShellWrapper('bun build && cat dist/index.js')).toBeNull()
      expect(detectShellWrapper('rm tmp.txt || ls tmp.txt')).toBeNull()
    })

    it('does not fire on unrelated commands', async () => {
      expect(detectShellWrapper('bun test')).toBeNull()
      expect(detectShellWrapper('git status')).toBeNull()
      expect(detectShellWrapper('npm install')).toBeNull()
      expect(detectShellWrapper('cd kinbot-dev && bun run build')).toBeNull()
    })

    it('detects regardless of leading whitespace and case', async () => {
      expect(detectShellWrapper('   CAT file.ts')).toEqual({ binary: 'cat', suggestion: expect.stringContaining('read_file'), reason: 'wrapper' })
      expect(detectShellWrapper('LS')).toEqual({ binary: 'ls', suggestion: expect.stringContaining('list_directory'), reason: 'wrapper' })
    })
  })

  describe('banned commands (network / browser)', () => {
    it('refuses curl, wget, httpie, xh — pointing at http_request', async () => {
      for (const bin of ['curl', 'wget', 'httpie', 'xh', 'aria2c']) {
        const result = await execute({ command: `${bin} https://example.com` })
        expect(result.success).toBe(false)
        expect(result.exitCode).toBe(-1)
        expect(result.error).toContain('http_request')
        expect(result.error).toContain('banned')
      }
    })

    it('refuses lynx, w3m, links — pointing at browse_url', async () => {
      for (const bin of ['lynx', 'w3m', 'links']) {
        const result = await execute({ command: `${bin} https://example.com` })
        expect(result.success).toBe(false)
        expect(result.error).toContain('browse_url')
      }
    })

    it('refuses GUI browsers as a symbolic ban', async () => {
      for (const bin of ['chrome', 'firefox', 'chromium']) {
        const result = await execute({ command: `${bin} https://example.com` })
        expect(result.success).toBe(false)
      }
    })

    it('refuses nc and telnet — pointing at http_request or asking', async () => {
      for (const bin of ['nc', 'telnet']) {
        const result = await execute({ command: `${bin} localhost 80` })
        expect(result.success).toBe(false)
      }
    })

    it('allows banned commands when used in a pipeline', async () => {
      // Same carve-out as for wrappers: pipelines / redirects are real
      // composition, not entrypoints. Don't refuse them — let the user
      // pipe whatever they need.
      expect(detectShellWrapper('echo hi | curl -d @- example.com')).toBeNull()
      expect(detectShellWrapper('git diff | wc -l')).toBeNull()
    })

    it('reports reason: "banned" vs "wrapper" in the violation', () => {
      const banned = detectShellWrapper('curl example.com')
      const wrapper = detectShellWrapper('cat file.ts')
      expect(banned?.reason).toBe('banned')
      expect(wrapper?.reason).toBe('wrapper')
    })
  })

  describe('output truncation', () => {
    it('returns small outputs unchanged', async () => {
      const result = await execute({ command: 'echo hello' })
      expect(result.success).toBe(true)
      expect(result.output).toBe('hello')
      expect((result as Record<string, unknown>).truncated).toBeUndefined()
    })

    it('caps very large stdout and reports truncation in the response', async () => {
      // Produce ~120 KB of output with one line at the end the model is
      // most likely to care about. Truncation keeps the tail.
      const result = await execute({
        command: "printf 'x%.0s' $(seq 1 120000); printf '\\nMARKER_END\\n'",
        timeout: 60000,
      })
      expect(result.success).toBe(true)
      expect(result.output.length).toBeLessThanOrEqual(40_000) // 30k cap + truncation header
      expect(result.output).toContain('MARKER_END')
      expect(result.output).toContain('truncated')
      expect((result as Record<string, unknown>).truncated).toBe(true)
    })
  })
})
