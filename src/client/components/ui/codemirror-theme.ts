import { EditorView } from '@codemirror/view'

/** Read a CSS variable from :root and resolve to hex via Canvas 2D */
export function cssVarToHex(varName: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  if (!raw) return fallback
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d')
    if (!ctx) return fallback
    ctx.fillStyle = raw
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return `#${d[0]!.toString(16).padStart(2, '0')}${d[1]!.toString(16).padStart(2, '0')}${d[2]!.toString(16).padStart(2, '0')}`
  } catch {
    return fallback
  }
}

/**
 * Build a CodeMirror theme extension driven by the app's CSS design tokens so
 * the editor matches the active palette (dark/light + palette overrides).
 * Shared by both the markdown editor and the generic code editor.
 */
export function buildThemeExtension(isDark: boolean) {
  const bg = cssVarToHex('--color-background', isDark ? '#1a1a2e' : '#fafafa')
  const fg = cssVarToHex('--color-foreground', isDark ? '#fafafa' : '#1a1a2e')
  const primary = cssVarToHex('--color-primary', '#7c3aed')
  const muted = cssVarToHex('--color-muted', isDark ? '#2a2a3e' : '#f0f0f5')
  const mutedFg = cssVarToHex('--color-muted-foreground', '#6b6b80')

  return EditorView.theme({
    '&': {
      backgroundColor: bg,
      color: fg,
      fontSize: '13px',
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    },
    '.cm-content': {
      padding: '12px 0',
      lineHeight: '20px',
      caretColor: primary,
    },
    '.cm-cursor': {
      borderLeftColor: primary,
    },
    '&.cm-focused .cm-cursor': {
      borderLeftColor: primary,
    },
    '.cm-gutters': {
      backgroundColor: bg,
      color: mutedFg + '80',
      border: 'none',
      minWidth: '3em',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: primary,
    },
    '.cm-activeLine': {
      backgroundColor: muted + '40',
    },
    '&.cm-focused .cm-activeLine': {
      backgroundColor: muted + '60',
    },
    '.cm-selectionBackground': {
      backgroundColor: primary + '30 !important',
    },
    '&.cm-focused .cm-selectionBackground': {
      backgroundColor: primary + '30 !important',
    },
    '.cm-line': {
      padding: '0 12px 0 4px',
    },
    '.cm-scroller': {
      overflow: 'auto',
    },
    '.cm-scroller::-webkit-scrollbar': {
      width: '8px',
    },
    '.cm-scroller::-webkit-scrollbar-thumb': {
      backgroundColor: mutedFg + '20',
      borderRadius: '4px',
    },
    '.cm-scroller::-webkit-scrollbar-thumb:hover': {
      backgroundColor: mutedFg + '40',
    },
    // Search panel (Mod-F) — token-driven so it matches every palette.
    '.cm-panels': {
      backgroundColor: muted,
      color: fg,
      borderColor: mutedFg + '30',
    },
    '.cm-search.cm-panel input, .cm-textfield': {
      backgroundColor: bg,
      color: fg,
      border: `1px solid ${mutedFg}40`,
      borderRadius: '4px',
      padding: '2px 6px',
    },
    '.cm-button': {
      backgroundColor: bg,
      backgroundImage: 'none',
      color: fg,
      border: `1px solid ${mutedFg}40`,
      borderRadius: '4px',
    },
    '.cm-button:hover': {
      backgroundColor: muted,
    },
    '.cm-search label': {
      color: mutedFg,
    },
    '.cm-searchMatch': {
      backgroundColor: primary + '30',
    },
    '.cm-searchMatch-selected': {
      backgroundColor: primary + '66',
    },
    '.cm-selectionMatch': {
      backgroundColor: primary + '22',
    },
    // Syntax colors
    '.cm-header': { color: primary, fontWeight: 'bold' },
    '.cm-strong': { fontWeight: 'bold' },
    '.cm-emphasis': { fontStyle: 'italic' },
    '.cm-link': { color: cssVarToHex('--color-info', '#3b82f6'), textDecoration: 'none' },
    '.cm-url': { color: mutedFg },
    '.cm-meta': { color: primary },
    '.cm-comment': { color: mutedFg, fontStyle: 'italic' },
    // Fenced code
    '.cm-monospace': { color: cssVarToHex('--color-success', '#22c55e') },
    // Focus outline handled by parent wrapper
    '&.cm-focused': {
      outline: 'none',
    },
  }, { dark: isDark })
}
