/**
 * Custom-tool RESULT RENDERER bundler (host-context React).
 *
 * A custom tool MAY ship an optional `renderer.tsx` (fallback `renderer.jsx` /
 * `renderer.js`) that default-exports a React component:
 *
 *     export default function Renderer({ result, args, ui }) { … }
 *
 * The component is bundled SERVER-SIDE and served as an ESM module that the chat
 * client loads at runtime via `React.lazy(() => import(url))`. It shares the
 * HOST's single React instance — exposed on the page as `window.__KINBOT_REACT__`
 * (see src/client/main.tsx) — so hooks work (no "Invalid hook call") and it
 * inherits the app theme through the cascading `--color-*` CSS variables.
 *
 * Bundling recipe (proven end-to-end before productionizing):
 *   - Bun's native bundler (Bun.build) — bundles the renderer's LOCAL imports
 *     (anything inside the tool dir) into a single ESM module.
 *   - Classic JSX transform (React.createElement / React.Fragment) so the output
 *     only needs a `React` binding — no react/jsx-runtime import.
 *   - A banner `const React = window.__KINBOT_REACT__;` backs that free `React`
 *     binding for renderers that DON'T import React (the documented contract).
 *   - A resolver plugin maps any bare `react` / `react-dom` import to the same
 *     host globals, so a renderer that DOES `import React from 'react'` still
 *     works and the output never contains an unresolved bare import (the browser
 *     would otherwise fail with "Failed to resolve module specifier 'react'").
 *
 * THREAT MODEL: host-context renderers run with full host privileges (no
 * isolation). This is acceptable because custom tools are trusted (user/Kin-
 * authored on a self-hosted instance) and the renderer is for RESULT DISPLAY
 * only.
 *
 * The built output is cached in memory keyed by slug + the renderer file's mtime
 * so we only rebuild when the source changes.
 */

import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { createLogger } from '@/server/logger'
import { getCustomTool, toolDir } from '@/server/services/custom-tools'

const log = createLogger('custom-tool-renderer')

/** Renderer entry filenames, in resolution order. */
const RENDERER_CANDIDATES = ['renderer.tsx', 'renderer.jsx', 'renderer.js'] as const

/** Binds the host's single React instance to the free `React` global the classic
 *  JSX transform emits. Keeps hooks working (shared React, no duplicate). */
const REACT_BANNER = 'const React = window.__KINBOT_REACT__;'

/**
 * Bun.build plugin: resolve any bare react / react-dom import to a virtual module
 * that re-exports from the host globals. Two payoffs:
 *   - a renderer that imports React works (resolves to the same host instance);
 *   - the output never contains an unresolved bare specifier the browser can't
 *     load (no import map exists on the chat page).
 */
const reactGlobalPlugin: import('bun').BunPlugin = {
  name: 'kinbot-react-global',
  setup(build) {
    build.onResolve({ filter: /^(react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client)$/ }, (args) => ({
      path: args.path,
      namespace: 'kinbot-react-global',
    }))
    build.onLoad({ filter: /.*/, namespace: 'kinbot-react-global' }, (args) => {
      if (args.path.startsWith('react-dom')) {
        return {
          loader: 'js',
          contents:
            'const RD = (window.__KINBOT_REACT_DOM__ || {});' +
            'export default RD;' +
            'export const createPortal = RD.createPortal, flushSync = RD.flushSync, createRoot = RD.createRoot;',
        }
      }
      // react/jsx-runtime + react/jsx-dev-runtime — the AUTOMATIC JSX runtime
      // (Bun emits jsx/jsxs/jsxDEV regardless of the classic-jsx option above).
      // CRITICAL: these must NOT be aliased to React.createElement. Their
      // signatures differ — children live in `props.children`, and the 3rd+
      // positional args are `key` / `isStaticChildren` / `source` / `self`.
      // Aliasing to createElement makes those extra args get treated as children
      // and CLOBBER the real `props.children` → components render empty. So we
      // re-implement jsx/jsxs/jsxDEV correctly over the host createElement.
      if (args.path.includes('jsx-runtime') || args.path.includes('jsx-dev-runtime')) {
        return {
          loader: 'js',
          contents: [
            'const R = window.__KINBOT_REACT__;',
            'const Fragment = R.Fragment;',
            'function jsx(type, props, key) {',
            '  const p = props || {};',
            '  const rest = {};',
            "  for (const k in p) { if (k !== 'children') rest[k] = p[k]; }",
            '  if (key !== undefined) rest.key = key;',
            '  return p.children === undefined',
            '    ? R.createElement(type, rest)',
            '    : R.createElement(type, rest, p.children);',
            '}',
            'export { jsx, jsx as jsxs, jsx as jsxDEV, Fragment };',
            'export default { jsx, jsxs: jsx, jsxDEV: jsx, Fragment };',
          ].join('\n'),
        }
      }
      // react — re-export the host React instance + its common named exports so
      // both default and named imports resolve to the host instance.
      return {
        loader: 'js',
        contents:
          'const R = window.__KINBOT_REACT__;' +
          'export default R;' +
          'export const useState=R.useState,useEffect=R.useEffect,useLayoutEffect=R.useLayoutEffect,' +
          'useMemo=R.useMemo,useRef=R.useRef,useCallback=R.useCallback,useReducer=R.useReducer,' +
          'useContext=R.useContext,createContext=R.createContext,useId=R.useId,useTransition=R.useTransition,' +
          'useDeferredValue=R.useDeferredValue,useSyncExternalStore=R.useSyncExternalStore,' +
          'Fragment=R.Fragment,createElement=R.createElement,cloneElement=R.cloneElement,' +
          'isValidElement=R.isValidElement,memo=R.memo,forwardRef=R.forwardRef,Children=R.Children;',
      }
    })
  },
}

