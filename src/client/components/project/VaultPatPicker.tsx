import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronsUpDown, KeyRound, Ban } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { Button } from '@/client/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/client/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/client/components/ui/command'
import { api, getErrorMessage } from '@/client/lib/api'
import { toast } from 'sonner'
import type { VaultEntrySummary } from '@/shared/types'

/**
 * Picks the vault entry to use as the GitHub PAT for a project. Lists
 * credential-type vault entries whose key or description contains "git"
 * or "github" (heuristic — the user usually names PATs accordingly).
 *
 * The value is the entry **key** (not id), because the server-side
 * `resolvePat(vaultKey)` looks the secret up by key.
 */
interface VaultPatPickerProps {
  value: string | null
  onValueChange: (vaultKey: string | null) => void
  disabled?: boolean
  className?: string
}

/** Vault entry types that obviously aren't tokens. We exclude these
 *  rather than allow-list a small set — that way user-defined custom
 *  types (`secret`, `api-key`, `pat`, …) are picked up automatically. */
const NON_TOKEN_TYPES = new Set(['card', 'note', 'identity'])

/** Soft hint: bubble GitHub-themed entries to the top of the list so the
 *  user finds the right PAT in one glance even with a large vault.
 *  Does NOT filter — non-matching entries still appear below. */
function isGitHubFlavored(entry: VaultEntrySummary): boolean {
  const haystack = `${entry.key} ${entry.description ?? ''}`.toLowerCase()
  return haystack.includes('git') || haystack.includes('gh_') || haystack.includes('pat')
}

export function VaultPatPicker({ value, onValueChange, disabled, className }: VaultPatPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<VaultEntrySummary[] | null>(null)
  const [loading, setLoading] = useState(false)

  // Fetch lazily on first open: avoids loading the vault list for every
  // project modal mount, and refreshes on each open so newly-created PATs
  // appear without a manual reload.
  useEffect(() => {
    if (!open || loading) return
    setLoading(true)
    api
      .get<{ entries: VaultEntrySummary[] }>('/vault/entries')
      .then((data) => setEntries(data.entries))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Two tiers: GitHub-flavored entries first (alphabetical inside), then
  // any other secret-like entries. The Command component still fuzzy-
  // searches the rendered items via CommandInput.
  const { suggested, others } = useMemo(() => {
    if (!entries) return { suggested: [] as VaultEntrySummary[], others: [] as VaultEntrySummary[] }
    const eligible = entries.filter((e) => !NON_TOKEN_TYPES.has(e.entryType))
    const byKey = (a: VaultEntrySummary, b: VaultEntrySummary) => a.key.localeCompare(b.key)
    return {
      suggested: eligible.filter(isGitHubFlavored).sort(byKey),
      others: eligible.filter((e) => !isGitHubFlavored(e)).sort(byKey),
    }
  }, [entries])

  const selected =
    suggested.find((e) => e.key === value)
    ?? others.find((e) => e.key === value)
    ?? null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'w-full justify-between font-normal',
            !value && 'text-muted-foreground',
            className,
          )}
        >
          {selected ? (
            <span className="flex items-center gap-2 truncate">
              <KeyRound className="size-4 shrink-0 opacity-70" />
              <span className="truncate">{selected.key}</span>
            </span>
          ) : value ? (
            // Value set but entry not in the filtered list (e.g. user
            // edited it, or doesn't match the git/github heuristic).
            // Show the raw key so the user knows what's stored.
            <span className="flex items-center gap-2 truncate">
              <KeyRound className="size-4 shrink-0 opacity-70" />
              <span className="truncate">{value}</span>
            </span>
          ) : (
            <span>{t('projects.github.patPlaceholder')}</span>
          )}
          <ChevronsUpDown className="ml-auto size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder={t('projects.github.patSearchPlaceholder')} />
          <CommandList
            className="max-h-[300px] overflow-y-auto overscroll-contain"
            onWheel={(e) => e.stopPropagation()}
          >
            <CommandEmpty>
              {loading ? t('common.loading') : t('projects.github.patNoneFound')}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__clear__"
                onSelect={() => {
                  onValueChange(null)
                  setOpen(false)
                }}
              >
                <Check
                  className={cn('size-4 shrink-0', !value ? 'opacity-100' : 'opacity-0')}
                />
                <Ban className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground italic">
                  {t('projects.github.patClear')}
                </span>
              </CommandItem>
            </CommandGroup>
            {suggested.length > 0 && (
              <CommandGroup heading={t('projects.github.patSectionTitle')}>
                {suggested.map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={entry.key}
                    onSelect={() => {
                      onValueChange(entry.key)
                      setOpen(false)
                    }}
                  >
                    <Check className={cn('size-4 shrink-0', entry.key === value ? 'opacity-100' : 'opacity-0')} />
                    <KeyRound className="size-4 shrink-0 opacity-70" />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{entry.key}</span>
                      {entry.description && (
                        <span className="truncate text-xs text-muted-foreground">{entry.description}</span>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {others.length > 0 && (
              <CommandGroup heading={t('projects.github.patOtherSection')}>
                {others.map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={entry.key}
                    onSelect={() => {
                      onValueChange(entry.key)
                      setOpen(false)
                    }}
                  >
                    <Check className={cn('size-4 shrink-0', entry.key === value ? 'opacity-100' : 'opacity-0')} />
                    <KeyRound className="size-4 shrink-0 opacity-70" />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{entry.key}</span>
                      {entry.description && (
                        <span className="truncate text-xs text-muted-foreground">{entry.description}</span>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
