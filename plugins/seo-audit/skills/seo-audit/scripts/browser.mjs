#!/usr/bin/env node
// Screenshots for the report, all in one Chrome session.
//
//   node browser.mjs shots <url> <spec.json>      many shots, 3 at a time (fastest)
//   node browser.mjs shot  <url> <out.png> [--width 1440] [--height 900] [--full]
//                          [--selector CSS] [--inject file.js] [--hide CSS,CSS] [--wait ms] [--scroll px]
//   node browser.mjs filmstrip <url> <out.json> [--width 390] [--css file.css] [--sheet out.png]
//                          one load on throttled slow 4G (150 ms RTT, 1.6 Mbps) with 4x CPU
//                          slowdown, like Lighthouse mobile: every painted frame (screencast)
//                          plus the real FCP and LCP (and the LCP element) from the browser;
//                          --css injects a stylesheet before the page parses (an "after" load);
//                          --sheet saves a contact sheet of one frame per second to look at
//
// spec.json is a list of shots; paths are relative to the spec file:
//   [{"out": "shots/b3-before.png", "width": 390},
//    {"out": "shots/b3-after.png",  "width": 390, "inject": "data/b3-after.js"},
//    {"out": "shots/b5-before.png", "selector": "[data-id=\"fc9f1de\"]"},
//    {"out": "shots/b5-after.png",  "selector": "#cards", "js": "document.querySelector('#cards h3').textContent='New'"}]
// Keys: out, width (1440), height, selector, full, js (inline) and/or inject (file), hide (CSS list), scroll, wait.
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { launch, open, warm, sleep, UA_MOBILE, UA_DESKTOP } from "./lib.mjs";
import { writeFileSync } from "node:fs";

const [, , cmd, url, a2, ...rest] = process.argv;
const opt = (name, def) => { const i = rest.indexOf("--" + name); return i < 0 ? def : (rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : true); };
if (!cmd || !url || !a2 || cmd === "--help") {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 19).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(1);
}

async function shoot(browser, s) {
  const width = +(s.width || 1440);
  const { page } = await open(browser, url, width, { height: s.height ? +s.height : undefined, wait: s.wait ? +s.wait : 1500 });
  try {
    // Finish scroll-in and fade animations at once, so shots aren't caught half-faded.
    await page.addStyleTag({ content: "*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important}" }).catch(() => {});
    if (s.selector || s.full) await warm(page);
    if (s.hide) await page.addStyleTag({ content: `${s.hide} { display:none !important }` });
    const scripts = [s.js, s.inject && readFileSync(s.inject, "utf8")].filter(Boolean);
    for (const js of scripts) await page.evaluate(js);
    if (scripts.length) await sleep(900);
    if (s.scroll) { await page.evaluate(y => window.scrollTo(0, +y), s.scroll); await sleep(500); }
    mkdirSync(dirname(s.out), { recursive: true });
    if (s.selector) {
      const el = await page.$(s.selector);
      if (!el) throw new Error("selector not found: " + s.selector);
      // Scroll twice so lazy content above settles, then capture the element itself.
      await el.evaluate(e => e.scrollIntoView({ block: "start" })); await sleep(900);
      await el.evaluate(e => e.scrollIntoView({ block: "start" })); await sleep(400);
      await el.screenshot({ path: s.out, captureBeyondViewport: true });
    } else {
      await page.screenshot({ path: s.out, fullPage: !!s.full });
    }
    console.log("saved " + s.out);
  } catch (e) {
    console.error(`${s.out}: ${e.message}`); process.exitCode = 1;
  } finally { await page.close(); }
}

