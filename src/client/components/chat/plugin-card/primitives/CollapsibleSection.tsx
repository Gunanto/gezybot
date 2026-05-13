/**
 * CollapsibleSection: plugin-card wrapper for foldable content.
 *
 * Built on the shadcn Collapsible (Radix) so the rotate-on-open chevron
 * and data-[state=open]/closed transitions match the rest of the chat
 * UI. The trigger row shows a chevron, the label, and an optional badge
 * counter to the right (the renderer fills this in with the line count
 * when the wrapped content is a log-stream).
 *
 * Content fade comes from Tailwind's `animate-in fade-in` utilities
 * keyed off the Radix data-state attribute, giving a 150ms cross-fade
 * without measuring DOM heights ourselves.
 */

import { memo } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/client/components/ui/collapsible'

interface CollapsibleSectionProps {
  label: string
  defaultOpen?: boolean
  /**
   * Optional small badge shown on the right of the trigger. Used by the
   * plugin-card renderer to surface the `log-stream` line count without
   * forcing the user to open the section.
   */
  countBadge?: number | null
  children: React.ReactNode
}

export const CollapsibleSection = memo(function CollapsibleSection({
  label,
  defaultOpen = false,
  countBadge,
  children,
}: CollapsibleSectionProps) {
  const showBadge = typeof countBadge === 'number' && countBadge >= 0
  return (
    <Collapsible defaultOpen={defaultOpen} className="flex flex-col gap-1.5">
      <CollapsibleTrigger
        className={cn(
          'group flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-xs font-medium text-muted-foreground transition-colors',
          'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        )}
      >
        <ChevronDown className="size-3.5 shrink-0 transition-transform duration-150 group-data-[state=closed]:-rotate-90" />
        <span className="flex-1 text-left">{label}</span>
        {showBadge && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {countBadge} {countBadge === 1 ? 'line' : 'lines'}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          'overflow-hidden',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          'duration-150',
        )}
      >
        <div className="pl-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
})
