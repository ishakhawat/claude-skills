#!/usr/bin/env node
// Collect all evidence for one page in a single parallel run.
//
//   node audit.mjs <url> [out-dir] [--no-lighthouse] [--no-pagespeed] [--no-desktop] [--no-linkcheck] [--no-full]
//
// out-dir defaults to seo-audit-<host>-<slug>. A relative out-dir lands in the
// current folder, or in ~/SEO Audits when the current folder is a
// temp or scratch folder. The first line printed is the absolute out-dir.
//
// Runs at the same time: collect.py (raw HTML, links, sitemap), Lighthouse
// (mobile), and one Chrome session that inspects desktop 1440 px and
// mobile 390 px, dumps the page section by section and takes the baseline
// screenshots. Also in parallel: TTFB samples (ttfb.py) and Google PageSpeed
// Insights mobile + desktop (with real-user field data) when the site is public;
// PageSpeed needs a free API key (setup.mjs --pagespeed-key=KEY or
// PAGESPEED_API_KEY) unless Google's shared quota happens to be free. Without
// PageSpeed, desktop scores come from a local Lighthouse desktop run.
// Then writes:
//   data/collect.json  data/rendered.json  data/sections.json  data/lighthouse.json
//   data/checks.json   (pass / warn / fail for ~60 checks)
//   data/ttfb.json  data/pagespeed.json  data/road-to-100.json  data/lighthouse-desktop.json
//   data/summary.md    (read this first: everything condensed)
//   shots/desktop-top.png  shots/mobile-top.png  shots/desktop-full.jpg
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, statSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { HERE, CACHE, CHROME, depPath, launch, open, warm, inspect, sections, sleep, resolveOut, defaultOutName } from "./lib.mjs";
import { buildChecks, summaryMarkdown } from "./checks.mjs";
import { psiKey, fetchPSI, fieldData, roadTo100, scoresOf, readJSON, speedMarkdown } from "./pagespeed.mjs";

const [, , url, ...args] = process.argv;
if (!url || url === "--help") {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 20).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(1);
}
const outArg = args[0] && !args[0].startsWith("--") ? args[0] : defaultOutName(url);
const rest = args;
const flag = f => rest.includes("--" + f);
const out = resolveOut(outArg), data = join(out, "data"), shots = join(out, "shots");
mkdirSync(data, { recursive: true }); mkdirSync(shots, { recursive: true });
console.log("Output folder: " + out);
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

// Google PageSpeed Insights runs on Google's servers, so start it first; it takes 20–60 s.
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.(test|localhost|local))(:|\/|$)/.test(url);
const psiJob = (async () => {
  if (flag("no-pagespeed")) return { mobile: { ok: false, msg: "skipped (--no-pagespeed)" }, desktop: { ok: false, msg: "skipped (--no-pagespeed)" } };
  if (isLocal) return { mobile: { ok: false, msg: "local site: Google can't reach it" }, desktop: { ok: false, msg: "local site: Google can't reach it" } };
  const key = psiKey();
  const [mobile, desktop] = await Promise.all(["mobile", "desktop"].map(st => fetchPSI(url, st, key)));
  for (const [st, r] of [["mobile", mobile], ["desktop", desktop]]) if (r.ok) writeFileSync(join(data, `psi-${st}.json`), JSON.stringify(r.json));
  console.log(`[${secs()}] pagespeed: mobile ${mobile.ok ? "done" : "failed: " + mobile.msg}; desktop ${desktop.ok ? "done" : "failed: " + desktop.msg}`);
  return { mobile, desktop, keyed: !!key };
})();

