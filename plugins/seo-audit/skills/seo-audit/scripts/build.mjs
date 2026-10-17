#!/usr/bin/env node
// Render <out-dir>/report.json into report.html and a one-page PDF.
//
//   node build.mjs <out-dir> [--no-pdf] [--no-reverify] [--no-open] [--reshoot]
//
// Issues with a "capture" get their screenshots taken here, in one Chrome
// session while the page is re-verified: shots/<key>-before.png, plus
// shots/<key>-after.png when capture.after_js / after_inject builds the fix
// mockup. Existing files are kept unless --reshoot.
// Opens the PDF (or the HTML with --no-pdf) in the system viewer when done,
// unless --no-open or SEO_AUDIT_NO_OPEN=1.
//
// Reads report.json plus any issues/*.json files (one issue object, or an array,
// per file: written in parallel by writer agents) — see references/report-json.md —
// plus data/collect.json, data/lighthouse.json and data/checks.json for the
// header facts, metric tiles, scorecard and passing checks. Before printing it
// re-fetches the page and compares the modified time (the "Re-verified" line).
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { HERE, launch, resolveOut, openFile } from "./lib.mjs";
import { CATEGORIES, THRESHOLDS, grade, lhMetrics } from "./checks.mjs";

const [, , dirArg, ...rest] = process.argv;
if (!dirArg || dirArg === "--help") {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 18).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(1);
}
const dir = existsSync(join(resolve(dirArg), "report.json")) ? resolve(dirArg) : resolveOut(dirArg);
const read = f => existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), "utf8")) : null;
const R = read("report.json");
if (!R) { console.error("Missing " + join(dir, "report.json")); process.exit(1); }
// Issues written by parallel writer agents: issues/<key>.json, merged after report.json's own.
if (existsSync(join(dir, "issues"))) {
  const extra = readdirSync(join(dir, "issues")).filter(f => f.endsWith(".json")).sort().flatMap(f => {
    try { const j = JSON.parse(readFileSync(join(dir, "issues", f), "utf8")); return Array.isArray(j) ? j : j.issues || [j]; }
    catch (e) { console.error(`issues/${f}: invalid JSON (${e.message})`); process.exit(1); }
  });
  const keys = new Set((R.issues || []).map(x => x.key).filter(Boolean));
  R.issues = [...(R.issues || []), ...extra.filter(x => !x.key || !keys.has(x.key))];
}

// Re-verify (re-fetch the page) while waiting for the background desktop Lighthouse run.
let py = "python3"; try { execFileSync(py, ["--version"]); } catch { py = "python"; }
const C0 = read("data/collect.json") || {};
const reverifyJob = R.reverified || rest.includes("--no-reverify") || !C0.url ? Promise.resolve(null) : new Promise(res =>
  execFile(py, ["-I", join(HERE, "collect.py"), C0.url, join(dir, "data", "collect-reverify.json"), "--no-linkcheck"], { timeout: 90000 },
    err => res(err ? { error: err.message.split("\n")[0] } : JSON.parse(readFileSync(join(dir, "data", "collect-reverify.json"), "utf8")))));
// Per-issue screenshots (issue.capture), all in one browser.mjs run.
const capList = [];
for (const [i, x] of (R.issues || []).entries()) {
  const c = x.capture; if (!c) continue;
  const k = (x.key || "issue" + (i + 1)).replace(/[^\w-]/g, "");
  const base = { selector: c.selector, width: c.width || 1440, height: c.height, hide: c.hide, scroll: c.scroll, full: c.full, wait: c.wait };
  x._cap = { before: `shots/${k}-before.png`, after: c.after_js || c.after_inject ? `shots/${k}-after.png` : null, width: base.width, c };
  const need = f => rest.includes("--reshoot") || !existsSync(join(dir, f));
  if (need(x._cap.before)) capList.push({ ...base, js: c.js, out: x._cap.before });
  if (x._cap.after && need(x._cap.after)) capList.push({ ...base, js: [c.js, c.after_js].filter(Boolean).join(";\n"), inject: c.after_inject, out: x._cap.after });
}
const capJob = !capList.length || !(C0.final_url || C0.url) ? Promise.resolve("") : new Promise(res => {
  writeFileSync(join(dir, ".capture.json"), JSON.stringify(capList, null, 1));
  console.log(`taking ${capList.length} issue screenshots...`);
  execFile(process.execPath, [join(HERE, "browser.mjs"), "shots", C0.final_url || C0.url, join(dir, ".capture.json")], { timeout: 300000 },
    (err, out, errOut) => res(errOut || (err ? err.message : "")));
});
// Filmstrips: one real throttled load per source used by a filmstrip block (browser.mjs filmstrip),
// plus an "after" load per block with after.css (the fix's CSS applied in the browser).
const fsNeed = new Map();
for (const [i, x] of (R.issues || []).entries()) for (const b of x.blocks || []) if (b.type === "filmstrip") {
  const src = b.source === "desktop" ? "desktop" : "mobile";
  fsNeed.set(`filmstrip-${src}.json`, { src });
  if (b.after?.css) { b._after = `filmstrip-${src}-after-${(x.key || "issue" + (i + 1)).replace(/[^\w-]/g, "")}.json`; fsNeed.set(b._after, { src, css: b.after.css }); }
}
const fsTodo = [...fsNeed].filter(([f]) => rest.includes("--reshoot") || !existsSync(join(dir, "data", f)));
const fsJob = Promise.all(fsTodo.map(([f, { src, css }]) => !(C0.final_url || C0.url) ? "" : new Promise(res => {
  const args = [join(HERE, "browser.mjs"), "filmstrip", C0.final_url || C0.url, join(dir, "data", f), "--width", src === "desktop" ? "1440" : "390"];
  if (css) { writeFileSync(join(dir, "data", f.replace(/\.json$/, ".css")), css); args.push("--css", join(dir, "data", f.replace(/\.json$/, ".css"))); }
  execFile(process.execPath, args, { timeout: 120000 }, (err, out) => { if (err) console.warn(`LAYOUT: ${f} failed (${err.message.split("\n")[0]})`); else process.stdout.write(out); res(); });
})));
if (fsTodo.length) console.log(`recording ${fsTodo.length} filmstrip load(s) on throttled slow 4G...`);
const pending = join(dir, "data", "desktop.pending");
if (existsSync(pending)) {
  console.log("waiting for the background desktop Lighthouse run...");
  for (let i = 0; i < 240 && existsSync(pending); i++) await new Promise(r => setTimeout(r, 1000));
  if (existsSync(pending)) console.warn("desktop Lighthouse still running after 4 min; building without it");
}
const reverifyResult = await reverifyJob;
await fsJob;
const capErrors = (await capJob).split("\n").filter(l => /\.png: /.test(l));
for (const l of capErrors) console.warn("CAPTURE: " + l.replace(dir + "/", ""));

