import { describe, expect, it } from "vitest";
import { postProcessingWindow } from "./engine";

const S = 1000;
const window = (now: number, partial = false) => postProcessingWindow({ startedAt: 0, now: now * S, partial, deadlineMs: 90 * S, verifyMs: 8 * S });

describe("postProcessingWindow", () => {
  it("gives network work its budget, then 5 s of CPU work", () => {
    expect(window(30)).toEqual({ networkDeadline: 38 * S, endsAt: 43 * S });
  });

  it("cuts network work so that post-processing ends by the scan deadline", () => {
    expect(window(84)).toEqual({ networkDeadline: 85 * S, endsAt: 90 * S });
    expect(window(85)).toEqual({ networkDeadline: 85 * S, endsAt: 90 * S });
  });

  it("gives no network time and 5 s of CPU time to a scan at or near the deadline", () => {
    expect(window(87)).toEqual({ networkDeadline: 87 * S, endsAt: 92 * S });
    expect(window(91, true)).toEqual({ networkDeadline: 91 * S, endsAt: 96 * S });
    expect(window(30, true)).toEqual({ networkDeadline: 30 * S, endsAt: 35 * S });
  });
});
