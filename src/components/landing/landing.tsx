"use client";

import { useEffect, useId, useRef } from "react";
import { Wordmark } from "@/components/app-shell/wordmark";
import { Kbd } from "@/components/common/kbd";
import { usePlatformModifier } from "@/components/common/use-platform";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { submitUrl } from "@/lib/client/scan-session";
import { useApp } from "@/lib/client/store";
import { HostChips } from "./host-chips";

const TRY_HOSTS = ["stripe.com", "linear.app", "framer.com"];

/** Spec 12.2 landing: one centered block at about 38 percent of the viewport height, nothing else to read. */
export function Landing() {
  const input = useApp((s) => s.input);
  const inputError = useApp((s) => s.inputError);
  const recent = useApp((s) => s.recent);
  const setInput = useApp((s) => s.setInput);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const modifier = usePlatformModifier();

  useEffect(() => {
    // Autofocus on devices with a fine pointer only, so phones do not open the keyboard over the page.
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (inputError) inputRef.current?.focus();
  }, [inputError]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="page-x flex h-(--top-bar-height) w-full items-center">
        <Wordmark />
      </header>

      <main className="page-x w-full flex-1">
        <div className="mx-auto w-full max-w-[560px] pt-[max(40px,calc(38dvh-172px))] pb-20">
          <h1 className="text-[26px] leading-[32px] font-semibold tracking-[-0.02em] text-balance text-text sm:text-display">
            Every SVG, image and font on a page.
          </h1>
          <p className="mt-2 text-input-lg text-text-2">Paste a URL. Download one file, a selection or everything.</p>

          <form
            className="mt-8 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submitUrl(input);
            }}
          >
            <Input
              ref={inputRef}
              name="url"
              aria-label="Page URL"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="linear.app"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
              enterKeyHint="go"
              aria-invalid={inputError ? true : undefined}
              aria-describedby={inputError ? errorId : undefined}
              className="h-12 flex-1 px-3.5 text-input-lg sm:h-10"
            />
            <Button type="submit" variant="primary" size="lg" className="h-12 px-5 sm:h-10">
              Scan
            </Button>
          </form>
          <p id={errorId} role="alert" className="mt-2 min-h-[18px] text-small text-danger">
            {inputError}
          </p>

          <div className="mt-3 flex flex-col gap-2.5">
            <HostChips label="Try" hosts={TRY_HOSTS} />
            {recent.length ? <HostChips label="Recent" hosts={recent} removable /> : null}
          </div>
        </div>
      </main>

      <footer className="page-x flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-2 pt-4 pb-[calc(20px+env(safe-area-inset-bottom,0px))] text-small text-text-3">
        <p>Scans aren&apos;t saved. Assets belong to their owners.</p>
        <p className="hidden items-center gap-1.5 md:flex">
          Paste a URL anywhere to scan
          <span className="inline-flex gap-0.5">
            <Kbd>{modifier}</Kbd>
            <Kbd>V</Kbd>
          </span>
        </p>
      </footer>
    </div>
  );
}
