"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { goHome, submitUrl } from "@/lib/client/scan-session";
import { useApp } from "@/lib/client/store";
import { Mark } from "./wordmark";

/**
 * Sticky 56 px bar of the results layout: wordmark, URL field, Scan (spec 12.2, 12.6). An address that is not a URL
 * shows the inline message under this field and keeps the page as it is (spec 13 `invalid-url`); Esc puts the current
 * address back.
 */
export function TopBar() {
  const input = useApp((s) => s.input);
  const inputError = useApp((s) => s.inputError);
  const url = useApp((s) => s.url);
  const setInput = useApp((s) => s.setInput);
  const setInputError = useApp((s) => s.setInputError);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  useEffect(() => {
    if (inputError) inputRef.current?.focus();
  }, [inputError]);

  return (
    <header className="sticky top-[env(safe-area-inset-top,0px)] z-40 h-(--top-bar-height) border-b border-border bg-bg">
      <div className="page-x flex h-full items-center gap-3 sm:gap-5">
        <Link
          href="/"
          // Below 640 px the label is display:none and the mark is aria-hidden, which left the only way back to the
          // landing with no accessible name.
          aria-label="Assets Scraper"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            goHome();
          }}
          className="-mx-1.5 flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 text-body font-semibold tracking-[-0.01em] text-text"
        >
          <Mark />
          <span className="hidden sm:inline">Assets Scraper</span>
        </Link>
        <form
          role="search"
          aria-label="Scan a page"
          className="flex min-w-0 flex-1 items-center gap-2 sm:max-w-[580px]"
          onSubmit={(event) => {
            event.preventDefault();
            submitUrl(input);
          }}
        >
          <div className="relative min-w-0 flex-1">
            <Input
              ref={inputRef}
              name="url"
              aria-label="Page URL"
              data-testid="top-bar-url"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={() => {
                if (inputError) setInputError(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || !url || (input === url && !inputError)) return;
                event.preventDefault();
                event.stopPropagation();
                setInput(url);
              }}
              placeholder="linear.app"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
              enterKeyHint="go"
              aria-invalid={inputError ? true : undefined}
              aria-describedby={inputError ? errorId : undefined}
              className="pr-2 font-mono text-mono"
            />
            {inputError ? (
              <p id={errorId} role="alert" className="absolute top-full left-0 mt-1.5 rounded-md border border-border bg-surface px-2 py-1 text-small whitespace-nowrap text-danger">
                {inputError}
              </p>
            ) : null}
          </div>
          <Button type="submit" variant="secondary" size="md" aria-label="Scan">
            <span className="hidden sm:inline">Scan</span>
            <ArrowRight className="sm:hidden" />
          </Button>
        </form>
      </div>
    </header>
  );
}
