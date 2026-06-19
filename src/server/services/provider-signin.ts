/**
 * Provider OAuth sign-in (PKCE) — the shared engine behind BOTH the HTTP routes
 * (`routes/provider-oauth.ts`, Settings "Sign in") and the in-chat OAuth setup
 * card (`secret-prompts.ts`, kind:'oauth'). Generic over `LLMProvider.oauth`:
 * nothing here names a specific provider type.
 *
 *   startProviderSignIn(type)    → mint PKCE + authorize URL (verifier returned
 *                                   to the caller, which holds it server-side)
 *   completeProviderSignIn(...)  → exchange the pasted code, vault the tokens,
 *                                   create/update + test the provider, broadcast
 */
import { eq } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { providers } from '@/server/db/schema'
import { encrypt } from '@/server/services/encryption'
import { getCapabilitiesForType, testProviderConnection } from '@/server/providers/index'
import { reconcileProvider } from '@/server/services/model-registry'
import { generateProviderSlug } from '@/server/services/provider-slug'
import { sseManager } from '@/server/sse/index'
import { PROVIDER_META, type ProviderType } from '@/shared/provider-metadata'
import { createLogger } from '@/server/logger'
import { getLLMProvider } from '@/server/llm/llm/registry'
import {
  generatePkce,
  buildPkceAuthorizeUrl,
  exchangePkceCode,
  parsePastedCode,
} from '@/server/llm/llm/_oauth-pkce'
import {
  writeTokenBundle,
  oauthVaultKey,
  PROVIDER_ID_KEY,
  PROVIDER_TYPE_KEY,
  type OAuthTokenBundle,
} from '@/server/llm/llm/_oauth-token-store'

const log = createLogger('provider-signin')

export interface ProviderSignInStart {
  authorizeUrl: string
  state: string
  /** Secret — held server-side by the caller (route pendingFlows / card spec),
   *  never sent to the client. */
  verifier: string
  providerDisplayName: string
  redirectStyle: 'page' | 'loopback'
}

/** Begin a sign-in: mint PKCE + the browser authorize URL. Null when the type
 *  declares no `oauth` (not a sign-in provider / not registered). */
export function startProviderSignIn(type: string): ProviderSignInStart | null {
  const provider = getLLMProvider(type)
  const entry = provider?.oauth
  if (!entry) return null
  const { verifier, challenge } = generatePkce()
  const state = uuid()
  const authorizeUrl = buildPkceAuthorizeUrl({ client: entry.client, challenge, state })
  return {
    authorizeUrl,
    state,
    verifier,
    providerDisplayName: provider?.displayName ?? type,
    redirectStyle: entry.redirectStyle,
  }
}

export interface SignedInProvider {
  id: string
  slug: string
  name: string
  type: string
  capabilities: string[]
  isValid: boolean
}

export type CompleteSignInResult =
  | { ok: true; created: boolean; provider: SignedInProvider }
  | { ok: false; code: 'NOT_OAUTH_SIGNIN' | 'INVALID_CODE' | 'EXCHANGE_FAILED' | 'NO_REFRESH_TOKEN'; message: string }

/**
 * Finish a sign-in: exchange the pasted code (bare code / `<code>#<state>` /
 * full redirect URL), vault the tokens, then create (or, with `providerId`,
 * re-authenticate) and test the provider.
 */
export async function completeProviderSignIn(params: {
  type: string
  /** Whatever the user pasted back (code, `code#state`, or redirect URL). */
  codeInput: string
  /** The verifier minted by startProviderSignIn, held by the caller. */
  verifier: string
  /** The state we generated, for providers that echo it in the exchange. */
  expectedState?: string
  name?: string
  /** Re-authenticate this existing provider in place instead of creating. */
  providerId?: string
  createdByAgentId?: string
}): Promise<CompleteSignInResult> {
  const entry = getLLMProvider(params.type)?.oauth
  if (!entry) {
    return { ok: false, code: 'NOT_OAUTH_SIGNIN', message: `${params.type} does not support in-app sign-in` }
  }

  const parsed = parsePastedCode(params.codeInput)
  if (!parsed.code) {
    return { ok: false, code: 'INVALID_CODE', message: 'Could not read an authorization code from the input.' }
  }

  let tokens
  try {
    tokens = await exchangePkceCode({
      client: entry.client,
      code: parsed.code,
      verifier: params.verifier,
      state: parsed.state ?? params.expectedState,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token exchange failed'
    log.warn({ type: params.type, err: message }, 'OAuth code exchange failed')
    return { ok: false, code: 'EXCHANGE_FAILED', message }
  }
  if (!tokens.refreshToken) {
    return { ok: false, code: 'NO_REFRESH_TOKEN', message: 'The provider did not return a refresh token — try again.' }
  }

  const bundle: OAuthTokenBundle = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
    ...(entry.buildExtra ? { extra: entry.buildExtra(tokens) } : {}),
  }
  if (bundle.extra === undefined) delete bundle.extra

  const existing = params.providerId
    ? await db.select().from(providers).where(eq(providers.id, params.providerId)).get()
    : undefined
  const id = existing?.id ?? uuid()

  // Persist tokens in the vault under the row's deterministic key.
  await writeTokenBundle(oauthVaultKey(params.type, id), bundle)

  // Validate (tokens are fresh, so this just probes the model list). Thread the
  // row identity so the vault bundle is found.
  const probeConfig: Record<string, string> = {
    authMode: 'signin',
    [PROVIDER_ID_KEY]: id,
    [PROVIDER_TYPE_KEY]: params.type,
  }
  const testResult = await testProviderConnection(params.type, probeConfig)
  const configEncrypted = await encrypt(JSON.stringify({ authMode: 'signin' }))
  const capabilities = getCapabilitiesForType(params.type)
  const meta = PROVIDER_META[params.type as ProviderType]

  if (existing) {
    await db
      .update(providers)
      .set({
        configEncrypted,
        capabilities: JSON.stringify(capabilities),
        isValid: testResult.valid,
        lastError: testResult.valid ? null : (testResult.error ?? null),
        updatedAt: new Date(),
      })
      .where(eq(providers.id, id))
    if (testResult.valid) void reconcileProvider(id).catch(() => {})
    sseManager.broadcast({
      type: 'provider:updated',
      data: {
        providerId: id,
        slug: existing.slug,
        name: existing.name,
        providerType: params.type,
        capabilities,
        isValid: testResult.valid,
        lastError: testResult.valid ? null : (testResult.error ?? null),
      },
    })
    log.info({ providerId: id, type: params.type, isValid: testResult.valid }, 'Provider re-authenticated via sign-in')
    return {
      ok: true,
      created: false,
      provider: { id, slug: existing.slug, name: existing.name, type: params.type, capabilities, isValid: testResult.valid },
    }
  }

  const name = params.name?.trim() || meta?.displayName || params.type
  const slug = generateProviderSlug(name)
  await db.insert(providers).values({
    id,
    slug,
    name,
    type: params.type,
    configEncrypted,
    capabilities: JSON.stringify(capabilities),
    isValid: testResult.valid,
    lastError: testResult.valid ? null : (testResult.error ?? null),
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  if (testResult.valid) await reconcileProvider(id)
  sseManager.broadcast({
    type: 'provider:created',
    data: { providerId: id, slug, name, providerType: params.type, capabilities, isValid: testResult.valid },
  })
  log.info({ providerId: id, slug, type: params.type, isValid: testResult.valid }, 'Provider created via sign-in')
  return { ok: true, created: true, provider: { id, slug, name, type: params.type, capabilities, isValid: testResult.valid } }
}
