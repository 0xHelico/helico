import { motion } from 'framer-motion'
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react'
import { renderBold } from './bold'
import type { Cycle, ToolStreamEntry } from './cycles'

type Stage =
	| 'idle'
	| 'greeting-user'
	| 'greeting-think'
	| 'greeting-reply'
	| 'main-user'
	| 'main-think'
	| 'main-tools'
	| 'main-reply'

const SF_STACK = '-apple-system, "SF Pro Text", "SF Pro", system-ui, "Segoe UI", Roboto, sans-serif'

const TOOL_EMOJI: Record<string, string> = {
	'stateView.getSlot0': '📈',
	'vault.positionOf': '📍',
	'mandate.verify': '🔐',
	'size.swap': '🔁',
	'enclave.sign': '✍️',
	'vault.recenterWithSignature': '⚓',
	decide: '🧠',
}

// Stage timeline in ms from the cycle's start; the voyage stations are tuned to it.
const T_GREETING_USER = 200
const T_GREETING_THINK = 800
const T_GREETING_REPLY = 1500
const T_MAIN_USER = 2400
const T_MAIN_THINK = 3000
const T_MAIN_TOOLS = 3800
const TOOL_LINE_STAGGER_MS = 380
const TOOL_END_LAG_MS = 240
const REPLY_GAP_MS = 380
const REPLY_FADE_MS = 380

export function TgCanvas({ cycle }: { cycle: Cycle }) {
	const hasGreeting = !!cycle.greeting
	const [stage, setStage] = useState<Stage>('idle')
	const [times, setTimes] = useState({ gUser: '', gReply: '', mUser: '', mReply: '' })

	useEffect(() => {
		setStage('idle')
		const timers: ReturnType<typeof setTimeout>[] = []
		const sched = (at: number, s: Stage) => timers.push(setTimeout(() => setStage(s), at))
		if (hasGreeting) {
			sched(T_GREETING_USER, 'greeting-user')
			sched(T_GREETING_THINK, 'greeting-think')
			sched(T_GREETING_REPLY, 'greeting-reply')
			sched(T_MAIN_USER, 'main-user')
			sched(T_MAIN_THINK, 'main-think')
			sched(T_MAIN_TOOLS, 'main-tools')
		} else {
			sched(T_GREETING_USER, 'main-user')
			sched(T_GREETING_THINK, 'main-think')
			sched(T_GREETING_REPLY, 'main-tools')
		}
		const toolsStartAt = hasGreeting ? T_MAIN_TOOLS : T_GREETING_REPLY
		sched(
			toolsStartAt +
				cycle.toolStream.length * TOOL_LINE_STAGGER_MS +
				TOOL_END_LAG_MS +
				REPLY_GAP_MS,
			'main-reply',
		)
		setTimes({ gUser: fmtNow(-180), gReply: fmtNow(-150), mUser: fmtNow(-30), mReply: fmtNow(60) })
		return () => {
			for (const t of timers) clearTimeout(t)
		}
	}, [cycle.toolStream.length, hasGreeting])

	const past = (...stages: Stage[]) => stages.includes(stage)
	const showGreetingUser = hasGreeting && stage !== 'idle'
	const showGreetingTyping = hasGreeting && stage === 'greeting-think'
	const showGreetingReply =
		hasGreeting && past('greeting-reply', 'main-user', 'main-think', 'main-tools', 'main-reply')
	const showMainUser = past('main-user', 'main-think', 'main-tools', 'main-reply')
	const showMainTyping = stage === 'main-think'
	const showToolBubble = past('main-tools', 'main-reply')
	const showMainReply = stage === 'main-reply'

	return (
		<div
			className="relative flex h-full min-h-[460px] flex-col overflow-hidden"
			style={{ background: 'var(--tg-chat-bg)', fontFamily: SF_STACK, color: 'var(--tg-text)' }}
		>
			<ChatWallpaper />
			<ChatHeader typing={stage === 'greeting-think' || stage === 'main-think'} />

			<div className="relative z-10 flex min-h-0 flex-1 flex-col justify-end overflow-hidden pt-2 pb-2">
				{showGreetingUser && cycle.greeting && (
					<BubbleAppear>
						<UserBubble text={cycle.greeting.prompt} t={times.gUser} />
					</BubbleAppear>
				)}
				{showGreetingTyping && (
					<BubbleAppear>
						<TypingBubble />
					</BubbleAppear>
				)}
				{showGreetingReply && cycle.greeting && (
					<BubbleAppear>
						<ReplyBubble text={cycle.greeting.reply} t={times.gReply} compact />
					</BubbleAppear>
				)}
				{showMainUser && (
					<BubbleAppear>
						<UserBubble text={cycle.prompt} t={times.mUser} />
					</BubbleAppear>
				)}
				{showMainTyping && (
					<BubbleAppear>
						<TypingBubble />
					</BubbleAppear>
				)}
				{showToolBubble && (
					<BubbleAppear>
						<ToolBubble entries={cycle.toolStream} />
					</BubbleAppear>
				)}
				{showMainReply && (
					<BubbleAppear>
						<ReplyBubble text={cycle.reply} t={times.mReply} />
					</BubbleAppear>
				)}
			</div>

			<Composer />
		</div>
	)
}

