import { createCn } from "cn/config";

/**
 * Class merging aware of the app's type scale. Without the extension, `text-body` or `text-mono` look like colors
 * to the merger and silently drop `text-ink-fg` or `text-text-3` from the same element.
 */
export const cn = createCn({
  extend: { classGroups: { "font-size": [{ text: ["display", "title", "body", "small", "mono", "mono-xs", "input-lg"] }] } },
});
