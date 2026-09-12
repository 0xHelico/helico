import type { MetadataRoute } from "next";

/**
 * One page, because one page is what a crawler can read.
 *
 * `/limit` and `/portfolio` need a wallet, so what a crawler sees of them is the connect gate —
 * listing them would offer three near-identical pages competing with the one that has something to
 * say. `/chat` and `/mandate` are redirects to the front door. The landing site at `helico.site`
 * has its own sitemap, with the blog in it.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://app.helico.site/",
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
