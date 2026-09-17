import type { CDPSession, Page } from "playwright-core";

/** Where the palette code runs in the page (spec 7.5). */
export interface PaletteScope {
  world: "isolated" | "main";
  /** Evaluates `expression` (awaiting a returned promise) and returns its value as JSON-compatible data. */
  evaluate(expression: string): Promise<unknown>;
  /** Releases the CDP session. Call it once every evaluation has settled: a pending one could be dropped. */
  close(): Promise<void>;
}

const WORLD_NAME = "assets-scraper-palette";

/**
 * Opens a CDP isolated world on the page's main frame: page scripts cannot see its globals nor replace the built-ins it
 * uses, and it shares the DOM. Falls back to the main world when the world cannot be created (no CDP, detached frame).
 * Never rejects.
 */
export async function openPaletteScope(page: Page): Promise<PaletteScope> {
  let session: CDPSession | undefined;
  try {
    session = await page.context().newCDPSession(page);
    const { frameTree } = await session.send("Page.getFrameTree");
    const { executionContextId } = await session.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: WORLD_NAME,
      grantUniveralAccess: false,
    });
    const cdp = session;
    return {
      world: "isolated",
      async evaluate(expression) {
        const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
          expression,
          contextId: executionContextId,
          awaitPromise: true,
          returnByValue: true,
        });
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
        return result.value;
      },
      close: () => cdp.detach().catch(() => {}),
    };
  } catch {
    await session?.detach().catch(() => {});
    return { world: "main", evaluate: (expression) => page.evaluate(expression), close: async () => {} };
  }
}