const C = read("data/collect.json") || {}, LH = read("data/lighthouse.json"), CK = read("data/checks.json");
const TT = read("data/ttfb.json"), PS = read("data/pagespeed.json"), ROAD = read("data/road-to-100.json");

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const SEV = { Critical: "crit", High: "high", Medium: "med", Low: "low" };
const ORDER = ["Critical", "High", "Medium", "Low"];
const fmtDate = (d, time = true) => {
  const x = new Date(d); if (isNaN(x)) return String(d || "");
  const s = x.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return time ? `${s}, ${x.toISOString().slice(11, 16)} UTC` : s;
};

// ---------- issues: sort by severity, number them, resolve {{ref:key}} ----------
const prefix = R.id_prefix ?? "B";
const issues = (R.issues || []).map((x, i) => ({ ...x, _i: i }))
  .sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || a._i - b._i)
  .map((x, i) => ({ ...x, id: prefix + (i + 1) }));
for (const x of issues) if (!SEV[x.severity]) { console.error(`Issue "${x.title}" has severity "${x.severity}"; use ${ORDER.join("/")}`); process.exit(1); }
const keyToId = Object.fromEntries(issues.filter(x => x.key).map(x => [x.key, x.id]));
const refs = s => String(s ?? "").replace(/\{\{ref:([\w-]+)\}\}/g, (_, k) => keyToId[k] || "?");

// Code: plain text. [-removed-] and {+added+}; <!-- comments --> are greyed.
const code = s => esc(s)
  .replace(/\[-([\s\S]*?)-\]/g, '<span class="del">$1</span>')
  .replace(/\{\+([\s\S]*?)\+\}/g, '<span class="add">$1</span>')
  .replace(/(&lt;!--[\s\S]*?--&gt;|\/\* [\s\S]*? \*\/)/g, '<span class="cm">$1</span>');

const P = lhMetrics(LH);
function metricTiles(tiles) {
  return `<div class="metrics${tiles.length === 4 ? " four" : ""}">${tiles.map(t =>
    `<div class="metric"><div class="k">${esc(t.k)}</div><div class="v ${t.c || ""}">${esc(t.v)}</div></div>`).join("")}</div>`;
}
function lhTiles() {
  if (!P) return "";
  return metricTiles([
    { k: "Performance score", v: P.performance, c: grade(P.performance, THRESHOLDS.score, true) },
    { k: "LCP", v: (P.lcp / 1000).toFixed(1) + " s", c: grade(P.lcp, THRESHOLDS.lcp) },
    { k: "First paint", v: (P.fcp / 1000).toFixed(1) + " s", c: grade(P.fcp, THRESHOLDS.fcp) },
    { k: "Total blocking", v: Math.round(P.tbt) + " ms", c: grade(P.tbt, THRESHOLDS.tbt) },
    { k: "Layout shift", v: P.cls.toFixed(3), c: grade(P.cls, THRESHOLDS.cls) }]);
}
const viaPSI = PS?.sources?.mobile === "Google PageSpeed Insights";
const lhCaption = () => P ? `Lighthouse ${P.version}, mobile emulation with simulated slow 4G, ${viaPSI ? "run by Google PageSpeed Insights" : "run locally"} on ${fmtDate(P.fetched, false)}. Real phones on Wi-Fi will be faster, but the ranking is the same.` : "Lighthouse did not run for this report.";

function shotBox(s, cls, label) {
  if (!s) return "";
  return `<a class="box shot ${cls}" href="${esc(s.src)}"><div class="box-label">${esc(s.label || label)}</div><img src="${esc(s.src)}" alt="${esc(s.alt || s.cap || "")}">${s.cap ? `<div class="cap">${refs(s.cap)}</div>` : ""}</a>`;
}