// 0. TTFB first, on its own: Lighthouse and Chrome running alongside inflate it (TLS alone by ~1 s).
{
  const r = await run(await pythonCmd(), ["-I", join(HERE, "ttfb.py"), url, join(data, "ttfb.json")], { timeout: 120000 });
  console.log(`[${secs()}] ${(r.so || r.se).trim().split("\n").pop()}`);
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
for (const f of ["lighthouse.json", "lighthouse-desktop.json", "lighthouse-local.json", "psi-mobile.json", "psi-desktop.json"]) if (existsSync(join(data, f))) unlinkSync(join(data, f));
const lhValid = (p = lhPath) => { try { const j = JSON.parse(readFileSync(p, "utf8")); return !j.runtimeError && j.categories?.performance?.score != null; } catch { return false; } };
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
// Some firewalls reject Lighthouse's own user agent (e.g. Cloudflare 520/403); retries use a plain Chrome one.
const PLAIN_UA = { mobile: "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
  desktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36" };
async function runLighthouse(desktop = false, plainUA = false) { return withLighthouseLock(() => runLighthouseNow(desktop, plainUA)); }
async function runLighthouseNow(desktop, plainUA) {
  const outPath = join(data, desktop ? "lighthouse-desktop.json" : "lighthouse.json");
  const cli = depPath("lighthouse/cli/index.js");
  if (!cli) return { ok: false, msg: "Lighthouse not installed (run setup.mjs)" };
  const r = await run(process.execPath, [cli, url, ...(desktop ? ["--preset=desktop"] : ["--form-factor=mobile", "--screenEmulation.mobile"]),
    "--only-categories=performance,accessibility,best-practices,seo", "--output=json",
    `--output-path=${outPath}`, "--chrome-flags=--headless=new --no-sandbox" + (/^https?:\/\/(localhost|127\.0\.0\.1|[^/]+\.(test|localhost|local))(:|\/|$)/.test(url) ? " --ignore-certificate-errors" : ""), "--quiet", "--max-wait-for-load=45000",
    ...(plainUA ? [`--emulated-user-agent=${PLAIN_UA[desktop ? "desktop" : "mobile"]}`] : [])],
    { env: { CHROME_PATH: CHROME }, timeout: 200000 });
  const ok = r.code === 0 && lhValid(outPath);
  let msg = r.se.trim().split("\n").slice(-2).join(" ");
  if (!ok && existsSync(outPath)) { try { msg = JSON.parse(readFileSync(outPath, "utf8")).runtimeError?.message || msg; } catch {} unlinkSync(outPath); }
  console.log(`[${secs()}] lighthouse${desktop ? " desktop" : ""}: ${ok ? "done" : "failed: " + msg.slice(0, 160)}`);
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
        console_errors: [...new Set(o.errors)].slice(0, 15), failed_requests: o.failed.slice(0, 20), media_requests: o.media.snapshot(), sections: secs_ };
    })();
    const mobile = (async () => {
      const o = await open(browser, url, 390);
      const first = await inspect(o.page);
      await sleep(5000); // chat greetings and pop-ups usually appear after a few seconds
      const later = await inspect(o.page);
      await o.page.screenshot({ path: join(shots, "mobile-top.png") });
      await o.page.close();
      return { ...first, after_wait: { h1_covered_by: later.h1_covered_by, large_overlays: later.large_overlays, chat_widgets: later.chat_widgets },
        console_errors: [...new Set(o.errors)].slice(0, 15), failed_requests: o.failed.slice(0, 20), media_requests: o.media.snapshot() };
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

let [c, l, b, psi] = await Promise.all([collectJob, lhJob, browserJob, psiJob]);
// Lighthouse is sensitive to CPU load; retry once on its own if the parallel run failed.
if (!l.ok && !flag("no-lighthouse") && !/not installed/.test(l.msg)) { console.log(`[${secs()}] lighthouse: retrying alone`); l = await runLighthouse(false, /520|403|ERRORED_DOCUMENT|reliably load/.test(l.msg)); }
if (!c.ok) { console.error("collect.py failed: " + c.msg); process.exit(1); }

// PageSpeed's own Lighthouse run is the primary source when it worked (it's what
// pagespeed.web.dev shows); the local run is kept as lighthouse-local.json.
const sources = { mobile: "local", desktop: null };
if (psi.mobile.ok) {
  if (existsSync(lhPath)) writeFileSync(join(data, "lighthouse-local.json"), readFileSync(lhPath));
  writeFileSync(lhPath, JSON.stringify(psi.mobile.json.lighthouseResult)); sources.mobile = "pagespeed";
} else if (!l.ok) sources.mobile = null;
if (psi.desktop.ok) { writeFileSync(join(data, "lighthouse-desktop.json"), JSON.stringify(psi.desktop.json.lighthouseResult)); sources.desktop = "pagespeed"; }
else if (!flag("no-desktop") && !flag("no-lighthouse")) {
  console.log(`[${secs()}] lighthouse desktop: running locally (PageSpeed desktop unavailable)`);
  if ((await runLighthouse(true)).ok || (await runLighthouse(true, true)).ok) sources.desktop = "local";
}
const platform = readJSON(join(data, "collect.json"))?.platform || {};
const lhM = readJSON(lhPath), lhD = readJSON(join(data, "lighthouse-desktop.json"));
const label = s => s === "pagespeed" ? "Google PageSpeed Insights" : s === "local" ? "Lighthouse (local)" : null;
const pagespeed = {
  url, sources: { mobile: label(sources.mobile), desktop: label(sources.desktop) },
  status: { mobile: psi.mobile.ok ? "ok" : psi.mobile.msg, desktop: psi.desktop.ok ? "ok" : psi.desktop.msg, api_key: !!psi.keyed },
  mobile: scoresOf(lhM), desktop: scoresOf(lhD),
  field: psi.mobile.ok ? fieldData(psi.mobile.json) : null, field_desktop: psi.desktop.ok ? fieldData(psi.desktop.json) : null,
  report_url: `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(url)}`,
};
writeFileSync(join(data, "pagespeed.json"), JSON.stringify(pagespeed, null, 1));
writeFileSync(join(data, "road-to-100.json"), JSON.stringify({ mobile: roadTo100(lhM, platform), desktop: roadTo100(lhD, platform) }, null, 1));

const read = f => existsSync(join(data, f)) ? JSON.parse(readFileSync(join(data, f), "utf8")) : null;
const collect = read("collect.json"), rendered = read("rendered.json"), lh = read("lighthouse.json"), secList = read("sections.json") || [];
const checks = buildChecks(collect, rendered, lh);
const status = { lighthouse: l.ok ? "ok" : l.msg, browser: b.ok ? "ok" : b.msg };
writeFileSync(join(data, "checks.json"), JSON.stringify({ url, status, checks }, null, 1));
writeFileSync(join(data, "summary.md"), summaryMarkdown({ url, collect, rendered, lh, sections: secList, checks, status }) +
  speedMarkdown(read("ttfb.json"), pagespeed, read("road-to-100.json")));
const n = s => checks.filter(x => x.status === s).length;
console.log(`[${secs()}] done: ${n("fail")} fail, ${n("warn")} warn, ${n("pass")} pass -> ${join(data, "summary.md")}`);

process.exit(process.exitCode || 0);
