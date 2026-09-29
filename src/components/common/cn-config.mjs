/**
 * The app's type scale, for the class merger (see cn.ts). Tailwind reads the sizes from `--text-*` in globals.css, but
 * the merger only knows the stock scale: unknown to it, `text-body` reads as a color and drops `text-ink-fg` from the
 * same element. A size added to globals.css goes here too, then `pnpm build:cn` compiles the tables again.
 */
const config = {
  extend: { classGroups: { "font-size": [{ text: ["display", "title", "body", "small", "mono", "mono-xs", "input-lg"] }] } },
};

export default config;
