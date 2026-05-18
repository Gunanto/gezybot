# `@kinbot-developer/sdk`

Plugin SDK for [KinBot](https://github.com/MarlBurroW/kinbot). Re-exports the small surface that plugin authors need to declare tools, so plugins don't have to depend on KinBot internals or on the (now removed) Vercel AI SDK.

## Install

```bash
bun add @kinbot-developer/sdk
# or
npm i @kinbot-developer/sdk
```

> KinBot's plugin loader resolves this package against the host's installation, so it doubles as a peer dep when plugins are loaded in-process.

## Usage

```ts
import { tool, z } from '@kinbot-developer/sdk'

export default function (ctx) {
  const log = ctx.log

  return {
    tools: {
      greet: tool({
        description: 'Say hi to a user.',
        inputSchema: z.object({
          name: z.string().describe('Who to greet'),
        }),
        execute: async ({ name }) => {
          log.info('greet called', { name })
          return { reply: `Hi ${name}!` }
        },
      }),
    },
  }
}
```

## What's exported

- `tool()` — declarative tool helper. INPUT is inferred from `inputSchema`.
- `asSchema()` — normalize zod / JSON Schema / wrapper objects into plain JSON Schema.
- `Tool`, `JSONValue`, `NormalizedSchema` — TypeScript types.
- `z` — re-export of `zod` so plugins don't need a separate dep.

## License

AGPL-3.0-only.
