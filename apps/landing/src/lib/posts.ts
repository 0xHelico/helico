import { type CollectionEntry, getCollection } from 'astro:content'

// One shape for a post whichever way it arrived.
export type Post = {
	slug: string
	title: string
	summary: string
	author: string
	cover?: string
	tags: string[]
	readingMinutes: number
	publishedAt: Date
	/** Rendered HTML when the post came from the API; absent when it came from the files. */
	html?: string
	/** The collection entry when the post came from the files, for Astro to render. */
	entry?: CollectionEntry<'posts'>
}

export type PostsSource = 'api' | 'files'

type ApiItem = {
	slug: string
	title: string
	summary: string
	author: string
	cover?: string
	tags: string[]
	reading_minutes: number
	published_at: string
	html?: string
}

const WORDS_PER_MINUTE = 238

export const readingMinutes = (text: string): number =>
	Math.max(1, Math.ceil(text.split(/\s+/).filter(Boolean).length / WORDS_PER_MINUTE))

/**
 * Loads every post at build time: from the backend when `BE_URL` is set and answers, else
 * from the Markdown files it seeds from. The page says which, so a reader of the build log
 * knows what they are looking at.
 */
export async function loadPosts(): Promise<{ source: PostsSource; posts: Post[] }> {
	const base = import.meta.env.BE_URL as string | undefined
	if (base) {
		try {
			const posts = await fromApi(base.replace(/\/$/, ''))
			return { source: 'api', posts }
		} catch (err) {
			// biome-ignore lint/suspicious/noConsole: a build-time notice, the build log is its audience
			console.warn(
				`[blog] BE_URL is set but the API did not answer (${(err as Error).message}); using the files`,
			)
		}
	}
	return { source: 'files', posts: await fromFiles() }
}

async function fromApi(base: string): Promise<Post[]> {
	const res = await fetch(`${base}/api/posts?limit=100`)
	if (!res.ok) throw new Error(`GET /api/posts ${res.status}`)
	const { items } = (await res.json()) as { items: ApiItem[] }
	return Promise.all(
		items.map(async (item) => {
			const full = await fetch(`${base}/api/posts/${item.slug}`)
			if (!full.ok) throw new Error(`GET /api/posts/${item.slug} ${full.status}`)
			const p = (await full.json()) as ApiItem
			return {
				slug: p.slug,
				title: p.title,
				summary: p.summary,
				author: p.author,
				cover: p.cover,
				tags: p.tags,
				readingMinutes: p.reading_minutes,
				publishedAt: new Date(p.published_at),
				html: p.html,
			}
		}),
	)
}

async function fromFiles(): Promise<Post[]> {
	const entries = await getCollection('posts')
	return entries
		.map((entry) => ({
			slug: entry.id,
			title: entry.data.title,
			summary: entry.data.summary,
			author: entry.data.author,
			cover: entry.data.cover,
			tags: entry.data.tags,
			readingMinutes: readingMinutes(entry.body ?? ''),
			publishedAt: entry.data.published_at,
			entry,
		}))
		.sort(
			(a, b) => b.publishedAt.getTime() - a.publishedAt.getTime() || b.slug.localeCompare(a.slug),
		)
}

export const formatDate = (d: Date): string =>
	d.toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC',
	})
