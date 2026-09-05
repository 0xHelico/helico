# Chainlink CRE workflows

> 🚧 Nothing runnable here yet. The confidential handler lives in
> [`packages/plugins/cre`](../../packages/plugins/cre/) (`@helico/plugin-cre`); the runnable
> CRE project that imports it (`project.yaml`, `workflow.yaml`, `main.ts`, configs, a
> `simulate` script) is tracked in [#21](https://github.com/0xHelico/helico/issues/21) and
> will live in this directory.

## Chainlink prize requirements

The workflow **must** register and use a confidential TEE handler — `handlerInTee`
(TypeScript) or `cre.HandlerInTee` — and the Confidential Workflow must perform a
**meaningful part** of the application rather than a token gesture. Today the handler is
registered at
[`packages/plugins/cre/src/index.ts#L118-L136`](../../packages/plugins/cre/src/index.ts#L118-L136),
and the decision it runs is still the template's placeholder
([#20](https://github.com/0xHelico/helico/issues/20)).

## Official references

| Source |
|---|
| https://docs.chain.link/cre |
| https://docs.chain.link/cre-templates/hello-confidential-workflows |
| https://docs.chain.link/cre-templates/ai-audit-firewall |
| https://docs.chain.link/cre-templates/automated-liquidation-protection |
| https://github.com/smartcontractkit/cre-templates |
