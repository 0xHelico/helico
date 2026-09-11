/**
 * The scenarios the canvas cycles through.
 *
 * **Real, read from Arbitrum One on 11 September** — Aave v3's USDC supply rate, **2.75% APR**,
 * from `getReserveData().currentLiquidityRate` (`27528223034769606405950882`, which is 2.7528% at
 * Aave's 27 decimals); the Aave pool `0x794a6135…` and its aUSDC `0x724dc807…`; Aqua
 * `0x1111113ccf…` and the SwapVM router `0x111111338c…`, which are the addresses 1inch's own SDK
 * names. It said 2.65% and 8 September until today — the rate moves, so re-read it rather than
 * ageing it.
 *
 * **Scripted** — the conversations, the account address, the amounts, and the timings.
 *
 * The split is written down because the difference matters: a rate nobody can check and a rate
 * anybody can are not the same claim, and a visitor has no way to tell them apart on screen.
 */

export type CycleSurface = 'tui' | 'tg'
export type ToolStreamEntry = { tool: string; args?: string; status: 'ok' | 'failed' }
export type CycleGreeting = { prompt: string; reply: string }
export type Painting = 'mandate' | 'supply' | 'refuse' | 'hold' | 'takeable'

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
			{ tool: 'aave.getReserveData', args: 'USDC · 2.75% APR', status: 'ok' },
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

At **2.75%** — Aave's rate right now, not a projection.
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
			{ tool: 'aave.getReserveData', args: 'USDC · 2.75% APR', status: 'ok' },
			{ tool: 'account.balances', args: 'idle 10,180 · working 40,120', status: 'ok' },
			{ tool: 'decide', args: 'move 180 · under the deadband', status: 'ok' },
		],
		reply: `**HOLD (under the deadband)**

Interest accrues every block, so the split drifts a little every block. Chasing it would mean a transaction every five minutes to move a rounding error.

A move has to clear a fixed floor and a share of the account, and 180 clears neither. Nothing signed, no gas spent.`,
		painting: 'hold',
		durationMs: 9000,
	},
	{
		id: 'takeable',
		title: 'Takeable',
		surface: 'tui',
		/**
		 * The one the other four do not show, and the only one that is the product's actual thesis:
		 * **the capital that earns is the capital the mandate spends.**
		 *
		 * The first four are all about putting money to work and leaving it there. A vault makes you
		 * choose — earning or available, not both — and this is the scenario where that choice does
		 * not have to be made: a taker fills against the position, the wallet is short, and exactly
		 * the shortfall is redeemed out of Aave inside the same transaction.
		 *
		 * **Real** — the shape and the mechanism. `ForkOracleBoardYield.t.sol` measures it against
		 * the live feed, real USDC and a real Aave position: 500 liquid, 29,500 supplied, 2,493 paid
		 * to a taker, 27,507 supplied afterwards. The amounts below are that run rounded to the
		 * scenario's own 50,000, not new numbers.
		 *
		 * **Scripted** — the conversation and the timings, like every other cycle here.
		 */
		prompt: 'someone just filled against my position — where did the money come from?',
		toolStream: [
			{ tool: 'aqua.pull', args: 'maker → taker, under your mandate', status: 'ok' },
			{ tool: 'account.balances', args: 'idle 10,180 · wanted 12,400', status: 'ok' },
			{
				tool: 'find the shortfall',
				args: '2,220 short, so the wallet is not enough',
				status: 'ok',
			},
			{ tool: 'aave.withdraw', args: '2,220 · exactly the shortfall, once', status: 'ok' },
			{ tool: 'settle', args: 'inside the same transaction', status: 'ok' },
		],
		reply: `**FILLED 12,400 USDC** — and only 10,180 of it was liquid.

The rest came out of Aave **mid-swap**: 2,220 redeemed, exactly the shortfall, once. **Working** 37,900 · **Liquid** 0

This is the part a vault makes you choose between. Your money was earning the whole time it was also on offer — nobody had to move it back first, and nothing sat idle waiting to be taken.`,
		painting: 'takeable',
		durationMs: 10500,
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
	takeable:
		'radial-gradient(115% 95% at 70% 85%, #ffe9d6 0%, #f0a9c0 32%, #8b7cf6 72%, #2a3570 100%)',
}