// One throttled load, recorded frame by frame. Times are from navigation start.
async function filmstrip(browser, out, width, css, sheet) {
  const page = await browser.newPage();
  const mobile = width < 768;
  await page.setUserAgent(mobile ? UA_MOBILE : UA_DESKTOP);
  await page.setViewport({ width, height: mobile ? 844 : 900, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  if (css) await page.evaluateOnNewDocument(css => {
    const st = document.createElement("style"); st.textContent = css;
    new MutationObserver((_, o) => { if (document.head) { document.head.appendChild(st); o.disconnect(); } }).observe(document, { childList: true, subtree: true });
  }, css);
  await page.evaluateOnNewDocument(() => {
    window.__m = { fcp: 0, lcp: 0, el: "" };
    new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === "first-contentful-paint") window.__m.fcp = e.startTime; }).observe({ type: "paint", buffered: true });
    new PerformanceObserver(l => { for (const e of l.getEntries()) { window.__m.lcp = e.startTime;
      const el = e.element; window.__m.el = el ? el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "") : ""; } })
      .observe({ type: "largest-contentful-paint", buffered: true });
  });
  // Chrome's screencast sends a frame each time the screen changes, stamped with
  // when it was painted (the DevTools Performance filmstrip uses the same).
  const raw = [], start = Date.now(), MAX = 20000;
  cdp.on("Page.screencastFrame", f => { raw.push({ at: f.metadata.timestamp * 1000, data: f.data }); cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 50, maxWidth: width, maxHeight: mobile ? 844 : 900, everyNthFrame: 1 });
  let loadedAt = 0;
  page.goto(url, { waitUntil: "load", timeout: MAX + 10000 }).then(() => { loadedAt = Date.now(); }, () => { loadedAt = Date.now(); });
  while (Date.now() - start < MAX && !(loadedAt && Date.now() > loadedAt + 2500)) await sleep(200);
  await cdp.send("Page.stopScreencast").catch(() => {});
  const m = await page.evaluate(() => ({ ...window.__m, origin: performance.timeOrigin })).catch(() => null);
  await page.close();
  if (!m) throw new Error("page did not load");
  // Keep one frame per 250 ms (animations paint 60 a second) plus the exact first-paint and LCP frames.
  const all = raw.map(f => ({ t: Math.round(f.at - m.origin), src: "data:image/jpeg;base64," + f.data })).filter(f => f.t >= 0);
  const keep = new Set([all.find(f => f.t >= m.fcp), all.find(f => f.t >= m.lcp)]);
  const frames = all.filter((f, i) => keep.has(f) || i === 0 || Math.floor(f.t / 250) !== Math.floor(all[i - 1].t / 250));
  writeFileSync(out, JSON.stringify({ url, width, css: css || undefined, network: "slow 4G (150 ms, 1.6 Mbps), 4x CPU", fcp: Math.round(m.fcp), lcp: Math.round(m.lcp), lcp_element: m.el, load: Math.round(loadedAt - m.origin), frames }));
  if (sheet) {
    // One frame per second (plus first paint and LCP), labelled, in one image.
    const pick = frames.filter((f, i) => i === 0 || keep.has(f) || Math.floor(f.t / 1000) !== Math.floor(frames[i - 1].t / 1000)).slice(0, 24);
    const p = await browser.newPage();
    await p.setViewport({ width: 6 * 200 + 70, height: 400, deviceScaleFactor: 1 });
    await p.setContent(`<body style="margin:0;padding:10px;font:13px system-ui;background:#fff;display:grid;grid-template-columns:repeat(6,200px);gap:10px">${pick.map(f =>
      `<div style="text-align:center"><img src="${f.src}" style="width:200px;border:${keep.has(f) ? "3px solid #c00" : "1px solid #ccc"};box-sizing:border-box"><div>${(f.t / 1000).toFixed(1)} s${f.t >= m.lcp && keep.has(f) ? " LCP" : keep.has(f) ? " first paint" : ""}</div></div>`).join("")}</body>`);
    mkdirSync(dirname(sheet), { recursive: true });
    await p.screenshot({ path: sheet, fullPage: true }); await p.close();
  }
  console.log(`filmstrip: ${frames.length} frames, FCP ${(m.fcp / 1000).toFixed(1)} s, LCP ${(m.lcp / 1000).toFixed(1)} s (${m.el}) -> ${out}`);
}

const browser = await launch();
try {
  if (cmd === "shot") {
    await shoot(browser, { out: a2, width: opt("width", 1440), height: opt("height"), full: opt("full", false), selector: opt("selector"),
      inject: opt("inject"), hide: opt("hide"), wait: opt("wait"), scroll: opt("scroll") });
  } else if (cmd === "filmstrip") {
    await filmstrip(browser, a2, +opt("width", 390), opt("css") ? readFileSync(opt("css"), "utf8") : null, opt("sheet"));
  } else if (cmd === "shots") {
    const base = dirname(resolve(a2));
    const list = JSON.parse(readFileSync(a2, "utf8")).map(s => ({ ...s, out: resolve(base, s.out), inject: s.inject && resolve(base, s.inject) }));
    const queue = [...list];
    await Promise.all(Array.from({ length: Math.min(3, list.length) }, async () => { while (queue.length) await shoot(browser, queue.shift()); }));
  } else {
    console.error("unknown command " + cmd); process.exitCode = 1;
  }
} finally { await browser.close(); }

process.exit(process.exitCode || 0);
