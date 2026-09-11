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

/**
 * Assertions in the Solidity suite, counted rather than typed.
 *
 * The page said **291** and there were 359 by the time anyone checked. An undercount is a smaller
 * sin than the reverse and it is still a number a reader can tally and find wrong, which is the
 * same failure the comment above this file records. Counted the way a reader would: every
 * `assertX(` call in `contracts/test/`.
 */
export const solidityAssertions = files.reduce(
	(n, f) => n + (read(f).match(/\bassert[A-Za-z]*\(/g)?.length ?? 0),
	0,
)

/**
 * Tests in the CRE plugin, counted from its sources for the same reason.
 *
 * This is the number of `it(` and `test(` **declarations**, which is what a reader counts in the
 * files. `bun test` reports more — 241 against 208 today — because some of these are table-driven
 * and one declaration runs several cases. Neither number is wrong; this is the one that can be
 * checked by looking, so it is the one the badge shows.
 */
let creDir = new URL('./', import.meta.url)
while (!existsSync(new URL('packages/plugins/cre/src/', creDir))) creDir = new URL('../', creDir)
creDir = new URL('packages/plugins/cre/src/', creDir)
export const creTests = readdirSync(creDir)
	.filter((f) => f.endsWith('.test.ts'))
	.reduce(
		(n, f) =>
			n + (readFileSync(new URL(f, creDir), 'utf8').match(/^[ \t]*(it|test)\(/gm)?.length ?? 0),
		0,
	)
