import Link from "next/link";
import { Wordmark } from "@/components/app-shell/wordmark";
import { Badge } from "@/components/common/badge";
import { Toaster } from "@/components/ui/toast";
import { CodeBlock, InlineCode } from "./code-block";
import { AGENTS_DOC_URL, CLAUDE_CODE_INSTALL, CLI_EXAMPLES, MCP_CLIENT_CONFIG, MCP_TOOLS, REPO_URL, SCAN_CURL } from "./content";

const LINK = "text-text underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-text focus-ring rounded-sm";

function Section({ id, title, badge, children }: { id: string; title: string; badge?: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="mt-12 scroll-mt-6">
      <h2 className="flex items-center gap-2 text-title font-semibold text-text">
        <span id={`${id}-title`}>{title}</span>
        {badge ? <Badge>{badge}</Badge> : null}
      </h2>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Subsection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 flex flex-col gap-3">
      <h3 className="text-body font-semibold text-text">{title}</h3>
      {children}
    </div>
  );
}

function Prose({ children }: { children: React.ReactNode }) {
  return <p className="text-body leading-[22px] text-text-2">{children}</p>;
}

/**
 * `/agents`: how to plug an agent into Assets Scraper, in one readable column. The full reference stays in
 * docs/agents.md; this page says what an agent gets and the shortest way in for each kind of agent.
 */
export function AgentsDoc() {
  return (
    <Toaster>
      <div className="flex min-h-dvh flex-col">
        <header className="page-x flex h-(--top-bar-height) w-full items-center">
          <Link href="/" aria-label="Assets Scraper" className="-mx-1.5 rounded-md px-1.5 py-1 focus-ring">
            <Wordmark />
          </Link>
        </header>

        <main className="page-x w-full flex-1">
          <article className="mx-auto w-full max-w-[704px] pt-10 pb-16 sm:pt-16">
            <h1 className="text-[26px] leading-[32px] font-semibold tracking-[-0.02em] text-balance text-text sm:text-display">
              Use Assets Scraper from your AI agent
            </h1>
            <p className="mt-2 text-input-lg text-pretty text-text-2">
              It runs as an MCP server, a CLI and an HTTP API: your agent scans a page, reads a short summary and pulls exactly the files it needs.
            </p>

            <Section id="what-you-get" title="What your agent gets">
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-body leading-[22px] text-text-2 marker:text-text-3">
                <li>A summary of the page: logos, palette, fonts with their licence, the text wordmark, and brand kit links and files.</li>
                <li>
                  Filtered downloads into <InlineCode>scrap/&lt;host&gt;/</InlineCode> with a <InlineCode>manifest.json</InlineCode>, or into{" "}
                  <InlineCode>~/Downloads/assets-scraper/&lt;host&gt;</InlineCode> outside a project.
                </li>
                <li>Brand kits downloaded, with their logo files unpacked.</li>
                <li>Fonts installed locally, with their licence.</li>
                <li>Small answers, so the agent&apos;s context stays clean.</li>
              </ul>
            </Section>

            <Section id="mcp" title="MCP server" badge="Recommended">
              <Prose>Scans run locally, in your own Chrome. It needs Node 22.19 or later (or Node 24), pnpm and Google Chrome.</Prose>
              <Subsection title="Claude Code">
                <CodeBlock code={CLAUDE_CODE_INSTALL} label="Copy the Claude Code install commands" message="Commands copied" />
                <Prose>The plugin also ships a skill that teaches your agent the workflow: scan, read the summary, filter, then download.</Prose>
              </Subsection>
              <Subsection title="Any other MCP client">
                <Prose>
                  Claude Desktop, Cursor, Windsurf and other clients start the same server over stdio. Clone and build as above, then add it to the
                  client&apos;s MCP config with the absolute path of your clone:
                </Prose>
                <CodeBlock code={MCP_CLIENT_CONFIG} label="Copy the MCP config" message="Config copied" />
              </Subsection>
            </Section>

            <Section id="tools" title="Tools">
              <Prose>Every tool answers in compact JSON, never with file bytes.</Prose>
              <dl className="grid grid-cols-1 border-t border-border sm:grid-cols-[176px_minmax(0,1fr)]">
                {MCP_TOOLS.map((tool) => (
                  <div key={tool.name} className="col-span-full grid grid-cols-subgrid gap-x-4 gap-y-0.5 border-b border-border py-2.5">
                    <dt className="font-mono text-[13px] leading-5 text-text">{tool.name}</dt>
                    <dd className="text-body leading-5 text-text-2">{tool.purpose}</dd>
                  </div>
                ))}
              </dl>
            </Section>

            <Section id="cli" title="CLI">
              <Prose>
                The same tools from a shell. After <InlineCode>pnpm build:agent</InlineCode>, run <InlineCode>pnpm link --global</InlineCode> in the
                clone to put <InlineCode>assets-scraper</InlineCode> on your PATH. Add <InlineCode>--json</InlineCode> for output an agent can parse.
              </Prose>
              <div className="flex flex-col gap-2">
                {CLI_EXAMPLES.map((command) => (
                  <CodeBlock key={command} code={command} label={`Copy ${command}`} message="Command copied" />
                ))}
              </div>
            </Section>

            <Section id="http-api" title="HTTP API">
              <Prose>
                For an agent that only speaks HTTP, the hosted app runs the scan and answers one JSON document. It needs an agent token, issued by
                the owner of this deployment.
              </Prose>
              <CodeBlock code={SCAN_CURL} label="Copy the scan request" message="Command copied" />
              <Prose>
                <a href="/llms.txt" className={LINK}>
                  /llms.txt
                </a>{" "}
                and{" "}
                <a href="/api/openapi.json" className={LINK}>
                  /api/openapi.json
                </a>{" "}
                describe it for machines, along with the endpoint that returns the files as one ZIP.
              </Prose>
            </Section>

            <footer className="mt-16 border-t border-border pt-5 text-small text-text-3">
              <p>
                The full reference is{" "}
                <a href={AGENTS_DOC_URL} className={LINK}>
                  docs/agents.md
                </a>{" "}
                in the{" "}
                <a href={REPO_URL} className={LINK}>
                  GitHub repository
                </a>
                .
              </p>
            </footer>
          </article>
        </main>
      </div>
    </Toaster>
  );
}
