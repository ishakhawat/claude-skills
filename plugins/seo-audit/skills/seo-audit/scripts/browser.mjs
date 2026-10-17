#!/usr/bin/env node
// Screenshots for the report, all in one Chrome session.
//
//   node browser.mjs shots <url> <spec.json>      many shots, 3 at a time (fastest)
//   node browser.mjs shot  <url> <out.png> [--width 1440] [--height 900] [--full]
//                          [--selector CSS] [--inject file.js] [--hide CSS,CSS] [--wait ms] [--scroll px]
//
// spec.json is a list of shots; paths are relative to the spec file:
//   [{"out": "shots/b3-before.png", "width": 390},
//    {"out": "shots/b3-after.png",  "width": 390, "inject": "data/b3-after.js"},
//    {"out": "shots/b5-before.png", "selector": "[data-id=\"fc9f1de\"]"},
//    {"out": "shots/b5-after.png",  "selector": "#cards", "js": "document.querySelector('#cards h3').textContent='New'"}]
// Keys: out, width (1440), height, selector, full, inject (file) or js (inline), hide (CSS list), scroll, wait.
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { launch, open, warm, sleep } from "./lib.mjs";

const [, , cmd, url, a2, ...rest] = process.argv;
const opt = (name, def) => { const i = rest.indexOf("--" + name); return i < 0 ? def : (rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : true); };
if (!cmd || !url || !a2 || cmd === "--help") {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 15).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(1);
}

async function shoot(browser, s) {
  const width = +(s.width || 1440);
  const { page } = await open(browser, url, width, { height: s.height ? +s.height : undefined, wait: s.wait ? +s.wait : 1500 });
  try {
    if (s.selector || s.full) await warm(page);
    if (s.hide) await page.addStyleTag({ content: `${s.hide} { display:none !important }` });
    const js = s.js || (s.inject ? readFileSync(s.inject, "utf8") : null);
    if (js) { await page.evaluate(js); await sleep(900); }
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

const browser = await launch();
try {
  if (cmd === "shot") {
    await shoot(browser, { out: a2, width: opt("width", 1440), height: opt("height"), full: opt("full", false), selector: opt("selector"),
      inject: opt("inject"), hide: opt("hide"), wait: opt("wait"), scroll: opt("scroll") });
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
