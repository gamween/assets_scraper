import type { Metadata } from "next";
import { AgentsDoc } from "@/components/agents/agents-doc";

// The root layout's `robots` (noindex, nofollow) still applies: a page's metadata only replaces the keys it sets.
export const metadata: Metadata = {
  title: "AI agents · Assets Scraper",
  description: "Use Assets Scraper from your AI agent, as an MCP server, a CLI or an HTTP API.",
};

/** Static: nothing here reads the request, so it is rendered once at build time. */
export default function AgentsPage() {
  return <AgentsDoc />;
}
