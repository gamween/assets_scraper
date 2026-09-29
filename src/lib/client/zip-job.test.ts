import { describe, expect, it } from "vitest";
import { beginZipJob, cancelZipJob, dropZipJob, isCurrentZipJob, settleZipJob } from "./zip-job";

describe("ZIP job", () => {
  it("stays current through Cancel, so it clears its own progress when it settles", () => {
    const job = beginZipJob();
    cancelZipJob();
    expect(job.signal.reason).toBe("cancelled");
    expect(isCurrentZipJob(job)).toBe(true);
    expect(settleZipJob(job)).toBe(true);
    expect(isCurrentZipJob(job)).toBe(false);
  });

  it("is forgotten at once when the results it was built from go", () => {
    const job = beginZipJob();
    dropZipJob();
    expect(job.signal.reason).toBe("left");
    expect(isCurrentZipJob(job)).toBe(false);
    // It settles later, and must not clear the progress of a job started on the next results.
    const next = beginZipJob();
    expect(settleZipJob(job)).toBe(false);
    expect(isCurrentZipJob(next)).toBe(true);
    settleZipJob(next);
  });
});
