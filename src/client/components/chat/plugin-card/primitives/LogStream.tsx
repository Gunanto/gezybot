/**
 * LogStream: streaming text output for plugin cards.
 *
 * Renders log lines inside a monospace <pre> block with a muted
 * background. The container scrolls vertically (height capped by
 * `maxHeight`, default 300px). Long single lines wrap rather than
 * scrolling horizontally, since these are conversational logs not
 * terminal output that needs alignment.
 *
 * Auto-scroll follows the classic terminal UX: as new lines arrive we
 * keep the view pinned to the bottom only if the user was already at
 * the bottom. If the user has scrolled up to inspect earlier output we
 * leave the scroll position alone so they do not lose their place.
 */

import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { cn } from '@/client/lib/utils'

interface LogStreamProps {
  lines: string[]
  autoscroll?: boolean
  maxHeight?: number
}

// Treat anything within this many pixels of the bottom as "at the
// bottom". The browser's scrollTop is fractional after some zoom levels
// so a strict equality check would miss the pin condition.
const BOTTOM_THRESHOLD_PX = 24

export const LogStream = memo(function LogStream({
  lines,
  autoscroll = true,
  maxHeight = 300,
}: LogStreamProps) {
  const ref = useRef<HTMLPreElement>(null)
  const wasAtBottomRef = useRef(true)
  const safeLines = Array.isArray(lines) ? lines : []

  // Measure scroll position before each render. If the user is already
  // at the bottom we will repin after the new lines render; otherwise
  // we leave the position alone.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop
    wasAtBottomRef.current = distance <= BOTTOM_THRESHOLD_PX
  })

  useEffect(() => {
    if (!autoscroll) return
    const el = ref.current
    if (!el) return
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [safeLines.length, autoscroll])

  return (
    <pre
      ref={ref}
      className={cn(
        'm-0 rounded-md border border-border/60 bg-muted/30 px-3 py-2',
        'overflow-y-auto overflow-x-hidden font-mono text-xs leading-relaxed text-muted-foreground',
        'whitespace-pre-wrap break-all',
      )}
      style={{ maxHeight }}
    >
      {safeLines.length === 0 ? (
        <span className="italic opacity-60">No output yet.</span>
      ) : (
        safeLines.join('\n')
      )}
    </pre>
  )
})
