// One generated file written whole or not at all, for the build scripts.
import { rename, rm, writeFile } from "node:fs/promises";

/**
 * Writes `content` to `file` through a temporary name in the same directory, renamed into place.
 *
 * Two builds can run at the same time: two MCP launchers starting together (two Claude Code sessions) both rebuild,
 * and a reader that opens a generated module while the plain `writeFile` of the other is still filling it reads half a
 * module. A rename is atomic on the same filesystem, so a reader sees one version or the other and never part of both.
 * `scripts/build-agent.mjs` writes `dist` the same way, with esbuild building under the temporary name.
 *
 * The temporary name carries the pid, so two writers never fight over one, and it is removed when the write fails: a
 * failed build leaves the last good file in place rather than a half-written one beside it.
 */
export async function writeAtomic(file, content) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