function serpBox(r, cls, label) {
  let host = r.url || "", crumbs = "";
  try { const u = new URL(r.url); host = u.hostname.replace(/^www\./, ""); crumbs = u.pathname.split("/").filter(Boolean).join(" › "); } catch {}
  const tl = String(r.title || "").length, dl = String(r.desc || "").length;
  return `<div class="box ${cls} serp-box"><div class="box-label">${esc(label)}</div><div class="serp">
<div class="serp-site"><span class="serp-fav">${esc((r.site || host).slice(0, 1).toUpperCase())}</span><span><b>${esc(r.site || host)}</b><br><span class="serp-url">https://${esc(host)}${crumbs ? " › " + esc(crumbs) : ""}</span></span></div>
<div class="serp-title">${esc(r.title || "(no title)")}</div><div class="serp-desc">${esc(r.desc || "(no meta description: Google picks text from the page)")}</div></div>
<div class="cap">Title ${tl} characters${tl > 60 ? " (Google cuts titles at about 600 px, roughly 60 characters)" : ""} · description ${dl} characters${dl > 160 ? " (cut at about 160)" : ""}</div></div>`;
}

function block(b) {
  switch (b.type) {
    case "code": return `<div class="pair${b.stack ? " stack" : ""}">
    <div class="box before"><div class="box-label">${esc(b.before_label || "Before · Live HTML")}</div><pre>${code(b.before)}</pre></div>
    <div class="box after"><div class="box-label">${esc(b.after_label || "After")}</div><pre>${code(b.after)}</pre></div></div>`;
    case "shots": {
      const layout = b.layout || ((b.width || 1440) < 768 ? "phones" : "stack");
      return `<div class="pair ${layout}">${shotBox(b.before, "before", layout === "phones" ? "Before · Live, 390 px" : "Before · Live, desktop")}${shotBox(b.after, "after", "After · Proposed")}</div>`;
    }
    case "shot": {
      // A phone screenshot shown alone stays phone-sized instead of filling the page width.
      const phone = (b.width || 1440) < 768 || /mobile|390/.test(b.src + " " + (b.label || ""));
      return `<div class="pair ${phone ? "phones" : "stack"}">${shotBox(b, b.after ? "after" : "before", b.label || (phone ? "Live, 390 px" : "Live"))}</div>`;
    }
    case "metrics": return (b.tiles ? metricTiles(b.tiles) : lhTiles()) + `<p class="note">${refs(b.caption || lhCaption())}</p>`;
    case "table": return `<table class="table data"><thead><tr>${b.head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${
      b.rows.map(r => `<tr>${r.map(c => `<td>${refs(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    case "outline": {
      const o = list => list.map(([lvl, text, why]) => `<div class="${String(lvl).toLowerCase()}${why ? " bad" : ""}">${esc(lvl)} ${esc(text)}${why ? ` <span class="why">${esc(why)}</span>` : ""}</div>`).join("");
      return `<div class="pair"><div class="box before"><div class="box-label">Before · Live outline</div><pre class="outline">${o(b.before)}</pre></div>
      <div class="box after"><div class="box-label">After</div><pre class="outline">${o(b.after)}</pre></div></div>`;
    }
    case "serp": {
      // Google result preview. "before" defaults to the live title, description and URL.
      const m = C.meta || {};
      const live = { title: m.title, desc: m.description, url: C.final_url, site: m.og?.["og:site_name"] };
      const before = { ...live, ...(b.before || {}) }, after = b.after ? { ...live, ...b.after } : null;
      return `<div class="pair stack">${serpBox(before, "before", b.before_label || "Before · Google result today")}${after ? serpBox(after, "after", b.after_label || "After · Proposed") : ""}</div>`;
    }
    case "filmstrip": {
      // A real recorded load on throttled slow 4G (data/filmstrip-<source>.json, recorded by this build),
      // or, if that failed, Lighthouse's thumbnails (recorded unthrottled, so their times differ from its metrics).
      const src = b.source === "desktop" ? "desktop" : "mobile";
      const strip = (rec, cls, label, lead) => {
        const { fcp, lcp } = rec, all = rec.frames, at = t => all.find(f => f.t >= t) || all.at(-1);
        // Spread frames from first paint to the end of the recording, not just to LCP: LCP can come early
        // (a logo) while the main content is still hidden, and the strip must show that gap.
        const end = all.at(-1).t;
        const targets = [all[0].t, ...[0, .15, .3, .45, .6, .75, .9].map(k => fcp + (end - fcp) * k), lcp, end];
        const frames = [...new Set([all.filter(f => f.t < fcp).at(-1), ...targets.map(at)].filter(Boolean))].sort((a, b) => a.t - b.t).slice(0, 11);
        const lcpIdx = frames.findIndex(f => f.t >= lcp);
        return `<div class="box ${cls} film-box"><div class="box-label">${esc(label)}</div><div class="film">${frames.map((f, i) =>
          `<figure class="${i === lcpIdx ? "lcp" : f.t < fcp ? "blank" : ""}"><img src="${f.src}" alt=""><figcaption>${(f.t / 1000).toFixed(1)} s${i === lcpIdx ? " · LCP" : ""}</figcaption></figure>`).join("")}</div>
<div class="cap">${lead}First content at ${(fcp / 1000).toFixed(1)} s; the largest content${rec.lcp_element ? ` (<code>${esc(rec.lcp_element)}</code>)` : ""} at ${(lcp / 1000).toFixed(1)} s, outlined in red. Page fully loaded at ${(rec.load / 1000).toFixed(1)} s.</div></div>`;
      };
      const rec = read(`data/filmstrip-${src}.json`), after = b._after && read(`data/${b._after}`);
      if (rec?.frames?.length) {
        const dev = src === "desktop" ? "a desktop" : "a phone";
        return strip(rec, "before", b.label || `Before · Page loading on ${dev}, slow 4G`,
          `${b.cap ? refs(b.cap) + " " : ""}One recorded load on ${dev} with throttled slow 4G (150 ms latency, 1.6 Mbps) and a 4× slower CPU, like Lighthouse ${src}; times vary a little from run to run. `) +
          (after?.frames?.length ? strip(after, "after", b.after.label || "After · Same load with the fix applied in the browser",
            `${b.after.cap ? refs(b.after.cap) + " " : ""}Recorded the same way, with the fix's CSS injected before the page loads; nothing was changed on the website. `) : "");
      }
      const lh = src === "desktop" ? read("data/lighthouse-desktop.json") : LH;
      const items = lh?.audits?.["screenshot-thumbnails"]?.details?.items || [];
      if (!items.length) { console.warn("LAYOUT: filmstrip has no frames"); return ""; }
      return `<div class="box before film-box"><div class="box-label">${esc(b.label || "Before · Page loading, Lighthouse frames")}</div><div class="film">${items.map(t =>
        `<figure><img src="${t.data}" alt=""><figcaption>${(t.timing / 1000).toFixed(1)} s</figcaption></figure>`).join("")}</div>
<div class="cap">${b.cap ? refs(b.cap) + " " : ""}Frames from Lighthouse's own recording, which loads the page without throttling; its slow-4G metrics are simulated from that load, so these frame times are not the metric times.</div></div>`;
    }
    case "note": return `<p class="note">${refs(b.html)}</p>`;
    case "html": return refs(b.html);
    default: console.error("unknown block type " + b.type); return "";
  }
}

