import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, ChevronDown, Loader2, Square, X } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import type { TaskTodo, TaskTodoStatus } from '@/shared/types'

interface TaskTodoListProps {
  todos: TaskTodo[]
}

function statusIcon(status: TaskTodoStatus) {
  switch (status) {
    case 'completed':
      return <Check className="size-3.5 text-success" />
    case 'in_progress':
      return <Loader2 className="size-3.5 animate-spin text-primary" />
    case 'cancelled':
      return <X className="size-3.5 text-muted-foreground" />
    default:
      return <Square className="size-3.5 text-muted-foreground" />
  }
}

function rowClasses(status: TaskTodoStatus): string {
  switch (status) {
    case 'completed':
      return 'text-muted-foreground line-through'
    case 'in_progress':
      return 'text-foreground font-medium'
    case 'cancelled':
      return 'text-muted-foreground/70 line-through opacity-70'
    default:
      return 'text-foreground/90'
  }
}

/**
 * Renders the structured plan a sub-Kin maintains via the `task_todos` tool.
 * Header is always visible; details collapse so the list doesn't push the
 * message log off-screen on long plans.
 */
export const TaskTodoList = memo(function TaskTodoList({ todos }: TaskTodoListProps) {
  const { t } = useTranslation()
  const completed = todos.filter((t) => t.status === 'completed').length
  const inProgress = todos.find((t) => t.status === 'in_progress')
  const total = todos.length
  const [expanded, setExpanded] = useState(true)

  return (
    <section className="shrink-0 border-b border-border bg-muted/20">
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
        <span className="font-medium text-foreground">
          {t('taskDetail.todos.title')}
        </span>
        <span className="text-muted-foreground">
          {t('taskDetail.todos.progress', { completed, total })}
        </span>
        {inProgress && !expanded && (
          <span className="ml-auto inline-flex items-center gap-1 text-primary truncate max-w-[60%]">
            <Loader2 className="size-3 animate-spin shrink-0" />
            <span className="truncate">{inProgress.subject}</span>
          </span>
        )}
      </button>

      {expanded && (
        <ol className="px-3 pb-2 space-y-1">
          {todos.map((todo) => (
            <li
              key={todo.id}
              className={cn('flex items-start gap-2 text-xs leading-snug', rowClasses(todo.status))}
            >
              <span className="shrink-0 mt-0.5">{statusIcon(todo.status)}</span>
              <span className="flex-1 min-w-0 whitespace-pre-wrap break-words">{todo.subject}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
})
