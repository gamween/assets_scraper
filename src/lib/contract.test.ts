import { describe, expect, it } from "vitest";
import { ApiError, Asset, ScanEvent, ScanRequest } from "./contract";

const asset = {
  id: "a1", kind: "svg", role: "site-logo", name: "Fixture logo", filename: "fixture-logo.svg", format: "svg",
  foundIn: ["inline-svg"], visible: true, declaredOnly: false, order: 0, score: 1140, usedCount: 1,
  tone: "dark", display: null, original: null, inline: { mime: "image/svg+xml", text: "<svg/>" },
};

describe("contract", () => {
  it("accepts a valid asset", () => {
    expect(Asset.parse(asset).name).toBe("Fixture logo");
  });

  it("rejects an unknown role", () => {
    expect(() => Asset.parse({ ...asset, role: "banner" })).toThrow();
  });

  it("discriminates scan events by type", () => {
    const event = ScanEvent.parse({ type: "step", step: "load", state: "start" });
    expect(event.type).toBe("step");
    expect(() => ScanEvent.parse({ type: "step", step: "nope", state: "start" })).toThrow();
  });

  it("validates requests and API errors", () => {
    expect(ScanRequest.parse({ url: "linear.app" }).url).toBe("linear.app");
    expect(() => ScanRequest.parse({ url: "" })).toThrow();
    expect(ApiError.parse({ error: { code: "budget", message: "x" } }).error.code).toBe("budget");
  });
});