const para = s => !s ? "" : /^\s*<(p|ul|ol|div|table)\b/.test(s) ? refs(s) : `<p>${refs(s)}</p>`;
function fixBox(f) {
  if (!f) return "";
  if (typeof f === "string") return `<div class="fix"><p><b class="lead">Fix.</b> ${refs(f)}</p></div>`;
  return `<div class="fix"><span class="fix-title">${esc(f.title || "Fix")}</span>${f.steps ? `<ol>${f.steps.map(s => `<li>${refs(s)}</li>`).join("")}</ol>` : ""}${f.html ? refs(f.html) : ""}</div>`;
}
// "After the fix": what changes for Google and visitors, expected numbers, how to check.
function resultBox(r) {
  if (!r) return "";
  if (typeof r === "string") r = { html: r };
  const rows = r.metrics || [];
  return `<div class="result"><span class="result-title">${esc(r.title || "After the fix")}</span>${para(r.html)}${rows.length ? `<table class="table data result-table"><thead><tr><th>${esc(r.head?.[0] || "Measure")}</th><th>${esc(r.head?.[1] || "Now")}</th><th>${esc(r.head?.[2] || "After the fix")}</th></tr></thead><tbody>${
    rows.map(([k, a, b]) => `<tr><td>${refs(k)}</td><td class="bad">${refs(a)}</td><td class="ok">${refs(b)}</td></tr>`).join("")}</tbody></table>` : ""}${r.verify ? `<p class="verify"><b>How to check:</b> ${refs(r.verify)}</p>` : ""}</div>`;
}
// Screenshots taken by this build from issue.capture.
function captureBlock(x) {
  const k = x._cap; if (!k || !existsSync(join(dir, k.before))) return "";
  const c = k.c, phone = k.width < 768;
  if (!k.after || !existsSync(join(dir, k.after)))
    return block({ type: "shot", src: k.before, width: k.width, label: c.label || (phone ? "Live, 390 px" : "Live, desktop"), cap: c.before_cap || c.cap });
  return block({ type: "shots", width: k.width, before: { src: k.before, cap: c.before_cap, label: c.before_label }, after: { src: k.after, cap: c.after_cap, label: c.after_label || "After · Proposed (mockup)" } });
}
const VISUAL = new Set(["shot", "shots", "serp", "filmstrip"]);
const issueHtml = x => `<section class="issue" id="${x.id.toLowerCase()}">
  <div class="issue-head"><span class="issue-id">${x.id}</span><h3 class="issue-title">${esc(refs(x.title))}</h3><span class="pill ${SEV[x.severity]}">${x.severity}</span></div>
  ${x.loc ? `<div class="loc">${refs(x.loc)}</div>` : ""}
  ${para(x.body)}
  ${captureBlock(x)}
  ${(x.blocks || []).map(block).join("\n")}
  ${para(x.after_body)}
  ${fixBox(x.fix)}
  ${resultBox(x.result)}
</section>`;
for (const x of issues) {
  const hasShot = (x._cap && existsSync(join(dir, x._cap.before))) || (x.blocks || []).some(b => VISUAL.has(b.type));
  if (!hasShot) console.warn(`LAYOUT: ${x.id} (${x.key || x.short || x.title}) has no screenshot, Google preview or filmstrip`);
  if (!x.result) console.warn(`LAYOUT: ${x.id} (${x.key || x.short || x.title}) has no "After the fix" result`);
}

