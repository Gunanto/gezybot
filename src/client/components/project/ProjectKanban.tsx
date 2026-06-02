import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  pointerWithin,
  rectIntersection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type CollisionDetection,
} from '@dnd-kit/core'
import { TicketColumn } from './TicketColumn'
import { TicketCard } from './TicketCard'
import { KanbanMobileBoard } from './KanbanMobileBoard'
import { useTickets } from '@/client/hooks/useTickets'
import { TICKET_STATUSES } from '@/shared/constants'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { Plus, Search, X } from 'lucide-react'
import { useSidePanel } from '@/client/contexts/SidePanelContext'
import { useIsMobile } from '@/client/hooks/use-mobile'
import type { TicketStatus, TicketSummary } from '@/shared/types'

interface ProjectKanbanProps {
  projectId: string
  onNewTicket: () => void
}

/**
 * Drag-drop strategy:
 *  - We keep a LOCAL copy of the tickets (`displayTickets`) that mirrors the
 *    hook's `tickets` (server-truth) but can be optimistically reordered during
 *    a drag.
 *  - `onDragOver` moves the dragged item across columns instantly as the cursor
 *    enters them, so the user sees the ticket follow the cursor instead of
 *    snapping back on drop.
 *  - `onDragEnd` persists the final position+status via a single API call. The
 *    SSE round-trip then reconciles `tickets` → `displayTickets` via useEffect.
 *
 * Collision detection prefers `pointerWithin` (only triggers when the pointer
 * is actually inside a droppable rect). Falls back to `rectIntersection` to
 * avoid losing the drop target near column edges.
 */
