/** Node-side palette extras: colors of the site icon and of the web manifest. */
import { rgbToHex } from "./color";

/** 3, 4, 6 or 8 digit hex, with or without `#`, to lowercase `#rrggbb` (alpha dropped); anything else to null. */
export const normHex = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const match = /^#?(?:([0-9a-f]{3})[0-9a-f]?|([0-9a-f]{6})(?:[0-9a-f]{2})?)$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1] ? match[1].split("").map((c) => c + c).join("") : match[2];
  return "#" + hex.toLowerCase();
};

/**
 * Colors declared in an SVG icon (fill, stroke and stop-color, as attributes or CSS), as [hex, weight] with weights
 * summing to 1000. Shapes without any color default to black.
 */
export function svgColors(svg: string): [string, number][] {
  const counts = new Map<string, number>();
  for (const match of svg.matchAll(/(?:fill|stroke|stop-color)\s*[:=]\s*["']?\s*(#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|white|black)/gi)) {
    const value = match[1].toLowerCase();
    let hex: string | null = null;
    if (value === "white") hex = "#ffffff";
    else if (value === "black") hex = "#000000";
    else if (value.startsWith("#")) hex = normHex(value);
    else {
      const channels = value.match(/[\d.]+/g);
      if (channels && channels.length >= 3) hex = rgbToHex([+channels[0], +channels[1], +channels[2]].map((v) => Math.min(255, v)) as [number, number, number]);
    }
    if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  if (!counts.size && /<(path|circle|rect|polygon)\b/i.test(svg)) counts.set("#000000", 1);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return [...counts.entries()].map(([hex, n]): [string, number] => [hex, (n / total) * 1000]);
}
