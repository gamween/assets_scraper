/**
 * `localStorage` access that never throws: storage can be missing (server render, tests), blocked (Safari private
 * mode, disabled cookies) or full. Every caller gets `null` or a no-op instead.
 */
export type StringStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function browserStorage(): StringStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readString(key: string, storage: StringStorage | null = browserStorage()): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string | null, storage: StringStorage | null = browserStorage()): void {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch {
    // Storage is a convenience: losing a preference is fine.
  }
}

export function readJson<T>(key: string, parse: (value: unknown) => T, fallback: T, storage: StringStorage | null = browserStorage()): T {
  const raw = readString(key, storage);
  if (raw === null) return fallback;
  try {
    return parse(JSON.parse(raw));
  } catch {
    return fallback;
  }
}
