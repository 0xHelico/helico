# @helico/plugin-cre

Reusable Chainlink CRE handler that runs inside a TEE enclave. Exports `configSchema`,
`initWorkflow`, and `onCronTrigger` from [`src/index.ts`](src/index.ts).

What the handler does, all inside the enclave except the last step: fetch a Vault DON
secret, call `config.url` with it, score the response against `config.scoreThreshold`,
then cross back to the DON with only the verdict and score, signed as a report.

`src/index.ts` and `src/index.test.ts` are the template's `workflow.ts` and `workflow.test.ts`,
unchanged apart from Biome formatting and one tightened TEE assertion in the test.
Scaffolded with `cre init` from Chainlink's
[`hello-confidential-workflows-ts`](https://github.com/smartcontractkit/cre-templates/tree/main/starter-templates/hello-confidential-workflows).
Plan: [`docs/plans/2026-09-05-plugin-cre.md`](../../../docs/plans/2026-09-05-plugin-cre.md).

## Status

| | |
|---|---|
| Registers a TEE handler with `handlerInTee` | ✅ [`src/index.ts#L118-L136`](src/index.ts#L118-L136), `initWorkflow`; the call is on L132 |
| Unit tests, `bun test` | ✅ |
| Compiles to WASM and simulates | ✅ verified from a throwaway CRE project importing this package, not in the repo |
| Decision logic is Helico's | ❌ template placeholder, `scoreResponse` |
| Wired into an app under `apps/` | ❌ |
| Deployed | ❌ needs CRE deploy access **and** the separate Confidential Workflows private beta |

## Use

In a CRE workflow's `main.ts`:

```ts
import { Runner } from '@chainlink/cre-sdk'
import { configSchema, initWorkflow } from '@helico/plugin-cre'

const runner = await Runner.newRunner({ configSchema })
await runner.run(initWorkflow)
```

Config: `{ schedule, url, secretId, scoreThreshold }`. `secrets.yaml` must map `secretId`
to an env var. Needs Bun 1.2.21+ and the CRE CLI.

## Check

```bash
bun run --filter @helico/plugin-cre typecheck
bun run --filter @helico/plugin-cre test
```

## Do not forget

- The binary is not confidential, only the data it computes over. Never pass the secret or
  the raw response through `usingTheDons()`.
- `runtime.log()` inside the handler is for the simulator. Remove it before deploying.
