#!/usr/bin/env node
// Collect all evidence for one page in a single parallel run.
//
//   node audit.mjs <url> <out-dir> [--no-lighthouse] [--no-linkcheck] [--no-full]
//
// Runs at the same time: collect.py (raw HTML, links, sitemap), Lighthouse
// (mobile), and one Chrome session that inspects desktop 1440 px and
// mobile 390 px, dumps the page section by section and takes the baseline
// screenshots. Then writes:
//   data/collect.json  data/rendered.json  data/sections.json  data/lighthouse.json
//   data/checks.json   (pass / warn / fail for ~60 checks)
//   data/summary.md    (read this first: everything condensed)
//   shots/desktop-top.png  shots/mobile-top.png  shots/desktop-full.jpg
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, statSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { HERE, CACHE, CHROME, depPath, launch, open, warm, inspect, sections, sleep } from "./lib.mjs";
import { buildChecks, summaryMarkdown } from "./checks.mjs";

const [, , url, outArg, ...rest] = process.argv;
if (!url || !outArg || url === "--help") {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 16).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(1);
}
const flag = f => rest.includes("--" + f);
const out = resolve(outArg), data = join(out, "data"), shots = join(out, "shots");
mkdirSync(data, { recursive: true }); mkdirSync(shots, { recursive: true });
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(0) + "s";

function run(cmd, args, { env, timeout = 180000 } = {}) {
  return new Promise(res => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env } });
    let so = "", se = "";
    p.stdout.on("data", d => so += d); p.stderr.on("data", d => se += d);
    const timer = setTimeout(() => { p.kill("SIGKILL"); se += "\ntimed out"; }, timeout);
    p.on("error", e => { clearTimeout(timer); res({ code: -1, so, se: String(e) }); });
    p.on("close", code => { clearTimeout(timer); res({ code, so, se }); });
  });
}

async function pythonCmd() {
  for (const c of ["python3", "python"]) if ((await run(c, ["--version"])).code === 0) return c;
  return null;
}

// 1. raw HTML collector
const collectJob = (async () => {
  const py = await pythonCmd();
  if (!py) return { ok: false, msg: "Python 3 not found" };
  const args = ["-I", join(HERE, "collect.py"), url, join(data, "collect.json")];
  if (flag("no-linkcheck")) args.push("--no-linkcheck");
  const r = await run(py, args);
  console.log(`[${secs()}] collect: ${(r.so || r.se).trim().split("\n").pop()}`);
  return { ok: r.code === 0, msg: r.se.trim() };
})();

// 2. Lighthouse (own Chrome instance)
const lhPath = join(data, "lighthouse.json");
if (existsSync(lhPath)) unlinkSync(lhPath);
const lhValid = () => { try { const j = JSON.parse(readFileSync(lhPath, "utf8")); return !j.runtimeError && j.categories?.performance?.score != null; } catch { return false; } };
// Two Lighthouse runs at once starve each other ("unable to reliably load the page"),
// so audits started in parallel take turns through a lock directory.
const LOCK = join(CACHE, "lighthouse.lock");
async function withLighthouseLock(fn) {
  mkdirSync(CACHE, { recursive: true });
  for (let i = 0; ; i++) {
    try { mkdirSync(LOCK); break; } catch {
      try { if (Date.now() - statSync(LOCK).mtimeMs > 240000) rmSync(LOCK, { recursive: true, force: true }); } catch {}
      if (i === 0) console.log(`[${secs()}] lighthouse: waiting for another audit's Lighthouse run`);
      if (i > 400) break; // ~6.5 min: give up waiting and run anyway
      await sleep(1000);
    }
  }
  try { return await fn(); } finally { rmSync(LOCK, { recursive: true, force: true }); }
}
async function runLighthouse() { return withLighthouseLock(runLighthouseNow); }
async function runLighthouseNow() {
  const cli = depPath("lighthouse/cli/index.js");
  if (!cli) return { ok: false, msg: "Lighthouse not installed (run setup.mjs)" };
  const r = await run(process.execPath, [cli, url, "--form-factor=mobile", "--screenEmulation.mobile",
    "--only-categories=performance,accessibility,best-practices,seo", "--output=json",
    `--output-path=${join(data, "lighthouse.json")}`, "--chrome-flags=--headless=new --no-sandbox" + (/^https?:\/\/(localhost|127\.0\.0\.1|[^/]+\.(test|localhost|local))(:|\/|$)/.test(url) ? " --ignore-certificate-errors" : ""), "--quiet", "--max-wait-for-load=45000"],
    { env: { CHROME_PATH: CHROME }, timeout: 200000 });
  const ok = r.code === 0 && lhValid();
  let msg = r.se.trim().split("\n").slice(-2).join(" ");
  if (!ok && existsSync(lhPath)) { try { msg = JSON.parse(readFileSync(lhPath, "utf8")).runtimeError?.message || msg; } catch {} unlinkSync(lhPath); }
  console.log(`[${secs()}] lighthouse: ${ok ? "done" : "failed: " + msg.slice(0, 160)}`);
  return { ok, msg: ok ? "" : msg };
}
const lhJob = flag("no-lighthouse") ? Promise.resolve({ ok: false, msg: "skipped (--no-lighthouse)" }) : runLighthouse();