// ---------- re-verify ----------
let reverified = R.reverified || "";
if (!reverified && reverifyResult) {
  if (reverifyResult.error) console.warn("re-verify skipped: " + reverifyResult.error);
  else {
    const now = reverifyResult, t = new Date().toISOString();
    const same = (now.modified_time || "") === (C.modified_time || "");
    reverified = `${fmtDate(t)}` + (C.modified_time ? (same ? ` (no edits since ${new Date(C.modified_time).toISOString().slice(11, 16) || "?"})` : " (THE PAGE CHANGED since the audit: re-check affected issues)") : "");
    if (!same && C.modified_time) console.warn("WARNING: the page was edited after the evidence was collected (" + now.modified_time + ").");
    R._reverify_time = t; R._changed = !same;
  }
}

// ---------- header ----------
const p = C.platform || {};
const platform = [p.cms, p.builder || p.framework].filter(Boolean).join(", ");
const counts = Object.fromEntries(ORDER.map(s => [s, issues.filter(x => x.severity === s).length]));
const path = C.final_url ? new URL(C.final_url).pathname : "";
const meta = R.meta || {};
const metaLine = [
  ["Page", meta.page ?? (C.page_id ? `#${C.page_id}${platform ? ` (${platform})` : ""}` : platform || null)],
  ["Last edited", meta.last_edited ?? (C.modified_time ? fmtDate(C.modified_time) : null)],
  ["Re-verified", meta.reverified ?? (reverified || null)],
  ["Tested", meta.tested ?? `Chrome desktop 1440 px, iPhone 390 px${P ? `, Lighthouse ${P.version.split(".").slice(0, 2).join(".")} mobile${PS?.desktop ? " + desktop" : ""}${viaPSI ? " via Google PageSpeed" : ""}` : ""}${TT?.cached ? ", TTFB × " + TT.cached.n : ""}`],
].filter(([, v]) => v);

// ---------- scorecard ----------
function scorecard() {
  if (R.scorecard === false || !CK) return "";
  const checks = CK.checks.filter(c => c.status !== "info");
  const cats = CATEGORIES.map(cat => {
    const xs = checks.filter(c => c.cat === cat); if (!xs.length) return "";
    const n = s => xs.filter(c => c.status === s).length;
    return `<div class="cat"><div class="k">${esc(cat)}</div><div class="n">${n("fail") ? `<span class="f">${n("fail")} fail</span>` : ""}${n("warn") ? `<span class="w">${n("warn")} warn</span>` : ""}<span class="p">${n("pass")} pass</span></div></div>`;
  }).join("");
  const tiles = P ? metricTiles([
    { k: "Performance", v: P.performance, c: grade(P.performance, THRESHOLDS.score, true) },
    { k: "Accessibility", v: P.accessibility, c: grade(P.accessibility, THRESHOLDS.score, true) },
    { k: "Best practices", v: P.best_practices, c: grade(P.best_practices, THRESHOLDS.score, true) },
    { k: "SEO", v: P.seo, c: grade(P.seo, THRESHOLDS.score, true) }]) : "";
  return `<h2 class="section-title">Scorecard</h2>
<p class="section-sub">${checks.length} automated checks against the live page, plus Lighthouse mobile scores. The issues below explain the failures that matter.</p>
${tiles}<div class="cats">${cats}</div>`;
}
function passes() {
  if (R.passes === false || !CK) return "";
  const xs = CK.checks.filter(c => c.status === "pass");
  if (!xs.length) return "";
  return `<h2 class="section-title" style="margin-top:44px">Already in good shape</h2>
<p class="section-sub">Checks this page passes. Keep these as they are when making the fixes above.</p>
<ul class="passes">${xs.map(c => `<li><span class="pc">${esc(c.cat)}</span> ${esc(c.label)}</li>`).join("")}</ul>`;
}

