// Google PageSpeed Insights, real-user (CrUX) field data, and the "Road to 100"
// list: every failing Lighthouse audit per category with the elements behind it
// and a fix. Works on PageSpeed's lighthouseResult or a local Lighthouse JSON
// (same format).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CACHE } from "./lib.mjs";

// ---------- API key ----------
const CONFIG = join(CACHE, "config.json");
export function psiKey() {
  if (process.env.PAGESPEED_API_KEY) return process.env.PAGESPEED_API_KEY;
  try { return JSON.parse(readFileSync(CONFIG, "utf8")).pagespeed_api_key || null; } catch { return null; }
}
export function savePsiKey(key) {
  mkdirSync(CACHE, { recursive: true });
  let c = {}; try { c = JSON.parse(readFileSync(CONFIG, "utf8")); } catch {}
  c.pagespeed_api_key = key || undefined;
  writeFileSync(CONFIG, JSON.stringify(c, null, 1));
}

// ---------- PageSpeed Insights API ----------
export async function fetchPSI(url, strategy, key) {
  const q = new URLSearchParams({ url, strategy });
  for (const c of ["PERFORMANCE", "ACCESSIBILITY", "BEST_PRACTICES", "SEO"]) q.append("category", c);
  if (key) q.set("key", key);
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 150000);
  try {
    const r = await fetch("https://www.googleapis.com/pagespeedonline/v5/runPagespeed?" + q, { signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const msg = j.error?.message || `HTTP ${r.status}`;
      return { ok: false, status: r.status, msg: r.status === 429 && !key ? "Google's shared PageSpeed quota is used up; add a free API key (setup.mjs --pagespeed-key=KEY)" : msg.slice(0, 200) };
    }
    if (j.lighthouseResult?.runtimeError) return { ok: false, msg: j.lighthouseResult.runtimeError.message };
    return { ok: true, json: j };
  } catch (e) { return { ok: false, msg: e.name === "AbortError" ? "PageSpeed timed out after 150 s" : e.message }; }
  finally { clearTimeout(t); }
}

// CrUX field data from a PSI response: page-level if Google has enough traffic, else origin-level.
const FIELD = [["LARGEST_CONTENTFUL_PAINT_MS", "LCP", "ms"], ["INTERACTION_TO_NEXT_PAINT", "INP", "ms"],
  ["CUMULATIVE_LAYOUT_SHIFT_SCORE", "CLS", "cls"], ["FIRST_CONTENTFUL_PAINT_MS", "FCP", "ms"], ["EXPERIMENTAL_TIME_TO_FIRST_BYTE", "TTFB", "ms"]];
export function fieldData(psi) {
  const pick = le => !le?.metrics ? null : {
    overall: le.overall_category || null, origin_fallback: !!le.origin_fallback,
    metrics: FIELD.filter(([k]) => le.metrics[k]).map(([k, name, unit]) => ({ name, unit,
      p75: unit === "cls" ? le.metrics[k].percentile / 100 : le.metrics[k].percentile, category: le.metrics[k].category })) };
  const page = pick(psi?.loadingExperience), origin = pick(psi?.originLoadingExperience);
  return { page: page && !page.origin_fallback ? page : null, origin };
}

// ---------- Road to 100 ----------
// Lighthouse 12 reports most problems twice: a classic audit and a newer "insight".
// Show the classic one when both fail.
const TWINS = { "render-blocking-insight": ["render-blocking-resources"], "cache-insight": ["uses-long-cache-ttl"],
  "image-delivery-insight": ["modern-image-formats", "uses-optimized-images", "uses-responsive-images", "efficient-animated-content"],
  "font-display-insight": ["font-display"], "dom-size-insight": ["dom-size"], "third-parties-insight": ["third-party-summary"],
  "duplicated-javascript-insight": ["duplicated-javascript"], "legacy-javascript-insight": ["legacy-javascript"],
  "cls-culprits-insight": ["layout-shifts", "unsized-images"], "viewport-insight": ["viewport"],
  "document-latency-insight": ["server-response-time", "redirects", "uses-text-compression"],
  "lcp-phases-insight": ["largest-contentful-paint-element"], "interactive": ["total-blocking-time"], "max-potential-fid": ["total-blocking-time"] };
