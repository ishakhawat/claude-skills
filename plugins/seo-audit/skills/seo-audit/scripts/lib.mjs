// Shared helpers: dependency loading, Chrome launch, page inspection.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
// Dependencies live outside the plugin folder so plugin updates don't wipe them.
export const CACHE = process.env.SEO_AUDIT_HOME || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "claude-seo-audit");

export function requireDep(name) {
  for (const base of [CACHE, HERE]) {
    try { return createRequire(join(base, "package.json"))(name); } catch {}
  }
  console.error(`${name} is not installed. Run:  node ${resolve(HERE, "setup.mjs")}`);
  process.exit(2);
}

export function depPath(rel) {
  for (const base of [CACHE, HERE]) { const p = join(base, "node_modules", rel); if (existsSync(p)) return p; }
  return null;
}

export const CHROME = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find(p => p && existsSync(p));

export const UA_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
export const UA_MOBILE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launch() {
  if (!CHROME) { console.error("Google Chrome not found. Install it or set CHROME_PATH."); process.exit(2); }
  const puppeteer = requireDep("puppeteer-core");
  return puppeteer.launch({ executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--ignore-certificate-errors", "--hide-scrollbars", "--font-render-hinting=none", "--autoplay-policy=no-user-gesture-required"] });
}

// Open a URL at a width. Collects console errors and failed requests.
export async function open(browser, url, width, { height, wait = 1500 } = {}) {
  const page = await browser.newPage();
  const mobile = width < 768;
  await page.setUserAgent(mobile ? UA_MOBILE : UA_DESKTOP);
  await page.setViewport({ width, height: height || (mobile ? 844 : 900), deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  const errors = [], failed = [], media = [];
  page.on("pageerror", e => errors.push(String(e.message || e).slice(0, 200)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  page.on("requestfailed", r => failed.push({ url: r.url().slice(0, 200), error: r.failure()?.errorText }));
  page.on("response", r => {
    const s = r.status();
    if (s >= 400) failed.push({ url: r.url().slice(0, 200), status: s });
    const t = r.request().resourceType();
    if (t === "media") media.push({ url: r.url().slice(0, 200), bytes: +(r.headers()["content-length"] || 0) });
  });
  // "load" plus a capped idle wait: networkidle never settles on pages that stream video or poll.
  await page.goto(url, { waitUntil: "load", timeout: 45000 }).catch(e => errors.push("goto: " + e.message));
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 6000 }).catch(() => {});
  await sleep(wait);
  return { page, errors, failed, media };
}

// Scroll through the page so lazy images and widgets load, then back to top.
export async function warm(page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 800) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 90)); }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await sleep(600);
}

// Runs in the page. Locator style matches collect.py: #id, [data-id], landmark tags.
const LOC = `(el) => {
  const parts = []; let e = el;
  while (e && e !== document.body && parts.length < 3) {
    const id = e.id;
    if (id && !/[0-9a-f]{10,}|\\d{5,}|^(:r|__)/.test(id)) { parts.unshift('#' + id); break; }
    const did = e.getAttribute && e.getAttribute('data-id');
    if (did && e.classList.contains('elementor-element')) { parts.unshift('[data-id="' + did + '"]'); break; }
    if (/^(SECTION|HEADER|FOOTER|NAV|MAIN|ARTICLE|ASIDE|FORM)$/.test(e.tagName))
      parts.unshift(e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/)[0] : ''));
    e = e.parentElement;
  }
  return parts.join(' > ') || el.tagName.toLowerCase();
}`;

