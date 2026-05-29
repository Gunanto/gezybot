import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Database, AlertTriangle } from 'lucide-react'
import { JsonViewer } from '@/client/components/common/JsonViewer'
import type { ToolResultRendererProps } from '@/client/lib/tool-renderers'

/** Render a single cell value compactly. */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '∅'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Rich renderer for execute_sql results.
 * Read queries → a result table (columns + rows). Write queries → an
 * affected-rows summary. Falls back to JsonViewer for unexpected shapes.
 */
export function SqlResultRenderer({ args, result, status }: ToolResultRendererProps) {
  const { t } = useTranslation()
  const [showRaw, setShowRaw] = useState(false)

  const sql = typeof args.sql === 'string' ? args.sql : null
  const res = result as Record<string, unknown> | null | undefined
  const error = typeof res?.error === 'string' ? res.error : null
  const rows = Array.isArray(res?.rows) ? (res!.rows as Record<string, unknown>[]) : null
  const rowCount = typeof res?.rowCount === 'number' ? res.rowCount : null
  const truncated = res?.truncated === true
  const changes = typeof res?.changes === 'number' ? res.changes : null
  const lastInsertRowid =
    res?.lastInsertRowid !== undefined && res?.lastInsertRowid !== null
      ? String(res.lastInsertRowid)
      : null

  // Columns derived from the union of keys across the (capped) rows.
  const columns = rows && rows.length > 0 ? Array.from(new Set(rows.flatMap(r => Object.keys(r)))) : []

  const header = (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border-b border-zinc-800">
      <Database className="size-3 text-zinc-500 shrink-0" />
      {sql && <code className="text-[10px] text-zinc-300 truncate font-mono">{sql}</code>}
    </div>
  )

  let body: React.ReactNode = null

  if (error || status === 'error') {
    body = (
      <div className="flex items-start gap-2 px-3 py-2 text-red-300">
        <AlertTriangle className="size-3 mt-0.5 shrink-0 text-red-400" />
        <span className="break-all">{error ?? t('tools.renderers.error')}</span>
      </div>
    )
  } else if (rows) {
    body = rows.length === 0 ? (
      <div className="px-3 py-2 text-[11px] text-zinc-500">{t('tools.renderers.sqlNoRows')}</div>
    ) : (
      <div className="max-h-80 overflow-auto scrollbar-thin">
        <table className="w-full text-[11px] font-mono">
          <thead className="sticky top-0 bg-zinc-900">
            <tr>
              {columns.map(col => (
                <th key={col} className="px-2 py-1 text-left font-semibold text-zinc-400 border-b border-zinc-800 whitespace-nowrap">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-zinc-800/40 hover:bg-zinc-800/30">
                {columns.map(col => (
                  <td key={col} className="px-2 py-1 text-zinc-300 align-top max-w-[24rem] truncate" title={formatCell(row[col])}>
                    {formatCell(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  } else if (changes !== null) {
    body = (
      <div className="px-3 py-2 text-[11px] text-zinc-300 space-y-0.5">
        <div>{t('tools.renderers.sqlChanges', { count: changes })}</div>
        {lastInsertRowid && (
          <div className="text-zinc-500">{t('tools.renderers.sqlLastInsert', { id: lastInsertRowid })}</div>
        )}
      </div>
    )
  }

  // Unexpected shape → fall back to JSON.
  if (body === null) {
    return (
      <>
        <JsonViewer data={args} label={t('tools.renderers.input')} maxHeight="max-h-40" />
        {result !== undefined && <JsonViewer data={result} label={t('tools.renderers.output')} maxHeight="max-h-60" />}
      </>
    )
  }

  return (
    <div className="space-y-2">
      <div className="rounded-md bg-zinc-950 text-zinc-100 overflow-hidden">
        {header}
        {body}
        {rows && rows.length > 0 && (
          <div className="px-3 py-1 text-[10px] text-zinc-500 bg-zinc-900/50 border-t border-zinc-800">
            {truncated && rowCount !== null
              ? t('tools.renderers.sqlRowsTruncated', { shown: rows.length, total: rowCount })
              : t('tools.renderers.sqlRows', { count: rowCount ?? rows.length })}
          </div>
        )}
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
    </div>
  )
}
