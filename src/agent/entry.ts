import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether the module at `moduleUrl` is the file node was asked to run, so importing a bundle's module from a test runs
 * nothing. Both sides are resolved to their real paths: `node /tmp/x/dist/mcp.mjs` names the file through a symbolic
 * link on macOS (`/tmp` is `/private/tmp`), and the URL of the module is its real path, so comparing the two spellings
 * made the MCP server exit 0 without serving anything. `import.meta` is per module, so each entry point passes its own.
 */
export function isEntry(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