function BubbleAppear({ children }: { children: ReactNode }) {
	return (
		<motion.div
			initial={{ opacity: 0, y: 6 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: REPLY_FADE_MS / 1000 }}
		>
			{children}
		</motion.div>
	)
}

function fmtNow(offsetSecs = 0) {
	const d = new Date()
	d.setSeconds(d.getSeconds() + offsetSecs)
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function ChatWallpaper() {
	return (
		<svg
			aria-hidden="true"
			className="pointer-events-none absolute inset-0"
			width="100%"
			height="100%"
			preserveAspectRatio="xMidYMid slice"
		>
			<defs>
				<pattern
					id="helico-doodle"
					x="0"
					y="0"
					width="240"
					height="320"
					patternUnits="userSpaceOnUse"
				>
					<g
						fill="none"
						stroke="var(--tg-doodle-stroke)"
						strokeWidth="1.4"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M30 40 q14 -22 32 -8 q-4 22 -32 8z" />
						<path d="M120 20 l3 9 9 3 -9 3 -3 9 -3 -9 -9 -3 9 -3z" />
						<path d="M180 60 q-12 -14 -22 0 q-4 14 22 26 q26 -12 22 -26 q-10 -14 -22 0z" />
						<path d="M70 130 q22 -36 50 -22 q-6 30 -38 38 z" />
						<path d="M170 150 l16 -10 16 10 -8 18 -8 6 -8 -6z" />
						<path d="M120 220 q-14 0 -14 -12 q0 -16 14 -16 q14 0 14 16 q0 12 -14 12z" />
						<path d="M196 210 a14 14 0 1 0 12 22 a12 12 0 1 1 -12 -22z" />
						<path d="M40 290 l20 -10 -8 -2 6 -10" />
						<path d="M150 290 q12 -22 30 -16 q-4 18 -26 22 z" />
					</g>
				</pattern>
			</defs>
			<rect width="100%" height="100%" fill="url(#helico-doodle)" />
		</svg>
	)
}

function HelicoAvatar({ size = 24 }: { size?: number }) {
	return (
		<img
			src="/favicon-32x32.png"
			alt=""
			width={size}
			height={size}
			style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, display: 'block' }}
		/>
	)
}

