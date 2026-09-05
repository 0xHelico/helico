# Plugins

**Every partner integration lives here.** One package per integration, at
`packages/plugins/<name>`, published in the workspace as `@helico/plugin-<name>`.
Apps consume them; apps never talk to a protocol directly.

A plugin may depend on [`@helico/core`](../core/) through `workspace:*`; none does yet.

| Plugin | Package | Integration |
|---|---|---|
| [`cre/`](cre/) | `@helico/plugin-cre` | Chainlink CRE confidential workflows |

## Why a package rather than code inside an app

- Uniswap's bounty rewards "tooling or solutions built for the broader ecosystem".
  A reusable package is that; integration code buried in an app is not.
- Both partner prizes require a README pointing reviewers at the exact lines that prove
  the integration. One package per partner keeps those references stable.
- Apps stay thin, so what the product does stays separable from how it talks to a protocol.

## Adding one

1. `packages/plugins/<name>/` with `package.json` naming it `@helico/plugin-<name>`
2. `typecheck` and `test` scripts, so the workspace tasks and CI pick it up
3. A README stating what the integration does and which lines prove it
4. Add a row to the table above
