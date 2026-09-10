import { describe, expect, test } from 'bun:test'

import { configSchema } from '@helico/plugin-cre'

import production from './workflow/config.production.json'
import staging from './workflow/config.staging.json'

/**
 * The two files that decide what the enclave actually does, parsed by the schema that will read
 * them.
 *
 * **Why this was worth adding.** Nothing checked these until now: the workflow bundles whichever
 * one it is pointed at, and the first thing that reads it is the deployed binary, on a cron, in a
 * TEE. A config the schema would refuse becomes a workflow that fails every five minutes with a
 * message nobody is watching for.
 *
 * The rule these exist to enforce arrived with the second asset. Aave's Pool serves every reserve,
 * so one address answers for USDC and WETH alike; a `CompoundVenue` holds exactly one market and
 * `getReserveAToken` on any other asset **reverts**. Since a failed call fails the whole run by
 * design, an unscoped USDC venue in a configuration that also names WETH does not earn less — it
 * stops every run. The scope is the fix, and this is what checks it was actually written down.
 */
describe('the workflow configs parse', () => {
	test('production', () => {
		const result = configSchema.safeParse(production)
		expect(result.error?.issues ?? []).toEqual([])
		expect(result.success).toBe(true)
	})

	test('staging', () => {
		const result = configSchema.safeParse(staging)
		expect(result.error?.issues ?? []).toEqual([])
		expect(result.success).toBe(true)
	})
})

describe('production reaches both assets', () => {
	const config = configSchema.parse(production)
	const lists = (pool: (typeof config.pools)[number], asset: string) =>
		pool.assets === undefined || pool.assets.some((a) => a.toLowerCase() === asset.toLowerCase())

	test('every asset has somewhere to go', () => {
		// The schema refuses the opposite, so this is the same claim twice — deliberately, because
		// the schema's version is a rule and this one names the numbers. An asset with nowhere to go
		// is capital the enclave watches sit idle and can never place, and every run reads as a
		// decision to hold.
		for (const asset of config.assets) {
			const reachable = config.pools.filter((pool) => lists(pool, asset))
			expect(reachable.length).toBeGreaterThan(1)
		}
	})

	test('and USDC and WETH do not see the same set of markets', () => {
		// The assertion that fails if the scopes were dropped and everything reverted to "all
		// markets take all assets" — which parses cleanly and breaks at the first RPC batch.
		const [usdc, weth] = config.assets as [string, string]
		const forUsdc = config.pools.filter((p) => lists(p, usdc)).map((p) => p.address)
		const forWeth = config.pools.filter((p) => lists(p, weth)).map((p) => p.address)
		expect(forUsdc).not.toEqual(forWeth)
		expect(forUsdc.length).toBe(3)
		expect(forWeth.length).toBe(2)
	})
})
