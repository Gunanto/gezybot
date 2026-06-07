---
title: Developing Plugins
description: Build, test, and publish Hivekeep plugins with the @hivekeep/sdk package.
---

This is the canonical guide for writing Hivekeep plugins. Every plugin imports everything it needs from `@hivekeep/sdk` — there are no Hivekeep-internal imports a plugin should reach into.

> The legacy plugin-store-specific `docs/plugins.md` and `PLUGIN-SPEC.md` are pointers to this page. If you're consulting them and they disagree with this guide, this guide wins.

## Quickstart

```bash
bunx create-hivekeep-plugin --name hello-agent --type tools
cd hello-agent
```

The scaffolder generates a `plugin.json` manifest, an `index.ts` entry point, and a `README.md`. Drop the folder into your Hivekeep install's `plugins/` directory and Hivekeep picks it up at startup.

Or write it by hand:

```typescript
// plugins/hello-agent/index.ts
import { tool, z } from '@hivekeep/sdk'
import type { PluginContext, PluginExports } from '@hivekeep/sdk'

export default function (ctx: PluginContext): PluginExports {
  ctx.log.info('hello-agent plugin loaded')

  return {
    tools: {
      greet: {
        availability: ['main', 'sub-agent'],
        create: () =>
          tool({
            description: 'Say hi to someone.',
            inputSchema: z.object({
              name: z.string().describe('Who to greet'),
            }),
            execute: async ({ name }) => ({
              reply: `Hi ${name}, glad to meet you!`,
            }),
          }),
      },
    },
  }
}
```

```json
// plugins/hello-agent/plugin.json
{
  "$schema": "https://unpkg.com/@hivekeep/sdk/schemas/plugin-manifest.schema.json",
  "name": "hello-agent",
  "version": "0.1.0",
  "description": "Greet users by name.",
  "main": "index.ts",
  "hivekeep": ">=0.40.0"
}
```

That's it. Restart Hivekeep, enable the plugin in Settings → Plugins, and Agents can call `greet({name:'Marl'})`.

## Manifest (`plugin.json`)

| Field | Type | Notes |
|---|---|---|
| `name` | string | `[a-z0-9-]+` — unique across the install. |
| `version` | string | Semver. |
| `description` | string | Surfaced in the Plugins UI. |
| `main` | string | Entry file. Usually `index.ts`. |
| `hivekeep` | semver range | Hivekeep host versions this plugin is compatible with. |
| `author` | string? | Optional. |
| `license` | string? | Optional. |
| `homepage` | string? | Optional. |
| `icon` | string? | Emoji or path. |
| `permissions` | string[] | `http:<host>` declarations granted by `ctx.http.fetch()`. Defaults to none. |
| `dependencies` | `Record<string, string>` | Other plugins this one depends on (semver). |
| `config` | `Record<string, PluginConfigField>` | Plugin-level config schema (renders the per-plugin settings form). |
| `channels.<platform>.configSchema` | `ChannelConfigSchema` | Optional channel config form schema declared at manifest level. |

Hivekeep validates the manifest at load time. A bad field fails fast and the plugin doesn't get activated.

## The Plugin Context

```ts
import type { PluginContext } from '@hivekeep/sdk'

interface PluginContext<Config = Record<string, unknown>> {
  config:   Config            // <Config> generic for typed config
  log:      PluginLogger       // scoped to your plugin name
  storage:  PluginStorageAPI   // key/value store, plugin-scoped
  http:     PluginHTTPClient   // fetch with permission enforcement
  vault:    PluginVaultAPI     // secrets (read permissive, write scoped)
  manifest: { name: string; version: string }
  cards:    PluginCardsAPI     // emit / update plugin cards in the chat
}
```

### `ctx.config<Config>()` — typed config

Plug your manifest config shape into the generic and `ctx.config.<field>` is fully typed:

```ts
interface MyConfig { apiKey: string; region?: 'eu' | 'us' }

export default function (ctx: PluginContext<MyConfig>) {
  const region = ctx.config.region ?? 'eu'   // typed
  // ctx.config.apiKey  ← string
}
```

The runtime never validates against the generic — Hivekeep already validated the values against the manifest's `config` schema before instantiating the context. The generic is purely a type-side convenience.

### `ctx.log`

Per-plugin scoped logger. Pino-backed. Both shapes work:

```ts
ctx.log.info('event happened')
ctx.log.error({ err, userId }, 'failed to fetch')
```

