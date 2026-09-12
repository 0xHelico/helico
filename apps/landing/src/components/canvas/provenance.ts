/**
 * What happened behind each conversation, station by station. Rendered as the right-hand
 * "voyage"; `delayMs` is tuned to fire just after the matching moment lands in the chat.
 */

export type GlyphKind = 'sign' | 'brain' | 'browser' | 'lock' | 'anchor' | 'swap'

export type Receipt = {
	id: string
	glyph: GlyphKind
	/**
	 * The four things a move crosses, and each one can refuse — which is what makes the trail
	 * worth drawing rather than decorating. `Vault` was here until 8 September; it is no longer
	 * a layer of this product.
	 */
	layer: 'You' | 'Account' | 'Enclave' | 'Aqua'
	narration: string
	proofHref?: string
	delayMs: number
}

export type Provenance = {
	intro: string
	outcome: string
	receipts: Receipt[]
}

const INTRO = 'every move crosses the same gates'
const EVIDENCE = 'https://github.com/0xHelico/helico#readme'

export const PROVENANCE: Record<string, Provenance> = {
	mandate: {
		intro: INTRO,
		outcome: 'Account open · the enclave decides, the account holds',
		receipts: [
			{
				id: 'm-you',
				glyph: 'sign',
				layer: 'You',
				narration: 'You set the terms once: how much stays liquid, which markets, which agent.',
				delayMs: 2700,
			},
			{
				id: 'm-account',
				glyph: 'lock',
				layer: 'Account',
				narration: 'The account is yours alone, at an address known before it was deployed.',
				delayMs: 4300,
			},
			{
				id: 'm-enclave',
				glyph: 'brain',
				layer: 'Enclave',
				narration:
					"The thresholds are sealed into the Vault DON, released only into the enclave Chainlink's network runs the program in.",
				delayMs: 5700,
			},
			{
				id: 'm-aqua',
				glyph: 'anchor',
				layer: 'Aqua',
				narration: 'A mandate is filed as a ledger entry. No tokens moved to open it.',
				proofHref: EVIDENCE,
				delayMs: 7600,
			},
		],
	},
	supply: {
		intro: INTRO,
		outcome: '40,000 at work · 10,000 kept liquid',
		receipts: [
			{
				id: 's-enclave',
				glyph: 'brain',
				layer: 'Enclave',
				narration: 'The enclave read the account and the market rate.',
				delayMs: 2600,
			},
			{
				id: 's-decide',
				glyph: 'brain',
				layer: 'Enclave',
				narration: 'It sized the move against your liquid floor, then checked it was worth making.',
				delayMs: 4200,
			},
			{
				id: 's-account',
				glyph: 'lock',
				layer: 'Account',
				narration: 'The account checked the market was one you allow-listed, and supplied.',
				delayMs: 5900,
			},
			{
				id: 's-back',
				glyph: 'swap',
				layer: 'Account',
				narration: 'The receipt came back here. There is no address it could have gone to instead.',
				proofHref: EVIDENCE,
				delayMs: 7500,
			},
		],
	},
	refuse: {
		intro: INTRO,
		outcome: 'Refused by shape · not by a rule anyone can edit',
		receipts: [
			{
				id: 'r-ask',
				glyph: 'sign',
				layer: 'You',
				narration: 'Somebody asked for the balance to be sent to an address.',
				delayMs: 2500,
			},
			{
				id: 'r-account',
				glyph: 'lock',
				layer: 'Account',
				narration: 'The agent has two calls. Neither has a parameter for where anything goes.',
				delayMs: 4100,
			},
			{
				id: 'r-stop',
				glyph: 'lock',
				layer: 'Account',
				narration: 'So an agent that was entirely compromised still could not do it.',
				proofHref: EVIDENCE,
				delayMs: 5800,
			},
		],
	},
	hold: {
		intro: INTRO,
		outcome: 'Nothing signed · no gas spent',
		receipts: [
			{
				id: 'h-enclave',
				glyph: 'brain',
				layer: 'Enclave',
				narration: 'The enclave read the split.',
				delayMs: 2500,
			},
			{
				id: 'h-decide',
				glyph: 'brain',
				layer: 'Enclave',
				narration:
					'Interest moves it every block. This one was too small to be worth a transaction.',
				delayMs: 4300,
			},
		],
	},
	takeable: {
		intro: INTRO,
		outcome: 'Filled from a position that never stopped earning',
		receipts: [
			{
				id: 't-aqua',
				glyph: 'swap',
				layer: 'Aqua',
				narration:
					'A taker filled against your mandate. Aqua pulled from your account, never into its own.',
				proofHref: EVIDENCE,
				delayMs: 2600,
			},
			{
				id: 't-account',
				glyph: 'lock',
				layer: 'Account',
				narration:
					'The wallet was short, so exactly the shortfall came out of the lending market — once, inside the same transaction.',
				delayMs: 4400,
			},
			{
				id: 't-you',
				glyph: 'sign',
				layer: 'You',
				narration:
					'You never chose between earning and being available. The ceiling you set is still the only thing that bounds it.',
				delayMs: 6000,
			},
		],
	},
}