// ---------- PageSpeed, TTFB, Road to 100 ----------
const fmtMs = v => v == null ? "–" : v >= 1000 ? (v / 1000).toFixed(1) + " s" : Math.round(v) + " ms";
const short = u => { try { const x = new URL(u); return (x.hostname === new URL(C.final_url || u).hostname ? "" : x.hostname) + x.pathname.replace(/^(.{0,20}).*(\/[^/]{0,48})$/, (m, a, b) => m.length > 72 ? a + "…" + b : m); } catch { return u; } };
const itemHtml = i => C.final_url && i.what === C.final_url ? `Page HTML and inline scripts${i.value ? " " + esc(i.value) : ""}` : /^https?:/.test(i.what) ? `<code>${esc(short(i.what))}</code>${i.value ? " " + esc(i.value) : ""}` : `${esc(i.what)}${i.value ? " <b>" + esc(i.value) + "</b>" : ""}`;
function speedSection() {
  if (R.speed === false || (!PS && !TT)) return "";
  const g = (v, t, hi) => v == null ? "" : grade(v, t, hi);
  const ff = ["mobile", "desktop"].filter(f => PS?.[f]);
  let h = `<h2 class="section-title" style="margin-top:44px">PageSpeed and server response</h2>
<p class="section-sub">${ff.length ? `Scores from ${[...new Set(ff.map(f => PS.sources[f]))].join(" and ")}${viaPSI ? "" : " (Google PageSpeed was not available: " + esc(PS?.status?.mobile || "") + ")"}. Lab scores move a few points between runs.` : ""} <a href="${esc(PS?.report_url || "")}">Open in PageSpeed Insights</a>.</p>`;
  for (const f of ff) {
    const s = PS[f];
    h += `<div class="ff">${f === "mobile" ? "Mobile" : "Desktop"}</div>` + metricTiles([
      { k: "Performance", v: s.performance, c: g(s.performance, THRESHOLDS.score, true) }, { k: "Accessibility", v: s.accessibility, c: g(s.accessibility, THRESHOLDS.score, true) },
      { k: "Best practices", v: s.best_practices, c: g(s.best_practices, THRESHOLDS.score, true) }, { k: "SEO", v: s.seo, c: g(s.seo, THRESHOLDS.score, true) }]);
  }
  if (ff.length) {
    const rows = [["Largest Contentful Paint (LCP)", "lcp", THRESHOLDS.lcp, fmtMs, "≤ 2.5 s"], ["First Contentful Paint (FCP)", "fcp", THRESHOLDS.fcp, fmtMs, "≤ 1.8 s"],
      ["Total Blocking Time (TBT)", "tbt", THRESHOLDS.tbt, fmtMs, "≤ 200 ms"], ["Cumulative Layout Shift (CLS)", "cls", THRESHOLDS.cls, v => v?.toFixed(3) ?? "–", "≤ 0.1"],
      ["Speed Index", "si", [3400, 5800], fmtMs, "≤ 3.4 s"]];
    h += `<table class="table data"><thead><tr><th>Lab metric</th>${ff.map(f => `<th>${f}</th>`).join("")}<th>Good</th></tr></thead><tbody>${rows.map(([n, k, t, fm, good]) =>
      `<tr><td>${n}</td>${ff.map(f => `<td class="${g(PS[f][k], k === "si" && f === "desktop" ? [1300, 2300] : t)}">${fm(PS[f][k])}</td>`).join("")}<td>${good}</td></tr>`).join("")}</tbody></table>`;
  }
  const fd = PS?.field?.page || PS?.field?.origin;
  if (fd) {
    const cls = c => c === "FAST" ? "ok" : c === "AVERAGE" ? "mid" : "bad";
    h += `<div class="ff">Real users (Chrome UX Report, last 28 days, mobile, 75th percentile${PS.field.page ? "" : ", whole site: this page has too little traffic for its own data"})</div>
<table class="table data"><thead><tr><th>Metric</th><th>Real users</th><th>Rating</th></tr></thead><tbody>${fd.metrics.map(m =>
      `<tr><td>${m.name}</td><td class="${cls(m.category)}">${m.unit === "cls" ? m.p75.toFixed(2) : fmtMs(m.p75)}</td><td>${esc(m.category.replace("AVERAGE", "NEEDS IMPROVEMENT").toLowerCase())}</td></tr>`).join("")}</tbody></table>
<p class="note">Core Web Vitals assessment: <b>${fd.overall === "FAST" ? "passed" : fd.overall ? "failed" : "unknown"}</b>. This is what Google uses for ranking; the lab scores above explain why.</p>`;
  } else if (PS) h += `<p class="note">No real-user (field) data: ${viaPSI ? "Google does not have enough Chrome traffic for this site yet." : `it comes from Google PageSpeed, which did not run (${esc(PS.status?.mobile || "unknown error")}).`}</p>`;
  if (TT?.cached) {
    const c = TT.cached, b = TT.busted;
    h += `<div class="ff">Time to first byte (TTFB), ${c.n} requests from the audit machine</div>` + metricTiles([
      { k: "TTFB (median)", v: c.ttfb_ms + " ms", c: c.ttfb_ms <= 800 ? "ok" : c.ttfb_ms <= 1800 ? "mid" : "bad" },
      { k: "Server wait", v: c.wait_ms + " ms", c: c.wait_ms <= 200 ? "ok" : c.wait_ms <= 600 ? "mid" : "bad" },
      { k: "DNS + connect + TLS", v: (c.dns_ms + c.connect_ms + c.tls_ms) + " ms", c: c.dns_ms + c.connect_ms + c.tls_ms <= 150 ? "ok" : "mid" },
      { k: "Uncached page", v: b ? b.ttfb_ms + " ms" : "–", c: b ? (b.ttfb_ms <= 800 ? "ok" : b.ttfb_ms <= 1800 ? "mid" : "bad") : "" }]);
    const cache = TT.cache_status || Object.entries(TT.headers || {}).filter(([k]) => /cache|age/.test(k)).map(([k, v]) => k + ": " + v).join(", ");
    const tips = [];
    if (TT.redirects?.length) tips.push(`The URL redirects ${TT.redirects.length}× first (${TT.redirects.map(r => r.status).join(", ")}), adding ${TT.redirect_ms} ms: link to <code>${esc(TT.final_url)}</code> directly.`);
    if (c.wait_ms > 200) tips.push(`The server takes ${c.wait_ms} ms to start answering. ${/DYNAMIC|MISS|BYPASS/i.test(cache || "") || !cache ? "The HTML is not served from a cache" + (cache ? ` (<code>${esc(cache)}</code>)` : "") + ": turn on full-page caching and cache HTML at the CDN edge (e.g. Cloudflare APO or a Cache Everything rule with bypass on login cookies)." : "Check the full-page cache hit rate and slow back-end work."}`);
    if (b && c && b.wait_ms > c.wait_ms * 1.5 && b.wait_ms - c.wait_ms > 150) tips.push(`An uncached page takes ${b.ttfb_ms} ms versus ${c.ttfb_ms} ms cached, so visitors who miss the cache wait longer: speed up the origin (PHP/OPcache, database queries, object cache).`);
    h += `<p class="note">Breakdown (median): DNS ${c.dns_ms} ms, connect ${c.connect_ms} ms, TLS ${c.tls_ms} ms, server wait ${c.wait_ms} ms; range ${c.min_ms}–${c.max_ms} ms. Google rates TTFB under 800 ms as good; under 200 ms of server wait is the target for a cached page. Measured from the audit machine, so network distance to the server is included.${cache ? ` Cache headers: <code>${esc(cache)}</code>.` : ""}</p>` +
      (tips.length ? `<div class="fix"><span class="fix-title">Fix TTFB</span><ol>${tips.map(t => `<li>${t}</li>`).join("")}</ol></div>` : "");
  }
  return h;
}
function roadSection() {
  if (R.road === false || !ROAD?.mobile) return "";
  const notes = R.road_notes || {};
  const sc = v => grade(v, THRESHOLDS.score, true);
  let h = `<h2 class="section-title" style="margin-top:44px">Road to 100</h2>
<p class="section-sub">Every check that keeps a ${PS?.sources?.mobile ? esc(PS.sources.mobile) : "Lighthouse"} score below 100 on mobile, with what causes it on this page and how to fix it, biggest impact first. "Points" is how much of the category score the check costs. Performance is scored from the five metrics, so the fixes there are ranked by estimated time saved.</p>`;
  const row = a => `<tr><td><b>${esc(a.title)}</b>${a.display ? `<br><span class="hint">${esc(a.display)}</span>` : ""}${a.points_lost ? `<br><span class="pts">−${a.points_lost} points</span>` : ""}</td>
<td>${a.items.length ? `<ul>${a.items.slice(0, 5).map(i => `<li>${itemHtml(i)}</li>`).join("")}</ul>` : "–"}</td>
<td>${refs(notes[a.id] || esc(a.fix).replace(/`([^`]+)`/g, "<code>$1</code>"))}${a.hint ? `<span class="hint">${esc(a.hint).replace(/`([^`]+)`/g, "<code>$1</code>")}</span>` : ""}</td></tr>`;
  for (const c of Object.values(ROAD.mobile)) {
    h += `<div class="road-cat"><h3>${esc(c.title)}</h3><span class="sc ${sc(c.score)}">${c.score}${c.score < 100 ? " → 100" : ""}</span></div>`;
    if (c.metrics) h += `<table class="table data"><thead><tr><th>Metric</th><th>Value</th><th>Metric score</th><th>Points lost</th></tr></thead><tbody>${c.metrics.map(m =>
      `<tr><td>${esc(m.name)}</td><td>${esc(m.value)}</td><td class="${sc(m.score)}">${m.score}</td><td>${m.points_lost ? "−" + m.points_lost : "0"}</td></tr>`).join("")}</tbody></table>`;
    h += c.audits.length ? `<table class="table data road"><thead><tr><th>Problem</th><th>What causes it on this page</th><th>Fix</th></tr></thead><tbody>${c.audits.map(row).join("")}</tbody></table>`
      : `<p class="note">Nothing to fix: this category already scores 100.</p>`;
  }
  if (ROAD.desktop) {
    const mob = new Set(Object.values(ROAD.mobile).flatMap(c => c.audits.map(a => a.id)));
    const extra = Object.values(ROAD.desktop).flatMap(c => c.audits.filter(a => !mob.has(a.id)));
    if (extra.length) h += `<div class="road-cat"><h3>Desktop only</h3></div><table class="table data road"><thead><tr><th>Problem</th><th>What causes it on this page</th><th>Fix</th></tr></thead><tbody>${extra.map(row).join("")}</tbody></table>`;
  }
  return h;
}