export async function inspect(page) {
  return page.evaluate(new Function("LOCSRC", `
    const loc = eval(LOCSRC);
    const vis = el => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && +s.opacity > 0 && r.width > 0 && r.height > 0; };
    const h1s = [...document.querySelectorAll("h1")].map(h => ({ text: h.innerText.trim().slice(0, 120), visible: vis(h), loc: loc(h),
      top: Math.round(h.getBoundingClientRect().top + scrollY) }));
    const vh = innerHeight, vw = innerWidth;
    let lcp = null, best = 0;
    for (const im of document.images) {
      const r = im.getBoundingClientRect(); if (!vis(im) || r.top > vh) continue;
      const area = Math.min(r.width, vw) * Math.min(r.height, vh - Math.max(r.top, 0));
      if (area > best) { best = area; lcp = im; }
    }
    const lcpInfo = lcp && { src: lcp.currentSrc || lcp.src, alt: lcp.getAttribute("alt"), loading: lcp.getAttribute("loading"),
      fetchpriority: lcp.getAttribute("fetchpriority"), lazy_attr: !!(lcp.dataset.lazySrc || lcp.dataset.src) || /lazy/.test(lcp.className),
      loc: loc(lcp), rendered: [Math.round(lcp.width), Math.round(lcp.height)], natural: [lcp.naturalWidth, lcp.naturalHeight] };
    const h1 = [...document.querySelectorAll("h1")].find(vis); const covered = [];
    if (h1) {
      const r = h1.getBoundingClientRect();
      for (const [x, y] of [[r.left + 10, r.top + 5], [r.left + r.width / 2, r.top + r.height / 2], [r.right - 10, r.bottom - 5]]) {
        if (y < 0 || y > vh) continue;
        const top = document.elementFromPoint(x, y);
        if (top && !h1.contains(top) && top !== h1 && !top.contains(h1)) covered.push(loc(top));
      }
    }
    const buttons = [...document.querySelectorAll("a[class*=button],a[class*=btn],button,input[type=submit],[role=button],a[class*=cta]")]
      .filter(b => vis(b) && !b.closest("nav,header,[role=navigation],[class*=menu],[id*=menu]")).map(b => ({ text: (b.innerText || b.value || "").trim().slice(0, 40), href: b.getAttribute("href"),
        top: Math.round(b.getBoundingClientRect().top + scrollY) }))
      .filter(b => b.text && b.top > 100).sort((a, b) => a.top - b.top);
    const fixed = [...document.querySelectorAll("body *")].filter(e => { const s = getComputedStyle(e); return (s.position === "fixed" || s.position === "sticky") && vis(e); })
      .map(e => { const r = e.getBoundingClientRect(); return { loc: loc(e), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top),
        share: +(Math.min(r.width, vw) * Math.min(r.height, vh) / (vw * vh)).toFixed(2) }; })
      .filter(f => f.w * f.h > 4000).slice(0, 12);
    const overflow = document.documentElement.scrollWidth > vw + 1 ?
      [...document.querySelectorAll("body *")].filter(e => vis(e) && e.getBoundingClientRect().right > vw + 2 && getComputedStyle(e).position !== "fixed")
        .slice(0, 6).map(e => ({ loc: loc(e), right: Math.round(e.getBoundingClientRect().right) })) : [];
    const missingAnchors = [...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute("href").slice(1)).filter(Boolean)
      .filter((t, i, arr) => arr.indexOf(t) === i)
      .filter(t => { try { return !document.getElementById(decodeURIComponent(t)) && !document.getElementsByName(t).length; } catch { return false; } })
      .slice(0, 20);
    const brokenImgs = [...document.images].filter(i => i.complete && i.naturalWidth === 0 && vis(i) && !(i.currentSrc || i.src).startsWith("data:"))
      .map(i => (i.currentSrc || i.src).slice(0, 160)).slice(0, 10);
    const videos = [...document.querySelectorAll("video")].map(v => ({ src: (v.currentSrc || v.src || "").slice(0, 200), visible: vis(v),
      playing: !v.paused, autoplay: v.autoplay, loc: loc(v) }));
    const chat = [...document.querySelectorAll("iframe,div[id]")].map(e => (e.id || e.src || ""))
      .filter(s => /fc_|freshchat|intercom|drift|tawk|crisp|hubspot-messages|zendesk|livechat|tidio|gorgias|olark/i.test(s)).slice(0, 5);
    const text = document.body.innerText || "";
    return { title: document.title, viewport: [vw, vh], doc_height: document.documentElement.scrollHeight,
      dom_nodes: document.getElementsByTagName("*").length, words_rendered: (text.match(/\\w+/g) || []).length,
      h1s, visible_h1_count: h1s.filter(h => h.visible).length,
      canonical_rendered: document.querySelector('link[rel=canonical]')?.href || null,
      description_rendered: document.querySelector('meta[name=description]')?.content || null,
      og_title_rendered: document.querySelector('meta[property="og:title"]')?.content || null,
      robots_rendered: document.querySelector('meta[name=robots]')?.content || null,
      lcp_candidate: lcpInfo, h1_covered_by: [...new Set(covered)],
      first_button: buttons[0] || null, first_button_above_fold: buttons[0] ? buttons[0].top < vh : false,
      fixed_overlays: fixed, large_overlays: fixed.filter(f => f.share >= 0.3),
      horizontal_overflow: overflow, missing_anchor_targets: missingAnchors, broken_images: brokenImgs,
      videos, chat_widgets: chat };
  `), LOC);
}

// Top-level content blocks with their text, so the page can be read section by section.
export async function sections(page) {
  return page.evaluate(new Function("LOCSRC", `
    const loc = eval(LOCSRC);
    const vis = el => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && r.height > 40; };
    let kids = [...document.querySelectorAll('[data-elementor-type="wp-page"] > .e-con, [data-elementor-type="wp-page"] > .elementor-section, [data-elementor-type="wp-page"] > .elementor-inner > .elementor-section-wrap > .elementor-section')];
    if (kids.length < 3) {
      let root = document.querySelector("main,[role=main],#main,#content,#MainContent") || document.body;
      kids = [...root.children];
      while (kids.filter(vis).length === 1 && kids.find(vis).children.length) kids = [...kids.find(vis).children];
    }
    return kids.filter(vis).slice(0, 60).map((el, i) => {
      const r = el.getBoundingClientRect();
      return { n: i + 1, loc: loc(el), top: Math.round(r.top + scrollY), height: Math.round(r.height),
        headings: [...el.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(vis).map(h => h.tagName + " " + h.innerText.trim().replace(/\\s+/g, " ").slice(0, 90)).slice(0, 10),
        text: (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 700),
        images: [...el.querySelectorAll("img")].filter(vis).slice(0, 8).map(im => ({ file: (im.currentSrc || im.src).split("/").pop().split("?")[0].slice(0, 80), alt: im.getAttribute("alt") })),
        links: [...el.querySelectorAll("a[href]")].filter(vis).slice(0, 12).map(a => ((a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 40) + " -> " + a.getAttribute("href")).slice(0, 160)) };
    });
  `), LOC);
}
