import type { APIRoute } from 'astro'
import { loadPosts } from '../lib/posts'

// Every public page, so a crawler does not have to find the posts by following links.
export const GET: APIRoute = async ({ site }) => {
	const origin = site?.origin ?? 'https://helico.site'
	const { posts } = await loadPosts()
	const urls = ['/', '/blog/', ...posts.map((p) => `/blog/${p.slug}/`)]
	const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${origin}${u}</loc></url>`).join('\n')}
</urlset>
`
	return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
}
