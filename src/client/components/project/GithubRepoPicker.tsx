import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronsUpDown, Github, Lock, Globe } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
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
import type { GitHubRepoSummary } from '@/shared/types'

const DEBOUNCE_MS = 300

interface GithubRepoPickerProps {
  /** Selected repo as "owner/name" (the value persisted on the project). */
  value: string | null
  onValueChange: (repo: string | null, defaultBranch: string | null) => void
  /** Vault key whose PAT is used to drive the backend search. When null,
   *  the picker is disabled with a helpful message. */
  patVaultKey: string | null
  disabled?: boolean
  className?: string
}

/**
 * Combobox over the GitHub-repos endpoint. Two modes:
 *   - empty query → repos the PAT can directly access (own, collaborator,
 *     org member), sorted by most-recently-updated
 *   - non-empty query → free-form search across all of GitHub
 *
 * Filtering is server-side; `shouldFilter={false}` on the Command keeps
 * `cmdk` from second-guessing what the API returned. Search is debounced
 * to avoid stampeding `/search/repositories` on every keystroke.
 */
export function GithubRepoPicker({
  value,
  onValueChange,
  patVaultKey,
  disabled,
  className,
}: GithubRepoPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [repos, setRepos] = useState<GitHubRepoSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Debounce the input so we don't hammer /search/repositories.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [query])

  // Fetch on open, on PAT change, and on debounced query change. The
  // `open` guard avoids a wasted fetch when the picker is closed.
  useEffect(() => {
    if (!open || !patVaultKey) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ pat_vault_key: patVaultKey })
    if (debounced) params.set('q', debounced)
    api
      .get<{ repos: GitHubRepoSummary[] }>(`/projects/list-github-repos?${params}`)
      .then((data) => {
        if (!cancelled) setRepos(data.repos)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(getErrorMessage(err))
          setRepos([])
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, patVaultKey, debounced])

  // Reset transient state when closing so reopening starts fresh.
  useEffect(() => {
    if (!open) {
      setQuery('')
      setDebounced('')
      setError(null)
    }
  }, [open])

  const selected = useMemo(
    () => repos.find((r) => r.fullName === value) ?? null,
    [repos, value],
  )

  const triggerLabel = value
    ? selected?.fullName ?? value
    : t('projects.github.repoPlaceholder')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled || !patVaultKey}
          className={cn(
            'w-full justify-between font-normal',
            !value && 'text-muted-foreground',
            className,
          )}
          title={!patVaultKey ? t('projects.github.repoNeedsPat') : undefined}
        >
          <span className="flex items-center gap-2 truncate">
            <Github className="size-4 shrink-0 opacity-70" />
            <span className="truncate">{triggerLabel}</span>
          </span>
          <ChevronsUpDown className="ml-auto size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t('projects.github.repoSearchPlaceholder')}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList
            className="max-h-[320px] overflow-y-auto overscroll-contain"
            onWheel={(e) => e.stopPropagation()}
          >
            <CommandEmpty>
              {loading
                ? t('common.loading')
                : error
                ? error
                : debounced
                ? t('projects.github.repoNoResults', { query: debounced })
                : t('projects.github.repoNoneAccessible')}
            </CommandEmpty>
            {repos.length > 0 && (
              <CommandGroup
                heading={
                  debounced
                    ? t('projects.github.repoSearchResults')
                    : t('projects.github.repoAccessible')
                }
              >
                {repos.map((repo) => (
                  <CommandItem
                    key={repo.fullName}
                    value={repo.fullName}
                    onSelect={() => {
                      onValueChange(repo.fullName, repo.defaultBranch)
                      setOpen(false)
                    }}
                  >
                    <Check
                      className={cn(
                        'size-4 shrink-0',
                        repo.fullName === value ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    {repo.private ? (
                      <Lock className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <Globe className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{repo.fullName}</span>
                      {repo.description && (
                        <span className="truncate text-xs text-muted-foreground">
                          {repo.description}
                        </span>
                      )}
                    </div>
                    {repo.canPush === false && (
                      <Badge variant="outline" size="xs" className="shrink-0">
                        {t('projects.github.repoReadOnly')}
                      </Badge>
                    )}
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
