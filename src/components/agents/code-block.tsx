import { CopyButton } from "./copy-button";

/**
 * A command or a config as it is typed: Geist Mono on the well. A long line scrolls inside the block, never the page,
 * and the copy button sits beside the text rather than over it, so it never hides the end of a line.
 */
export function CodeBlock({ code, label, message }: { code: string; label: string; message: string }) {
  return (
    <div className="flex items-start gap-1 rounded-lg border border-border bg-well py-1.5 pr-1.5 pl-3.5">
      <pre className="scrollbar-thin min-w-0 flex-1 overflow-x-auto py-1 font-mono text-[13px] leading-5 text-text">
        <code>{code}</code>
      </pre>
      <CopyButton text={code} label={label} message={message} />
    </div>
  );
}

/** A path, a flag or a file name inside a sentence. It never breaks at its own hyphens or slashes. */
export function InlineCode({ children }: { children: React.ReactNode }) {
  return <code className="rounded-sm bg-well px-1 py-px font-mono text-[0.9em] whitespace-nowrap text-text">{children}</code>;
}
