/**
 * The scenarios the canvas cycles through. Illustrative: the pool, tick, token, out-of-range
 * band, and the 94.3% retained are the fork rehearsal's (docs/plans/2026-09-05-cre-forwarder-delivery.md);
 * the 20-tick target band, the mandate hash, the nonce, and the conversations are scripted.
 */

export type CycleSurface = 'tui' | 'tg'
export type ToolStreamEntry = { tool: string; args?: string; status: 'ok' | 'failed' }
export type CycleGreeting = { prompt: string; reply: string }
export type Painting = 'mandate' | 'recentre' | 'refuse' | 'hold'

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
		prompt:
			'keep my ETH/ARB position in range: 20 ticks wide, keep 90% of the liquidity, one move an hour',
		toolStream: [
			{ tool: 'pool.read', args: 'ETH/ARB 0.05% · tick 94505', status: 'ok' },
			{ tool: 'mandate.build', args: 'width 20 · retain 90% · cooldown 1h', status: 'ok' },
			{ tool: 'mandate.hash', args: '0x134be6bb…6225', status: 'ok' },
			{ tool: 'vault.setMandate', args: 'position #1900769', status: 'ok' },
			{ tool: 'secrets.seal', args: 'thresholds → Vault DON', status: 'ok' },
		],
		reply: `Mandate committed.

**Range** 20 ticks · **Retain** at least 90% · **Cooldown** 1 h
Hash **0x134be6bb…6225** is on chain; the thresholds behind it are sealed for the enclave.

The enclave checks the pool every five minutes. It can only propose moves inside these terms, and the vault refuses anything else.`,
		painting: 'mandate',
		durationMs: 11000,
	},
	{
		id: 'recentre',
		title: 'Re-centre',
		surface: 'tg',
		greeting: { prompt: 'gm', reply: 'gm ☀️ your ETH/ARB position drifted below its range' },
		prompt: 'bring it back in range',
		toolStream: [
			{ tool: 'stateView.getSlot0', args: 'tick 94505 · fee 0.05%', status: 'ok' },
			{ tool: 'vault.positionOf', args: '#202707 · [93270, 93470)', status: 'ok' },
			{ tool: 'mandate.verify', args: 'hash ✓ · nonce 7', status: 'ok' },
			{ tool: 'size.swap', args: '41.0 ARB → ETH, inside the band', status: 'ok' },
			{ tool: 'enclave.sign', args: 'EIP-712 · the key never leaves', status: 'ok' },
			{ tool: 'vault.recenterWithSignature', args: '→ [94500, 94520)', status: 'ok' },
		],
		reply: `Back in range.

**[94500, 94520)** around tick 94505
Swapped 41.0 ARB for ETH through the position's own pool, then minted.
Retained **94.3%** of the liquidity · cooldown until 15:32

The vault checked the width, the price, the improvement, the floor, and the nonce before it moved anything.`,
		painting: 'recentre',
		durationMs: 10500,
	},
	{
		id: 'refuse',
		title: 'Refuse',
		surface: 'tui',
		prompt: 'drop the cooldown to zero and move it now',
		toolStream: [
			{ tool: 'secrets.read', args: 'thresholds', status: 'ok' },
			{ tool: 'mandate.hash', args: 'recomputed', status: 'ok' },
			{ tool: 'mandate.verify', args: '0x9a3c…0f11 ≠ 0x134be6bb…6225', status: 'failed' },
		],
		reply: `**HOLD (mandate hash mismatch)**

The thresholds I was handed do not hash to the mandate you committed. I will not act on terms you did not sign, and nothing was read from the chain.

Change the mandate in the vault first; the enclave follows the hash, not the request.`,
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
			{ tool: 'stateView.getSlot0', args: 'tick 130471', status: 'ok' },
			{ tool: 'vault.positionOf', args: '[130460, 130480)', status: 'ok' },
			{ tool: 'decide', args: 'in range', status: 'ok' },
		],
		reply: `**HOLD (in range)**

Tick 130471 sits inside [130460, 130480). Nothing to do, so nothing was signed and no gas was spent.

Next check in five minutes.`,
		painting: 'hold',
		durationMs: 9000,
	},
]

/** The "painting" behind each scenario: a gradient in the logo's palette, no image to load. */
export const PAINTINGS: Record<Painting, string> = {
	mandate:
		'radial-gradient(120% 90% at 15% 10%, #dbe8ff 0%, #9dbbff 30%, #7c6bff 62%, #e59bd8 100%)',
	recentre:
		'radial-gradient(110% 100% at 80% 15%, #cfe6ff 0%, #6aa4ff 35%, #8b7cf6 70%, #f0b8e4 100%)',
	refuse:
		'radial-gradient(120% 90% at 30% 90%, #e9d6f4 0%, #b79cf0 35%, #5b74d6 75%, #1f2a55 100%)',
	hold: 'radial-gradient(120% 100% at 50% 0%, #e6f0ff 0%, #b5cdff 40%, #9d90f5 80%, #d9b6ea 100%)',
}
