/**
 * Limits of the hosted agent API that only its routes read, in the shape of `src/server/config/limits.ts`: read from the
 * environment on every access, and ignored unless they are whole numbers above 0. They live apart from `zip.ts` so a
 * route that only needs the number (the gate, `llms.txt`) does not load the ZIP builder, and with it client-zip, sharp
 * and the budget store.
 */

const MB = 1024 * 1024;

const envWhole = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

/** Bytes one ZIP request serves, whatever the daily budget still allows: it is also what one function holds in memory. */
export const zipMaxBytes = (): number => envWhole("AGENT_ZIP_MAX_BYTES", 64 * MB);

/**
 * Milliseconds from a ZIP request's arrival by which its archive is built. `vercel.json` gives the function 120 s and
 * the scan alone may take 90 of them, so the fetches and the duplicate passes share what is left: whatever they have
 * not finished by then stays out of an archive that still streams, with a note, instead of the platform ending the
 * function with no answer at all. The 20 s after it are for streaming the archive out.
 */
export const zipDeadlineMs = (): number => envWhole("AGENT_ZIP_DEADLINE_MS", 100_000);
