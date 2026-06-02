import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Home, FolderKanban } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { useAuth } from '@/client/hooks/useAuth'
import { ThemeToggle } from '@/client/components/common/ThemeToggle'
import { PaletteToggle } from '@/client/components/common/PaletteToggle'
import { UserMenu } from '@/client/components/common/UserMenu'
import { NotificationBell } from '@/client/components/notifications/NotificationBell'
import { SSEStatusIndicator } from '@/client/components/common/SSEStatusIndicator'
import { QueueIndicator } from '@/client/components/layout/QueueIndicator'
import { SetupChecklistButton } from '@/client/components/layout/SetupChecklistButton'

interface AppTopBarProps {
  /** Open a settings section (or the default tab). */
  onOpenSettings: (section?: string, filters?: { kinId?: string }) => void
  /** Open the account dialog. */
  onOpenAccount: () => void
}

/**
 * Persistent top bar shown across all authenticated pages (Kins, Projets, etc.).
 *
 * Hosts global actions: brand, SSE indicator, palette/theme toggles, notifications,
 * user menu. Lives at the App.tsx layout level so it doesn't disappear when the
 * user navigates between modes via the ActivityBar.
 *
 * The Kins-specific SidebarTrigger (toggle for the shadcn Sidebar) stays inside
 * ChatPage's local header — it depends on SidebarProvider context which is scoped
 * to that page.
 */
export function AppTopBar({ onOpenSettings, onOpenAccount }: AppTopBarProps) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()

  // Mobile mode switch — the left ActivityBar rail is hidden below md, so the
  // Kins/Projects switch moves into this always-present top bar as a compact
  // segmented control. Keeps navigation reachable without wasting a full column.
  const isProjects = location.pathname.startsWith('/projects')
  const modeItems = [
    { key: 'kins', to: '/', icon: Home, active: !isProjects, label: t('activityBar.kins') },
    { key: 'projects', to: '/projects', icon: FolderKanban, active: isProjects, label: t('activityBar.projects') },
  ] as const

  return (
    <header className="surface-header sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b px-4">
      <button
        type="button"
        className="flex shrink-0 items-center gap-2.5"
        onClick={() => navigate('/')}
      >
        <img src="/kinbot.svg" alt="" width={28} height={28} className="rounded-lg" />
        {/* Logo wordmark collides with the right cluster at very narrow widths
            (<=375px). Hide the text on mobile; the icon alone keeps the brand. */}
        <span className="hidden sm:inline gradient-primary-text text-xl font-bold tracking-tight">
          KinBot
        </span>
      </button>

      {/* Mobile mode switch (Kins / Projects) — replaces the hidden ActivityBar
          rail below md. Icon-only segmented control to stay compact. */}
      <nav
        className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/60 p-0.5 md:hidden"
        aria-label={t('activityBar.kins')}
      >
        {modeItems.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => navigate(item.to)}
              title={item.label}
              aria-label={item.label}
              aria-current={item.active ? 'page' : undefined}
              className={cn(
                'flex size-8 items-center justify-center rounded-md transition-colors',
                item.active
                  ? 'bg-background text-primary shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-4" strokeWidth={1.75} />
            </button>
          )
        })}
      </nav>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
        {user && <QueueIndicator />}
        <SSEStatusIndicator />
        {user && <SetupChecklistButton onOpenSettings={onOpenSettings} />}
        <PaletteToggle />
        <ThemeToggle />
        {user && <NotificationBell onOpenSettings={onOpenSettings} />}
        {user && (
          <UserMenu
            user={{
              firstName: user.firstName,
              lastName: user.lastName,
              pseudonym: user.pseudonym,
              email: user.email,
              avatarUrl: user.avatarUrl,
            }}
            onLogout={logout}
            onOpenSettings={() => onOpenSettings()}
            onOpenAccount={onOpenAccount}
          />
        )}
      </div>
    </header>
  )
}
