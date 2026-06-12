import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, RefreshCw, X } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { api } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import type { UpdateChannel, UpdateRunInfo, UpdateStepId } from '@/shared/types'

const ALL_STEPS: UpdateStepId[] = [
  'preflight',
  'snapshot',
  'backup',
  'download',
  'apply',
  'dependencies',
  'assets',
  'restart',
]

type StepStatus = 'pending' | 'running' | 'done' | 'error'

interface UpdateProgressViewProps {
  runId: string
  channel: UpdateChannel
  /** Called once with the terminal run state (success / failed / rolled-back) */
  onFinished: (run: UpdateRunInfo) => void
}

/** Live stepper for a self-update run. Progress arrives over SSE while the
 *  old server is alive; once it restarts (SSE drops), the journal is polled
 *  until the run reaches a terminal state. */
export function UpdateProgressView({ runId, channel, onFinished }: UpdateProgressViewProps) {
  const { t } = useTranslation()
  const steps = ALL_STEPS.filter((s) => (channel === 'edge' ? s !== 'download' : true))
  const [statuses, setStatuses] = useState<Partial<Record<UpdateStepId, StepStatus>>>({})
  const [restarting, setRestarting] = useState(false)
  const finishedRef = useRef(false)

  const finish = (run: UpdateRunInfo) => {
    if (finishedRef.current) return
    finishedRef.current = true
    onFinished(run)
  }

  useSSE({
    'update:progress': (data) => {
      if (data.runId !== runId) return
      const step = data.step as UpdateStepId
      const status = data.status as 'running' | 'done' | 'error'
      setStatuses((prev) => ({ ...prev, [step]: status }))
      if (step === 'restart' && status === 'running') setRestarting(true)
    },
    'update:finished': (data) => {
      if (data.runId !== runId) return
      // Pre-restart failure (or post-boot outcome): fetch the journal for the
      // full record and hand it to the parent.
      api
        .get<{ run: UpdateRunInfo | null }>('/version-check/last-update')
        .then(({ run }) => {
          if (run && run.id === runId) finish(run)
        })
        .catch(() => {})
    },
  })

  // Poll the journal as a safety net — it is the only channel that survives
  // the restart (the SSE connection dies with the old process).
  useEffect(() => {
    const interval = setInterval(async () => {
      if (finishedRef.current) return
      try {
        const { run } = await api.get<{ run: UpdateRunInfo | null }>('/version-check/last-update')
        if (!run || run.id !== runId) return
        if (run.status === 'success' || run.status === 'failed' || run.status === 'rolled-back') {
          finish(run)
        }
      } catch {
        // Server restarting — keep polling until it's back
      }
    }, 3000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  return (
    <div className="space-y-1">
      {steps.map((step) => {
        const status: StepStatus = statuses[step] ?? 'pending'
        return (
          <div
            key={step}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-xs transition-colors',
              status === 'running' && 'bg-primary/5 text-foreground',
              status === 'pending' && 'text-muted-foreground/50',
              status === 'done' && 'text-muted-foreground',
              status === 'error' && 'text-destructive',
            )}
          >
            <span className="flex size-4 items-center justify-center shrink-0">
              {status === 'running' && <Loader2 className="size-3.5 animate-spin text-primary" />}
              {status === 'done' && <Check className="size-3.5 text-emerald-500" />}
              {status === 'error' && <X className="size-3.5" />}
              {status === 'pending' && <span className="size-1.5 rounded-full bg-current" />}
            </span>
            <span className="flex-1">{t(`updateProgress.steps.${step}`)}</span>
          </div>
        )
      })}

      {restarting && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <RefreshCw className="size-3.5 animate-spin" />
          {t('updateProgress.waitingForServer')}
        </div>
      )}
    </div>
  )
}
