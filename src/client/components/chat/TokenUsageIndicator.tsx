import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Zap } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/client/components/ui/popover'
import { computeBillableInput, computeCacheHitRate, computeFreshInput, getCacheMultipliers } from '@/shared/billing'
import type { MessageTokenUsage, TaskTokenUsage } from '@/shared/types'

interface TokenUsageIndicatorProps {
  tokenUsage: MessageTokenUsage | TaskTokenUsage
  /** Provider type ("anthropic", "openai", ...) to pick the right cache
   *  multipliers. Falls back to Anthropic if absent. */
  providerType?: string | null
  /** Optional popover title override. Defaults to "Billable equivalent" — the
   *  task-level reading uses "Task total" instead so the user can tell apart a
   *  per-message badge from the running task total when both surface in the
   *  task panel. */
  title?: string
  /** Optional one-line hint under the popover title (e.g. "X LLM calls").
   *  Skipped when absent. */
  subtitle?: string
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString()
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

export const TokenUsageIndicator = memo(function TokenUsageIndicator({ tokenUsage, providerType, title, subtitle }: TokenUsageIndicatorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const multipliers = getCacheMultipliers(providerType)
  // Prefer the server-computed billable total when the caller passes a
  // `TaskTokenUsage` (provider-aware across rows). Falls back to the local
  // approximation for plain `MessageTokenUsage` (single message).
  const serverBillable = (tokenUsage as Partial<TaskTokenUsage>).billableInputTokens
  const billableInput = typeof serverBillable === 'number'
    ? serverBillable
    : computeBillableInput(tokenUsage, providerType)
  const fresh = computeFreshInput(tokenUsage)
  const cacheRead = tokenUsage.cacheReadTokens ?? 0
  const cacheWrite = tokenUsage.cacheWriteTokens ?? 0
  const hitRate = computeCacheHitRate(tokenUsage)
  const hasCache = cacheRead > 0 || cacheWrite > 0

  // Headline = the input billed equivalent + output. This is what the user
  // actually paid for — gross totalTokens was misleading (90% off cache reads
  // counted at full price).
  const headline = billableInput + tokenUsage.outputTokens

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
            'text-[10px] font-medium tabular-nums',
            'bg-primary/10 text-primary hover:bg-primary/18',
            'transition-colors duration-150',
          )}
          title={t('chat.tokenUsage.headlineHint', '~ billable token equivalent. Click for the full breakdown.')}
        >
          <Zap className="size-2.5" />
          <span>≈ {formatTokenCount(headline)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-72 p-3"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-3 text-xs">
          {/* Headline: billable equivalent */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <Zap className="size-3 text-primary" />
              {title ?? t('chat.tokenUsage.billableTitle', 'Billable equivalent')}
            </div>
            {subtitle && (
              <div className="text-[10px] text-muted-foreground leading-snug">{subtitle}</div>
            )}
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 tabular-nums">
              <span className="text-muted-foreground">{t('chat.tokenUsage.input')}</span>
              <span className="text-right font-semibold text-primary">≈ {formatTokenCount(billableInput)}</span>
              <span className="text-muted-foreground">{t('chat.tokenUsage.output')}</span>
              <span className="text-right font-semibold text-foreground">{formatTokenCount(tokenUsage.outputTokens)}</span>
            </div>
            {hasCache && (
              <p className="pt-1 text-[10px] text-muted-foreground leading-snug">
                {t('chat.tokenUsage.billableHintDynamic', {
                  defaultValue: 'On this provider, cache reads cost {{readPct}}% and cache writes cost {{writePct}}% of fresh input — this number reflects that.',
                  readPct: Math.round(multipliers.read * 100),
                  writePct: Math.round(multipliers.write * 100),
                })}
              </p>
            )}
          </div>

          {/* Raw breakdown */}
          <div className="space-y-1 border-t border-border/50 pt-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
              {t('chat.tokenUsage.rawBreakdown', 'Raw breakdown')}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground tabular-nums">
              <span>{t('chat.tokenUsage.inputGross', 'Input (gross)')}</span>
              <span className="text-right text-foreground">{formatTokenCount(tokenUsage.inputTokens)}</span>
              {hasCache && (
                <>
                  <span className="pl-2">↳ {t('chat.tokenUsage.fresh', 'fresh')}</span>
                  <span className="text-right text-foreground">{formatTokenCount(fresh)}</span>
                </>
              )}
              {cacheWrite > 0 && (
                <>
                  <span className="pl-2">↳ {t('chat.tokenUsage.cacheWrite')} <span className="text-muted-foreground/70">({multipliers.write}×)</span></span>
                  <span className="text-right text-foreground">{formatTokenCount(cacheWrite)}</span>
                </>
              )}
              {cacheRead > 0 && (
                <>
                  <span className="pl-2">↳ {t('chat.tokenUsage.cacheRead')} <span className="text-muted-foreground/70">({multipliers.read}×)</span></span>
                  <span className="text-right text-foreground">{formatTokenCount(cacheRead)}</span>
                </>
              )}
              <span>{t('chat.tokenUsage.output')}</span>
              <span className="text-right text-foreground">{formatTokenCount(tokenUsage.outputTokens)}</span>
              {(tokenUsage.reasoningTokens ?? 0) > 0 && (
                <>
                  <span>{t('chat.tokenUsage.reasoning')}</span>
                  <span className="text-right text-foreground">{formatTokenCount(tokenUsage.reasoningTokens!)}</span>
                </>
              )}
              {hasCache && (
                <>
                  <span>{t('chat.tokenUsage.cacheHit', 'Cache hit')}</span>
                  <span className={cn(
                    'text-right font-semibold',
                    hitRate >= 0.7 ? 'text-success' : hitRate >= 0.3 ? 'text-warning' : 'text-muted-foreground',
                  )}>{formatPercent(hitRate)}</span>
                </>
              )}
              {(tokenUsage.stepCount ?? 1) > 1 && (
                <>
                  <span>{t('chat.tokenUsage.steps', { count: tokenUsage.stepCount })}</span>
                  <span className="text-right text-foreground">{tokenUsage.stepCount}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
})
