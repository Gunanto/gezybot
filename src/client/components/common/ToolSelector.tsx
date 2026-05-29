import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '@/client/components/ui/switch'
import { Badge } from '@/client/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/components/ui/collapsible'
import { ToolDomainIcon } from '@/client/components/common/ToolDomainIcon'
import { TOOL_DOMAIN_META } from '@/shared/constants'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import type { ToolCatalogEntry, ToolDomain, ToolLabel } from '@/shared/types'

/**
 * Resolve a tool's display label:
 *   - string label → use as-is
 *   - locale map → user's lang, then `en`, then any first entry
 *   - null/undefined → strip a `plugin_<plugin>_` prefix from the raw name
 */
function resolveToolLabel(name: string, label: ToolLabel | null | undefined, lang: string): string {
  if (typeof label === 'string') return label
  if (label && typeof label === 'object') {
    return label[lang] ?? label.en ?? label[Object.keys(label)[0] ?? ''] ?? prettifyToolName(name)
  }
  return prettifyToolName(name)
}

function prettifyToolName(name: string): string {
  const match = name.match(/^plugin_[^_]+_(.+)$/)
  return match ? match[1]! : name
}

export interface ToolSelectorTool extends ToolCatalogEntry {}

/** Optional per-tool decoration the host can inject (e.g. a capability or
 *  hard-exclusion warning rendered under the tool label). */
export type ToolNoteResolver = (tool: ToolSelectorTool) => string | undefined

interface ToolSelectorProps {
  /** Native tool catalog (GET /api/tools/catalog). */
  tools: ToolSelectorTool[]
  /** Controlled set of currently-selected tool names. */
  selected: Set<string>
  /** Called with the next full selection set whenever a row/domain toggles. */
  onChange: (next: Set<string>) => void
  /** When true, every switch is rendered disabled (read-only built-in view). */
  readOnly?: boolean
  /** Optional soft note shown under a tool row (warnings etc.). */
  toolNote?: ToolNoteResolver
  /** Show the friendly i18n name (tools.names.*) instead of the raw key as the
   *  primary label. Defaults to true. The raw tool key is always shown muted. */
  useFriendlyNames?: boolean
}

interface DomainBucket {
  domain: ToolDomain
  tools: ToolSelectorTool[]
}

/**
 * Reusable presentational picker for native tools grouped by domain, with a
 * per-tool toggle and a per-domain "toggle the whole category" switch. Fully
 * controlled: the parent owns the selected `Set<string>` of tool names and is
 * notified through `onChange`. Used by the toolbox editor and (adapted) by the
 * Kin tools tab.
 */
export function ToolSelector({
  tools,
  selected,
  onChange,
  readOnly = false,
  toolNote,
  useFriendlyNames = true,
}: ToolSelectorProps) {
  const { t, i18n } = useTranslation()
  const userLang = (i18n.language || 'en').split('-')[0]!

  // Bucket tools by domain, preserving the order in which each domain first
  // appears in the catalog so the list stays stable across renders.
  const buckets = useMemo<DomainBucket[]>(() => {
    const map = new Map<ToolDomain, ToolSelectorTool[]>()
    for (const tool of tools) {
      const arr = map.get(tool.domain)
      if (arr) arr.push(tool)
      else map.set(tool.domain, [tool])
    }
    return Array.from(map.entries()).map(([domain, t]) => ({ domain, tools: t }))
  }, [tools])

  const toggleTool = (name: string) => {
    if (readOnly) return
    const next = new Set(selected)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    onChange(next)
  }

  const toggleDomain = (bucket: DomainBucket) => {
    if (readOnly) return
    const allSelected = bucket.tools.every((tool) => selected.has(tool.name))
    const next = new Set(selected)
    for (const tool of bucket.tools) {
      if (allSelected) next.delete(tool.name)
      else next.add(tool.name)
    }
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {buckets.map((bucket) => {
        const enabledCount = bucket.tools.filter((tool) => selected.has(tool.name)).length
        const allEnabled = enabledCount === bucket.tools.length
        return (
          <DomainGroup
            key={bucket.domain}
            domain={bucket.domain}
            enabledCount={enabledCount}
            totalCount={bucket.tools.length}
            allEnabled={allEnabled}
            readOnly={readOnly}
            onToggleAll={() => toggleDomain(bucket)}
          >
            {bucket.tools.map((tool) => {
              const friendly = useFriendlyNames
                ? t(`tools.names.${tool.name}`, resolveToolLabel(tool.name, tool.label, userLang))
                : resolveToolLabel(tool.name, tool.label, userLang)
              const showKey = friendly !== tool.name
              return (
                <ToolRow
                  key={tool.name}
                  label={friendly}
                  toolKey={showKey ? tool.name : undefined}
                  enabled={selected.has(tool.name)}
                  readOnly={readOnly}
                  note={toolNote?.(tool)}
                  onToggle={() => toggleTool(tool.name)}
                />
              )
            })}
          </DomainGroup>
        )
      })}
    </div>
  )
}

function DomainGroup({
  domain,
  enabledCount,
  totalCount,
  allEnabled,
  readOnly,
  onToggleAll,
  children,
}: {
  domain: ToolDomain
  enabledCount: number
  totalCount: number
  allEnabled: boolean
  readOnly?: boolean
  onToggleAll: () => void
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const meta = TOOL_DOMAIN_META[domain]
  const [open, setOpen] = useState(false)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border bg-card/50">
        <div className="flex items-center justify-between px-3 py-2">
          <CollapsibleTrigger asChild>
            <button type="button" className="flex flex-1 items-center gap-2 text-left">
              <ChevronRight
                className={cn(
                  'size-3.5 text-muted-foreground transition-transform',
                  open && 'rotate-90',
                )}
              />
              <span className={`flex size-6 items-center justify-center rounded-md ${meta.bg}`}>
                <ToolDomainIcon domain={domain} className={`size-3.5 ${meta.text}`} />
              </span>
              <span className="text-sm font-medium">{t(meta.labelKey)}</span>
              <span className="text-xs text-muted-foreground">
                {t('kin.tools.countEnabled', { count: enabledCount, total: totalCount })}
              </span>
            </button>
          </CollapsibleTrigger>
          <Switch
            size="sm"
            checked={allEnabled}
            disabled={readOnly}
            onCheckedChange={onToggleAll}
          />
        </div>
        <CollapsibleContent>
          <div className="border-t">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function ToolRow({
  label,
  toolKey,
  enabled,
  readOnly,
  note,
  onToggle,
}: {
  label: string
  toolKey?: string
  enabled: boolean
  readOnly?: boolean
  note?: string
  onToggle: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 pr-3 pl-12 hover:bg-accent/30 transition-colors">
      <div className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm text-foreground">{label}</span>
          {toolKey && (
            <span className="font-mono text-[11px] text-muted-foreground/70">{toolKey}</span>
          )}
        </span>
        {note && (
          <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">{note}</p>
        )}
      </div>
      <Switch size="sm" checked={enabled} disabled={readOnly} onCheckedChange={onToggle} />
    </div>
  )
}

/** Convenience re-export so hosts can render a hard-exclusion Badge inline. */
export function HardExcludedBadge() {
  const { t } = useTranslation()
  return (
    <Badge variant="secondary" size="xs">
      {t('toolboxes.hardExcluded')}
    </Badge>
  )
}
