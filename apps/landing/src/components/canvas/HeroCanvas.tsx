import { useEffect, useState } from 'react'
import { CYCLES, type Cycle, PAINTINGS } from './cycles'
import { OutputCanvas } from './OutputCanvas'
import { TgCanvas } from './TgCanvas'
import { TuiCanvas } from './TuiCanvas'

/**
 * The framed canvas: a "painting" behind, an inner frame that holds the app surface, the chat
 * on the left and the voyage behind it on the right. Cycles through the scenarios on a timer.
 */
export function HeroCanvas() {
	const [activeIdx, setActiveIdx] = useState(0)
	// `activeIdx` is always wrapped modulo the list, and the list is not empty.
	const cycle = CYCLES[activeIdx] as Cycle

	useEffect(() => {
		const id = setTimeout(() => setActiveIdx((i) => (i + 1) % CYCLES.length), cycle.durationMs)
		return () => clearTimeout(id)
	}, [cycle.durationMs])

	return (
		<div className="relative">
			<div className="relative isolate h-[clamp(540px,78svh,720px)] overflow-hidden rounded-[24px] border border-[var(--color-border)] shadow-[0_40px_80px_-50px_rgba(20,28,60,0.5)] sm:h-auto sm:aspect-[16/9] sm:min-h-[460px]">
				{CYCLES.map((c, i) => (
					<div
						key={c.id}
						aria-hidden="true"
						className="absolute inset-0 transition-opacity duration-[1200ms] ease-out"
						style={{
							backgroundImage: PAINTINGS[c.painting],
							opacity: i === activeIdx ? 0.95 : 0,
							transform: 'scale(1.04)',
						}}
					/>
				))}
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0"
					style={{
						background:
							'radial-gradient(110% 80% at 50% 50%, rgba(10,14,30,0) 55%, rgba(10,14,30,0.12) 100%)',
					}}
				/>

				<div className="relative flex h-full flex-col px-5 pt-5 sm:px-10 sm:pt-10 lg:px-12 lg:pt-12">
					<div className="relative flex flex-1 overflow-hidden rounded-t-[14px] border border-b-0 border-[var(--color-border)] bg-[var(--color-paper)] shadow-[0_-24px_50px_-30px_rgba(20,28,60,0.32)]">
						<div className="grid h-full min-h-0 w-full grid-cols-12 grid-rows-1 gap-0">
							<div className="col-span-12 lg:col-span-5 lg:border-r lg:border-[var(--color-border)]">
								{cycle.surface === 'tui' ? (
									<TuiCanvas key={cycle.id} cycle={cycle} />
								) : (
									<TgCanvas key={cycle.id} cycle={cycle} />
								)}
							</div>
							<div className="hidden lg:col-span-7 lg:block">
								<OutputCanvas key={`${cycle.id}-out`} cycle={cycle} />
							</div>
						</div>
					</div>
				</div>
			</div>

			<nav className="mt-3 flex items-center justify-center gap-2" aria-label="Scenarios">
				{CYCLES.map((c, i) => (
					<button
						key={c.id}
						type="button"
						onClick={() => setActiveIdx(i)}
						className="rounded-full px-3 py-1 text-[11px] font-medium tracking-[0.02em] transition-colors"
						style={{
							background: i === activeIdx ? 'var(--color-ink)' : 'rgba(11,14,21,0.06)',
							color: i === activeIdx ? '#fff' : 'var(--color-ink-2)',
						}}
					>
						{c.title}
					</button>
				))}
			</nav>
		</div>
	)
}