function ChatHeader({ typing }: { typing: boolean }) {
	return (
		<div
			className="relative z-20 flex shrink-0 items-center gap-2.5 rounded-t-[14px] px-3 pt-3 pb-2 backdrop-blur-xl sm:rounded-tr-none"
			style={{ background: 'var(--tg-header-bg)', borderBottom: '1px solid var(--tg-divider)' }}
		>
			<span
				className="inline-flex items-center"
				style={{ fontSize: 13, lineHeight: 1, gap: 1, color: 'var(--tg-accent)' }}
			>
				<svg width="6" height="11" viewBox="0 0 6 11" fill="none" aria-hidden="true">
					<path
						d="M5 1 L1.5 5.5 L5 10"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
					/>
				</svg>
				<span style={{ marginLeft: -1 }}>Chats</span>
			</span>
			<div className="flex flex-1 flex-col items-center leading-tight">
				<span
					className="text-[14px] font-semibold tracking-[-0.2px]"
					style={{ color: 'var(--tg-name)' }}
				>
					Helico
				</span>
				<span
					className="text-[11px] font-medium"
					style={{ color: typing ? 'var(--tg-accent)' : 'var(--tg-online)' }}
				>
					{typing ? 'deciding…' : 'in the enclave'}
				</span>
			</div>
			<HelicoAvatar size={30} />
		</div>
	)
}

const tailIn: CSSProperties = {
	position: 'absolute',
	bottom: 0,
	left: -5,
	width: 9,
	height: 14,
	background: 'var(--tg-bubble-in-bg)',
	clipPath: 'path("M9 0 Q 9 14 0 14 L 9 14 Z")',
}

function UserBubble({ text, t }: { text: string; t: string }) {
	const tail: CSSProperties = {
		position: 'absolute',
		bottom: 0,
		right: -5,
		width: 9,
		height: 14,
		background: 'var(--tg-bubble-out-bg)',
		clipPath: 'path("M0 0 Q 0 14 9 14 L 0 14 Z")',
	}
	return (
		<div className="mt-1.5 flex items-end justify-end gap-1.5 px-2">
			<div
				className="relative text-[12.5px] leading-[1.36]"
				style={{
					maxWidth: '78%',
					background: 'var(--tg-bubble-out-bg)',
					borderRadius: '16px 16px 4px 16px',
					padding: '5px 10px 5px 12px',
					boxShadow: 'var(--tg-bubble-shadow)',
					wordBreak: 'break-word',
				}}
			>
				<div aria-hidden="true" style={tail} />
				<span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>
				<Stamp t={t} checked />
				<div style={{ clear: 'both' }} />
			</div>
		</div>
	)
}

function Stamp({ t, checked }: { t: string; checked?: boolean }) {
	return (
		<span
			className="ml-2 inline-flex items-center gap-[3px] text-[10px]"
			style={{
				float: 'right',
				color: 'var(--tg-text-muted)',
				position: 'relative',
				top: 4,
				marginTop: 4,
				lineHeight: 1,
			}}
		>
			{t}
			{checked && (
				<svg
					width="14"
					height="10"
					viewBox="0 0 16 11"
					fill="none"
					stroke="var(--tg-check-blue)"
					strokeWidth="1.6"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M1 6 L4.2 9.2 L9.5 3" />
					<path d="M6.2 9.2 L11.5 3" />
				</svg>
			)}
		</span>
	)
}

function ToolBubble({ entries }: { entries: ToolStreamEntry[] }) {
	return (
		<div className="mt-1.5 flex items-end gap-1.5 px-2">
			<div style={{ width: 24, flexShrink: 0 }}>
				<HelicoAvatar size={24} />
			</div>
			<div
				className="relative"
				style={{
					maxWidth: '85%',
					background: 'var(--tg-bubble-in-bg)',
					borderRadius: '16px 16px 16px 4px',
					padding: '7px 11px 7px 12px',
					boxShadow: 'var(--tg-bubble-shadow)',
				}}
			>
				<div aria-hidden="true" style={tailIn} />
				<div className="flex flex-col gap-[3px]">
					{entries.map((entry, idx) => (
						<ToolLine
							key={`${entry.tool}-${entry.args ?? ''}`}
							entry={entry}
							delaySec={(idx * TOOL_LINE_STAGGER_MS) / 1000}
							endLagSec={TOOL_END_LAG_MS / 1000}
						/>
					))}
				</div>
			</div>
		</div>
	)
}

