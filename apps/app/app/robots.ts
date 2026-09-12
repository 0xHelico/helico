import type { MetadataRoute } from "next";

/**
 * What a crawler may read.
 *
 * `/api/` because it is not content, and `/chat/` because everything under it is one person's
 * transcript — thin for a crawler, near duplicate of every other one, and not ours to publish.
 * The bare `/chat` is a redirect to the front door and is not matched by the prefix, so a link to
 * it still resolves.
 *
 * The pages behind a wallet carry their own `noindex` rather than being disallowed here, because
 * the two do different jobs: disallowing stops the fetch, `noindex` stops the listing. A page
 * already linked from elsewhere can be listed without ever being fetched, which is exactly the
 * case a bare disallow does not cover.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/chat/"] }],
    sitemap: "https://app.helico.site/sitemap.xml",
    host: "https://app.helico.site",
  };
}
