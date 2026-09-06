import { motion } from 'framer-motion'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { renderBold } from './bold'
import type { Cycle, ToolStreamEntry } from './cycles'

type Stage = 'idle' | 'typing' | 'committed' | 'tools' | 'reply'

// Wall-clock from the start of the cycle. The right-hand stations in provenance.ts are tuned
// to these: typing 400–2600 ms, commit at 2800, one tool every 700 ms, reply 600 ms later.
const IDLE_MS = 400
const TYPING_MS = 2200
const COMMIT_MS = 200
const TOOL_STAGGER_MS = 700
const REPLY_DELAY_MS = 600

const COLOR_SYS = 'rgba(11, 14, 21, 0.4)'
const COLOR_YOU = '#2a78a8'
const COLOR_HELICO = '#3a8e5e'
const COLOR_THINKING = '#2a78a8'

export function TuiCanvas({ cycle }: { cycle: Cycle }) {
	const [stage, setStage] = useState<Stage>('idle')
	const scrollRef = useRef<HTMLDivElement | null>(null)

	useEffect(() => {
		setStage('idle')
		const replyAt =
			IDLE_MS + TYPING_MS + COMMIT_MS + cycle.toolStream.length * TOOL_STAGGER_MS + REPLY_DELAY_MS
		const timers = [
			setTimeout(() => setStage('typing'), IDLE_MS),
			setTimeout(() => setStage('committed'), IDLE_MS + TYPING_MS),
			setTimeout(() => setStage('tools'), IDLE_MS + TYPING_MS + COMMIT_MS),
			setTimeout(() => setStage('reply'), replyAt),
		]
		return () => {
			for (const t of timers) clearTimeout(t)
		}
	}, [cycle.toolStream.length])

	useEffect(() => {
		if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
	}, [])

	const showUserPrompt = stage === 'committed' || stage === 'tools' || stage === 'reply'
	const showHelicoRow = stage === 'tools' || stage === 'reply'
	const showReply = stage === 'reply'
	const showThinking = stage === 'committed' || stage === 'tools'

	return (
		<div className="flex h-full min-h-[460px] flex-col bg-[var(--color-paper)] font-mono text-[12px] leading-[1.55] text-[var(--color-ink)]">
			<div
				ref={scrollRef}
				className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
			>
				<Row label="sys" labelColor={COLOR_SYS}>
					<span style={{ color: COLOR_SYS }}>connected · Arbitrum One · mandate armed</span>
				</Row>

				{showUserPrompt && (
					<motion.div
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						transition={{ duration: 0.18 }}
						className="mt-3"
					>
						<Row label="you" labelColor={COLOR_YOU}>
							<span style={{ whiteSpace: 'pre-wrap' }}>{cycle.prompt}</span>
						</Row>
					</motion.div>
				)}

				{showHelicoRow && (
					<motion.div
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						transition={{ duration: 0.18 }}
						className="mt-3"
					>
						<Row label="helico" labelColor={COLOR_HELICO}>
							<div className="flex flex-col">
								{cycle.toolStream.map((entry, idx) => (
									<ToolBlock
										key={`${cycle.id}-${entry.tool}-${entry.args ?? ''}`}
										entry={entry}
										delaySec={(idx * TOOL_STAGGER_MS) / 1000}
									/>
								))}
								{showReply && (
									<motion.div
										initial={{ opacity: 0, y: 4 }}
										animate={{ opacity: 1, y: 0 }}
										transition={{ duration: 0.32 }}
										className="mt-3 font-sans text-[12.5px] leading-[1.5]"
										style={{ whiteSpace: 'pre-wrap' }}
									>
										{renderBold(cycle.reply)}
									</motion.div>
								)}
							</div>
						</Row>
					</motion.div>
				)}
			</div>

			{showThinking && <ThinkingRow />}

			<div
				className="shrink-0 border-t border-[var(--color-border)] px-4 py-2.5"
				style={{ background: 'rgba(11, 14, 21, 0.04)' }}
			>
				<div className="flex items-center gap-1.5">
					<span style={{ color: COLOR_THINKING }}>{'>'}</span>
					<span className="min-w-0 flex-1" style={{ wordBreak: 'break-word' }}>
						{stage === 'typing' ? <TypingChars text={cycle.prompt} durationMs={TYPING_MS} /> : null}
						<span
							aria-hidden="true"
							className="inline-block align-text-bottom bg-[var(--color-ink)]"
							style={{ width: 7, height: 13, marginLeft: 1 }}
						/>
					</span>
				</div>
			</div>

			<div className="flex shrink-0 items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-paper)] px-4 py-1.5 text-[10px] tracking-[0.04em]">
				<span className="flex items-center gap-2">
					<span style={{ color: COLOR_HELICO, fontWeight: 500 }}>helico</span>
					<span style={{ color: 'var(--color-ink-3)', opacity: 0.5 }}>·</span>
					<span style={{ color: 'var(--color-ink-3)' }}>enclave · nitro · us-west-2</span>
					<span style={{ color: 'var(--color-ink-3)', opacity: 0.5 }}>·</span>
					<span style={{ color: 'var(--color-ink-3)' }}>vault 0x362d…f772</span>
				</span>
				<span style={{ color: '#c4793a' }}>key: sealed</span>
			</div>
		</div>
	)
}

