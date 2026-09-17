import { describe, expect, it } from "vitest";
import { pageWorkMs, postProcessingWindow } from "./engine";

const S = 1000;
const window = (now: number) => postProcessingWindow({ startedAt: 0, now: now * S, deadlineMs: 90 * S, verifyMs: 8 * S });

describe("pageWorkMs", () => {
  it("stops page work 5 s before the scan deadline", () => {
    expect(pageWorkMs(90 * S)).toBe(85 * S);
    expect(pageWorkMs(3 * S)).toBe(0);
  });
});

describe("postProcessingWindow", () => {
  it("gives network work its budget, then 5 s of CPU work", () => {
    expect(window(30)).toEqual({ networkDeadline: 38 * S, endsAt: 43 * S });
  });

  it("cuts network work so that post-processing ends by the scan deadline", () => {
    expect(window(84)).toEqual({ networkDeadline: 85 * S, endsAt: 90 * S });
    expect(window(85)).toEqual({ networkDeadline: 85 * S, endsAt: 90 * S });
  });

  it("gives no network time to a scan whose page work reached its deadline, and never runs past the scan deadline", () => {
    expect(window(87)).toEqual({ networkDeadline: 87 * S, endsAt: 90 * S });
    expect(window(90)).toEqual({ networkDeadline: 90 * S, endsAt: 90 * S });
    expect(window(91).endsAt).toBe(90 * S);
  });
});
