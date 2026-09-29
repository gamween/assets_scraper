"use client";

import { buttonVariants } from "@/components/ui/button-variants";

/**
 * Last resort for an error thrown while the page renders: a scan event of a shape this tab does not expect, from a
 * deploy newer than the tab, is the likely one. Without it, Next's client-side exception screen replaced everything,
 * the top bar included. The store still holds what failed to render, so both ways out load the page again rather than
 * retry the render.
 *
 * Plain buttons with the button classes, not the Button component: an error boundary is a client entry of its own,
 * and the bundler copies what it imports into its chunks again. The Base UI primitive added about 50 KB to the first
 * load of every page; the class list costs nothing.
 */
export default function AppError() {
  return (
    <main className="page-x flex min-h-dvh w-full flex-col justify-center">
      <div data-testid="app-error" role="alert" className="mx-auto w-full max-w-[648px]">
        <h1 className="text-title font-semibold text-text">Something went wrong on our side</h1>
        <p className="mt-1 text-body text-text-2">The page stopped working. Reload it, or start again from the home page.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => window.location.reload()} className={buttonVariants({ variant: "primary" })}>
            Reload
          </button>
          {/* A document load, not a client navigation: the store would come along with the state that broke. */}
          <button type="button" onClick={() => window.location.assign(window.location.origin)} className={buttonVariants({ variant: "secondary" })}>
            Start again
          </button>
        </div>
      </div>
    </main>
  );
}
