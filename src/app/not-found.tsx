import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/app-shell/wordmark";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = { title: "Page not found" };

/**
 * Any address the app has no page for. Next's default 404 is unbranded, dark on a system in dark mode although the app
 * is light only, and titled after the app rather than the error.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="page-x flex h-(--top-bar-height) w-full items-center">
        <Link href="/" aria-label="Assets Scraper" className="-mx-1.5 rounded-md px-1.5 py-1">
          <Wordmark />
        </Link>
      </header>
      <main className="page-x w-full flex-1">
        <div className="mx-auto w-full max-w-[648px] pt-[max(40px,calc(38dvh-172px))] pb-20">
          <h1 className="text-[26px] leading-[32px] font-semibold tracking-[-0.02em] text-text sm:text-display">Page not found</h1>
          <p className="mt-2 text-input-lg text-text-2">There is nothing at this address. Scans start from the home page.</p>
          <Link href="/" className={buttonVariants({ variant: "primary", size: "lg", className: "mt-8" })}>
            Scan a page
          </Link>
        </div>
      </main>
    </div>
  );
}
