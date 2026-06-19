/**
 * HTTP routes for the in-app provider OAuth sign-in (PKCE), used by the Settings
 * "Sign in" flow. The actual engine lives in `services/provider-signin.ts` and
 * is shared with the in-chat OAuth setup card. Generic over `LLMProvider.oauth`:
 * any provider that declares it supports these routes.
 *
 *   POST /api/providers/oauth/:type/start     → { authUrl, state }
 *   POST /api/providers/oauth/:type/complete  → exchange code, create provider
 */
import { Hono } from 'hono'
import { createLogger } from '@/server/logger'
import { startProviderSignIn, completeProviderSignIn } from '@/server/services/provider-signin'

const log = createLogger('routes:provider-oauth')
const providerOAuthRoutes = new Hono()

// Short-lived store for in-flight PKCE flows (the verifier is secret and never
// leaves the server). Keyed by the state we generated.
const pendingFlows = new Map<string, { type: string; verifier: string; createdAt: number }>()
const FLOW_TTL_MS = 10 * 60 * 1000

function sweepFlows(): void {
  const cutoff = Date.now() - FLOW_TTL_MS
  for (const [k, v] of pendingFlows) if (v.createdAt < cutoff) pendingFlows.delete(k)
}

// POST /api/providers/oauth/:type/start — begin the PKCE flow.
providerOAuthRoutes.post('/:type/start', async (c) => {
  const type = c.req.param('type')
  const started = startProviderSignIn(type)
  if (!started) {
    return c.json(
      { error: { code: 'NOT_OAUTH_SIGNIN', message: `${type} does not support in-app sign-in` } },
      400,
    )
  }
  sweepFlows()
  pendingFlows.set(started.state, { type, verifier: started.verifier, createdAt: Date.now() })
  return c.json({ authUrl: started.authorizeUrl, state: started.state })
})

// POST /api/providers/oauth/:type/complete — finish the flow.
// Body: { state, code, name?, providerId? }
//   - code may be the bare code, Anthropic's `<code>#<state>`, or a full
//     redirect URL; the engine normalises all three.
//   - providerId (optional) re-authenticates an existing row in place.
providerOAuthRoutes.post('/:type/complete', async (c) => {
  const type = c.req.param('type')
  type CompleteBody = { state?: string; code?: string; name?: string; providerId?: string }
  const body: CompleteBody = await c.req.json<CompleteBody>().catch(() => ({} as CompleteBody))
  if (!body.state || !body.code) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'state and code are required' } }, 400)
  }
  const flow = pendingFlows.get(body.state)
  if (!flow || flow.type !== type) {
    return c.json({ error: { code: 'INVALID_STATE', message: 'Sign-in session expired — start again.' } }, 400)
  }
  pendingFlows.delete(body.state)

  const result = await completeProviderSignIn({
    type,
    codeInput: body.code,
    verifier: flow.verifier,
    expectedState: body.state,
    name: body.name,
    providerId: body.providerId,
  })
  if (!result.ok) {
    log.warn({ type, code: result.code }, 'Provider sign-in failed')
    return c.json({ error: { code: result.code, message: result.message } }, 400)
  }
  const p = result.provider
  return c.json(
    { provider: { id: p.id, slug: p.slug, name: p.name, type: p.type, capabilities: p.capabilities, isValid: p.isValid } },
    result.created ? 201 : 200,
  )
})

export { providerOAuthRoutes }