const title = R.title || `${R.page}: SEO audit`;
const css = readFileSync(join(HERE, "../assets/report.css"), "utf8");
const footer = R.footer || `Checked on ${fmtDate(C.fetched_at_utc ? C.fetched_at_utc.replace(" UTC", "Z").replace(" ", "T") : Date.now(), false)} against the live page${R._reverify_time ? ` and re-verified at ${new Date(R._reverify_time).toISOString().slice(11, 16)} UTC` : ""}. "After" screenshots were made by editing the page in a local headless browser; nothing was changed on the website. Click any screenshot to open it full size.${R.footer_extra ? " " + R.footer_extra : ""}`;
const checklist = issues.filter(x => x.check !== false && x.check !== null);

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(R.page || "Page")} SEO Audit</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@600;700;800&family=Source+Sans+3:ital,wght@0,400;0,600;0,700;1,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${css}</style></head><body><div class="wrap">
<div class="eyebrow">${esc(R.eyebrow || "SEO audit")}</div>
<h1 class="title">${esc(title)}</h1>
<p class="lede">${R.lede ? refs(R.lede) : `What is wrong with <a href="${esc(C.final_url)}">${esc(path || C.final_url)}</a> for search engines and visitors: indexing, markup, content, links, images, performance and mobile layout. Each issue shows the live page and the proposed fix.`}</p>
<div class="meta">${metaLine.map(([k, v]) => `<span><b>${k}</b> ${esc(v)}</span>`).join("\n")}</div>
<div class="counts">${ORDER.map(s => `<span class="count ${SEV[s]}"><b>${counts[s]}</b>${s}</span>`).join("")}</div>
<hr class="rule">
${scorecard()}
<h2 class="section-title">All issues</h2>
<p class="section-sub">Ordered by severity. Critical blocks indexing or the launch; High hurts visitors or rankings right away; Medium and Low are cleanup.</p>
<table class="table"><thead><tr><th>ID</th><th>Issue</th><th>Severity</th><th>Where</th></tr></thead><tbody>
${issues.map(x => `<tr><td class="id">${x.id}</td><td><a href="#${x.id.toLowerCase()}">${esc(refs(x.short || x.title))}</a></td><td class="sev"><span class="pill ${SEV[x.severity]}">${x.severity}</span></td><td class="where">${refs(x.where || "")}</td></tr>`).join("\n")}
</tbody></table>
<h2 class="section-title" style="margin-bottom:22px">Issues in detail</h2>
${issues.map(issueHtml).join("\n")}
${speedSection()}
${roadSection()}
${checklist.length ? `<h2 class="section-title" style="margin-top:44px">Fix checklist</h2>
<p class="section-sub">${esc(R.checklist_intro || "In order of priority.")}</p>
${checklist.map(x => `<div class="check"><span class="cb"></span><span class="txt">${refs(x.check || x.short || x.title)}</span><span class="ref">${x.id}</span></div>`).join("\n")}` : ""}
${passes()}
<div class="foot">${refs(footer)}</div>
</div></body></html>`;

writeFileSync(join(dir, "report.html"), html);
let opened = join(dir, "report.html");
console.log(`report.html: ${issues.length} issues (${ORDER.map(s => counts[s] + " " + s).join(", ")})`);

if (!rest.includes("--no-pdf")) {
  const name = R.pdf_name || `${[R.site, R.page].filter(Boolean).join(" ")} - SEO Audit.pdf`;
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1120, height: 1000 });
    await page.goto(pathToFileURL(join(dir, "report.html")).href, { waitUntil: "networkidle0", timeout: 120000 });
    await page.evaluateHandle("document.fonts.ready");
    await page.emulateMediaType("screen");
    const h = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
    // Layout check, so nobody has to eyeball the PDF: clipped code, wide tables, missing screenshots.
    const problems = await page.evaluate(() => [
      ...[...document.querySelectorAll("pre")].filter(e => e.scrollWidth > e.clientWidth + 2).map(e => "code block clipped: " + e.textContent.trim().slice(0, 60)),
      ...[...document.querySelectorAll("table")].filter(e => e.scrollWidth > e.parentElement.clientWidth + 2).map(e => "table wider than the page: " + e.textContent.trim().slice(0, 60)),
      ...[...document.images].filter(i => !i.complete || !i.naturalWidth).map(i => "image missing: " + i.getAttribute("src")),
      ...[...document.querySelectorAll(".issue")].filter(e => e.scrollWidth > e.clientWidth + 2).map(e => "issue overflows: " + e.id)]);
    for (const p of problems) console.warn("LAYOUT: " + p);
    if (!problems.length) console.log("layout check: no clipped code, wide tables or missing images");
    const maxPx = 19000; // Chrome's single-page limit is about 200 inches
    // Taller reports are scaled down to stay one page (vector text stays sharp); very tall ones are split.
    const scale = h <= maxPx ? 1 : maxPx / (h + 2) >= 0.4 ? Math.floor(maxPx / (h + 2) * 1000) / 1000 : 1;
    await page.pdf({ path: join(dir, name), width: Math.floor(1120 * scale) + "px", height: Math.min(Math.ceil((h + 2) * scale), maxPx) + "px", scale,
      printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    opened = join(dir, name);
    console.log(`${name}: 1120x${h}px${scale < 1 ? `, scaled to ${Math.round(scale * 100)}% to fit one page` : h > maxPx ? ", split into several pages" : ", single page"}`);
  } finally { await browser.close(); }
}

console.log("Report: " + opened);
if (!rest.includes("--no-open") && !process.env.SEO_AUDIT_NO_OPEN && openFile(opened)) console.log("Opened in the default viewer.");
// Give the detached viewer process a moment to start before exiting.
setTimeout(() => process.exit(process.exitCode || 0), 300);
