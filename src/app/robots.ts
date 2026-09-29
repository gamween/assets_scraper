import type { MetadataRoute } from "next";

/**
 * Spec 11.5: nothing is indexed, and crawlers stay out of everything but the two documents written for agents (agent
 * spec 8). A fetcher acting for a person, like an assistant handed the llms.txt URL, honours robots.txt too, so
 * disallowing those two kept out the very reader they were written for. `X-Robots-Tag: noindex` still keeps them out of
 * search results.
 */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", allow: ["/llms.txt", "/api/openapi.json"], disallow: "/" }] };
}
