import { motion } from 'framer-motion'
import type { GlyphKind } from './provenance'

const SIZE = 42
const STROKE = 'var(--color-ink)'
const draw = {
	fill: 'none',
	stroke: STROKE,
	strokeLinecap: 'round',
	strokeLinejoin: 'round',
} as const

export function BigGlyph({ kind, active }: { kind: GlyphKind; active: boolean }) {
	switch (kind) {
		case 'sign':
			return <SignGlyph />
		case 'brain':
			return <BrainGlyph active={active} />
		case 'browser':
			return <BrowserGlyph active={active} />
		case 'lock':
			return <LockGlyph />
		case 'anchor':
			return <AnchorGlyph />
		case 'swap':
			return <SwapGlyph active={active} />
	}
}

function SignGlyph() {
	return (
		<svg
			viewBox="0 0 24 24"
			width={SIZE}
			height={SIZE}
			className="relative z-10"
			aria-hidden="true"
		>
			<motion.path
				d="M 3 14 C 5 6 8 6 8 14 C 8 10 11 10 11 14 S 14 17 16 13 Q 19 9 21 7"
				{...draw}
				strokeWidth="1.4"
				initial={{ pathLength: 0 }}
				animate={{ pathLength: 1 }}
				transition={{ duration: 1.5, ease: [0.4, 0, 0.2, 1], delay: 0.15 }}
			/>
			<motion.circle
				cx="11"
				cy="6"
				r="0.75"
				fill={STROKE}
				initial={{ y: -3, opacity: 0 }}
				animate={{ y: 0, opacity: 1 }}
				transition={{ duration: 0.35, ease: [0.4, 1.6, 0.4, 1], delay: 1.55 }}
			/>
			<motion.line
				x1="3"
				y1="20"
				x2="20"
				y2="20"
				{...draw}
				strokeWidth="0.85"
				opacity="0.5"
				initial={{ pathLength: 0 }}
				animate={{ pathLength: 1 }}
				transition={{ duration: 0.65, ease: 'easeOut', delay: 1.8 }}
			/>
		</svg>
	)
}

function BrainGlyph({ active }: { active: boolean }) {
	const fold = {
		...draw,
		strokeWidth: '1',
		opacity: '0.85',
		initial: { pathLength: 0 },
		animate: { pathLength: 1 },
	}
	return (
		<svg
			viewBox="0 0 24 24"
			width={SIZE}
			height={SIZE}
			className="relative z-10"
			aria-hidden="true"
		>
			<motion.path
				d="M 12 5 C 10 3 6 4 4 7 C 2.5 9.5 2.5 13 4 16 C 6 19 9 20 12 19 C 15 20 18 19 20 16 C 21.5 13 21.5 9.5 20 7 C 18 4 14 3 12 5 Z"
				{...draw}
				strokeWidth="1.4"
				initial={{ pathLength: 0 }}
				animate={{ pathLength: 1 }}
				transition={{ duration: 1.1, ease: [0.4, 0, 0.2, 1], delay: 0.2 }}
			/>
			<motion.g
				animate={active ? { opacity: [0.65, 1, 0.65] } : { opacity: 1 }}
				transition={{
					duration: active ? 2.4 : 0.4,
					repeat: active ? Number.POSITIVE_INFINITY : 0,
					ease: 'easeInOut',
					delay: 1.7,
				}}
			>
				<motion.line
					x1="12"
					y1="5"
					x2="12"
					y2="19"
					{...fold}
					transition={{ duration: 0.65, delay: 1.25 }}
				/>
				<motion.path
					d="M 5 9 Q 6.5 8.2 7.2 10 Q 7.8 11.6 9.6 10.8"
					{...fold}
					transition={{ duration: 0.55, delay: 1.45 }}
				/>
				<motion.path
					d="M 4.5 13 Q 6.2 12.4 7 14.2 Q 7.7 16 9.6 15.2"
					{...fold}
					transition={{ duration: 0.55, delay: 1.6 }}
				/>
				<motion.path
					d="M 19 9 Q 17.5 8.2 16.8 10 Q 16.2 11.6 14.4 10.8"
					{...fold}
					transition={{ duration: 0.55, delay: 1.5 }}
				/>
				<motion.path
					d="M 19.5 13 Q 17.8 12.4 17 14.2 Q 16.3 16 14.4 15.2"
					{...fold}
					transition={{ duration: 0.55, delay: 1.65 }}
				/>
				<motion.path
					d="M 11.2 19.4 Q 12 21 12.8 19.4"
					{...fold}
					transition={{ duration: 0.4, delay: 1.85 }}
				/>
			</motion.g>
		</svg>
	)
}

