import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '@/client/components/ui/switch'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/components/ui/collapsible'
import { ToolSelector, type ToolSelectorTool } from '@/client/components/common/ToolSelector'
import { useKinTools, type McpToolGroup, type PluginToolGroup, type ToolLabel } from '@/client/hooks/useKinTools'
import { useHasCapability } from '@/client/hooks/useHasCapability'
import { Badge } from '@/client/components/ui/badge'
import { ChevronRight, Loader2, Plug, Puzzle } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import type { KinToolConfig } from '@/shared/types'

/**
 * Native tools whose execution requires a provider of the named
 * capability family. When the family is unconfigured the row shows a
 * soft 'Add a … provider' note next to the toggle so the user
 * understands the toggle will still flip but the tool itself will
 * return an error at call time.
 *
 * Keep in sync with the actual tool implementations — when a new
 * capability-bound native tool lands, add it here so the UI keeps
 * surfacing the gap.
 */
const TOOL_REQUIRED_CAPABILITY: Record<string, 'image' | 'search' | 'tts' | 'stt' | 'embedding'> = {
  generate_image: 'image',
  list_image_models: 'image',
  describe_image_model: 'image',
  web_search: 'search',
  list_search_providers: 'search',
  text_to_speech: 'tts',
  list_voices: 'tts',
  list_tts_providers: 'tts',
  transcribe_audio: 'stt',
  list_stt_models: 'stt',
  list_stt_providers: 'stt',
  recall: 'embedding',
  memorize: 'embedding',
}

interface KinToolsTabProps {
  kinId: string | null
  toolConfig: KinToolConfig | null
  onToolConfigChange: (config: KinToolConfig | null) => void
}

function getEffectiveConfig(config: KinToolConfig | null): KinToolConfig {
  return config ?? { disabledNativeTools: [], mcpAccess: {}, enabledOptInTools: [] }
}

/**
 * Resolve a tool label for display:
 *   - string label → use as-is
 *   - locale map → user's lang, then `en`, then any first entry
 *   - undefined → strip the `plugin_<plugin-name>_` prefix from the
 *     raw tool name so we don't render `plugin_kinbot-plugin-…_x`
 *     unless the plugin author explicitly opted out of providing a label
 */
function resolveToolLabel(name: string, label: ToolLabel | undefined, lang: string): string {
  if (typeof label === 'string') return label
  if (label && typeof label === 'object') {
    return label[lang] ?? label.en ?? label[Object.keys(label)[0] ?? ''] ?? prettifyToolName(name)
  }
  return prettifyToolName(name)
}

function prettifyToolName(name: string): string {
  // `plugin_<plugin-name>_<tool>` → `<tool>`. Plugin scope is already
  // shown as the group header, no need to repeat it on every row.
  const match = name.match(/^plugin_[^_]+_(.+)$/)
  return match ? match[1]! : name
}

