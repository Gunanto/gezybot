import { useTranslation } from 'react-i18next'
import { cn } from '@/client/lib/utils'
import { Lock, Wrench } from 'lucide-react'
import type { Toolbox } from '@/shared/types'

interface ToolboxMultiSelectProps {
  toolboxes: Toolbox[]
  /** Controlled set of selected toolbox ids. */
  selected: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}

/**
 * Chip-style multi-select for assigning toolboxes (an array) to a task. The
 * resolved native toolset of the task is the CORE floor unioned with every
 * selected toolbox's tools (see services/toolboxes.ts). Built-in toolboxes get
 * a translated label + lock glyph; user toolboxes show their raw name.
 */
export function ToolboxMultiSelect({
  toolboxes,
  selected,
  onChange,
  disabled = false,
}: ToolboxMultiSelectProps) {
  const { t } = useTranslation()

  function toggle(id: string) {
    if (disabled) return
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  }

  // Built-ins first (translated), then user toolboxes (alphabetical).
  const sorted = [...toolboxes].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return (
    <div className="flex flex-wrap gap-1.5">
      {sorted.map((tb) => {
        const isSelected = selected.includes(tb.id)
        const label = tb.builtin ? t(`toolboxes.builtin.${tb.name}`, tb.name) : tb.name
        return (
          <button
            key={tb.id}
            type="button"
            disabled={disabled}
            onClick={() => toggle(tb.id)}
            title={tb.description ?? undefined}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
              isSelected
                ? 'border-primary/40 bg-primary/15 text-primary'
                : 'border-border bg-transparent text-muted-foreground hover:bg-muted',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            {tb.builtin ? <Lock className="size-3" /> : <Wrench className="size-3" />}
            {label}
          </button>
        )
      })}
    </div>
  )
}