export function ProjectKanban({ projectId, onNewTicket }: ProjectKanbanProps) {
  const { t } = useTranslation()
  const { tickets, updateTicket, createTicket } = useTickets(projectId)
  const { openTicket } = useSidePanel()
  const isMobile = useIsMobile()
  // Mobile single-column view: which status column is currently shown.
  const [activeStatus, setActiveStatus] = useState<TicketStatus>('todo')

  /**
   * Quick inline create from a kanban column. Pre-binds the status so the new
   * ticket lands in the column the user clicked. We intentionally don't open
   * the side panel afterwards — the value of the quick-add is to stay in flow.
   * If the user wants to enrich the ticket (description, tags), they can click
   * the card to open it.
   */
  async function handleQuickCreate({ title, status }: { title: string; status: TicketStatus }) {
    await createTicket({ title, status })
  }

  const [displayTickets, setDisplayTickets] = useState<TicketSummary[]>(tickets)
  const [activeTicket, setActiveTicket] = useState<TicketSummary | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  // Keyboard shortcuts for the search bar:
  //  - `/` focuses it (when the user isn't already typing in another field)
  //  - Escape clears + blurs it when it's the active element
  // We listen on `window` so the shortcut works no matter where focus is in the kanban.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const isTypingElsewhere =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true
      if (e.key === '/' && !isTypingElsewhere && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      } else if (e.key === 'Escape' && document.activeElement === searchInputRef.current) {
        setSearchQuery('')
        searchInputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Sync local state with server truth whenever the upstream list changes
  // (SSE events, refetch, etc.). During a drag this is fine — useTickets debounces
  // events lightly and our optimistic update converges on the same final state.
  useEffect(() => {
    setDisplayTickets(tickets)
  }, [tickets])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  const collisionDetectionStrategy: CollisionDetection = (args) => {
    const pointerHits = pointerWithin(args)
    if (pointerHits.length > 0) return pointerHits
    return rectIntersection(args)
  }

  // Group tickets by status, sorted by position (rebuilds on every drag tick — keep cheap)
  // We keep ALL tickets in displayTickets (used by dnd-kit). The filter only
  // affects what gets rendered per column, so search and drag-drop don't
  // interfere with each other.
  const normalizedQuery = searchQuery.trim().toLowerCase()
  const byStatus = useMemo(() => {
    const map: Record<TicketStatus, TicketSummary[]> = {
      backlog: [],
      todo: [],
      in_progress: [],
      blocked: [],
      done: [],
    }
    for (const ticket of displayTickets) {
      if (normalizedQuery) {
        const titleMatch = ticket.title.toLowerCase().includes(normalizedQuery)
        const tagMatch = (ticket.tags ?? []).some((tg) => tg.label.toLowerCase().includes(normalizedQuery))
        if (!titleMatch && !tagMatch) continue
      }
      const s = ticket.status as TicketStatus
      if (map[s]) map[s].push(ticket)
    }
    for (const status of TICKET_STATUSES) {
      map[status].sort((a, b) => a.position - b.position)
    }
    return map
  }, [displayTickets, normalizedQuery])

  const totalMatches = useMemo(
    () => Object.values(byStatus).reduce((acc, list) => acc + list.length, 0),
    [byStatus],
  )

  function resolveTargetStatus(overId: string | number): TicketStatus | null {
    if (typeof overId === 'string' && overId.startsWith('column:')) {
      return overId.slice('column:'.length) as TicketStatus
    }
    const overTicket = displayTickets.find((t) => t.id === overId)
    return overTicket ? (overTicket.status as TicketStatus) : null
  }

  function handleDragStart(event: DragStartEvent) {
    const ticketId = event.active.id as string
    const ticket = displayTickets.find((t) => t.id === ticketId)
    if (ticket) setActiveTicket(ticket)
  }

  /** Move the dragged ticket between columns optimistically, so the user sees
   *  it follow during the drag (no snap-back on drop). Reordering within the
   *  same column is also reflected immediately. */
  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event
    if (!over) return

    const source = displayTickets.find((t) => t.id === active.id)
    if (!source) return

    const targetStatus = resolveTargetStatus(over.id)
    if (!targetStatus) return

    const overIsTicket = typeof over.id === 'string' && !over.id.startsWith('column:')

    if (source.status !== targetStatus) {
      // Cross-column move during drag — drop the ticket at the spot of the hovered
      // ticket (or end of column if hovering the empty area).
      setDisplayTickets((prev) => {
        const targetList = prev.filter((t) => t.status === targetStatus && t.id !== source.id)
        let insertIndex = targetList.length
        if (overIsTicket) {
          const idx = targetList.findIndex((t) => t.id === over.id)
          if (idx >= 0) insertIndex = idx
        }
        // Re-sequence positions inside the target list with the source inserted
        const nextTargetList = [...targetList]
        nextTargetList.splice(insertIndex, 0, { ...source, status: targetStatus })
        const repositioned = nextTargetList.map((t, i) => ({ ...t, position: (i + 1) * 1024 }))
        // Replace target-column items in the global list, keep others as-is
        return prev
          .filter((t) => t.status !== targetStatus && t.id !== source.id)
          .concat(repositioned)
      })
    } else if (overIsTicket && over.id !== source.id) {
      // Same-column reorder during drag
      setDisplayTickets((prev) => {
        const columnTickets = prev
          .filter((t) => t.status === targetStatus)
          .sort((a, b) => a.position - b.position)
        const fromIdx = columnTickets.findIndex((t) => t.id === source.id)
        const toIdx = columnTickets.findIndex((t) => t.id === over.id)
        if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return prev
        const reordered = [...columnTickets]
        const [moved] = reordered.splice(fromIdx, 1)
        if (!moved) return prev
        reordered.splice(toIdx, 0, moved)
        const repositioned = reordered.map((t, i) => ({ ...t, position: (i + 1) * 1024 }))
        return prev.filter((t) => t.status !== targetStatus).concat(repositioned)
      })
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveTicket(null)
    const { active, over } = event
    if (!over) {
      // Drag cancelled outside a droppable — revert local state to server truth
      setDisplayTickets(tickets)
      return
    }

    // displayTickets already reflects the desired final state thanks to onDragOver.
    // Persist whatever changed for this ticket vs. the server-truth `tickets`.
    const optimistic = displayTickets.find((t) => t.id === active.id)
    const original = tickets.find((t) => t.id === active.id)
    if (!optimistic || !original) return

    const statusChanged = optimistic.status !== original.status
    const positionChanged = optimistic.position !== original.position
    if (!statusChanged && !positionChanged) return

    updateTicket(active.id as string, {
      status: statusChanged ? (optimistic.status as TicketStatus) : undefined,
      position: optimistic.position,
    }).catch(() => {
      // Revert to server truth on failure (SSE may also do it)
      setDisplayTickets(tickets)
    })
  }

  function handleTicketClick(ticket: TicketSummary) {
    openTicket({ ticketId: ticket.id })
  }

  /**
   * Mobile "move to status" — the touch replacement for drag-and-drop. Reuses
   * the SAME `updateTicket` mutation the desktop `onDragEnd` calls, dropping the
   * ticket at the end of the target column (position after the current last one).
   */
  function handleMove(ticketId: string, targetStatus: TicketStatus) {
    const ticket = displayTickets.find((t) => t.id === ticketId)
    if (!ticket || ticket.status === targetStatus) return
    const targetTickets = displayTickets.filter((t) => t.status === targetStatus)
    const maxPosition = targetTickets.reduce((max, t) => Math.max(max, t.position), 0)
    const nextPosition = maxPosition + 1024
    // Optimistic local update so the card disappears from the current column
    // immediately; SSE reconciles displayTickets afterwards.
    setDisplayTickets((prev) =>
      prev.map((t) => (t.id === ticketId ? { ...t, status: targetStatus, position: nextPosition } : t)),
    )
    updateTicket(ticketId, { status: targetStatus, position: nextPosition }).catch(() => {
      setDisplayTickets(tickets)
    })
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        {/* Search — filters TicketCard rendering by title or tag, case-insensitive */}
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('projects.kanban.searchPlaceholder')}
            className="h-8 pl-7 pr-7 text-sm"
            aria-label={t('projects.kanban.searchPlaceholder')}
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-1 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              aria-label={t('projects.kanban.searchClear')}
            >
              <X className="size-3.5" />
            </button>
          ) : (
            // Discreet hint that "/" focuses the search bar. Mirrors the GitHub
            // pattern most devs are familiar with. Hidden on small screens to
            // avoid colliding with the placeholder text.
            <kbd
              aria-hidden
              className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-muted/60 px-1 text-[10px] font-medium text-muted-foreground sm:inline-block"
            >
              /
            </kbd>
          )}
        </div>
        {normalizedQuery && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {t('projects.kanban.searchResults', { count: totalMatches })}
          </span>
        )}
        <div className="flex-1" />
        <Button size="sm" onClick={onNewTicket}>
          <Plus className="mr-1 size-4" />
          {t('projects.kanban.newTicket')}
        </Button>
      </header>
      {isMobile ? (
        // Mobile (< 768px): single-column view with a status switcher + a
        // "move to status" action per card. No horizontal scroll, no touch dnd.
        <div className="flex-1 overflow-hidden">
          <KanbanMobileBoard
            byStatus={byStatus}
            activeStatus={activeStatus}
            onActiveStatusChange={setActiveStatus}
            onTicketClick={handleTicketClick}
            highlightQuery={normalizedQuery}
            onTagClick={(label) => setSearchQuery(label)}
            onQuickCreate={handleQuickCreate}
            onMove={handleMove}
          />
        </div>
      ) : (
        // Desktop (>= 768px): unchanged 5-column drag-and-drop board.
        <div className="flex-1 overflow-x-auto p-4">
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetectionStrategy}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
          >
            <div className="flex h-full gap-3">
              {TICKET_STATUSES.map((status) => (
                <TicketColumn
                  key={status}
                  status={status}
                  label={t(`projects.status.${status}`)}
                  tickets={byStatus[status]}
                  onTicketClick={handleTicketClick}
                  highlightQuery={normalizedQuery}
                  onTagClick={(label) => setSearchQuery(label)}
                  onQuickCreate={handleQuickCreate}
                />
              ))}
            </div>
            {/* Portal to <body> so the fixed-position overlay escapes the
                ProjectsPage `transform: translateZ(0)` containing block (that
                wrapper scopes the shadcn Sidebar's fixed positioning). Without
                the portal the drag ghost would be offset. */}
            {createPortal(
              <DragOverlay>
                {activeTicket ? <TicketCard ticket={activeTicket} isOverlay /> : null}
              </DragOverlay>,
              document.body,
            )}
          </DndContext>
        </div>
      )}
    </div>
  )
}