### `ctx.storage`

Plugin-scoped KV store. Keys are namespaced internally so two plugins with the same key don't collide.

```ts
await ctx.storage.set('counter', 42)
const n = await ctx.storage.get<number>('counter')   // → 42 | null
await ctx.storage.list('prefix:')                    // → string[]
await ctx.storage.delete('counter')
await ctx.storage.clear()                            // wipe everything this plugin stored
```

### `ctx.http`

Same shape as `fetch()`. The wrapper enforces your manifest's `permissions: ['http:<host>']` declarations — calls to undeclared hosts throw before going out.

```ts
const res = await ctx.http.fetch('https://api.example.com/weather?q=Paris')
```

### `ctx.vault`

```ts
await ctx.vault.getSecret(key)                     // read any vault key (you must know it)
await ctx.vault.setSecret(key, value, description?) // scoped: plugin:<name>:<key>
await ctx.vault.deleteSecret(key)                  // scoped
await ctx.vault.listKeys()                         // your plugin's keys, unprefixed
```

Read is permissive: you read the key your config gave you (e.g. an `authTokenVaultKey` reference Hivekeep persisted from a channel password field). Write / delete / list are strictly scoped to a `plugin:<your-plugin-name>:` namespace — you cannot touch another plugin's secrets or Hivekeep's own.

### `ctx.cards`

See the [Cards](#cards) section below.

## Tools

Tools are AI-callable functions Agents can invoke during a turn. Declare them with `tool()` from the SDK — `inputSchema` is a zod schema, the `execute` callback's argument is inferred from it.

```ts
import { tool, z } from '@hivekeep/sdk'

return {
  tools: {
    fetch_weather: {
      availability: ['main', 'sub-agent'],
      defaultDisabled: false,
      readOnly: true,
      concurrencySafe: true,
      create: (execCtx) =>
        tool({
          description: 'Get current weather for a location.',
          inputSchema: z.object({
            location: z.string().describe('City name (e.g. "Paris")'),
            units: z.enum(['metric', 'imperial']).optional(),
          }),
          execute: async ({ location, units = 'metric' }) => {
            // execCtx.agentId, execCtx.userId, etc. are available in the closure
            const res = await ctx.http.fetch(`https://api.example.com/?q=${location}&units=${units}`)
            return res.json()
          },
        }),
    },
  },
}
```

Available `ToolRegistration` flags:

| Flag | Default | Effect |
|---|---|---|
| `availability` | required | Which agents see the tool — `'main'`, `'sub-agent'`, or both. |
| `defaultDisabled` | `false` | If true, Agents must explicitly opt in to enable the tool. |
| `readOnly` | `false` | Declares the tool doesn't mutate state. Used by UI confirmations. |
| `concurrencySafe` | `false` | Allows Hivekeep to invoke this tool in parallel with other safe tools in the same step. |
| `destructive` | `false` | Marks the tool as performing irreversible operations. UI may confirm before firing. |
| `condition` | — | Predicate evaluated at resolve time. Return false to omit. |

## Channels

A channel adapter is an instance of `ChannelAdapter` exported under `channels.<platform-name>`. It owns the transport with an external messaging platform (Telegram, Discord, Twilio, custom WebSocket bot…) and translates between that platform and Hivekeep's `IncomingMessage` / `OutboundMessageParams` shapes.

```ts
import type {
  ChannelAdapter,
  IncomingMessageHandler,
  OutboundMessageParams,
  OutboundMessageResult,
  PluginContext,
} from '@hivekeep/sdk'

