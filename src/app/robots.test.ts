import { describe, expect, it } from "vitest";
import robots from "./robots";

describe("robots.txt", () => {
  it("keeps crawlers out of everything but the two documents written for agents", () => {
    expect(robots().rules).toEqual([{ userAgent: "*", allow: ["/llms.txt", "/api/openapi.json"], disallow: "/" }]);
  });
});
