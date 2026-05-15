import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Badge } from '@/client/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/client/components/ui/tooltip'
import { Loader2, ListChecks, Clock } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '@/client/lib/time'
import { TicketReporterBadge } from '@/client/components/project/TicketReporterBadge'
import type { TicketSummary } from '@/shared/types'

interface TicketCardProps {
  ticket: TicketSummary
  onClick?: () => void
  isOverlay?: boolean
  /** Lowercased, trimmed search query. When non-empty, matching substrings in
   *  the title and tag labels are wrapped in a `<mark>` for visual feedback. */
  highlightQuery?: string
}

/**
 * Split a string around case-insensitive occurrences of `query` and wrap matches
 * in `<mark>`. Returns the raw string when `query` is empty or has no match,
 * keeping the call cheap on the common (unfiltered) render path.
 */
function highlightMatches(text: string, query: string) {
  if (!query) return text
  const lowerText = text.toLowerCase()
  const idx = lowerText.indexOf(query)
  if (idx < 0) return text
  const parts: Array<string | { match: string }> = []
  let cursor = 0
  let next = idx
  while (next >= 0) {
    if (next > cursor) parts.push(text.slice(cursor, next))
    parts.push({ match: text.slice(next, next + query.length) })
    cursor = next + query.length
    next = lowerText.indexOf(query, cursor)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts.map((part, i) =>
    typeof part === 'string' ? (
      <span key={i}>{part}</span>
    ) : (
      <mark
        key={i}
        className="rounded-sm bg-primary/25 px-0.5 text-foreground"
      >
        {part.match}
      </mark>
    ),
  )
}

export function TicketCard({ ticket, onClick, isOverlay = false, highlightQuery }: TicketCardProps) {
  const { t } = useTranslation()
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: ticket.id,
    data: { type: 'ticket', ticket },
  })

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  }

  const hasRunning = ticket.runningKins.length > 0
  const visibleRunning = ticket.runningKins.slice(0, 3)
  const overflowRunning = ticket.runningKins.length - visibleRunning.length
  const normalizedQuery = (highlightQuery ?? '').trim().toLowerCase()

  // Distinguish created vs. updated: if updated more than 1 minute after creation
  // we treat it as a meaningful edit and prefer surfacing that timestamp.
  const wasEdited = ticket.updatedAt - ticket.createdAt > 60_000
  const displayedTs = wasEdited ? ticket.updatedAt : ticket.createdAt
  const fullDate = new Date(displayedTs).toLocaleString()

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={cn(
        'group relative cursor-grab rounded-lg border border-border bg-card p-3 shadow-sm transition-shadow active:cursor-grabbing',
        isDragging && !isOverlay && 'opacity-30',
        isOverlay && 'shadow-lg',
        // Running emphasis: subtle pulse glow ring while a task is in flight
        hasRunning && 'ring-1 ring-primary/40 shadow-primary/10 animate-running-pulse',
      )}
      {...attributes}
      {...listeners}
    >
      <button
        type="button"
        // Use pointer-up on a tiny click instead of full click, so drag doesn't trigger
        onClick={(e) => {
          // dnd-kit blocks click while dragging; this still fires for short clicks
          e.stopPropagation()
          onClick?.()
        }}
        className="block w-full text-left"
      >
        <div className="flex items-start gap-1.5">
          <h3 className="line-clamp-2 flex-1 text-sm font-medium leading-snug">
            {highlightMatches(ticket.title, normalizedQuery)}
          </h3>
          {ticket.reporter && (
            <TicketReporterBadge reporter={ticket.reporter} variant="compact" size="size-4" />
          )}
        </div>

        {ticket.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {ticket.tags.slice(0, 4).map((tag) => (
              <Badge
                key={tag.id}
                variant="secondary"
                className="px-1.5 py-0 text-[10px] font-normal"
                style={{
                  backgroundColor: `${tag.color}20`,
                  color: tag.color,
                  borderColor: `${tag.color}40`,
                }}
              >
                {tag.label}
              </Badge>
            ))}
            {ticket.tags.length > 4 && (
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
                +{ticket.tags.length - 4}
              </Badge>
            )}
          </div>
        )}

        <div className="mt-2 flex items-center justify-between gap-2 text-xs">
          {/* Left side: running indicator OR plain task count */}
          {hasRunning ? (
            <span className="inline-flex items-center gap-1 text-primary">
              <Loader2 className="size-3 animate-spin" />
              <span className="font-medium">
                {t('projects.ticketCard.running', { count: ticket.runningTaskCount })}
              </span>
            </span>
          ) : ticket.taskCount > 0 ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <ListChecks className="size-3" />
              {t('projects.ticketCard.taskCount', { count: ticket.taskCount })}
            </span>
          ) : (
            <span />
          )}

          {/* Right side: running Kins avatar stack OR timestamp.
              When a task is running, the avatars win the slot — the running
              signal is more relevant than age. Otherwise we surface the
              creation/update timestamp with a tooltip carrying the full date. */}
          {hasRunning ? (
            <div
              className="flex items-center -space-x-1.5"
              onClick={(e) => e.stopPropagation()}
            >
              {visibleRunning.map((rk, i) => {
                const initials = rk.kinName.slice(0, 2).toUpperCase()
                return (
                  <Tooltip key={`${rk.taskId}-${i}`}>
                    <TooltipTrigger asChild>
                      <span>
                        <Avatar className="size-5 ring-2 ring-card">
                          {rk.avatarUrl && <AvatarImage src={rk.avatarUrl} alt={rk.kinName} />}
                          <AvatarFallback className="text-[9px] bg-secondary">{initials}</AvatarFallback>
                        </Avatar>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <span className="text-xs">
                        {t('projects.ticketCard.kinRunning', { name: rk.kinName })}
                      </span>
                    </TooltipContent>
                  </Tooltip>
                )
              })}
              {overflowRunning > 0 && (
                <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground ring-2 ring-card">
                  +{overflowRunning}
                </span>
              )}
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground/70">
                  <Clock className="size-3" aria-hidden />
                  {formatRelativeTime(displayedTs)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <span className="text-xs">
                  {t(
                    wasEdited
                      ? 'projects.ticketCard.updatedAt'
                      : 'projects.ticketCard.createdAt',
                    { date: fullDate },
                  )}
                </span>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </button>
    </article>
  )
}
