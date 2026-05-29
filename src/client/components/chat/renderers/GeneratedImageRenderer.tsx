import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, ImageIcon, Maximize2, AlertTriangle } from 'lucide-react'
import { JsonViewer } from '@/client/components/common/JsonViewer'
import { ImageLightbox } from '@/client/components/chat/ImageLightbox'
import type { ToolResultRendererProps } from '@/client/lib/tool-renderers'

function formatSize(bytes: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (bytes >= 1024) return t('tools.renderers.bytesKB', { size: (bytes / 1024).toFixed(1) })
  return t('tools.renderers.bytesB', { size: bytes })
}

/**
 * Rich renderer for generate_image results — shows the generated image as a
 * click-to-zoom thumbnail with the prompt as caption. Falls back to JsonViewer
 * for unexpected shapes.
 */
export function GeneratedImageRenderer({ args, result, status }: ToolResultRendererProps) {
  const { t } = useTranslation()
  const [showRaw, setShowRaw] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  const res = result as Record<string, unknown> | null | undefined
  const url = typeof res?.url === 'string' ? res.url : null
  const error = typeof res?.error === 'string' ? res.error : null
  const mimeType = typeof res?.mimeType === 'string' ? res.mimeType : 'image/png'
  const size = typeof res?.size === 'number' ? res.size : null
  const prompt = typeof args.prompt === 'string' ? args.prompt : null

  if (error && !url) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <AlertTriangle className="size-3 mt-0.5 shrink-0" />
        <span className="break-all">{error}</span>
      </div>
    )
  }

  // No image URL → fall back to JSON.
  if (!url || status === 'error') {
    return (
      <>
        <JsonViewer data={args} label={t('tools.renderers.input')} maxHeight="max-h-40" />
        {result !== undefined && (
          <JsonViewer
            data={result}
            label={t('tools.renderers.output')}
            labelClassName={status === 'error' ? 'text-destructive' : undefined}
            maxHeight="max-h-60"
          />
        )}
      </>
    )
  }

  const fileName = (() => {
    try { return new URL(url, window.location.origin).pathname.split('/').filter(Boolean).pop() || 'generated' } catch { return 'generated' }
  })()

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-border overflow-hidden text-xs">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border-b border-border/50">
          <ImageIcon className="size-3 text-muted-foreground shrink-0" />
          {prompt && <span className="text-foreground truncate" title={prompt}>{prompt}</span>}
          {size !== null && (
            <span className="ml-auto text-[10px] text-muted-foreground shrink-0">{formatSize(size, t)}</span>
          )}
        </div>

        {/* Thumbnail */}
        <div className="relative group bg-background">
          <img
            src={url}
            alt={prompt ?? fileName}
            loading="lazy"
            onClick={() => setLightboxOpen(true)}
            className="block max-h-80 w-full cursor-zoom-in object-contain"
          />
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            aria-label={t('tools.renderers.openLightbox')}
            className="absolute right-1.5 top-1.5 rounded bg-background/80 p-1 opacity-0 backdrop-blur transition-opacity hover:bg-background group-hover:opacity-100"
          >
            <Maximize2 className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Raw toggle */}
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

      {lightboxOpen && (
        <ImageLightbox
          file={{ id: url, name: fileName, url, mimeType, size: size ?? 0 }}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </div>
  )
}