function Row({
	label,
	labelColor,
	children,
}: {
	label: string
	labelColor: string
	children: ReactNode
}) {
	return (
		<div className="grid grid-cols-[60px_1fr] items-start gap-2">
			<span style={{ color: labelColor, fontWeight: 500 }} className="pt-[1px] tracking-tight">
				{label}
			</span>
			<div className="min-w-0">{children}</div>
		</div>
	)
}

function ToolBlock({ entry, delaySec }: { entry: ToolStreamEntry; delaySec: number }) {
	const ok = entry.status === 'ok'
	return (
		<motion.div
			initial={{ opacity: 0, x: -3 }}
			animate={{ opacity: 1, x: 0 }}
			transition={{ duration: 0.22, delay: delaySec }}
			className="mt-1.5 first:mt-0"
		>
			<div className="flex items-baseline gap-1.5">
				<span style={{ color: 'var(--color-ink)' }}>●</span>
				<span style={{ color: 'var(--color-ink)' }}>{entry.tool}</span>
				{entry.args && <span style={{ color: 'var(--color-ink-3)' }}>({entry.args})</span>}
			</div>
			<motion.div
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				transition={{ duration: 0.18, delay: delaySec + 0.12 }}
				className="pl-[14px]"
				style={{ color: 'var(--color-ink-3)' }}
			>
				└ <span style={{ color: ok ? COLOR_HELICO : '#c4393a' }}>{entry.status}</span>
			</motion.div>
		</motion.div>
	)
}

function ThinkingRow() {
	const [seconds, setSeconds] = useState(0)
	useEffect(() => {
		const id = setInterval(() => setSeconds((s) => s + 1), 1000)
		return () => clearInterval(id)
	}, [])
	return (
		<div className="shrink-0 px-4 py-1.5">
			<div className="flex items-center gap-2">
				<Spinner />
				<span className="text-[12px]" style={{ color: COLOR_THINKING }}>
					deciding… {seconds}s
				</span>
			</div>
		</div>
	)
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

function Spinner() {
	const [frame, setFrame] = useState(0)
	useEffect(() => {
		const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80)
		return () => clearInterval(id)
	}, [])
	return (
		<span className="font-mono text-[12px]" style={{ color: COLOR_THINKING }}>
			{SPINNER_FRAMES[frame]}
		</span>
	)
}

function TypingChars({ text, durationMs }: { text: string; durationMs: number }) {
	const [shown, setShown] = useState('')
	useEffect(() => {
		setShown('')
		const start = performance.now()
		let raf = 0
		const tick = () => {
			const progress = Math.min(1, (performance.now() - start) / durationMs)
			setShown(text.slice(0, Math.floor(progress * text.length)))
			if (progress < 1) raf = requestAnimationFrame(tick)
			else setShown(text)
		}
		raf = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(raf)
	}, [text, durationMs])
	return <span>{shown}</span>
}
