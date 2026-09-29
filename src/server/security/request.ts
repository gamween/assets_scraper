import { createHash, timingSafeEqual } from "node:crypto";
import { ipAddress } from "@vercel/functions";
import { declaredType } from "./sniff";

/**
 * What the gates read off a request, in one place for the browser endpoint and the agent API so the two cannot read a
 * body, a header or a secret differently. It imports nothing from the gates themselves: `gate.ts` and `agent-auth.ts`
 * both depend on it, and neither has to depend on the other for it.
 */

/** Bytes of a request body a gate reads: a scan request is one short URL. */
export const MAX_BODY_BYTES = 16 * 1024;

/** Constant-time comparison over digests, so neither the length nor the first differing byte shows in the timing. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** The media type a request declares, lower cased and without its parameters. */
export const requestMediaType = (request: Request): string => declaredType(request.headers.get("content-type"));

/**
 * The body of `request`, read up to `maxBytes`: empty when there is none, null when it is larger or cannot be read. The
 * size is enforced while reading, so a body that lies in `content-length` is still capped.
 */
export async function readCappedBody(request: Request, maxBytes: number = MAX_BODY_BYTES): Promise<Buffer | null> {
  if (Number(request.headers.get("content-length")) > maxBytes) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

/**
 * The caller's address, the key of its per-client daily quotas, or null. Only on Vercel is `x-real-ip` the platform's
 * word: its edge sets the header itself, over anything the client sent. On any other host the header is whatever the
 * client chose, and a fresh value per request would be a fresh quota (or somebody else's), so there the per-client
 * quotas are off and the shared daily budgets bound everything, as they do for a request with no address at all.
 */
export function clientAddress(request: Request): string | null {
  return process.env.VERCEL ? (ipAddress(request) ?? null) : null;
}
