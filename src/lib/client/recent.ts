import { browserStorage, readJson, writeString, type StringStorage } from "./storage";

const KEY = "assets-scraper:recent";
export const RECENT_LIMIT = 5;

const parseHosts = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((host): host is string => typeof host === "string" && host.length > 0).slice(0, RECENT_LIMIT) : [];

export function readRecent(storage: StringStorage | null = browserStorage()): string[] {
  return readJson(KEY, parseHosts, [], storage);
}

/** Moves `host` to the front and keeps the last 5 unique hosts. Returns the new list even when storage fails. */
export function addRecent(host: string, storage: StringStorage | null = browserStorage()): string[] {
  const next = [host, ...readRecent(storage).filter((item) => item !== host)].slice(0, RECENT_LIMIT);
  writeString(KEY, JSON.stringify(next), storage);
  return next;
}

export function removeRecent(host: string, storage: StringStorage | null = browserStorage()): string[] {
  const next = readRecent(storage).filter((item) => item !== host);
  writeString(KEY, JSON.stringify(next), storage);
  return next;
}
