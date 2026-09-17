// css-tree has no types of its own and @types/css-tree only describes the package root. These entry points export the
// same functions as the root without building the lexer, which loads mdn-data JSON through createRequire, something
// bundlers and serverless file tracing do not follow reliably.
declare module "css-tree/tokenizer" {
  export { tokenize, tokenTypes } from "css-tree";
}

declare module "css-tree/utils" {
  export { ident, string, url } from "css-tree";
}

// Used by css.test.ts only, to show the parser's shared buffers no longer slow the fonts code down.
declare module "css-tree/parser" {
  import type { parse } from "css-tree";
  const parser: typeof parse;
  export default parser;
}
