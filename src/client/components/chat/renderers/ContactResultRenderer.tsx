import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, User, AtSign, StickyNote, AlertTriangle, SearchX } from 'lucide-react'
import { JsonViewer } from '@/client/components/common/JsonViewer'
import type { ToolResultRendererProps } from '@/client/lib/tool-renderers'

interface ContactNote {
  source?: string
  scope?: string
  content?: string
}

interface Contact {
  id?: string
  firstName?: string
  lastName?: string
  displayName?: string
  nicknames?: string[]
  identifiers?: Array<{ label?: string; value?: string }>
  notes?: ContactNote[]
}

function initials(c: Contact): string {
  const name = c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ')
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  const first = parts[0]?.[0] ?? ''
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : ''
  return (first + second).slice(0, 2).toUpperCase() || '?'
}

function ContactCard({ c }: { c: Contact }) {
  const { t } = useTranslation()
  const name = c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || t('tools.renderers.contactUnnamed')
  return (
    <div className="px-3 py-2">
      <div className="flex items-start gap-2.5">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
          {initials(c)}
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="font-medium text-foreground truncate">{name}</div>

          {/* Nicknames */}
          {!!c.nicknames?.length && (
            <div className="flex flex-wrap gap-1">
              {c.nicknames.map((n, i) => (
                <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{n}</span>
              ))}
            </div>
          )}

          {/* Identifiers */}
          {!!c.identifiers?.length && (
            <div className="space-y-0.5">
              {c.identifiers.map((id, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[11px]">
                  <AtSign className="size-2.5 shrink-0 text-muted-foreground/60" />
                  {id.label && <span className="text-muted-foreground/70">{id.label}:</span>}
                  <span className="text-foreground/90 break-all font-mono">{id.value}</span>
                </div>
              ))}
            </div>
          )}

          {/* Notes */}
          {!!c.notes?.length && (
            <div className="space-y-0.5">
              {c.notes.map((note, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                  <StickyNote className="size-2.5 mt-0.5 shrink-0 text-muted-foreground/60" />
                  <span className="break-words">{note.content}</span>
                  {note.source && (
                    <span className="ml-auto shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground/60">
                      {note.source}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Rich renderer for contact tools — get_contact, search_contacts, create_contact,
 * update_contact and find_contact_by_identifier. Renders each contact as a card
 * (avatar initials, nicknames, identifiers, notes); handles the "not found" case.
 * Falls back to JsonViewer for unexpected shapes.
 */
export function ContactResultRenderer({ args, result, status }: ToolResultRendererProps) {
  const { t } = useTranslation()
  const [showRaw, setShowRaw] = useState(false)

  const res = result as Record<string, unknown> | null | undefined
  const error = typeof res?.error === 'string' ? res.error : null

  // find_contact_by_identifier "not found" case.
  const notFound = res?.found === false
  const notFoundMessage = typeof res?.message === 'string' ? res.message : null

  // Build the contact list: search returns `contacts[]`, the others a single contact.
  const list = Array.isArray(res?.contacts) ? (res!.contacts as Contact[]) : null
  const single: Contact | null =
    !list && res && typeof res.id === 'string' && (res.displayName || res.firstName || res.lastName)
      ? (res as Contact)
      : null
  const contacts = list ?? (single ? [single] : null)

  if (error || status === 'error') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <AlertTriangle className="size-3 mt-0.5 shrink-0" />
        <span className="break-all">{error ?? t('tools.renderers.error')}</span>
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <SearchX className="size-3 shrink-0" />
        <span>{notFoundMessage ?? t('tools.renderers.contactNotFound')}</span>
      </div>
    )
  }

  // Unexpected shape → fall back to JSON.
  if (!contacts) {
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
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border-b border-border/50">
          <User className="size-3 text-muted-foreground shrink-0" />
          <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">
            {t('tools.renderers.contactCount', { count: contacts.length })}
          </span>
        </div>

        {contacts.length > 0 ? (
          <div className="divide-y divide-border/40 max-h-96 overflow-auto scrollbar-thin">
            {contacts.map((c, i) => (
              <ContactCard key={c.id ?? i} c={c} />
            ))}
          </div>
        ) : (
          <div className="px-3 py-2 text-[11px] text-muted-foreground">{t('tools.renderers.contactNoResults')}</div>
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