export default function (ctx: PluginContext) {
  const adapter: ChannelAdapter = {
    platform: 'my-platform',
    meta: { displayName: 'My Platform', brandColor: '#9b59b6' },
    configSchema: {
      fields: [
        { name: 'apiKey', label: 'API Key', type: 'password', required: true },
        { name: 'channelName', label: 'Channel', type: 'text', required: true },
      ],
    },
    async start(channelId, config, onMessage: IncomingMessageHandler) { /* … */ },
    async stop(channelId) { /* … */ },
    async sendMessage(channelId, config, params: OutboundMessageParams): Promise<OutboundMessageResult> {
      // …
      return { platformMessageId: 'plat-123' }
    },
    async validateConfig(config) { return { valid: true } },
    async getBotInfo(config) { return { name: 'MyBot' } },
  }
  return { channels: { 'my-platform': adapter } }
}
```

Webhook-driven adapters implement `handleInboundWebhook`. Hivekeep routes `POST /api/channels/plugin/<platform>/webhook/<channelId>` to it — the adapter verifies the request signature, returns the `IncomingMessage` to inject (or `null` to drop the event) plus the HTTP `Response` to send back to the platform.

Identity-switch behaviour (when a channel is transferred to a different Agent) is controlled by `identitySwitchMode`: `'native'` (adapter implements `onIdentityChange`), `'prefix'` (default — Hivekeep prefixes outbound messages with the new Agent's name), or `'none'`.

## Providers (LLM, Embedding, Image, Search)

Plugin providers implement the **same** native interfaces as Hivekeep's built-in Anthropic / OpenAI / Brave / Tavily providers. Streaming, prompt caching, thinking effort, tool calls — all of it. There is no second, simplified shape for plugins.

```ts
import type {
  LLMProvider,
  ChatRequest,
  ChatChunk,
  PluginContext,
} from '@hivekeep/sdk'

class MistralProvider implements LLMProvider {
  readonly type = 'mistral'
  readonly displayName = 'Mistral'
  readonly apiKeyUrl = 'https://console.mistral.ai/api-keys'
  readonly configSchema = [
    { key: 'apiKey', type: 'secret', label: 'API Key', required: true },
  ] as const

  async authenticate(config) {
    // validate the key, return { valid, error?, accountLabel? }
    return { valid: true }
  }

  async listModels(config) {
    // return [{ id, name, contextWindow, thinking?, supportsImageInput?, … }]
    return []
  }

  async *chat(model, request: ChatRequest, config): AsyncIterable<ChatChunk> {
    // stream text-delta / tool-use / thinking-delta / thinking-signature chunks,
    // finish with exactly one finish chunk carrying { reason, usage }
  }
}

export default function (ctx: PluginContext) {
  return { providers: [new MistralProvider()] }
}
```

Embedding and image providers follow the same pattern with their own interface (`EmbeddingProvider.embed`, `ImageProvider.generate`).

The plugin loader detects the family by inspecting which method the provider exposes (`chat` → LLM, `embed` → embedding, `generate` → image, `search` → search). The provider's `type` field is prefixed internally to `plugin:<your-plugin-name>:<type>` so it can't collide with built-ins.

### Search providers

Search providers have a thinner shape than the model-bearing families — no `listModels()` (one provider == one search endpoint), no streaming. They MUST declare a static `capabilities` object so the host's `web_search` tool can warn the LLM when a request asks for something the provider doesn't expose.

```ts
import type {
  SearchProvider,
  SearchRequest,
  SearchResult,
  PluginContext,
} from '@hivekeep/sdk'

class KagiSearchProvider implements SearchProvider {
  readonly type = 'kagi-search'
  readonly displayName = 'Kagi'
  readonly apiKeyUrl = 'https://kagi.com/settings?p=api'
  readonly configSchema = [
    { key: 'apiKey', type: 'secret', label: 'API Token', required: true },
  ] as const

  // Static — describes the API surface, not the credentials in use.
  readonly capabilities = {
    supportsAnswer: false,
    supportsFreshness: false,
    supportsDomainFilter: false,
    supportsLanguage: false,
    supportsLocation: false,
  }

  async authenticate(config) {
    // Hit a cheap endpoint to validate. Don't burn a real search credit
    // when an auth-only check is available (e.g. SerpAPI's /account).
    return { valid: true }
  }

  async search(request: SearchRequest, config): Promise<SearchResult> {
    // Call upstream, normalize to { results, answer?, warnings? }.
    return { results: [] }
  }
}

export default function (ctx: PluginContext) {
  return { providers: [new KagiSearchProvider()] }
}
```

The `SearchRequest` shape covers the lowest common denominator (`query`, `count`, `freshness`, `domains`, `lang`, `location`, `answer`). For provider-specific knobs the standard schema doesn't model, use the `extra` passthrough:

```ts
// Provider-side: read whatever your upstream API understands.
async search(request) {
  const myCustomKnob = (request.extra?.myCustomKnob as string) ?? 'default'
  // ...
}
```

The LLM can pass through `extra` keys via the `web_search` tool's own `extra` parameter (when surfaced) or via host configuration. Providers MUST tolerate unknown keys (silently ignore rather than reject) so a key meant for one provider doesn't break calls routed to another.

For the `answer` capability: when the LLM requests `answer: true` and the provider declares `supportsAnswer: false`, the host adds a warning to the response but still calls `search()` with the original request. Your `search()` implementation should either ignore the `answer` flag or populate `SearchResult.answer` when honored. Don't throw on unsupported requests — let the warning system signal degradation.

## Hooks

Hook handlers receive a typed payload keyed by hook name — autocomplete on `ctx.message`, `ctx.toolResult`, etc.

```ts
import type { PluginExports, HookHandler } from '@hivekeep/sdk'