const SKIP = new Set(["interactive", "max-potential-fid", "valid-source-maps", "network-dependency-tree-insight", "mainthread-work-breakdown",
  "total-byte-weight", "screenshot-thumbnails", "final-screenshot", "main-thread-tasks", "diagnostics", "network-requests"]);
const METRICS = { "first-contentful-paint": "FCP", "largest-contentful-paint": "LCP", "total-blocking-time": "TBT",
  "cumulative-layout-shift": "CLS", "speed-index": "Speed Index" };

// Fix text per audit. {cms} hints are appended when the platform matches.
const FIXES = {
  "server-response-time": "Make the server answer faster: turn on full-page caching so HTML is served from cache, serve it from a CDN edge (Cloudflare APO / cache rules), and find slow database queries or plugins on the origin.",
  "redirects": "Link straight to the final URL. Every redirect costs a full round trip before the page can start loading.",
  "render-blocking-resources": "Stop the listed CSS and JS files from blocking the first paint: add `defer` to scripts in the head, inline the small critical CSS and load the rest with `media=\"print\" onload=\"this.media='all'\"`, and remove files this page does not use.",
  "render-blocking-insight": "Stop the listed CSS and JS files from blocking the first paint: defer scripts, inline critical CSS, load the rest asynchronously.",
  "unused-javascript": "Load JavaScript only on pages that use it: drop the listed bundles from this page, split code by route, and load widgets (maps, chat, sliders) when they scroll into view or on interaction.",
  "unused-css-rules": "Remove CSS this page does not use: generate per-page used CSS (\"Remove unused CSS\") or split stylesheets so this page loads only its own.",
  "unminified-javascript": "Serve the minified build of the listed scripts (enable JS minification in the build tool or optimisation plugin).",
  "unminified-css": "Serve minified CSS (enable CSS minification in the build tool or optimisation plugin).",
  "modern-image-formats": "Serve the listed images as WebP or AVIF, with the original as fallback.",
  "uses-optimized-images": "Recompress the listed images (quality 75–82 is usually invisible) and strip metadata.",
  "uses-responsive-images": "Serve images no bigger than they display: add `srcset` and `sizes` so phones get small files.",
  "offscreen-images": "Lazy-load the listed images below the fold with `loading=\"lazy\"`.",
  "efficient-animated-content": "Replace the animated GIFs with MP4/WebM `<video autoplay muted loop playsinline>`.",
  "uses-text-compression": "Turn on Brotli or gzip compression for HTML, CSS, JS and SVG on the server or CDN.",
  "uses-long-cache-ttl": "Give static files (CSS, JS, images, fonts, video) a long cache lifetime: `Cache-Control: public, max-age=31536000, immutable` with versioned file names.",
  "cache-insight": "Give the listed static files a long cache lifetime (`max-age=31536000, immutable`).",
  "font-display": "Add `font-display: swap` to every `@font-face` so text shows immediately in a fallback font.",
  "font-display-insight": "Add `font-display: swap` to the listed fonts.",
  "uses-rel-preconnect": "Add `<link rel=\"preconnect\">` for the listed third-party origins the page needs early.",
  "prioritize-lcp-image": "Preload the LCP image with `<link rel=\"preload\" as=\"image\" fetchpriority=\"high\">` and add `fetchpriority=\"high\"` to the `<img>`.",
  "lcp-discovery-insight": "Make the LCP image discoverable in the HTML: a real `<img>` (not a CSS background or JS-inserted), not lazy-loaded, with `fetchpriority=\"high\"`.",
  "lcp-lazy-loaded": "Remove `loading=\"lazy\"` from the LCP image (the first big image or the hero) and add `fetchpriority=\"high\"`.",
  "largest-contentful-paint-element": "Shorten the LCP phases shown: if most time is render delay, remove what blocks rendering (head CSS/JS) and main-thread work; if it is load time, make the hero file smaller or give a video a light poster image.",
  "lcp-phases-insight": "Shorten the slowest LCP phase shown (render delay: unblock rendering; load: smaller hero file).",
  "dom-size": "Reduce the number of page elements: remove hidden duplicate sections (desktop + mobile copies), nested wrappers and long off-screen lists.",
  "dom-size-insight": "Reduce the number of page elements (hidden duplicates, nested wrappers).",
  "bootup-time": "Cut JavaScript execution time: remove or defer the heaviest scripts listed, and load third-party widgets on interaction.",
  "mainthread-work-breakdown": "Reduce main-thread work: less JavaScript, simpler CSS, fewer DOM elements.",
  "long-tasks": "Break up the listed long tasks or defer the scripts that cause them.",
  "third-party-summary": "Load the listed third-party scripts later (after interaction or on idle) or remove ones you no longer use.",
  "third-parties-insight": "Load the listed third-party scripts later or remove unused ones.",
  "third-party-facades": "Replace the embed with a lightweight facade (a static preview image that loads the real widget on click), e.g. lite-youtube or a static map image.",
  "legacy-javascript": "Build JavaScript for modern browsers only (drop old polyfills and transforms) for the listed files.",
  "duplicated-javascript": "Load each library once: the listed modules are bundled more than once.",
  "layout-shifts": "Stop the listed elements from moving: give images, videos, ads and embeds fixed `width`/`height` or `aspect-ratio`, and reserve space for late-loading banners.",
  "cls-culprits-insight": "Reserve space for the listed shifting elements (dimensions or `aspect-ratio`, preloaded fonts).",
  "unsized-images": "Add `width` and `height` attributes to the listed images.",
  "non-composited-animations": "Animate only `transform` and `opacity` on the listed elements.",
  "uses-passive-event-listeners": "Mark scroll and touch listeners as `{ passive: true }`.",
  "forced-reflow-insight": "Avoid reading layout (offsetHeight, getBoundingClientRect) right after changing styles in the listed scripts; batch reads before writes.",
  "bf-cache": "Make the page eligible for the back/forward cache: avoid `unload` handlers and `Cache-Control: no-store` on HTML, close open connections on `pagehide`.",
  "total-byte-weight": "Reduce total page weight: lighter hero media, fewer scripts, modern image formats.",
  "image-delivery-insight": "Serve the listed images in WebP/AVIF at the size they display.",
  "viewport": "Add `<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">`.",
  "color-contrast": "Raise text contrast to at least 4.5:1 (3:1 for large text) on the listed elements: darken the text or the background.",
  "link-name": "Give every listed link an accessible name: visible text, or `aria-label` on icon and image links.",
  "button-name": "Give every listed button an accessible name: text, or `aria-label` on icon buttons.",
  "image-alt": "Add descriptive `alt` text to the listed images (empty `alt=\"\"` only for decorative ones).",
  "heading-order": "Use heading levels in order (H1 → H2 → H3) without skipping; style with CSS instead of picking a level for its size.",
  "link-in-text-block": "Make links inside text distinguishable without color: underline them.",
  "label": "Add a `<label>` (or `aria-label`) to every listed form field.",
  "html-has-lang": "Add `lang` to the `<html>` tag, e.g. `<html lang=\"en\">`.",
  "document-title": "Add a `<title>` to the page.",
  "aria-allowed-attr": "Remove ARIA attributes that are not allowed on the listed elements.",
  "aria-hidden-focus": "Remove focusable elements from inside `aria-hidden=\"true\"` containers, or add `tabindex=\"-1\"`.",
  "aria-required-children": "Give the listed ARIA roles the child roles they require (or remove the role).",
  "aria-prohibited-attr": "Remove ARIA attributes that are prohibited on the listed elements.",
  "target-size": "Make the listed tap targets at least 24×24 px with spacing between them.",
  "list": "Only put `<li>` (and script/template) directly inside `<ul>`/`<ol>`.",
  "listitem": "Wrap `<li>` elements in a `<ul>` or `<ol>`.",
  "frame-title": "Add a `title` to every listed `<iframe>`.",
  "duplicate-id-aria": "Make the listed ARIA-referenced IDs unique.",
  "select-name": "Add a label to every listed `<select>`.",
  "meta-viewport": "Remove `user-scalable=no` and `maximum-scale` below 5 from the viewport meta.",
  "tabindex": "Remove `tabindex` values above 0.",
  "errors-in-console": "Fix the listed browser console errors (often a missing file, a blocked script or a JS bug).",
  "inspector-issues": "Fix the issues listed in Chrome DevTools › Issues (usually cookies or mixed content).",
  "third-party-cookies": "The listed third-party service sets cookies Chrome is phasing out; update or remove that embed.",
  "is-on-https": "Serve the page and every resource over HTTPS.",
  "image-aspect-ratio": "Show the listed images at their natural aspect ratio (fix width/height or use `object-fit`).",
  "image-size-responsive": "Serve the listed images at a resolution high enough for their displayed size × device pixel ratio.",
  "deprecations": "Replace the deprecated browser APIs used by the listed scripts.",
  "csp-xss": "Add a Content-Security-Policy header (informational in Lighthouse; does not change the score).",
  "crawlable-anchors": "Give every listed link a real `href` URL (not `#` or `javascript:`); use a `<button>` for things that are not links.",
  "link-text": "Replace generic link text (\"click here\", \"learn more\") with text that says where the link goes.",
  "meta-description": "Add a unique meta description.",
  "is-crawlable": "Remove `noindex` (meta robots or X-Robots-Tag) if this page should be in Google.",
  "robots-txt": "Fix robots.txt so it is valid and returns 200.",
  "hreflang": "Fix the hreflang tags: valid language codes and absolute URLs.",
  "canonical": "Point the canonical to a valid, indexable URL of this page.",
  "http-status-code": "Make the page return 200.",
};
const HINTS = {
  WordPress: { "render-blocking-resources": "WordPress: WP Rocket › File Optimization › Load JavaScript deferred + Optimize CSS delivery (or Perfmatters / LiteSpeed Cache).",
    "unused-javascript": "WordPress: disable plugin assets on pages that do not use them (Perfmatters Script Manager, Asset CleanUp), and enable \"Delay JavaScript execution\" in WP Rocket.",
    "unused-css-rules": "WordPress: WP Rocket › File Optimization › Remove unused CSS; Elementor › Settings › Features › Improved CSS loading.",
    "server-response-time": "WordPress: page cache (WP Rocket, LiteSpeed Cache) plus Cloudflare APO, and Query Monitor to find slow plugins.",
    "modern-image-formats": "WordPress: Imagify, ShortPixel or the CDN's image optimisation (Cloudflare Polish).", "dom-size": "Elementor: avoid duplicate desktop/mobile sections hidden per device; enable Flexbox containers." },
  Shopify: { "unused-javascript": "Shopify: remove leftover app embeds (Online Store › Themes › Customize › App embeds) and uninstalled apps' snippets in theme.liquid.",
    "render-blocking-resources": "Shopify: add `defer` to script tags in theme.liquid and load app scripts after interaction.", "modern-image-formats": "Shopify: use `image_url` with `| image_tag` so the CDN serves WebP/AVIF at the right width." },
  Laravel: { "render-blocking-resources": "Laravel/Vite: keep `@vite` in the head (module scripts are already deferred) and move other `<script>` tags to the end or add `defer`.",
    "unused-javascript": "Laravel/Vite: split by page with Inertia's lazy `resolvePageComponent` (import.meta.glob without `eager`) and keep heavy libraries out of shared chunks.",
    "server-response-time": "Laravel: `php artisan optimize`, OPcache, a response cache (spatie/laravel-responsecache) and Octane; check slow queries with Telescope/Debugbar." },
  "Next.js": { "unused-javascript": "Next.js: `next/dynamic` for heavy client components, and keep `'use client'` boundaries small.",
    "render-blocking-resources": "Next.js: load third-party scripts with `next/script` strategy=\"lazyOnload\".", "modern-image-formats": "Next.js: use `next/image`." },
};

