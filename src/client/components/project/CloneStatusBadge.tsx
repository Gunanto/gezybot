import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Loader2, AlertTriangle, GitBranch, RefreshCw } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { Badge } from '@/client/components/ui/badge'
import { Button } from '@/client/components/ui/button'
import { api, getErrorMessage } from '@/client/lib/api'
import { toast } from 'sonner'
import type { CloneStatus } from '@/shared/types'

interface CloneStatusBadgeProps {
  status: CloneStatus
  /** Hidden when status is 'none' unless `showNone` is set. The header
   *  uses `showNone={false}` (clean look); the edit modal sets it true. */
  showNone?: boolean
  className?: string
}

/**
 * Compact pill describing the per-project clone lifecycle. Use in the
 * project header next to the title; for the longer error message + retry
 * button, use `<CloneStatusBlock>`.
 */
export function CloneStatusBadge({ status, showNone = false, className }: CloneStatusBadgeProps) {
  const { t } = useTranslation()

  if (status === 'none' && !showNone) return null

  if (status === 'none') {
    return (
      <Badge variant="outline" size="xs" className={cn('gap-1', className)}>
        <GitBranch className="size-2.5" />
        {t('projects.github.statusNone')}
      </Badge>
    )
  }
  if (status === 'cloning') {
    return (
      <Badge variant="outline" size="xs" className={cn('gap-1', className)}>
        <Loader2 className="size-2.5 animate-spin" />
        {t('projects.github.statusCloning')}
      </Badge>
    )
  }
  if (status === 'ready') {
    return (
      <Badge
        size="xs"
        className={cn(
          'gap-1 border-transparent bg-success text-success-foreground',
          className,
        )}
      >
        <CheckCircle2 className="size-2.5" />
        {t('projects.github.statusReady')}
      </Badge>
    )
  }
  // error
  return (
    <Badge variant="destructive" size="xs" className={cn('gap-1', className)}>
      <AlertTriangle className="size-2.5" />
      {t('projects.github.statusError')}
    </Badge>
  )
}

interface CloneStatusBlockProps {
  projectId: string
  status: CloneStatus
  /** Last clone failure message, surfaced verbatim when status='error'. */
  errorMessage: string | null
  /** True only when `githubRepo` is set on the project — otherwise the
   *  block is hidden (no clone to talk about). */
  hasRepo: boolean
  /** Optional callback fired after a successful retry call. The parent
   *  doesn't strictly need it (SSE updates the project anyway), but it
   *  lets callers refresh local state immediately. */
  onRetried?: () => void
  className?: string
}

/**
 * Detailed status block for the edit modal: shows the current state and,
 * on error, the failure message + a Retry button that calls
 * `POST /api/projects/:id/clone-retry`. SSE will flip the status back
 * to `cloning` then `ready`/`error` automatically.
 */
export function CloneStatusBlock({
  projectId,
  status,
  errorMessage,
  hasRepo,
  onRetried,
  className,
}: CloneStatusBlockProps) {
  const { t } = useTranslation()
  const [retrying, setRetrying] = useState(false)

  if (!hasRepo) return null

  async function handleRetry() {
    setRetrying(true)
    try {
      await api.post(`/projects/${projectId}/clone-retry`)
      onRetried?.()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CloneStatusBadge status={status} showNone />
          <span className="text-xs text-muted-foreground">
            {t(`projects.github.statusBlock.${status}`)}
          </span>
        </div>
        {status === 'error' && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleRetry}
            disabled={retrying}
          >
            {retrying ? (
              <Loader2 className="mr-1 size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 size-3.5" />
            )}
            {t('projects.github.retry')}
          </Button>
        )}
      </div>
      {status === 'error' && errorMessage && (
        <p className="text-xs text-destructive whitespace-pre-wrap break-words">
          {errorMessage}
        </p>
      )}
    </div>
  )
}
