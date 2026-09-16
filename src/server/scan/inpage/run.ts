import type { CDPSession, Page } from "playwright-core";

type Protocol = {
  exceptionDetails?: { text: string; exception?: { description?: string } };
  result: { value?: unknown };
};

export interface RunInPageOptions {
  timeoutMs: number;
  /** Tests inject a broken session to exercise the main-world fallback. */
  createSession?: (page: Page) => Promise<CDPSession>;
}

const WORLD_NAME = "assets-scraper";

/**
 * Evaluates `${source};${expression}` in a fresh CDP isolated world of the main frame (spec 7.5): same DOM, but its
 * own globals, so pages that patch built-ins cannot break the bundled code, and page scripts cannot see it. When the
 * isolated world cannot be created, runs in the main world and reports `world: "main"`. An exception thrown by the
 * code itself rejects without a retry. Rejects after `timeoutMs` in every case.
 */
export async function runInPage<T>(page: Page, source: string, expression: string, options: RunInPageOptions): Promise<{ value: T; world: "isolated" | "main" }> {
  const script = `${source};\n${expression}`;
  let session: CDPSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async (): Promise<{ value: T; world: "isolated" | "main" }> => {
    let contextId: number;
    try {
      session = await (options.createSession ?? ((target: Page) => target.context().newCDPSession(target)))(page);
      const { frameTree } = await session.send("Page.getFrameTree");
      ({ executionContextId: contextId } = await session.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: WORLD_NAME, grantUniveralAccess: false }));
    } catch {
      detach(session);
      session = undefined;
      return { value: (await page.evaluate(script)) as T, world: "main" };
    }
    const response = (await session.send("Runtime.evaluate", { expression: script, contextId, awaitPromise: true, returnByValue: true })) as Protocol;
    if (response.exceptionDetails) {
      const { exception, text } = response.exceptionDetails;
      throw new Error(`In-page code failed: ${(exception?.description ?? text).split("\n")[0]}`);
    }
    return { value: response.result.value as T, world: "isolated" };
  };

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`In-page code did not finish within ${options.timeoutMs} ms`)), options.timeoutMs);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
    detach(session);
  }
}

/** Not awaited: a page stuck in a script can keep the detach from answering. */
function detach(session: CDPSession | undefined): void {
  session?.detach().catch(() => {});
}
