import { createCn } from "cn/engine";
import tables from "./cn-tables";

/**
 * Class merging aware of the app's type scale. Without it, `text-body` or `text-mono` look like colors to the merger
 * and silently drop `text-ink-fg` or `text-text-3` from the same element. The scale is in cn-config.mjs, compiled into
 * cn-tables.ts ahead of time (`pnpm build:cn`), so the page ships the merge engine and its tables and never compiles
 * a config in the browser.
 */
export const cn = createCn(tables);
