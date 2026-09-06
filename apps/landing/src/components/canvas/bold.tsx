import { Fragment, type ReactNode } from 'react'

/** `**bold**` spans to `<strong>`, without HTML injection. */
export function renderBold(text: string): ReactNode[] {
	return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
		const key = `${i}-${part.slice(0, 12)}`
		if (part.startsWith('**') && part.endsWith('**')) {
			return (
				<strong key={key} style={{ fontWeight: 600 }}>
					{part.slice(2, -2)}
				</strong>
			)
		}
		return <Fragment key={key}>{part}</Fragment>
	})
}