function ToolLine({
	entry,
	delaySec,
	endLagSec,
}: {
	entry: ToolStreamEntry
	delaySec: number
	endLagSec: number
}) {
	const ok = entry.status === 'ok'
	return (
		<motion.div
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			transition={{ duration: 0.18, delay: delaySec }}
			className="flex items-baseline gap-1.5 font-mono"
			style={{ fontSize: 11.5, lineHeight: 1.4, color: 'var(--tg-text-tool-body)' }}
		>
			<span>{TOOL_EMOJI[entry.tool] ?? '🔧'}</span>
			<span>
				<span style={{ color: 'var(--tg-text-tool-tool)' }}>{entry.tool}</span>
				{entry.args && (
					<>
						<span style={{ color: 'var(--tg-text-tool-colon)' }}>: </span>
						<span style={{ color: 'var(--tg-text-tool-args)' }}>{entry.args}</span>
					</>
				)}
			</span>
			<motion.span
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				transition={{ duration: 0.15, delay: delaySec + endLagSec }}
				className="ml-auto pl-1.5"
				style={{ color: ok ? '#3aa66e' : '#ef4444', fontWeight: 600 }}
			>
				{ok ? '✓' : '✗'}
			</motion.span>
		</motion.div>
	)
}

function ReplyBubble({ text, t, compact }: { text: string; t: string; compact?: boolean }) {
	return (
		<div className={`${compact ? 'mt-0.5' : 'mt-1'} flex items-end gap-1.5 px-2`}>
			<div style={{ width: 24, flexShrink: 0 }}>{compact && <HelicoAvatar size={24} />}</div>
			<div
				className="relative text-[12.5px] leading-[1.4]"
				style={{
					maxWidth: '85%',
					background: 'var(--tg-bubble-in-bg)',
					borderRadius: '16px 16px 16px 4px',
					padding: '7px 11px 7px 12px',
					boxShadow: 'var(--tg-bubble-shadow)',
					wordBreak: 'break-word',
				}}
			>
				<div aria-hidden="true" style={tailIn} />
				<span style={{ whiteSpace: 'pre-wrap' }}>{renderBold(text)}</span>
				<Stamp t={t} />
				<div style={{ clear: 'both' }} />
			</div>
		</div>
	)
}

function TypingBubble() {
	return (
		<div className="mt-1.5 flex items-end gap-1.5 px-2">
			<div style={{ width: 24 }}>
				<HelicoAvatar size={24} />
			</div>
			<div
				className="flex items-center gap-1"
				style={{
					background: 'var(--tg-bubble-in-bg)',
					padding: '8px 12px',
					borderRadius: '16px 16px 16px 4px',
					boxShadow: 'var(--tg-bubble-shadow)',
				}}
			>
				{['a', 'b', 'c'].map((k, i) => (
					<motion.span
						key={k}
						animate={{ y: [0, -3, 0], opacity: [0.55, 1, 0.55] }}
						transition={{
							duration: 1.1,
							delay: i * 0.15,
							repeat: Number.POSITIVE_INFINITY,
							ease: 'easeInOut',
						}}
						className="block h-1.5 w-1.5 rounded-full"
						style={{ background: 'var(--tg-typing-dot)' }}
					/>
				))}
			</div>
		</div>
	)
}

function Composer() {
	return (
		<div
			className="relative z-20 flex shrink-0 items-center gap-1.5 p-2 backdrop-blur-xl"
			style={{ background: 'var(--tg-composer-bg)', borderTop: '1px solid var(--tg-divider)' }}
		>
			<div
				className="flex flex-1 items-center gap-2 px-2.5"
				style={{
					background: 'var(--tg-composer-input-bg)',
					border: '0.5px solid var(--tg-composer-input-border)',
					borderRadius: 16,
					minHeight: 30,
				}}
			>
				<span className="py-[6px] text-[12.5px]" style={{ color: 'var(--tg-placeholder)' }}>
					Message
				</span>
			</div>
			<span
				className="grid place-items-center p-1"
				style={{ color: 'var(--tg-icon-muted)' }}
				aria-hidden="true"
			>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
					<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
					<line x1="12" y1="19" x2="12" y2="23" />
				</svg>
			</span>
		</div>
	)
}
