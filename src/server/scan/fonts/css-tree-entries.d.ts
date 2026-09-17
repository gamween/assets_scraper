// css-tree has no types of its own and @types/css-tree only describes the package root. These entry points export the
// same functions as the root, built from the parser, walker and generator configurations alone.
declare module "css-tree/parser" {
  import type { parse } from "css-tree";
  const parser: typeof parse;
  export default parser;
}

declare module "css-tree/walker" {
  import type { walk } from "css-tree";
  const walker: typeof walk;
  export default walker;
}

declare module "css-tree/generator" {
  import type { generate } from "css-tree";
  const generator: typeof generate;
  export default generator;
}
