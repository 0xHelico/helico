import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { type Cycle, PAINTINGS } from './cycles'
import { BigGlyph } from './glyphs'
import { PROVENANCE, type Receipt } from './provenance'

/**
 * The right-hand canvas: what happened behind the chat, as a line that draws down through the
 * stations as each one fires. Empty stations do not render, only the line.
 */
export function OutputCanvas({ cycle }: { cycle: Cycle }) {
	const provenance = PROVENANCE[cycle.id] ?? null
	return (
		<div className="relative h-full min-h-[460px] overflow-hidden bg-[var(--color-cream-warm)]">
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-0"
				style={{
					backgroundImage: PAINTINGS[cycle.painting],
					opacity: 0.22,
					filter: 'blur(40px) saturate(0.85)',
					mixBlendMode: 'multiply',
				}}
			/>
			<AnimatePresence mode="wait">
				<motion.div
					key={cycle.id}
					initial={{ opacity: 0, y: 10 }}
					animate={{ opacity: 1, y: 0 }}
					exit={{ opacity: 0, y: -8 }}
					transition={{ duration: 1.0, ease: [0.22, 1, 0.36, 1] }}
					className="relative flex h-full flex-col px-6 pt-6 pb-6 sm:px-9 sm:pt-7"
				>
					<Header cycle={cycle} intro={provenance?.intro} />
					<div className="relative mt-4 flex-1">
						{provenance ? (
							<Voyage key={cycle.id} receipts={provenance.receipts} outcome={provenance.outcome} />
						) : null}
					</div>
				</motion.div>
			</AnimatePresence>
		</div>
	)
}

function Header({ cycle, intro }: { cycle: Cycle; intro?: string }) {
	const [tick, setTick] = useState(0)
	useEffect(() => {
		const id = setInterval(() => setTick((t) => t + 1), 1000)
		return () => clearInterval(id)
	}, [])
	return (
		<div className="flex items-start justify-between gap-6">
			<div className="min-w-0 flex-1">
				<div className="font-serif-italic text-[24px] leading-none text-[var(--color-ink)]">
					behind the chat
				</div>
				{intro ? (
					<div className="mt-2 whitespace-nowrap text-[12px] leading-snug text-[var(--color-ink-2)]">
						{intro}
					</div>
				) : null}
			</div>
			<div className="shrink-0 text-right font-mono text-[10px] tracking-[0.06em] text-[var(--color-ink-3)]">
				<div>{cycle.title}</div>
				<div className="mt-0.5 text-[var(--color-ink-2)]">
					14:32:{String(18 + tick).padStart(2, '0')}
				</div>
			</div>
		</div>
	)
}

const NODE_COL_PX = 22
const NODE_CENTER_PX = 11
const DOT_SIZE_PX = 9
const DOT_TOP_OFFSET_PX = 28
const LINE_START_PX = DOT_TOP_OFFSET_PX + DOT_SIZE_PX / 2
const GLYPH_COL_PX = 56
const STATION_GAP = 28

function Voyage({ receipts, outcome }: { receipts: Receipt[]; outcome: string }) {
	const [activeIdx, setActiveIdx] = useState(-1)
	const containerRef = useRef<HTMLDivElement | null>(null)
	const nodeRefs = useRef<(HTMLDivElement | null)[]>([])
	const [drawnHeight, setDrawnHeight] = useState(0)

	useEffect(() => {
		setActiveIdx(-1)
		const timeouts = receipts.map((r, i) =>
			setTimeout(() => setActiveIdx((prev) => Math.max(prev, i)), r.delayMs),
		)
		return () => {
			for (const t of timeouts) clearTimeout(t)
		}
	}, [receipts])

	useEffect(() => {
		function measure() {
			const c = containerRef.current
			if (!c) return
			if (activeIdx < 0) {
				setDrawnHeight(0)
				return
			}
			const node = nodeRefs.current[activeIdx]
			if (!node) return
			const centre =
				node.getBoundingClientRect().top +
				node.getBoundingClientRect().height / 2 -
				c.getBoundingClientRect().top
			setDrawnHeight(Math.max(0, centre - LINE_START_PX))
		}
		measure()
		const ro = new ResizeObserver(measure)
		if (containerRef.current) ro.observe(containerRef.current)
		return () => ro.disconnect()
	}, [activeIdx])

	const allDone = activeIdx >= receipts.length - 1

	return (
		<div ref={containerRef} className="relative">
			<motion.div
				aria-hidden="true"
				className="pointer-events-none absolute"
				style={{
					top: LINE_START_PX,
					left: NODE_CENTER_PX - 0.75,
					width: 1.5,
					background: 'var(--color-ink)',
				}}
				initial={{ height: 0 }}
				animate={{ height: drawnHeight }}
				transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
			/>
			<ol className="relative flex list-none flex-col p-0" style={{ gap: STATION_GAP }}>
				{receipts.map((r, i) => (
					<Station
						key={r.id}
						receipt={r}
						visible={i <= activeIdx}
						isCurrent={i === activeIdx}
						nodeRef={(el) => {
							nodeRefs.current[i] = el
						}}
					/>
				))}
			</ol>
			<AnimatePresence>
				{allDone ? (
					<motion.div
						initial={{ opacity: 0, y: 6 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0, y: -4 }}
						transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: 0.3 }}
						className="mt-7 pl-[34px]"
					>
						<div className="mb-3 h-px w-10 bg-[var(--color-ink-3)] opacity-50" />
						<div className="text-[14.5px] font-medium leading-snug text-[var(--color-ink)]">
							{outcome}
						</div>
					</motion.div>
				) : null}
			</AnimatePresence>
		</div>
	)
}

