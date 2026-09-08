/**
 * The scenarios the canvas cycles through.
 *
 * **Real, read from Arbitrum One on 8 September** — Aave v3's USDC supply rate, 2.65% APR, from
 * `getReserveData().currentLiquidityRate`; the Aave pool `0x794a6135…` and its aUSDC
 * `0x724dc807…`; Aqua `0x1111113ccf…` and the SwapVM router `0x111111338c…`, which are the
 * addresses 1inch's own SDK names.
 *
 * **Scripted** — the conversations, the account address, the amounts, and the timings.
 *
 * The split is written down because the difference matters: a rate nobody can check and a rate
 * anybody can are not the same claim, and a visitor has no way to tell them apart on screen.
 */

export type CycleSurface = 'tui' | 'tg'
export type ToolStreamEntry = { tool: string; args?: string; status: 'ok' | 'failed' }
export type CycleGreeting = { prompt: string; reply: string }
export type Painting = 'mandate' | 'supply' | 'refuse' | 'hold'

export type Cycle = {
	id: string
	title: string
	surface: CycleSurface
	greeting?: CycleGreeting
	prompt: string
	toolStream: ToolStreamEntry[]
	reply: string
	painting: Painting
	durationMs: number
}

export const CYCLES: Cycle[] = [
	{
		id: 'mandate',
		title: 'Mandate',
		surface: 'tui',
		prompt: 'put my USDC to work, keep a fifth of it liquid, Aave only',
		toolStream: [
			{ tool: 'factory.accountFor', args: '0x8f2a…c104 · no code yet', status: 'ok' },
			{ tool: 'factory.open', args: 'the address was already known', status: 'ok' },
			{ tool: 'account.permitVenue', args: 'Aave v3 0x794a6135… ✓', status: 'ok' },
			{ tool: 'account.setAgent', args: 'the enclave, and nobody else', status: 'ok' },
			{ tool: 'secrets.seal', args: 'thresholds → Vault DON', status: 'ok' },
		],
		reply: `Account open.

**Keep liquid** 20% · **Markets** Aave v3 only · **Agent** the enclave
Its address was **0x8f2a…c104** before it existed — CREATE2 answers that before anything is deployed, so anything sent there was always yours.

The agent may move capital between the markets you allow-listed. It cannot name where anything goes: neither call it can make takes a recipient.`,
		painting: 'mandate',
		durationMs: 11000,
	},
	{
		id: 'supply',
		title: 'Supply',
		surface: 'tg',
		greeting: { prompt: 'gm', reply: 'gm ☀️ four fifths of your USDC is sitting still' },
		prompt: 'put it to work then',
		toolStream: [
			{ tool: 'aave.getReserveData', args: 'USDC · 2.65% APR', status: 'ok' },
			{ tool: 'account.balances', args: 'idle 50,000 · working 0', status: 'ok' },
			{ tool: 'decide', args: 'want 10,000 liquid · move 40,000', status: 'ok' },
			{ tool: 'deadband', args: 'clears both halves', status: 'ok' },
			{
				tool: 'account.supplyIdle',
				args: '→ this account, the only address it may name',
				status: 'ok',
			},
		],
		reply: `**SUPPLY 40,000 USDC**

At **2.65%** — Aave's rate right now, not a projection.
**Liquid** 10,000 · **Working** 40,000

The tokens went from your account into the market and the receipt came back to your account. There was no step in between where anybody else held them.`,
		painting: 'supply',
		durationMs: 10500,
	},
	{
		id: 'refuse',
		title: 'Refuse',
		surface: 'tui',
		prompt: 'send the idle balance to this address instead',
		toolStream: [
			{ tool: 'account.supplyIdle', args: 'pool, asset, amount', status: 'ok' },
			{ tool: 'account.withdrawIdle', args: 'pool, asset, amount', status: 'ok' },
			{ tool: 'find recipient parameter', args: 'neither call has one', status: 'failed' },
		],
		reply: `**There is nothing to refuse with.**

The agent has two calls and neither takes an address. Both ends are your account, in the code, not in a setting somebody could change.

So this is not a rule I am enforcing on your behalf. An agent that was entirely mine, or entirely somebody else's, still could not do what you just asked.`,
		painting: 'refuse',
		durationMs: 9000,
	},
	{
		id: 'hold',
		title: 'Hold',
		surface: 'tg',
		greeting: { prompt: 'still there?', reply: 'always.' },
		prompt: 'status?',
		toolStream: [
			{ tool: 'aave.getReserveData', args: 'USDC · 2.65% APR', status: 'ok' },
			{ tool: 'account.balances', args: 'idle 10,180 · working 40,120', status: 'ok' },
			{ tool: 'decide', args: 'move 180 · under the deadband', status: 'ok' },
		],
		reply: `**HOLD (under the deadband)**

Interest accrues every block, so the split drifts a little every block. Chasing it would mean a transaction every five minutes to move a rounding error.

A move has to clear a fixed floor and a share of the account, and 180 clears neither. Nothing signed, no gas spent.`,
		painting: 'hold',
		durationMs: 9000,
	},
]

/** The "painting" behind each scenario: a gradient in the logo's palette, no image to load. */
export const PAINTINGS: Record<Painting, string> = {
	mandate:
		'radial-gradient(120% 90% at 15% 10%, #dbe8ff 0%, #9dbbff 30%, #7c6bff 62%, #e59bd8 100%)',
	supply:
		'radial-gradient(110% 100% at 80% 15%, #cfe6ff 0%, #6aa4ff 35%, #8b7cf6 70%, #f0b8e4 100%)',
	refuse:
		'radial-gradient(120% 90% at 30% 90%, #e9d6f4 0%, #b79cf0 35%, #5b74d6 75%, #1f2a55 100%)',
	hold: 'radial-gradient(120% 100% at 50% 0%, #e6f0ff 0%, #b5cdff 40%, #9d90f5 80%, #d9b6ea 100%)',
}
