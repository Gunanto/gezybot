import { useEffect, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Pin, PinOff, Plus, Search, Trash2, Edit2, BookOpen, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { Textarea } from '@/client/components/ui/textarea'
import { Badge } from '@/client/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/client/components/ui/dialog'
import { Label } from '@/client/components/ui/label'
import { Switch } from '@/client/components/ui/switch'
import { EmptyState } from '@/client/components/common/EmptyState'
import { useProjectKnowledge, useProjectKnowledgeMutations } from '@/client/hooks/useProjectKnowledge'
import { getErrorMessage } from '@/client/lib/api'
import { cn } from '@/client/lib/utils'
import type { ProjectKnowledge } from '@/shared/types'

interface Props {
  projectId: string
}

type FilterPin = 'all' | 'pinned' | 'unpinned'

const PAGE_SIZE = 20

export function ProjectKnowledgePanel({ projectId }: Props) {
  const { t } = useTranslation()

  const [query, setQuery] = useState('')
  const [filterPin, setFilterPin] = useState<FilterPin>('all')
  const [page, setPage] = useState(0)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<ProjectKnowledge | null>(null)

  // Reset to page 0 whenever the filter set changes — otherwise narrowing a
  // filter could leave the user stranded on an empty page beyond the new total.
  useEffect(() => {
    setPage(0)
  }, [query, filterPin, projectId])

  const filters = useMemo(
    () => ({
      q: query.trim() || undefined,
      pinned: filterPin === 'pinned' ? true : filterPin === 'unpinned' ? false : undefined,
      limit: PAGE_SIZE,
      // In search mode the backend returns top-N by relevance and ignores
      // offset, so passing it costs nothing but keeps the list path correct.
      offset: page * PAGE_SIZE,
    }),
    [query, filterPin, page],
  )

  const { entries, total, mode, isLoading, refetch } = useProjectKnowledge(projectId, filters)
  // Hide pagination in search mode (ranked top-N, not a page slice).
  const showPagination = mode === 'list' && total > PAGE_SIZE
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const hasMore = page < pageCount - 1

  // If the current page is now beyond the last (e.g. last item of a page was
  // just deleted), snap back to the last available page. Without this the
  // user would see an empty page with no way to know there's content earlier.
  useEffect(() => {
    if (mode === 'list' && !isLoading && page > 0 && page >= pageCount) {
      setPage(pageCount - 1)
    }
  }, [mode, isLoading, page, pageCount])
  const { create, update, remove, togglePin } = useProjectKnowledgeMutations(projectId)

  const pinnedCount = entries.filter((e) => e.pinned).length

  async function handleCreate(input: { content: string; category: string | null; pinned: boolean }) {
    try {
      await create(input)
      toast.success(t('projects.knowledge.toast.created'))
      await refetch()
      setEditorOpen(false)
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  async function handleUpdate(
    id: string,
    input: { content: string; category: string | null; pinned: boolean },
  ) {
    try {
      await update(id, input)
      toast.success(t('projects.knowledge.toast.updated'))
      await refetch()
      setEditorOpen(false)
      setEditing(null)
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t('projects.knowledge.confirmDelete'))) return
    try {
      await remove(id)
      toast.success(t('projects.knowledge.toast.deleted'))
      await refetch()
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  async function handleTogglePin(entry: ProjectKnowledge) {
    try {
      await togglePin(entry.id, !entry.pinned)
      await refetch()
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('projects.knowledge.searchPlaceholder')}
            className="pl-8"
          />
        </div>
        <div className="flex gap-1">
          {(['all', 'pinned', 'unpinned'] as const).map((opt) => (
            <Button
              key={opt}
              type="button"
              size="sm"
              variant={filterPin === opt ? 'default' : 'outline'}
              onClick={() => setFilterPin(opt)}
              disabled={!!filters.q && opt !== 'all'}
            >
              {t(`projects.knowledge.filter.${opt}`)}
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null)
            setEditorOpen(true)
          }}
        >
          <Plus className="size-4" />
          {t('projects.knowledge.add')}
        </Button>
      </div>

      <div className="border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
        {mode === 'search'
          ? t('projects.knowledge.searchResults', { count: entries.length, total })
          : t('projects.knowledge.summary', { pinned: pinnedCount, total })}
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-auto p-4">
          {isLoading && entries.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title={mode === 'search' ? t('projects.knowledge.empty.searchTitle') : t('projects.knowledge.empty.title')}
            description={
              mode === 'search'
                ? t('projects.knowledge.empty.searchDescription')
                : t('projects.knowledge.empty.description')
            }
            actionLabel={mode === 'search' ? undefined : t('projects.knowledge.add')}
            onAction={mode === 'search' ? undefined : () => setEditorOpen(true)}
          />
        ) : (
          <ul className="space-y-2">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className={cn(
                  'surface-card rounded-lg p-3 transition-colors',
                  entry.pinned && 'border-primary/30',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {entry.pinned && (
                        <Badge variant="default" className="gap-1">
                          <Pin className="size-3" />
                          {t('projects.knowledge.pinnedBadge')}
                        </Badge>
                      )}
                      {entry.category && <Badge variant="secondary">{entry.category}</Badge>}
                      <span>
                        {entry.authorKinName
                          ? t('projects.knowledge.byKin', { name: entry.authorKinName })
                          : t('projects.knowledge.byUser')}
                      </span>
                    </div>
                    <div className="mt-1.5 whitespace-pre-wrap text-sm">{entry.content}</div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => handleTogglePin(entry)}
                      title={entry.pinned ? t('projects.knowledge.unpin') : t('projects.knowledge.pin')}
                    >
                      {entry.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        setEditing(entry)
                        setEditorOpen(true)
                      }}
                      title={t('projects.knowledge.edit')}
                    >
                      <Edit2 className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => handleDelete(entry.id)}
                      title={t('projects.knowledge.delete')}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        </div>

        {showPagination && (
          <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs">
            <span className="text-muted-foreground">
              {t('projects.knowledge.pagination', {
                from: page * PAGE_SIZE + 1,
                to: Math.min((page + 1) * PAGE_SIZE, total),
                total,
              })}
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={page === 0 || isLoading}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="size-4" />
                {t('common.previous')}
              </Button>
              <span className="px-2 tabular-nums text-muted-foreground">
                {page + 1} / {pageCount}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!hasMore || isLoading}
                onClick={() => setPage((p) => p + 1)}
              >
                {t('common.next')}
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      <KnowledgeEditorDialog
        open={editorOpen}
        editing={editing}
        onOpenChange={(open) => {
          setEditorOpen(open)
          if (!open) setEditing(null)
        }}
        onSubmit={(input) => {
          if (editing) {
            void handleUpdate(editing.id, input)
          } else {
            void handleCreate(input)
          }
        }}
      />
    </div>
  )
}

interface EditorProps {
  open: boolean
  editing: ProjectKnowledge | null
  onOpenChange: (open: boolean) => void
  onSubmit: (input: { content: string; category: string | null; pinned: boolean }) => void
}

function KnowledgeEditorDialog({ open, editing, onOpenChange, onSubmit }: EditorProps) {
  const { t } = useTranslation()
  const [content, setContent] = useState('')
  const [category, setCategory] = useState('')
  const [pinned, setPinned] = useState(false)

  // Reset form when dialog opens. Without this, switching from create to edit
  // (or vice versa) without closing the dialog would leave stale values.
  useEffect(() => {
    if (open) {
      setContent(editing?.content ?? '')
      setCategory(editing?.category ?? '')
      setPinned(editing?.pinned ?? false)
    }
  }, [open, editing])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = content.trim()
    if (!trimmed) return
    onSubmit({ content: trimmed, category: category.trim() || null, pinned })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {editing ? t('projects.knowledge.dialog.editTitle') : t('projects.knowledge.dialog.createTitle')}
            </DialogTitle>
            <DialogDescription>{t('projects.knowledge.dialog.description')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-3">
            <div className="space-y-1.5">
              <Label htmlFor="pk-content">{t('projects.knowledge.dialog.contentLabel')}</Label>
              <Textarea
                id="pk-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={t('projects.knowledge.dialog.contentPlaceholder')}
                rows={5}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pk-category">{t('projects.knowledge.dialog.categoryLabel')}</Label>
              <Input
                id="pk-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder={t('projects.knowledge.dialog.categoryPlaceholder')}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border border-border p-2.5">
              <div>
                <Label htmlFor="pk-pinned" className="cursor-pointer">
                  {t('projects.knowledge.dialog.pinnedLabel')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('projects.knowledge.dialog.pinnedHint')}
                </p>
              </div>
              <Switch id="pk-pinned" checked={pinned} onCheckedChange={setPinned} />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!content.trim()}>
              {editing ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
