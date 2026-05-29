import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Clock, CalendarClock, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { JsonViewer } from '@/client/components/common/JsonViewer'
import type { ToolResultRendererProps } from '@/client/lib/tool-renderers'

interface Cron {
  id?: string
  cronId?: string
  name?: string
  schedule?: string
  taskDescription?: string
  isActive?: boolean
  runOnce?: boolean
  requiresApproval?: boolean
  lastTriggeredAt?: string | null
  message?: string
}

interface CronRun {
  status?: string
  result?: unknown
  executedAt?: string
  durationSeconds?: number
}

function ScheduleBadge({ schedule }: { schedule?: string }) {
  if (!schedule) return null
  return (
    <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
      <Clock className="size-2.5" />
      {schedule}
    </span>
  )
}

function CronCard({ c }: { c: Cron }) {
  const { t } = useTranslation()
  const lastRun = c.lastTriggeredAt ? new Date(c.lastTriggeredAt).toLocaleString() : null
  return (
    <div className="px-3 py-2 space-y-1">
      <div className="flex items-center gap-2">
        <CalendarClock className="size-3 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate font-medium text-foreground">{c.name ?? t('tools.renderers.cronUnnamed')}</span>
        {c.isActive === false ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">{t('tools.renderers.cronInactive')}</span>
        ) : c.isActive === true ? (
          <span className="rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success shrink-0">{t('tools.renderers.cronActive')}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <ScheduleBadge schedule={c.schedule} />
        {c.runOnce && <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{t('tools.renderers.cronRunOnce')}</span>}
        {c.requiresApproval && <span className="rounded bg-amber-500/10 px-1 py-0.5 text-[10px] text-amber-500">{t('tools.renderers.cronApproval')}</span>}
      </div>
      {c.taskDescription && (
        <p className="text-[11px] text-muted-foreground line-clamp-2">{c.taskDescription}</p>
      )}
      {c.message && <p className="text-[11px] text-muted-foreground/80">{c.message}</p>}
      {lastRun && <p className="text-[10px] text-muted-foreground/60">{t('tools.renderers.cronLastRun', { date: lastRun })}</p>}
    </div>
  )
}

/**
 * Rich renderer for cron tools — create_cron / update_cron (single cron card),
 * list_crons (list of cron cards) and get_cron_journal (execution history).
 * Falls back to JsonViewer for unexpected shapes.
 */
export function CronResultRenderer({ args, result, status }: ToolResultRendererProps) {
  const { t } = useTranslation()
  const [showRaw, setShowRaw] = useState(false)

  const res = result as Record<string, unknown> | null | undefined
  const error = typeof res?.error === 'string' ? res.error : null

  const list = Array.isArray(res?.crons) ? (res!.crons as Cron[]) : null
  const runs = Array.isArray(res?.runs) ? (res!.runs as CronRun[]) : null
  const single: Cron | null =
    !list && !runs && res && typeof res.name === 'string' && typeof res.schedule === 'string'
      ? (res as Cron)
      : null

  if (error || status === 'error') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <AlertTriangle className="size-3 mt-0.5 shrink-0" />
        <span className="break-all">{error ?? t('tools.renderers.error')}</span>
      </div>
    )
  }

  // Journal (execution history)
  if (runs) {
    return (
      <div className="space-y-2">
        <div className="rounded-md border border-border overflow-hidden text-xs">
          <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border-b border-border/50">
            <CalendarClock className="size-3 text-muted-foreground shrink-0" />
            <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">
              {t('tools.renderers.cronRuns', { count: runs.length })}
            </span>
          </div>
          {runs.length > 0 ? (
            <ul className="divide-y divide-border/40 max-h-96 overflow-auto scrollbar-thin">
              {runs.map((r, i) => {
                const ok = r.status === 'completed' || r.status === 'success'
                const failed = r.status === 'failed' || r.status === 'error'
                const when = r.executedAt ? new Date(r.executedAt).toLocaleString() : null
                const resultText = r.result === null || r.result === undefined
                  ? null
                  : typeof r.result === 'string' ? r.result : JSON.stringify(r.result)
                return (
                  <li key={i} className="px-3 py-2 space-y-0.5">
                    <div className="flex items-center gap-2">
                      {ok ? <CheckCircle2 className="size-3 shrink-0 text-success" />
                        : failed ? <XCircle className="size-3 shrink-0 text-destructive" />
                        : <Clock className="size-3 shrink-0 text-muted-foreground" />}
                      <span className={cn('text-[11px] font-medium', ok ? 'text-success' : failed ? 'text-destructive' : 'text-muted-foreground')}>
                        {r.status}
                      </span>
                      {when && <span className="ml-auto text-[10px] text-muted-foreground/60">{when}</span>}
                      {typeof r.durationSeconds === 'number' && (
                        <span className="text-[10px] text-muted-foreground/60 tabular-nums">{r.durationSeconds}s</span>
                      )}
                    </div>
                    {resultText && <p className="pl-5 text-[11px] text-muted-foreground line-clamp-2">{resultText}</p>}
                  </li>
                )
              })}
            </ul>
          ) : (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">{t('tools.renderers.cronNoRuns')}</div>
          )}
        </div>
        <RawToggle showRaw={showRaw} setShowRaw={setShowRaw} args={args} result={result} />
      </div>
    )
  }

  const crons = list ?? (single ? [single] : null)

  // Unexpected shape → fall back to JSON.
  if (!crons) {
    return (
      <>
        <JsonViewer data={args} label={t('tools.renderers.input')} maxHeight="max-h-40" />
        {result !== undefined && <JsonViewer data={result} label={t('tools.renderers.output')} maxHeight="max-h-60" />}
      </>
    )
  }

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-border overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border-b border-border/50">
          <CalendarClock className="size-3 text-muted-foreground shrink-0" />
          <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">
            {t('tools.renderers.cronCount', { count: crons.length })}
          </span>
        </div>
        {crons.length > 0 ? (
          <div className="divide-y divide-border/40 max-h-96 overflow-auto scrollbar-thin">
            {crons.map((c, i) => <CronCard key={c.id ?? c.cronId ?? i} c={c} />)}
          </div>
        ) : (
          <div className="px-3 py-2 text-[11px] text-muted-foreground">{t('tools.renderers.cronNoResults')}</div>
        )}
      </div>
      <RawToggle showRaw={showRaw} setShowRaw={setShowRaw} args={args} result={result} />
    </div>
  )
}

function RawToggle({
  showRaw,
  setShowRaw,
  args,
  result,
}: {
  showRaw: boolean
  setShowRaw: (v: boolean) => void
  args: Record<string, unknown>
  result: unknown
}) {
  const { t } = useTranslation()
  return (
    <>
      <button
        type="button"
        onClick={() => setShowRaw(!showRaw)}
        className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
      >
        {showRaw ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {t('tools.renderers.rawJson')}
      </button>
      {showRaw && (
        <>
          <JsonViewer data={args} label={t('tools.renderers.input')} maxHeight="max-h-40" />
          {result !== undefined && <JsonViewer data={result} label={t('tools.renderers.output')} maxHeight="max-h-60" />}
        </>
      )}
    </>
  )
}
