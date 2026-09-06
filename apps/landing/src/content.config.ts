import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'

// The posts the backend seeds from, read directly so a static build never needs it running.
const posts = defineCollection({
	loader: glob({ pattern: '*.md', base: '../be/content' }),
	schema: z.object({
		title: z.string(),
		summary: z.string().default(''),
		author: z.string().default('Helico'),
		cover: z.string().optional(),
		tags: z.array(z.string()).default([]),
		published_at: z.coerce.date(),
	}),
})

export const collections = { posts }