export function KinToolsTab({ kinId, toolConfig, onToolConfigChange }: KinToolsTabProps) {
  const { t, i18n } = useTranslation()
  const { nativeTools, pluginTools, mcpTools, isLoading } = useKinTools(kinId)
  const userLang = (i18n.language || 'en').split('-')[0]! // 'fr-FR' → 'fr'

  const config = getEffectiveConfig(toolConfig)

  // Capability awareness for native tools whose execution depends on a
  // provider family. The toggle still flips when the family is missing
  // (a user might add a provider later), but the row gets a soft note
  // so the gap is visible up-front.
  const hasImage = useHasCapability('image')
  const hasSearch = useHasCapability('search')
  const hasTts = useHasCapability('tts')
  const hasStt = useHasCapability('stt')
  const hasEmbedding = useHasCapability('embedding')
  const capabilityAvailable: Record<'image' | 'search' | 'tts' | 'stt' | 'embedding', boolean> = {
    image: hasImage,
    search: hasSearch,
    tts: hasTts,
    stt: hasStt,
    embedding: hasEmbedding,
  }

  const missingCapabilityFor = (toolName: string): string | undefined => {
    const family = TOOL_REQUIRED_CAPABILITY[toolName]
    if (!family) return undefined
    if (capabilityAvailable[family]) return undefined
    return t(`kin.tools.missingCapability.${family}`)
  }

  // ─── Native tools → ToolSelector adapter ────────────────────────────
  //
  // The shared ToolSelector is a flat "selected Set<string>" picker. The
  // Kin tool config is a *dual* model: a deny-list for standard tools and
  // an opt-in allow-list for defaultDisabled tools. We bridge the two:
  //
  //   selected = { every native tool currently ENABLED for this Kin }
  //   onChange(next) → rebuild disabledNativeTools (standard tools NOT in
  //     `next`) and enabledOptInTools (defaultDisabled tools IN `next`).

  // Flatten useKinTools native groups into a catalog the ToolSelector
  // understands. Defaults that the ToolSelector doesn't consume for native
  // tools (readOnly/destructive/hardExcludedFromSubKin) are filled with
  // benign placeholders.
  const nativeCatalog = useMemo<ToolSelectorTool[]>(() => {
    const out: ToolSelectorTool[] = []
    for (const group of nativeTools) {
      for (const tool of group.tools) {
        out.push({
          name: tool.name,
          domain: group.domain,
          label: tool.label ?? null,
          description: null,
          defaultDisabled: tool.defaultDisabled ?? false,
          readOnly: false,
          destructive: false,
          hardExcludedFromSubKin: false,
        })
      }
    }
    return out
  }, [nativeTools])

  const isNativeToolEnabled = (toolName: string, defaultDisabled: boolean): boolean => {
    if (defaultDisabled) return config.enabledOptInTools?.includes(toolName) ?? false
    return !config.disabledNativeTools.includes(toolName)
  }

  const nativeSelected = useMemo<Set<string>>(() => {
    const set = new Set<string>()
    for (const tool of nativeCatalog) {
      if (isNativeToolEnabled(tool.name, tool.defaultDisabled)) set.add(tool.name)
    }
    return set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeCatalog, config.disabledNativeTools, config.enabledOptInTools])

  const handleNativeChange = (next: Set<string>) => {
    const disabled = new Set<string>()
    const optIn = new Set<string>()
    for (const tool of nativeCatalog) {
      const selected = next.has(tool.name)
      if (tool.defaultDisabled) {
        if (selected) optIn.add(tool.name)
      } else if (!selected) {
        disabled.add(tool.name)
      }
    }
    onToolConfigChange({
      ...config,
      disabledNativeTools: Array.from(disabled),
      enabledOptInTools: Array.from(optIn),
    })
  }

  // ─── Plugin tool toggles ────────────────────────────────────────────
  // Plugin tools are always opt-in (the plugin loader forces
  // defaultDisabled: true), so individual rows reuse the same
  // enabledOptInTools allow-list as opt-in native tools.

  const isOptInEnabled = (toolName: string) => config.enabledOptInTools?.includes(toolName) ?? false

  const toggleOptInTool = (toolName: string) => {
    const optIn = new Set(config.enabledOptInTools ?? [])
    if (optIn.has(toolName)) optIn.delete(toolName)
    else optIn.add(toolName)
    onToolConfigChange({ ...config, enabledOptInTools: Array.from(optIn) })
  }

  const togglePluginGroup = (group: PluginToolGroup) => {
    const allEnabled = group.tools.every((t) => isOptInEnabled(t.name))
    const optIn = new Set(config.enabledOptInTools ?? [])
    for (const tool of group.tools) {
      if (allEnabled) optIn.delete(tool.name)
      else optIn.add(tool.name)
    }
    onToolConfigChange({ ...config, enabledOptInTools: Array.from(optIn) })
  }

  // ─── MCP tool toggle ──────────────────────────────────────────────

  const isMcpToolEnabled = (serverId: string, toolName: string, autoEnabled: boolean) => {
    const access = config.mcpAccess[serverId]
    if (access) return access.includes('*') || access.includes(toolName)
    return autoEnabled
  }

  const toggleMcpTool = (server: McpToolGroup, toolName: string) => {
    const newAccess = { ...config.mcpAccess }
    const current = newAccess[server.serverId] ?? (server.autoEnabled ? ['*'] : [])

    // Expand '*' to the full list of tool names
    let toolList: string[]
    if (current.includes('*')) {
      toolList = server.tools.map((t) => t.name)
    } else {
      toolList = [...current]
    }

    if (toolList.includes(toolName)) {
      toolList = toolList.filter((n) => n !== toolName)
    } else {
      toolList.push(toolName)
    }

    // If all tools are enabled, store '*' for compactness
    if (toolList.length === server.tools.length) {
      newAccess[server.serverId] = ['*']
    } else if (toolList.length === 0) {
      delete newAccess[server.serverId]
    } else {
      newAccess[server.serverId] = toolList
    }

    onToolConfigChange({ ...config, mcpAccess: newAccess })
  }

  const toggleMcpServer = (server: McpToolGroup) => {
    const allEnabled = server.tools.length > 0 && server.tools.every((t) =>
      isMcpToolEnabled(server.serverId, t.name, server.autoEnabled),
    )

    const newAccess = { ...config.mcpAccess }
    if (allEnabled) {
      delete newAccess[server.serverId]
      // If it was auto-enabled, we need to explicitly disable by setting empty
      if (server.autoEnabled) {
        newAccess[server.serverId] = []
      }
    } else {
      newAccess[server.serverId] = ['*']
    }

    onToolConfigChange({ ...config, mcpAccess: newAccess })
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Native tools — rendered via the shared ToolSelector, bridged to the
          Kin's dual deny-list / opt-in model. */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">{t('kin.tools.native')}</h3>
        <ToolSelector
          tools={nativeCatalog}
          selected={nativeSelected}
          onChange={handleNativeChange}
          toolNote={(tool) => missingCapabilityFor(tool.name)}
        />
      </div>

      {/* Plugin tools */}
      {pluginTools.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">{t('kin.tools.plugins')}</h3>

          {pluginTools.map((group) => {
            const enabledCount = group.tools.filter((t) => isOptInEnabled(t.name)).length
            const allEnabled = enabledCount === group.tools.length
            return (
              <PluginGroup
                key={group.pluginName}
                pluginName={group.pluginName}
                displayName={group.displayName}
                logoUrl={group.logoUrl}
                icon={group.icon}
                enabledCount={enabledCount}
                totalCount={group.tools.length}
                allEnabled={allEnabled}
                onToggleAll={() => togglePluginGroup(group)}
              >
                {group.tools.map((tool) => {
                  // Show the prettified name (prefix-stripped) as the
                  // mono subtitle whenever the author-supplied label
                  // differs from it — same UX as native tools.
                  const strippedName = prettifyToolName(tool.name)
                  const label = resolveToolLabel(tool.name, tool.label, userLang)
                  return (
                    <ToolRow
                      key={tool.name}
                      label={label}
                      toolKey={label !== strippedName ? strippedName : undefined}
                      enabled={isOptInEnabled(tool.name)}
                      onToggle={() => toggleOptInTool(tool.name)}
                    />
                  )
                })}
              </PluginGroup>
            )
          })}
        </div>
      )}

      {/* MCP tools */}
      {(mcpTools.length > 0 || kinId) && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">{t('kin.tools.mcp')}</h3>

          {!kinId ? (
            <p className="text-sm text-muted-foreground">{t('kin.tools.saveMcpHint')}</p>
          ) : mcpTools.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('kin.tools.noMcp')}</p>
          ) : (
            mcpTools.map((server) => {
              const enabledCount = server.tools.filter((t) =>
                isMcpToolEnabled(server.serverId, t.name, server.autoEnabled),
              ).length
              const allEnabled = server.tools.length > 0 && enabledCount === server.tools.length

              return (
                <McpServerGroup
                  key={server.serverId}
                  serverName={server.serverName}
                  autoEnabled={server.autoEnabled}
                  enabledCount={enabledCount}
                  totalCount={server.tools.length}
                  allEnabled={allEnabled}
                  disabled={server.tools.length === 0}
                  onToggleAll={() => toggleMcpServer(server)}
                >
                  {server.tools.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground italic">
                      {t('kin.tools.connectionFailed')}
                    </div>
                  ) : (
                    server.tools.map((tool) => (
                      <ToolRow
                        key={tool.name}
                        label={tool.name}
                        description={tool.description}
                        enabled={isMcpToolEnabled(server.serverId, tool.name, server.autoEnabled)}
                        onToggle={() => toggleMcpTool(server, tool.name)}
                      />
                    ))
                  )}
                </McpServerGroup>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

// ─── Sub-components (plugin + MCP groups keep their bespoke headers) ──

function PluginGroup({
  pluginName,
  displayName,
  logoUrl,
  icon,
  enabledCount,
  totalCount,
  allEnabled,
  onToggleAll,
  children,
}: {
  pluginName: string
  displayName?: string
  logoUrl?: string
  icon?: string
  enabledCount: number
  totalCount: number
  allEnabled: boolean
  onToggleAll: () => void
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // Header label hierarchy mirrors the marketplace card: prefer the
  // human-readable displayName, fall back to the npm slug.
  const headerLabel = displayName || pluginName

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border bg-card/50">
        <div className="flex items-center justify-between px-3 py-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex flex-1 items-center gap-2 text-left min-w-0"
            >
              <ChevronRight className={cn(
                'size-3.5 shrink-0 text-muted-foreground transition-transform',
                open && 'rotate-90',
              )} />
              {/* Logo slot: real logo from the plugin manifest when
                  available, emoji fallback, otherwise the generic
                  Puzzle icon so the row baseline stays consistent. */}
              {logoUrl ? (
                <img
                  src={logoUrl}
                  alt=""
                  className="size-6 shrink-0 rounded-md object-contain bg-muted/40 p-0.5"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                />
              ) : icon ? (
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/40 text-sm">
                  {icon}
                </span>
              ) : (
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10">
                  <Puzzle className="size-3.5 text-primary" />
                </span>
              )}
              <span className="text-sm font-medium truncate">{headerLabel}</span>
              <Badge variant="secondary" size="xs">
                {t('kin.tools.optIn')}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {t('kin.tools.countEnabled', { count: enabledCount, total: totalCount })}
              </span>
            </button>
          </CollapsibleTrigger>
          <Switch
            size="sm"
            checked={allEnabled}
            onCheckedChange={onToggleAll}
          />
        </div>

        <CollapsibleContent>
          <div className="border-t">
            {children}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function McpServerGroup({
  serverName,
  autoEnabled,
  enabledCount,
  totalCount,
  allEnabled,
  disabled,
  onToggleAll,
  children,
}: {
  serverName: string
  autoEnabled: boolean
  enabledCount: number
  totalCount: number
  allEnabled: boolean
  disabled?: boolean
  onToggleAll: () => void
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border bg-card/50">
        {/* Server header */}
        <div className="flex items-center justify-between px-3 py-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex flex-1 items-center gap-2 text-left"
            >
              <ChevronRight className={cn(
                'size-3.5 text-muted-foreground transition-transform',
                open && 'rotate-90',
              )} />
              <span className="flex size-6 items-center justify-center rounded-md bg-muted">
                <Plug className="size-3.5 text-muted-foreground" />
              </span>
              <span className="text-sm font-medium">{serverName}</span>
              {autoEnabled && (
                <Badge variant="secondary" size="xs">
                  {t('kin.tools.autoEnabled')}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {t('kin.tools.countEnabled', { count: enabledCount, total: totalCount })}
              </span>
            </button>
          </CollapsibleTrigger>
          <Switch
            size="sm"
            checked={allEnabled}
            disabled={disabled}
            onCheckedChange={onToggleAll}
          />
        </div>

        {/* Tool list */}
        <CollapsibleContent>
          <div className="border-t">
            {children}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function ToolRow({
  label,
  toolKey,
  description,
  enabled,
  onToggle,
}: {
  label: string
  /** Optional tool identifier (e.g. "browser_open_session") shown muted next to the label */
  toolKey?: string
  description?: string
  enabled: boolean
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
        {description && (
          <p className="truncate text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <Switch
        size="sm"
        checked={enabled}
        onCheckedChange={onToggle}
      />
    </div>
  )
}