function Station({
	receipt,
	visible,
	isCurrent,
	nodeRef,
}: {
	receipt: Receipt
	visible: boolean
	isCurrent: boolean
	nodeRef: (el: HTMLDivElement | null) => void
}) {
	return (
		<li
			className="grid items-start gap-4"
			style={{ gridTemplateColumns: `${NODE_COL_PX}px 1fr ${GLYPH_COL_PX}px` }}
		>
			<div className="relative flex justify-center" style={{ paddingTop: DOT_TOP_OFFSET_PX }}>
				<div ref={nodeRef} style={{ width: DOT_SIZE_PX, height: DOT_SIZE_PX }}>
					<NodeDot visible={visible} isCurrent={isCurrent} />
				</div>
			</div>
			<Annotation receipt={receipt} visible={visible} />
			<div className="flex h-9 items-center justify-end">
				<AnimatePresence>
					{visible ? (
						<motion.div
							initial={{ scale: 0.5, opacity: 0, rotate: -8 }}
							animate={{ scale: 1, opacity: 1, rotate: 0 }}
							exit={{ scale: 0.5, opacity: 0 }}
							transition={{ duration: 0.6, ease: [0.22, 1.4, 0.36, 1], delay: 0.1 }}
							className="origin-right"
						>
							<BigGlyph kind={receipt.glyph} active={isCurrent} />
						</motion.div>
					) : null}
				</AnimatePresence>
			</div>
		</li>
	)
}

function NodeDot({ visible, isCurrent }: { visible: boolean; isCurrent: boolean }) {
	return (
		<AnimatePresence>
			{visible ? (
				<motion.div
					initial={{ scale: 0.95, opacity: 0 }}
					animate={{ scale: [0.95, 1.4, 1], opacity: 1 }}
					exit={{ scale: 0.95, opacity: 0 }}
					transition={{ duration: 0.6, ease: [0.22, 1.6, 0.36, 1] }}
					className="relative h-full w-full rounded-full"
					style={{ background: 'var(--color-ink)' }}
				>
					{isCurrent ? (
						<motion.span
							aria-hidden="true"
							className="pointer-events-none absolute inset-0 rounded-full"
							style={{ background: 'var(--color-ink)' }}
							animate={{ opacity: [0.5, 0, 0.5], scale: [1, 2.4, 1] }}
							transition={{ duration: 2.4, repeat: Number.POSITIVE_INFINITY, ease: 'easeOut' }}
						/>
					) : null}
				</motion.div>
			) : null}
		</AnimatePresence>
	)
}

function Annotation({ receipt, visible }: { receipt: Receipt; visible: boolean }) {
	return (
		<AnimatePresence>
			{visible ? (
				<motion.div
					initial={{ opacity: 0, x: -8 }}
					animate={{ opacity: 1, x: 0 }}
					exit={{ opacity: 0, x: -8 }}
					transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: 0.25 }}
					className="min-w-0 pt-[1px]"
				>
					<div className="font-mono text-[10.5px] tracking-[0.06em] text-[var(--color-ink-2)]">
						{receipt.layer}
					</div>
					<p className="mt-1 text-[14px] leading-[1.5] text-[var(--color-ink)]">
						{receipt.narration}
					</p>
					{receipt.proofHref ? (
						<a
							href={receipt.proofHref}
							target="_blank"
							rel="noreferrer"
							className="mt-2 inline-block font-mono text-[10.5px] text-[var(--color-ink-3)] underline-offset-2 hover:text-[var(--color-ink)] hover:underline"
						>
							see the evidence ↗
						</a>
					) : null}
				</motion.div>
			) : null}
		</AnimatePresence>
	)
}