function BrowserGlyph({ active }: { active: boolean }) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={SIZE}
			height={SIZE}
			className="relative z-10"
			aria-hidden="true"
		>
			<motion.rect
				x="3"
				y="5"
				width="18"
				height="14"
				rx="1.4"
				{...draw}
				strokeWidth="1.4"
				initial={{ pathLength: 0 }}
				animate={{ pathLength: 1 }}
				transition={{ duration: 0.9, ease: [0.4, 0, 0.2, 1], delay: 0.15 }}
			/>
			<motion.line
				x1="3"
				y1="9"
				x2="21"
				y2="9"
				{...draw}
				strokeWidth="1"
				initial={{ pathLength: 0 }}
				animate={{ pathLength: 1 }}
				transition={{ duration: 0.5, ease: 'easeOut', delay: 0.7 }}
			/>
			<motion.circle
				cx="5.5"
				cy="7"
				r="0.8"
				fill={STROKE}
				initial={{ opacity: 0 }}
				animate={{ opacity: 0.6 }}
				transition={{ delay: 0.95 }}
			/>
			<motion.circle
				cx="8"
				cy="7"
				r="0.8"
				fill={STROKE}
				initial={{ opacity: 0 }}
				animate={{ opacity: 0.4 }}
				transition={{ delay: 1.05 }}
			/>
			<motion.circle
				cy="13"
				r="1.6"
				fill={STROKE}
				initial={{ cx: 5, opacity: 0 }}
				animate={active ? { cx: [5, 19, 5], opacity: [0, 1, 1, 1, 0] } : { cx: 19, opacity: 1 }}
				transition={{
					duration: active ? 3.2 : 0.6,
					repeat: active ? Number.POSITIVE_INFINITY : 0,
					repeatType: 'loop',
					ease: 'easeInOut',
					delay: 1.0,
				}}
			/>
		</svg>
	)
}

function LockGlyph() {
	return (
		<svg
			viewBox="0 0 24 24"
			width={SIZE}
			height={SIZE}
			className="relative z-10"
			aria-hidden="true"
		>
			<motion.rect
				x="5"
				y="11"
				width="14"
				height="10"
				rx="1.2"
				{...draw}
				strokeWidth="1.4"
				initial={{ pathLength: 0 }}
				animate={{ pathLength: 1 }}
				transition={{ duration: 0.7, ease: [0.4, 0, 0.2, 1], delay: 0.3 }}
			/>
			<motion.path
				d="M 8 11 V 8 a 4 3 0 0 1 8 0 V 11"
				{...draw}
				strokeWidth="1.4"
				initial={{ y: -3, opacity: 0 }}
				animate={{ y: 0, opacity: 1 }}
				transition={{ duration: 0.6, ease: [0.4, 1.5, 0.4, 1], delay: 0.95 }}
			/>
			<motion.circle
				cx="12"
				cy="15.5"
				r="1.1"
				fill={STROKE}
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				transition={{ delay: 1.5, duration: 0.4 }}
			/>
			<motion.line
				x1="12"
				y1="16.5"
				x2="12"
				y2="18.5"
				{...draw}
				strokeWidth="1.2"
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				transition={{ delay: 1.5, duration: 0.4 }}
			/>
		</svg>
	)
}

function AnchorGlyph() {
	const stroke = { ...draw, initial: { pathLength: 0 }, animate: { pathLength: 1 } }
	return (
		<svg
			viewBox="0 0 24 24"
			width={SIZE}
			height={SIZE}
			className="relative z-10"
			aria-hidden="true"
		>
			<motion.g
				initial={{ y: -3, opacity: 0 }}
				animate={{ y: 0, opacity: 1 }}
				transition={{ duration: 0.5, ease: [0.4, 1.2, 0.4, 1], delay: 0.15 }}
			>
				<motion.circle
					cx="12"
					cy="4"
					r="1.7"
					{...stroke}
					strokeWidth="1.3"
					transition={{ duration: 0.45, delay: 0.3 }}
				/>
				<motion.line
					x1="12"
					y1="5.7"
					x2="12"
					y2="17.5"
					{...stroke}
					strokeWidth="1.4"
					transition={{ duration: 0.65, delay: 0.55 }}
				/>
				<motion.line
					x1="7.8"
					y1="8"
					x2="16.4"
					y2="8"
					{...stroke}
					strokeWidth="1.3"
					transition={{ duration: 0.45, delay: 0.85 }}
				/>
				<motion.path
					d="M 6 13.5 Q 6 19 12 19 Q 18 19 18 13.5"
					{...stroke}
					strokeWidth="1.4"
					transition={{ duration: 0.7, ease: [0.4, 0, 0.2, 1], delay: 1.05 }}
				/>
				<motion.path
					d="M 6 13.5 L 4.3 12.5 M 6 13.5 L 5 15.6"
					{...stroke}
					strokeWidth="1.2"
					transition={{ duration: 0.35, delay: 1.65 }}
				/>
				<motion.path
					d="M 18 13.5 L 19.7 12.5 M 18 13.5 L 19 15.6"
					{...stroke}
					strokeWidth="1.2"
					transition={{ duration: 0.35, delay: 1.65 }}
				/>
			</motion.g>
		</svg>
	)
}

function SwapGlyph({ active }: { active: boolean }) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={SIZE}
			height={SIZE}
			className="relative z-10"
			aria-hidden="true"
		>
			<motion.path
				d="M 5 8 H 17 L 14 5"
				{...draw}
				strokeWidth="1.4"
				initial={{ pathLength: 0 }}
				animate={{ pathLength: 1 }}
				transition={{ duration: 0.7, delay: 0.3 }}
			/>
			<motion.path
				d="M 19 16 H 7 L 10 19"
				{...draw}
				strokeWidth="1.4"
				initial={{ pathLength: 0 }}
				animate={{ pathLength: 1 }}
				transition={{ duration: 0.7, delay: 0.8 }}
			/>
			{active ? (
				<motion.circle
					cx="12"
					cy="12"
					r="1.4"
					fill={STROKE}
					animate={{ opacity: [0.2, 1, 0.2] }}
					transition={{ duration: 1.6, repeat: Number.POSITIVE_INFINITY }}
				/>
			) : null}
		</svg>
	)
}
