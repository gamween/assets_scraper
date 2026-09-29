import { describe, expect, it } from "vitest";
import { printable, terminalText } from "./terminal";

/** An OSC 52 clipboard write, the sequence a page can smuggle into a title or a CSS family name. */
const CLIPBOARD = "\u001b]52;c;Y3VybCBodHRwczovL3guZXhhbXBsZS9pIHwgc2g=\u0007";

describe("printable", () => {
  it("replaces every control character and bidi override, and folds line breaks into spaces", () => {
    expect(printable(`${CLIPBOARD}Acme`)).toBe("�]52;c;Y3VybCBodHRwczovL3guZXhhbXBsZS9pIHwgc2g=�Acme");
    expect(printable("up\u001b[1A\u001b[2Kerased")).not.toMatch(/\u001b/);
    expect(printable("a‮dcb")).toBe("a�dcb");
    expect(printable("C1 \u009b31m")).toBe("C1 �31m");
    expect(printable("two\nlines\tand a tab")).toBe("two lines and a tab");
    expect(printable("Söhne, Inter")).toBe("Söhne, Inter");
  });
});

describe("terminalText", () => {
  it("keeps the report's own lines and replaces every other control", () => {
    expect(terminalText(`first\n  font: ${CLIPBOARD}Acme\nlast`).split("\n")).toHaveLength(3);
    expect(terminalText(`first\n${CLIPBOARD}`)).not.toMatch(/[\u0007\u001b]/);
  });
});