const clean = s => String(s ?? "").replace(/\[([^\]]+)\]\([^)]+\)\.?/g, "$1").replace(/\s+/g, " ").trim();
const kb = b => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB";
function itemsOf(det) {
  if (!det || typeof det !== "object") return [];
  if (det.type === "list") return (Array.isArray(det.items) ? det.items : []).flatMap(itemsOf);
  if (!Array.isArray(det.items)) return [];
  if (det.type === "critical-request-chain" || det.type === "network-tree") return [];
  return (det.items || []).flatMap(it => it.subItems?.items?.length && !it.url && !it.node ? it.subItems.items : [it]);
}
const tailSel = sel => { const parts = sel.split(" > "); let out = parts.pop(); while (parts.length && (parts.at(-1) + " > " + out).length <= 80) out = parts.pop() + " > " + out; return (parts.length ? "… > " : "") + out; };
function describeItem(it) {
  const nl = it.node?.nodeLabel ? clean(it.node.nodeLabel) : "";
  const label = it.node?.selector ? (nl && !it.node.selector.startsWith(nl.slice(0, 20)) ? `"${nl.slice(0, 60)}" ` : "") + tailSel(it.node.selector)
    : /^data:/.test(it.url || "") ? "inline data: image (" + (it.url.slice(5, 20).split(";")[0]) + ")"
    : it.url || it.source?.url || (typeof it.entity === "string" ? it.entity : it.entity?.text) || it.label || it.groupLabel || it.description || it.reason || it.phase || it.name || "";
  const val = it.wastedMs ? Math.round(it.wastedMs) + " ms" : it.wastedBytes ? kb(it.wastedBytes) : it.blockingTime ? Math.round(it.blockingTime) + " ms blocking"
    : it.duration ? Math.round(it.duration) + " ms" : it.total ? Math.round(it.total) + " ms" : it.transferSize ? kb(it.transferSize) : it.totalBytes ? kb(it.totalBytes)
    : it.timing ? Math.round(it.timing) + " ms" : it.percent || "";
  const v = /^0 (KB|ms)/.test(val) ? "" : String(val);
  return { value: v, what: clean(typeof label === "object" ? label.text || JSON.stringify(label) : label).slice(0, 160) };
}

