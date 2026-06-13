/**
 * Mini-app iframe tokens.
 *
 * The hardened iframe runs at an OPAQUE origin (sandbox without
 * `allow-same-origin`), so the user's session cookie never reaches its JS — it
 * therefore cannot call `/api/*` with the user's identity at all. To let the app
 * reach its OWN namespace (`/api/mini-apps/<id>/*`), the `/serve` route (which is
 * still loaded with the cookie via iframe navigation) mints a short-lived token
 * bound to (appId, userId) and injects it into the document. The SDK sends it as
 * the `x-hivekeep-app-token` header (or `?_t=` for the EventSource, which can't
 * set headers). authMiddleware accepts it ONLY for that app's namespace.
 *
 * In-memory + TTL: tokens are ephemeral (a fresh one is minted on every iframe
 * load), so losing them on restart just means open iframes re-mint on reload.
 */

import { randomBytes } from 'crypto'

interface AppTokenEntry {
  appId: string
  userId: string
  expiresAt: number
}

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000 // 12h — re-minted on every iframe load
const tokens = new Map<string, AppTokenEntry>()

/** Mint a token for (appId, userId). Returns the opaque token string. */
export function mintAppToken(appId: string, userId: string): string {
  const token = randomBytes(32).toString('base64url')
  tokens.set(token, { appId, userId, expiresAt: Date.now() + TOKEN_TTL_MS })
  // Opportunistic cleanup so the map can't grow unbounded across reloads.
  if (tokens.size > 5000) {
    const now = Date.now()
    for (const [t, e] of tokens) if (e.expiresAt < now) tokens.delete(t)
  }
  return token
}

/** Resolve a token to its (appId, userId), or null if unknown/expired. */
export function resolveAppToken(token: string): { appId: string; userId: string } | null {
  const entry = tokens.get(token)
  if (!entry) return null
  if (entry.expiresAt < Date.now()) {
    tokens.delete(token)
    return null
  }
  return { appId: entry.appId, userId: entry.userId }
}
