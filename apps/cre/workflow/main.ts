import { Runner } from '@chainlink/cre-sdk'
import { configSchema, initWorkflow } from '@helico/plugin-cre'

// The whole workflow is `@helico/plugin-cre`, which is also what the tests run
// against and what the landing page links to. This file exists so the CRE CLI
// has an entry point to compile; keeping the logic in a package rather than
// here is what lets 116 unit tests cover the enclave's decision without the
// CLI in the loop.
export async function main() {
	const runner = await Runner.newRunner({ configSchema })
	await runner.run(initWorkflow)
}

main()
