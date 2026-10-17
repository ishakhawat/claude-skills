#!/usr/bin/env node
// One-time setup: installs puppeteer-core and Lighthouse into ~/.cache/claude-seo-audit
// (outside the plugin folder, so plugin updates keep them). Uses your installed Chrome;
// no browser is downloaded.
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE, CHROME, HERE } from "./lib.mjs";

const [major] = process.versions.node.split(".").map(Number);
if (major < 18) { console.error(`Node.js 18+ is required (found ${process.version}).`); process.exit(1); }
mkdirSync(CACHE, { recursive: true });
const want = readFileSync(join(HERE, "package.json"), "utf8");
const have = existsSync(join(CACHE, "package.json")) ? readFileSync(join(CACHE, "package.json"), "utf8") : "";
const ready = want === have && existsSync(join(CACHE, "node_modules/lighthouse")) && existsSync(join(CACHE, "node_modules/puppeteer-core"));
if (!ready) {
  copyFileSync(join(HERE, "package.json"), join(CACHE, "package.json"));
  console.log(`Installing puppeteer-core and lighthouse into ${CACHE} ...`);
  execSync("npm install --no-audit --no-fund --loglevel=error", { cwd: CACHE, stdio: "inherit", env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "1" } });
}
let py = "";
for (const c of ["python3", "python"]) { try { py = execSync(`${c} --version`).toString().trim(); break; } catch {} }
console.log(`Chrome: ${CHROME || "NOT FOUND (install Google Chrome or set CHROME_PATH)"}`);
console.log(`Python: ${py || "NOT FOUND (install Python 3)"}`);
console.log(CHROME && py ? "setup ok" : "setup incomplete");
process.exit(CHROME && py ? 0 : 1);