export function roadTo100(lh, platform = {}) {
  if (!lh?.audits || !lh.categories) return null;
  const hintKey = Object.keys(HINTS).find(k => k === platform.cms || k === platform.framework || (k === "Laravel" && /Laravel|Inertia/.test(platform.cms + " " + platform.framework)));
  const out = {};
  for (const [catId, cat] of Object.entries(lh.categories)) {
    const refs = cat.auditRefs.filter(r => lh.audits[r.id]);
    const totalW = refs.reduce((s, r) => s + (r.weight || 0), 0) || 1;
    const failing = refs.map(r => ({ r, a: lh.audits[r.id] })).filter(({ a }) => a.score !== null && a.score < 1 &&
      !["notApplicable", "manual", "informative", "error"].includes(a.scoreDisplayMode));
    const failIds = new Set(failing.map(f => f.r.id));
    const metrics = catId === "performance" ? refs.filter(r => r.group === "metrics" && r.weight).map(r => {
      const a = lh.audits[r.id];
      return { id: r.id, name: METRICS[r.id] || a.title, value: a.displayValue, score: Math.round((a.score ?? 0) * 100), weight: r.weight,
        points_lost: Math.round(r.weight * (1 - (a.score ?? 0)) * 10) / 10 };
    }) : null;
    const audits = failing.filter(({ r }) => !(catId === "performance" && r.group === "metrics") && !SKIP.has(r.id) &&
      !(TWINS[r.id] || []).some(t => failIds.has(t)))
      .map(({ r, a }) => {
        const ms = a.details?.overallSavingsMs || Math.max(0, ...Object.values(a.metricSavings || {}));
        const seen = new Set();
        const items = itemsOf(a.details).map(describeItem).filter(x => x.what && !seen.has(x.what) && seen.add(x.what)).slice(0, 6);
        return { id: r.id, title: clean(a.title), display: clean(a.displayValue || ""), score: a.score,
          points_lost: r.weight ? Math.round(100 * r.weight / totalW * (1 - a.score) * 10) / 10 : 0,
          savings_ms: Math.round(ms || 0), savings_bytes: Math.round(a.details?.overallSavingsBytes || 0), items,
          fix: FIXES[r.id] || clean(a.description).replace(/ Learn (more|how).*$/i, ""), hint: hintKey ? HINTS[hintKey][r.id] || null : null };
      })
      .sort((a, b) => b.points_lost - a.points_lost || b.savings_ms - a.savings_ms || b.savings_bytes - a.savings_bytes);
    out[catId] = { title: cat.title, score: Math.round((cat.score ?? 0) * 100), metrics, audits };
  }
  return out;
}

