import type { CDPSession, Page } from "playwright-core";

type Protocol = {
  exceptionDetails?: { text: string; exception?: { description?: string } };
  result: { value?: unknown };
};

export class InPageTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`In-page code did not finish within ${timeoutMs} ms`);
    this.name = "InPageTimeoutError";
  }
}

export class InPageResultTooLargeError extends Error {
  constructor(maxChars: number) {
    super(`In-page code returned more than ${maxChars} characters of JSON`);
    this.name = "InPageResultTooLargeError";
  }
}

/** The page closed, its renderer crashed or the browser died: a pending CDP call is never answered in those cases. */
export class PageGoneError extends Error {
  constructor(what: "closed" | "crashed" | "disconnected") {
    super(`The page ${what === "disconnected" ? "lost its browser" : what} while in-page code ran`);
    this.name = "PageGoneError";
  }
}

export interface RunInPageOptions {
  timeoutMs: number;
  /** Rejects with the abort reason as soon as it aborts. */
  signal?: AbortSignal;
  /** Largest result, in characters of JSON. Callers that expect large results pass their own cap. */
  maxResultChars?: number;
  /** Tests inject a broken session to exercise the main-world fallback. */
  createSession?: (page: Page) => Promise<CDPSession>;
}

/**
 * The most characters of JSON one character of a string can take: `JSON.stringify` writes a control character or a
 * lone surrogate as `\uXXXX`. Callers size `maxResultChars` for string content with it.
 */
export const JSON_ESCAPE_FACTOR = 6;

const WORLD_NAME = "assets-scraper";
const DEFAULT_MAX_RESULT_CHARS = 1_000_000;

/**
 * The value of `expression` as JSON text, measured in the page: over `maxChars` only its length crosses to Node. A
 * main-world page that patches `JSON` can change the value, but `typeof` and the length of a string are not patchable,
 * so it cannot send more than the cap.
 */
const asCappedJson = (expression: string, maxChars: number) =>
  `(async () => { const json = JSON.stringify(await (${expression}));\n` +
  `return typeof json !== "string" ? null : json.length <= ${maxChars} ? json : json.length; })()`;

function decodeResult<T>(raw: unknown, maxChars: number): T {
  if (raw === null || raw === undefined) return undefined as T;
  if (typeof raw === "number" || (typeof raw === "string" && raw.length > maxChars)) throw new InPageResultTooLargeError(maxChars);
  if (typeof raw !== "string") throw new Error("In-page code returned an unexpected value");
  return JSON.parse(raw) as T;
}

/**
 * Evaluates `${source};${expression}` in a fresh CDP isolated world of the main frame (spec 7.5): same DOM, but its
 * own globals, so pages that patch built-ins cannot break the bundled code, and page scripts cannot see it. When the
 * isolated world cannot be created, runs in the main world and reports `world: "main"`. An exception thrown by the
 * code itself rejects without a retry. Rejects with `InPageTimeoutError` after `timeoutMs` in every case, and nothing
 * runs in the page after that; with `PageGoneError` as soon as the page closes or crashes or the browser dies. The
 * result crosses to Node as JSON of at most `maxResultChars` characters, otherwise it rejects with
 * `InPageResultTooLargeError`; a value JSON cannot represent (`undefined`) gives undefined.
 */
export async function runInPage<T>(page: Page, source: string, expression: string, options: RunInPageOptions): Promise<{ value: T; world: "isolated" | "main" }> {
  const maxChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const script = `${source};\n${asCappedJson(expression, maxChars)}`;
  const createSession = options.createSession ?? ((target: Page) => target.context().newCDPSession(target));
  let session: CDPSession | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async (): Promise<{ value: T; world: "isolated" | "main" }> => {
    let contextId: number;
    try {
      session = await createSession(page);
      // Created after runInPage gave up: detach it, and run nothing.
      if (finished) {
        detach(session);
        throw new Error("runInPage already finished");
      }
      const { frameTree } = await session.send("Page.getFrameTree");
      ({ executionContextId: contextId } = await session.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: WORLD_NAME, grantUniveralAccess: false }));
    } catch (error) {
      if (finished) throw error;
      detach(session);
      session = undefined;
      return { value: decodeResult<T>(await page.evaluate(script), maxChars), world: "main" };
    }
    const response = (await session.send("Runtime.evaluate", { expression: script, contextId, awaitPromise: true, returnByValue: true })) as Protocol;
    if (response.exceptionDetails) {
      const { exception, text } = response.exceptionDetails;
      throw new Error(`In-page code failed: ${(exception?.description ?? text).split("\n")[0]}`);
    }
    return { value: decodeResult<T>(response.result.value, maxChars), world: "isolated" };
  };

  const { signal } = options;
  const browser = page.context().browser();
  const listeners: (() => void)[] = [];
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new InPageTimeoutError(options.timeoutMs)), options.timeoutMs);
    const onAbort = () => reject(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const onClose = () => reject(new PageGoneError("closed"));
    const onCrash = () => reject(new PageGoneError("crashed"));
    const onDisconnect = () => reject(new PageGoneError("disconnected"));
    page.once("close", onClose).once("crash", onCrash);
    browser?.once("disconnected", onDisconnect);
    listeners.push(() => {
      signal?.removeEventListener("abort", onAbort);
      page.off("close", onClose).off("crash", onCrash);
      browser?.off("disconnected", onDisconnect);
    });
  });
  try {
    signal?.throwIfAborted();
    if (page.isClosed() || (browser && !browser.isConnected())) throw new PageGoneError(page.isClosed() ? "closed" : "disconnected");
    return await Promise.race([run(), stop]);
  } finally {
    finished = true;
    clearTimeout(timer);
    for (const remove of listeners) remove();
    detach(session);
  }
}

/** Not awaited: a page stuck in a script can keep the detach from answering. */
function detach(session: CDPSession | undefined): void {
  session?.detach().catch(() => {});
}
