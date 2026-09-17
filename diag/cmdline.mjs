import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const binary = process.env.CHROME_EXECUTABLE_PATH;
console.log("binary", binary, "realpath", realpathSync(binary));
const scratch = mkdtempSync(path.join(tmpdir(), "diag-"));
const pidfile = path.join(scratch, "chromium-1-0.pid");
const wrapper = path.join(scratch, "wrapper.sh");
writeFileSync(wrapper, `#!/bin/sh\nulimit -c 0\necho $$ > "$ASSETS_SCRAPER_PIDFILE"\nunset ASSETS_SCRAPER_PIDFILE\nexec '${binary}' "$@"\n`);
chmodSync(wrapper, 0o755);
const start = performance.now();
const child = spawn(wrapper, ["--headless", "--no-sandbox", "--no-first-run", `--user-data-dir=${path.join(scratch, "profile")}`, `--assets-scraper-pidfile=${pidfile}`, "about:blank"], {
  detached: true, stdio: "ignore", env: { PATH: process.env.PATH, HOME: process.env.HOME, ASSETS_SCRAPER_PIDFILE: pidfile },
});
let last = "";
const timer = setInterval(() => {
  let cmd = "";
  let exe = "";
  try { cmd = readFileSync(`/proc/${child.pid}/cmdline`, "utf8").replaceAll("\0", " "); } catch (e) { cmd = String(e.code); }
  try { exe = spawnSync("readlink", [`/proc/${child.pid}/exe`]).stdout.toString().trim(); } catch {}
  const line = `${exe} | ${cmd.slice(0, 160)} | hasBinary=${cmd.includes(binary)} hasMarker=${cmd.includes(`--assets-scraper-pidfile=${pidfile}`)}`;
  if (line !== last) { console.log(`${(performance.now() - start).toFixed(1)}ms ${line}`); last = line; }
}, 2);
setTimeout(() => { clearInterval(timer); process.kill(-child.pid, "SIGKILL"); process.exit(0); }, 3000);