/** Cache entry: the built ESM string + the mtime it was built from. */
interface CacheEntry {
  mtimeMs: number
  js: string
}

const cache = new Map<string, CacheEntry>()

/** Locate the renderer entry file for a tool. Returns its absolute path + mtime,
 *  or null when the tool ships no renderer. */
function findRendererFile(slug: string): { path: string; mtimeMs: number } | null {
  const dir = toolDir(slug)
  for (const candidate of RENDERER_CANDIDATES) {
    const abs = join(dir, candidate)
    if (existsSync(abs)) {
      try {
        return { path: abs, mtimeMs: statSync(abs).mtimeMs }
      } catch {
        /* race: file vanished between exists + stat — keep looking */
      }
    }
  }
  return null
}

/**
 * Cheap presence check used by the catalog / name-map so the client only attempts
 * to load a renderer when one exists. Pure filesystem (no bundling).
 */
export function customToolHasRenderer(slug: string): boolean {
  return findRendererFile(slug) !== null
}

/**
 * Build (and cache) the custom tool's renderer as a server-bundled ESM string.
 * Returns null when the tool has no renderer file. Throws with a clean message
 * when bundling fails (the route turns that into a 500 with the message).
 *
 * Cache key is slug; we rebuild only when the renderer file's mtime changes.
 */
export async function buildCustomToolRenderer(slug: string): Promise<string | null> {
  if (!getCustomTool(slug)) return null

  const entry = findRendererFile(slug)
  if (!entry) return null

  const cached = cache.get(slug)
  if (cached && cached.mtimeMs === entry.mtimeMs) return cached.js

  const result = await Bun.build({
    entrypoints: [entry.path],
    format: 'esm',
    target: 'browser',
    // Classic JSX → React.createElement / React.Fragment, leaving `React` as a
    // free global (backed by the banner / resolver plugin).
    jsx: { runtime: 'classic', factory: 'React.createElement', fragment: 'React.Fragment' },
    banner: REACT_BANNER,
    plugins: [reactGlobalPlugin],
    // Local imports within the tool dir are bundled; react/react-dom are handled
    // by the resolver plugin above (never left as bare specifiers).
  }).catch((err: unknown) => {
    // Bun.build rejects (rather than returning success:false) for some failures.
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Renderer build failed for "${slug}": ${message}`)
  })

  if (!result.success || result.outputs.length === 0) {
    const message = result.logs.map((l) => l.message).join('\n') || 'unknown bundling error'
    log.warn({ slug, message }, 'Custom tool renderer build failed')
    throw new Error(`Renderer build failed for "${slug}": ${message}`)
  }

  const js = await result.outputs[0]!.text()
  cache.set(slug, { mtimeMs: entry.mtimeMs, js })
  log.debug({ slug, bytes: js.length }, 'Custom tool renderer built')
  return js
}

/** Test-only: clear the in-memory build cache. */
export function _resetRendererCache(): void {
  cache.clear()
}
