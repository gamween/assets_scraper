import { afterEach, describe, expect, it, vi } from "vitest";
import { inlinePreviewUrl } from "./preview-urls";
import { cancelScan, goHome } from "./scan-session";
import { appStore } from "./store";
import { makeAsset } from "./testing";
import { beginZipJob, isCurrentZipJob } from "./zip-job";

/**
 * The session runs against the app store and module state, without a window: history writes are skipped under node,
 * and no scan starts here (every call below either fails validation or leaves the results).
 */
describe("scan session", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    appStore.getState().reset("");
  });

  it.each([
    ["Home", goHome],
    ["Cancel", cancelScan],
  ])("%s ends what the results held: their preview URLs and the ZIP built from them", (_name, leave) => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const url = inlinePreviewUrl(makeAsset({ id: "logo", kind: "svg", inline: { mime: "image/svg+xml", text: "<svg/>" } }));
    expect(url).toMatch(/^blob:/);
    const job = beginZipJob();

    leave();

    // Only a new scan used to revoke them, so the Blobs stayed in memory for as long as the landing did.
    expect(revoke).toHaveBeenCalledWith(url);
    // A job left running used to write its progress and its failures into the next scan's state.
    expect(job.signal.aborted).toBe(true);
    expect(job.signal.reason).toBe("left");
    expect(isCurrentZipJob(job)).toBe(false);
  });
});
