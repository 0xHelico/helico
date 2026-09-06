import { existsSync, readdirSync, readFileSync } from 'node:fs'

// Counted from the test sources at build time, the way Build.astro reads the vault, so the page
// cannot drift from `forge test` (the counts drifted three times in a day before this).
// A test is a `function test…`; a fork test is one in a `Fork*.t.sol` file that is not `pure`,
// which is exactly the set `forge test` skips without an Arbitrum endpoint.
// Walk up to the repository root: in dev this module lives in src/, in a build in dist/.
let dir = new URL('./', import.meta.url)
while (!existsSync(new URL('contracts/test/', dir))) dir = new URL('../', dir)
dir = new URL('contracts/test/', dir)
const files = readdirSync(dir).filter((f) => f.endsWith('.t.sol'))
const read = (f: string) => readFileSync(new URL(f, dir), 'utf8')
const tests = (s: string) => s.match(/function test/g)?.length ?? 0
const pureTests = (s: string) => s.match(/function test\w*\([^)]*\) public pure/g)?.length ?? 0

export const solidityTests = files.reduce((n, f) => n + tests(read(f)), 0)
export const forkTests = files
	.filter((f) => f.startsWith('Fork'))
	.reduce((n, f) => n + tests(read(f)) - pureTests(read(f)), 0)