// 3. Rendered page: desktop and mobile in parallel, one browser
const browserJob = (async () => {
  const browser = await launch();
  try {
    const desktop = (async () => {
      const o = await open(browser, url, 1440);
      await o.page.screenshot({ path: join(shots, "desktop-top.png") });
      const first = await inspect(o.page);
      await warm(o.page);
      const secs_ = await sections(o.page);
      const after = await inspect(o.page);
      if (!flag("no-full")) await o.page.screenshot({ path: join(shots, "desktop-full.jpg"), fullPage: true, type: "jpeg", quality: 55 }).catch(() => {});
      await o.page.close();
      return { ...first, broken_images: after.broken_images, missing_anchor_targets: after.missing_anchor_targets,
        console_errors: [...new Set(o.errors)].slice(0, 15), failed_requests: o.failed.slice(0, 20), media_requests: o.media, sections: secs_ };
    })();
    const mobile = (async () => {
      const o = await open(browser, url, 390);
      const first = await inspect(o.page);
      await sleep(5000); // chat greetings and pop-ups usually appear after a few seconds
      const later = await inspect(o.page);
      await o.page.screenshot({ path: join(shots, "mobile-top.png") });
      await o.page.close();
      return { ...first, after_wait: { h1_covered_by: later.h1_covered_by, large_overlays: later.large_overlays, chat_widgets: later.chat_widgets },
        console_errors: [...new Set(o.errors)].slice(0, 15), failed_requests: o.failed.slice(0, 20), media_requests: o.media };
    })();
    const [d, m] = await Promise.all([desktop, mobile]);
    const { sections: s, ...dRest } = d;
    writeFileSync(join(data, "sections.json"), JSON.stringify(s, null, 1));
    writeFileSync(join(data, "rendered.json"), JSON.stringify({ url, checked_at_utc: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC", desktop: dRest, mobile: m }, null, 1));
    console.log(`[${secs()}] browser: visible H1 desktop ${d.visible_h1_count}, mobile ${m.visible_h1_count}; ${s.length} sections`);
    return { ok: true };
  } catch (e) {
    console.log(`[${secs()}] browser: failed ${e.message}`);
    return { ok: false, msg: e.message };
  } finally { await browser.close(); }
})();

let [c, l, b] = await Promise.all([collectJob, lhJob, browserJob]);
// Lighthouse is sensitive to CPU load; retry once on its own if the parallel run failed.
if (!l.ok && !flag("no-lighthouse") && !/not installed/.test(l.msg)) { console.log(`[${secs()}] lighthouse: retrying alone`); l = await runLighthouse(); }
if (!c.ok) { console.error("collect.py failed: " + c.msg); process.exit(1); }

const read = f => existsSync(join(data, f)) ? JSON.parse(readFileSync(join(data, f), "utf8")) : null;
const collect = read("collect.json"), rendered = read("rendered.json"), lh = read("lighthouse.json"), secList = read("sections.json") || [];
const checks = buildChecks(collect, rendered, lh);
const status = { lighthouse: l.ok ? "ok" : l.msg, browser: b.ok ? "ok" : b.msg };
writeFileSync(join(data, "checks.json"), JSON.stringify({ url, status, checks }, null, 1));
writeFileSync(join(data, "summary.md"), summaryMarkdown({ url, collect, rendered, lh, sections: secList, checks, status }));
const n = s => checks.filter(x => x.status === s).length;
console.log(`[${secs()}] done: ${n("fail")} fail, ${n("warn")} warn, ${n("pass")} pass -> ${join(data, "summary.md")}`);

process.exit(process.exitCode || 0);
