import { describe, expect, it } from "vitest";
import { classifyLicense } from "./license";

describe("classifyLicense", () => {
  it("recognizes open licences in any name record", () => {
    const open = [
      { licenseDescription: "This Font Software is licensed under the SIL Open Font License, Version 1.1" },
      { licenseDescription: "Licensed under the Apache License, Version 2.0" },
      { copyright: "Copyright 2016 The Inter Project Authors", licenseUrl: "https://openfontlicense.org" },
      { licenseUrl: "http://scripts.sil.org/OFL" },
      { licenseDescription: "Ubuntu Font Licence 1.0" },
      { copyright: "Released under the OFL" },
    ];
    for (const meta of open) expect(classifyLicense(meta, "self-hosted").kind).toBe("open");
  });

  it("calls any other copyright or licence text commercial", () => {
    expect(classifyLicense({ copyright: "Copyright 2019 Klim Type Foundry", licenseUrl: "https://klim.co.nz/licences/" }, "self-hosted")).toEqual({
      kind: "commercial",
      text: "Copyright 2019 Klim Type Foundry",
      url: "https://klim.co.nz/licences/",
    });
  });

  it("gives unknown without any text", () => {
    expect(classifyLicense({}, "self-hosted")).toEqual({ kind: "unknown" });
    expect(classifyLicense({ copyright: "  " }, "third-party")).toEqual({ kind: "unknown" });
    expect(classifyLicense(null, "data-uri")).toEqual({ kind: "unknown" });
  });

  it("uses the source for Google Fonts and Adobe Fonts", () => {
    expect(classifyLicense(null, "google-fonts").kind).toBe("open");
    expect(classifyLicense({ copyright: "Copyright Some Foundry" }, "google-fonts").kind).toBe("open");
    expect(classifyLicense(null, "adobe-fonts").kind).toBe("commercial");
    expect(classifyLicense({ licenseUrl: "http://scripts.sil.org/OFL" }, "adobe-fonts").kind).toBe("commercial");
  });

  it("prefers the licence description as text, strips control characters and only keeps http(s) URLs", () => {
    const meta = { copyright: "Foundry", licenseDescription: "Licensed \u0000for web use\u009f only", licenseUrl: "javascript:alert(1)" };
    expect(classifyLicense(meta, "self-hosted")).toEqual({ kind: "commercial", text: "Licensed for web use only" });
  });
});