const auditAfterTool: HookHandler<'afterToolCall'> = (ctx) => {
  // ctx.toolName, ctx.toolArgs, ctx.toolResult are all typed
  ctx.log /* … */
}

return {
  hooks: {
    beforeChat:     (ctx) => { /* ctx.message: string */ },
    afterChat:      (ctx) => { /* ctx.response: string */ },
    beforeToolCall: (ctx) => { /* ctx.toolName, ctx.toolArgs */ },
    afterToolCall:  auditAfterTool,
  },
} satisfies PluginExports
```

Handlers may return a modified payload — it's passed to the next handler in the chain. Returning `void` keeps the previous payload.

## Cards

Plugin cards are declarative UI primitives that show up in the chat as rich live-updating messages. Useful for long-running tasks, structured data, action buttons.

```ts
import { card } from '@hivekeep/sdk'

const { messageId, cardInstanceId } = await ctx.cards.emit({
  agentId: execCtx.agentId,
  cardType: 'fetch-progress',
  layout: [
    card.header({ title: 'Fetching weather…', icon: 'Sparkles' }),
    card.statusBanner({ label: 'Working', animated: 'pulse', variant: 'primary' }),
    card.progress({ indeterminate: true }),
    card.actionRow([{ id: 'cancel', label: 'Cancel', variant: 'destructive' }]),
  ],
  initialState: { startedAt: Date.now() },
})

// later, push state updates that interpolate the `{{key}}` placeholders
await ctx.cards.update({ cardInstanceId, state: { phase: 'parsing' } })
```

Available primitives: `header`, `info-grid`, `status-banner`, `progress`, `collapsible`, `log-stream`, `action-row`, `markdown`, `spinner`, `badge`, `divider`. The `card.*` builders return the matching tagged variant — you can also hand-write the literals if you prefer.

Handle button clicks via `onCardAction`:

```ts
return {
  cards: { /* … */ },
  async onCardAction({ cardInstanceId, actionId, input, agentId }) {
    if (actionId === 'cancel') {
      await abortMyTask(cardInstanceId)
      return { ok: true }
    }
    return { ok: false, error: 'Unknown action' }
  },
}
```

## Lifecycle

```ts
return {
  // …

  async activate() {
    // Called when the plugin transitions to enabled.
    // Open persistent connections, start watchers, etc.
  },

  async deactivate() {
    // Called on disable / unload / hot-reload.
    // Close connections, flush state, drop subscriptions.
  },
}
```

Hot reload: editing your plugin's code triggers a full re-import; Hivekeep calls `deactivate()` on the old instance, instantiates the new one, then `activate()`s it.

## Local testing

Inside the Hivekeep tree, plugins under `plugins/<name>/` are discovered automatically — your unit tests can import them like any other module:

```ts
import { describe, it, expect } from 'bun:test'
import createPlugin from './index'

it('greets', async () => {
  const { tools } = createPlugin({ /* fake ctx */ } as any)
  const t = tools!.greet.create({ agentId: 'k', isSubAgent: false })
  expect(await t.execute!({ name: 'Marl' })).toEqual({ reply: 'Hi Marl, glad to meet you!' })
})
```

For real end-to-end testing, drop your plugin folder into a Hivekeep install and exercise it via the chat.

## Publishing

Plugins can ship through three paths:

1. **In-tree** — drop the folder in `plugins/`. Simplest, fits internal/private plugins.
2. **Git** — push to a repo, install via the Plugins UI (`Install from Git URL`).
3. **npm** — publish under the `@your-org/` scope, install via `Install from npm`. Your `package.json` should declare `@hivekeep/sdk` as a peer dep so Hivekeep's installed version is used.

Either way, the plugin's runtime contract is the same: a default-exported function returning `PluginExports`.

## Migration

If you're moving from a plugin written against the pre-0.2 SDK (legacy `ProviderDefinition`, loose `HookContext`, `import { tool } from 'ai'`…), see [Migrating from 0.1](/hivekeep/docs/plugins/migrating-from-0.1/).