export function scoresOf(lh) {
  if (!lh?.categories) return null;
  const c = id => lh.categories[id]?.score == null ? null : Math.round(lh.categories[id].score * 100);
  const a = id => lh.audits?.[id]?.numericValue;
  return { performance: c("performance"), accessibility: c("accessibility"), best_practices: c("best-practices"), seo: c("seo"),
    lcp: a("largest-contentful-paint"), fcp: a("first-contentful-paint"), tbt: a("total-blocking-time"), cls: a("cumulative-layout-shift"),
    si: a("speed-index"), version: lh.lighthouseVersion, fetched: lh.fetchTime };
}

export function readJSON(p) { try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { return null; } }

// ---------- summary.md section ----------
const fmtMs = v => v == null ? "–" : v >= 1000 ? (v / 1000).toFixed(1) + " s" : Math.round(v) + " ms";
export function ttfbGrade(ms) { return ms == null ? "" : ms <= 800 ? "good" : ms <= 1800 ? "needs improvement" : "poor"; }
export function speedMarkdown(ttfb, ps, road) {
  const L = ["", "## TTFB (server response, measured from this machine)", ""];
  if (ttfb?.cached) {
    const c = ttfb.cached, b = ttfb.busted;
    L.push(`- Median TTFB ${c.ttfb_ms} ms over ${c.n} requests (${ttfbGrade(c.ttfb_ms)}; Google: good ≤ 800 ms), range ${c.min_ms}–${c.max_ms} ms`,
      `- Breakdown (median): DNS ${c.dns_ms} ms, connect ${c.connect_ms} ms, TLS ${c.tls_ms} ms, server wait ${c.wait_ms} ms`,
      b ? `- Cache-busted (random query string, usually skips the page cache): ${b.ttfb_ms} ms, server wait ${b.wait_ms} ms` : "- Cache-busted: failed",
      `- Redirects before the page: ${ttfb.redirects.length ? ttfb.redirects.map(r => `${r.status} ${r.url} (${r.ms} ms)`).join(" → ") : "none"}`,
      `- Cache/CDN headers: ${Object.entries(ttfb.headers || {}).map(([k, v]) => `${k}: ${v}`).join("; ") || "none"}`);
  } else L.push("- TTFB measurement failed");
  L.push("", "## PageSpeed", "");
  if (ps) {
    for (const ff of ["mobile", "desktop"]) {
      const s = ps[ff];
      L.push(s ? `- ${ff} (${ps.sources[ff]}): Performance ${s.performance}, Accessibility ${s.accessibility}, Best practices ${s.best_practices}, SEO ${s.seo}; LCP ${fmtMs(s.lcp)}, FCP ${fmtMs(s.fcp)}, TBT ${fmtMs(s.tbt)}, CLS ${s.cls?.toFixed(3)}, Speed Index ${fmtMs(s.si)}`
        : `- ${ff}: not measured (${ps.status[ff]})`);
    }
    if (ps.status.mobile !== "ok") L.push(`- Google PageSpeed API: ${ps.status.mobile}`);
    const f = ps.field?.page || ps.field?.origin;
    L.push(f ? `- Real-user data (Chrome UX Report, ${ps.field.page ? "this page" : "whole site (not enough traffic for this page)"}, mobile, p75): Core Web Vitals ${f.overall || "?"}; ${f.metrics.map(m => `${m.name} ${m.unit === "cls" ? m.p75.toFixed(2) : fmtMs(m.p75)} (${m.category})`).join(", ")}`
      : "- Real-user data: none (no PageSpeed key, a local site, or not enough Chrome traffic)");
  }
  if (road?.mobile) {
    L.push("", "## Road to 100 (mobile; auto-listed in the report, read this to pick issues)", "");
    for (const [id, c] of Object.entries(road.mobile)) {
      if (c.score === 100 && !c.audits.length) { L.push(`### ${c.title}: 100`); continue; }
      L.push(`### ${c.title}: ${c.score}`);
      if (c.metrics) L.push("Metrics: " + c.metrics.map(m => `${m.name} ${m.value} (score ${m.score}, −${m.points_lost} pts)`).join("; "));
      for (const a of c.audits) L.push(`- \`${a.id}\` ${a.title}${a.display ? " — " + a.display : ""}${a.points_lost ? ` (−${a.points_lost} pts)` : ""}${a.items.length ? ": " + a.items.slice(0, 3).map(i => `${i.what}${i.value ? " " + i.value : ""}`).join("; ") : ""}`);
    }
    if (road.desktop) {
      const mob = new Set(Object.values(road.mobile).flatMap(c => c.audits.map(a => a.id)));
      const extra = Object.values(road.desktop).flatMap(c => c.audits.filter(a => !mob.has(a.id)).map(a => `\`${a.id}\` ${a.title}`));
      L.push("", `Desktop-only failures: ${extra.join("; ") || "none"}`);
    }
  }
  return L.join("\n") + "\n";
}
