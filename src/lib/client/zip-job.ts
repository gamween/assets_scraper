/**
 * The ZIP the page is building, one at a time. A job belongs to the results it was built from: leaving them (a new
 * scan, Home, Cancel, Back to the landing) drops it the way it aborts the scan stream, so a job never writes its
 * progress or its failures into the state of the next scan. The code that runs the job (zip-actions) writes to the
 * store only while `isCurrentZipJob` holds, and reads the abort reason to tell the two ways a job ends early apart.
 */
export type ZipAbortReason = "cancelled" | "left";

let job: AbortController | null = null;

/** Starts a job, cancelling one still running. */
export function beginZipJob(): AbortController {
  job?.abort("cancelled" satisfies ZipAbortReason);
  job = new AbortController();
  return job;
}

/** True while `controller` is the job the page runs: only that one may write to the store. */
export const isCurrentZipJob = (controller: AbortController): boolean => job === controller;

/** Marks `controller` as settled. Returns whether it was still the current job, which then clears its own progress. */
export function settleZipJob(controller: AbortController): boolean {
  if (job !== controller) return false;
  job = null;
  return true;
}

/** `Cancel` next to the progress: the job stays current until it settles, so it clears its own progress. */
export function cancelZipJob(): void {
  job?.abort("cancelled" satisfies ZipAbortReason);
}

/**
 * The results the job was built from are gone. It is aborted and forgotten at once: the store was reset with its
 * progress in it, and nothing the job does after this may reach the state of the next scan.
 */
export function dropZipJob(): void {
  const dropped = job;
  job = null;
  dropped?.abort("left" satisfies ZipAbortReason);
}
