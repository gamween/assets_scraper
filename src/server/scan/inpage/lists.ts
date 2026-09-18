import type { RawCollectorOutput } from "../types";

/**
 * The output lists the collector fills and the engine checks and fits. One copy for both sides: they used to be two
 * hand-typed lists, and a typo in either would have made every scan fall back to a network-only partial result with
 * nothing but a Chrome integration run to notice.
 */
export const OUTPUT_LISTS = [
  "candidates",
  "svgs",
  "fontFaces",
  "fontStatuses",
  "fontUsage",
  "unreadableSheets",
  "blobs",
  "brandLinks",
] as const satisfies readonly (keyof RawCollectorOutput)[];

/** Every list on `RawCollectorOutput` is named above: a list added there and forgotten here is a compile error. */
type ListKey = { [K in keyof RawCollectorOutput]-?: RawCollectorOutput[K] extends readonly unknown[] ? K : never }[keyof RawCollectorOutput];
type NoneMissing = Exclude<ListKey, (typeof OUTPUT_LISTS)[number]> extends never ? true : never;
const complete: NoneMissing = true;
void complete;
