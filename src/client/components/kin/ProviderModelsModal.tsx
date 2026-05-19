import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/client/components/ui/dialog'
import { Input } from '@/client/components/ui/input'
import { Badge } from '@/client/components/ui/badge'
import { Button } from '@/client/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/client/components/ui/tabs'
import { AlertTriangle, Brain, Image as ImageIcon, Loader2, RefreshCw, Search } from 'lucide-react'
import { api, getErrorMessage } from '@/client/lib/api'

interface ProviderModelEntry {
  id: string
  name: string
  capability: string
  contextWindow?: number
  maxOutput?: number
  /** LLM-family only — chat accepts image attachments. */
  supportsImageInput?: boolean
  /** Image-family only — how many source images the model accepts. */
  maxImageInputs?: number
}

interface ProviderModelsResponse {
  provider: { id: string; name: string; type: string; slug: string }
  capabilities: Array<'llm' | 'embedding' | 'image'>
  models: ProviderModelEntry[]
  errors: Array<{ capability: string; message: string }>
}

interface ProviderModelsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  providerId: string
  providerName: string
}

const CAPABILITY_ICON: Record<string, typeof Brain> = {
  llm: Brain,
  embedding: Search,
  image: ImageIcon,
}

const CAPABILITY_LABEL_KEY: Record<string, string> = {
  llm: 'onboarding.providers.cap_llm',
  embedding: 'onboarding.providers.cap_embedding',
  image: 'onboarding.providers.cap_image',
}

const ALL_TAB = '__all__'

export function ProviderModelsModal({
  open,
  onOpenChange,
  providerId,
  providerName,
}: ProviderModelsModalProps) {
  const { t } = useTranslation()
  const [data, setData] = useState<ProviderModelsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<string>(ALL_TAB)
  const [search, setSearch] = useState('')

  // Fetch once per open. The modal stays mounted between opens; resetting
  // here keeps state clean if the user closes + reopens for a different
  // provider.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setIsLoading(true)
    setError(null)
    setData(null)
    setActiveTab(ALL_TAB)
    setSearch('')

    api
      .get<ProviderModelsResponse>(`/providers/${providerId}/models`)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((err) => {
        if (!cancelled) setError(getErrorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, providerId])

  // Manual refresh — keeps the existing list visible (no flash to empty
  // state) and just swaps it once the new payload arrives. Useful when a
  // provider just released a new model and the user doesn't want to wait
  // for the next scheduled cache refresh.
  const handleRefresh = () => {
    if (isLoading || isRefreshing) return
    setIsRefreshing(true)
    setError(null)
    api
      .get<ProviderModelsResponse>(`/providers/${providerId}/models`)
      .then((res) => setData(res))
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setIsRefreshing(false))
  }

  const filteredModels = useMemo(() => {
    if (!data) return []
    const q = search.trim().toLowerCase()
    return data.models.filter((m) => {
      if (activeTab !== ALL_TAB && m.capability !== activeTab) return false
      if (!q) return true
      return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    })
  }, [data, search, activeTab])

  const showCapabilityTabs = (data?.capabilities.length ?? 0) > 1

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t('settings.providers.modelsModal.title', { name: providerName })}
          </DialogTitle>
          <DialogDescription>
            {t(
              'settings.providers.modelsModal.description',
              'Models the provider exposes right now (fetched live from its API). Use this list to verify what is available without leaving KinBot.',
            )}
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin mr-2" />
            {t('settings.providers.modelsModal.loading', 'Loading models…')}
          </div>
        )}

        {error && !isLoading && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="size-4 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium">{t('settings.providers.modelsModal.fetchError', 'Could not load models')}</p>
              <p className="mt-0.5 text-xs">{error}</p>
            </div>
          </div>
        )}

        {data && !isLoading && (
          <div className="space-y-3">
            {data.errors.length > 0 && (
              <div className="space-y-1">
                {data.errors.map((e, i) => (
                  <div
                    key={`${e.capability}-${i}`}
                    className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400"
                  >
                    <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
                    <span>
                      <span className="font-medium">{e.capability}:</span> {e.message}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {showCapabilityTabs && (
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList>
                  <TabsTrigger value={ALL_TAB}>
                    {t('settings.providers.modelsModal.allCapabilities', 'All')}
                    <Badge variant="secondary" size="xs" className="ml-1.5">
                      {data.models.length}
                    </Badge>
                  </TabsTrigger>
                  {data.capabilities.map((cap) => {
                    const Icon = CAPABILITY_ICON[cap]
                    const count = data.models.filter((m) => m.capability === cap).length
                    return (
                      <TabsTrigger key={cap} value={cap}>
                        {Icon && <Icon className="size-3.5 mr-1" />}
                        {t(CAPABILITY_LABEL_KEY[cap] ?? cap, cap)}
                        <Badge variant="secondary" size="xs" className="ml-1.5">
                          {count}
                        </Badge>
                      </TabsTrigger>
                    )
                  })}
                </TabsList>
              </Tabs>
            )}

            <div className="flex items-center gap-2">
              <Input
                type="search"
                placeholder={t('settings.providers.modelsModal.searchPlaceholder', 'Filter by name or id…')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={isRefreshing}
                title={t('settings.providers.modelsModal.refreshTooltip', 'Re-fetch the model list from the provider API')}
              >
                <RefreshCw className={isRefreshing ? 'animate-spin' : undefined} />
                {t('settings.providers.modelsModal.refresh', 'Refresh')}
              </Button>
            </div>

            <div className="max-h-[400px] overflow-y-auto rounded-md border border-border">
              {filteredModels.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground text-center">
                  {data.models.length === 0
                    ? t('settings.providers.modelsModal.emptyAll', 'This provider exposes no models.')
                    : t('settings.providers.modelsModal.emptyFiltered', 'No model matches the current filter.')}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {filteredModels.map((m) => {
                    const Icon = CAPABILITY_ICON[m.capability]
                    return (
                      <li key={`${m.capability}:${m.id}`} className="flex items-center gap-3 p-3">
                        <div className="shrink-0">
                          {Icon ? <Icon className="size-4 text-muted-foreground" /> : null}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{m.name}</p>
                          <p className="font-mono text-[11px] text-muted-foreground truncate">{m.id}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                          {m.contextWindow != null && (
                            <Badge variant="outline" size="xs">
                              {formatTokens(m.contextWindow)} ctx
                            </Badge>
                          )}
                          {m.maxOutput != null && (
                            <Badge variant="outline" size="xs">
                              {formatTokens(m.maxOutput)} out
                            </Badge>
                          )}
                          {m.supportsImageInput && (
                            <Badge variant="outline" size="xs">
                              <ImageIcon className="size-3 mr-0.5" />
                              {t('settings.providers.modelsModal.imageInput', 'image-in')}
                            </Badge>
                          )}
                          {m.maxImageInputs != null && m.maxImageInputs > 0 && (
                            <Badge variant="outline" size="xs">
                              <ImageIcon className="size-3 mr-0.5" />
                              {m.maxImageInputs === 1
                                ? t('settings.providers.modelsModal.img2img', 'img2img')
                                : t('settings.providers.modelsModal.multiImage', { count: m.maxImageInputs, defaultValue: 'multi-ref ({{count}})' })}
                            </Badge>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              {t('settings.providers.modelsModal.footer', {
                shown: filteredModels.length,
                total: data.models.length,
                defaultValue: 'Showing {{shown}} of {{total}} models',
              })}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`
  return String(n)
}
