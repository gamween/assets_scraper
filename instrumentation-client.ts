import { initBotId } from "botid/client/core";
import * as z from "zod";

/**
 * Zod probes for `Function("")` before it compiles a schema. The production CSP is `script-src 'self' 'unsafe-inline'`
 * with no `'unsafe-eval'`, so the probe was blocked and every page load reported a CSP violation before any
 * interaction. Asking for the jitless path here, which runs before the app's own code, means the probe never runs.
 * Validation is unchanged, only slower to compile, and the client validates one NDJSON stream per scan.
 */
z.config({ jitless: true });

initBotId({ protect: [{ path: "/api/scan", method: "POST" }] });
