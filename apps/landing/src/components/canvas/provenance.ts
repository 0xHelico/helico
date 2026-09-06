/**
 * What happened behind each conversation, station by station. Rendered as the right-hand
 * "voyage"; `delayMs` is tuned to fire just after the matching moment lands in the chat.
 */

export type GlyphKind = 'sign' | 'brain' | 'browser' | 'lock' | 'anchor' | 'swap'

export type Receipt = {
	id: string
	glyph: GlyphKind
	layer: 'You' | 'Enclave' | 'Vault' | 'Chain'
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
		outcome: 'Mandate live · the enclave watches, the vault enforces',
		receipts: [
			{
				id: 'm-you',
				glyph: 'sign',
				layer: 'You',
				narration: 'You set the terms once: range width, retained liquidity, cooldown.',
				delayMs: 2700,
			},
			{
				id: 'm-vault',
				glyph: 'lock',
				layer: 'Vault',
				narration: 'The vault stores the mandate and its hash on chain.',
				delayMs: 4300,
			},
			{
				id: 'm-enclave',
				glyph: 'brain',
				layer: 'Enclave',
				narration: 'The thresholds are sealed into the Vault DON, released only inside the TEE.',
				delayMs: 5700,
			},
			{
				id: 'm-chain',
				glyph: 'anchor',
				layer: 'Chain',
				narration: 'A cron trigger arms the confidential workflow.',
				proofHref: EVIDENCE,
				delayMs: 7600,
			},
		],
	},
	recentre: {
		intro: INTRO,
		outcome: 'Re-centred · every rule checked on chain before the mint',
		receipts: [
			{
				id: 'r-read',
				glyph: 'browser',
				layer: 'Enclave',
				narration: 'The enclave read the pool and your position from inside the TEE.',
				delayMs: 3900,
			},
			{
				id: 'r-size',
				glyph: 'swap',
				layer: 'Enclave',
				narration: 'It sized the swap and the mint against your mandate.',
				delayMs: 4700,
			},
			{
				id: 'r-sign',
				glyph: 'sign',
				layer: 'Enclave',
				narration: 'It signed the authorisation with a key that exists only inside the enclave.',
				delayMs: 5500,
			},
			{
				id: 'r-vault',
				glyph: 'lock',
				layer: 'Vault',
				narration: 'The vault recomputed the mandate hash and checked every rule.',
				delayMs: 6300,
			},
			{
				id: 'r-chain',
				glyph: 'anchor',
				layer: 'Chain',
				narration: 'Burn, swap, mint in one transaction; tokens never left the vault.',
				proofHref: EVIDENCE,
				delayMs: 7200,
			},
		],
	},
	refuse: {
		intro: INTRO,
		outcome: 'Refused · nothing left the enclave',
		receipts: [
			{
				id: 'f-you',
				glyph: 'sign',
				layer: 'You',
				narration: 'Someone asked for terms outside the mandate.',
				delayMs: 2700,
			},
			{
				id: 'f-brain',
				glyph: 'brain',
				layer: 'Enclave',
				narration: 'The enclave recomputed the hash from the thresholds it was given.',
				delayMs: 3300,
			},
			{
				id: 'f-lock',
				glyph: 'lock',
				layer: 'Vault',
				narration: 'It did not match the one on chain. The enclave stopped before its first read.',
				delayMs: 4600,
			},
		],
	},
	hold: {
		intro: INTRO,
		outcome: 'Held · no signature, no transaction',
		receipts: [
			{
				id: 'h-read',
				glyph: 'browser',
				layer: 'Enclave',
				narration: 'The enclave read the tick from inside the TEE.',
				delayMs: 3900,
			},
			{
				id: 'h-brain',
				glyph: 'brain',
				layer: 'Enclave',
				narration: 'In range: the mandate says leave it alone.',
				delayMs: 4700,
			},
			{
				id: 'h-lock',
				glyph: 'lock',
				layer: 'Vault',
				narration: 'No authorisation was produced, so the vault had nothing to accept.',
				delayMs: 5600,
			},
		],
	},
}
