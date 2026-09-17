import type { MetadataRoute } from "next";

/** Spec 11.5: nothing is indexed. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
