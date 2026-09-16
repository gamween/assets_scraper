import { describe, expect, it } from "vitest";
import { addRecent, readRecent, removeRecent } from "./recent";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

const throwing = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
  removeItem() {
    throw new Error("SecurityError");
  },
} as unknown as Storage;

describe("recent scans", () => {
  it("keeps the last 5 unique hosts, most recent first", () => {
    const storage = memoryStorage();
    for (const host of ["a.com", "b.com", "c.com", "a.com", "d.com", "e.com", "f.com"]) addRecent(host, storage);
    expect(readRecent(storage)).toEqual(["f.com", "e.com", "d.com", "a.com", "c.com"]);
  });

  it("removes a host", () => {
    const storage = memoryStorage();
    addRecent("a.com", storage);
    addRecent("b.com", storage);
    expect(removeRecent("a.com", storage)).toEqual(["b.com"]);
    expect(readRecent(storage)).toEqual(["b.com"]);
  });

  it("ignores corrupt stored values", () => {
    const storage = memoryStorage();
    storage.setItem("assets-scraper:recent", "{not json");
    expect(readRecent(storage)).toEqual([]);
    storage.setItem("assets-scraper:recent", JSON.stringify([1, "ok.com", null]));
    expect(readRecent(storage)).toEqual(["ok.com"]);
  });

  it("survives localStorage throwing or missing", () => {
    expect(readRecent(throwing)).toEqual([]);
    expect(addRecent("a.com", throwing)).toEqual(["a.com"]);
    expect(removeRecent("a.com", throwing)).toEqual([]);
    expect(readRecent(null)).toEqual([]);
  });
});
