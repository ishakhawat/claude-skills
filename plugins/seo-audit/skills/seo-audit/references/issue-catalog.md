# Issue catalog

Common problems, which check finds them, the default severity, and wording that works. Adapt it to what you actually verified; never copy a claim you didn't check.

## Contents
1. Problems and default severity
2. Where to fix it, by platform
3. Wording patterns
4. Reading Lighthouse JSON

## 1. Problems and default severity

| # | Problem | Check id / where to look | Default |
|---|---|---|---|
| 1 | noindex (meta, X-Robots-Tag, or added by JavaScript) | `noindex`, `js_robots` | Critical |
| 2 | Canonical pointing to another URL; several canonicals | `canonical`, `canonical_multi` | Critical / High |
| 3 | robots.txt blocks the URL | `robots_txt` | Critical |
| 4 | Page not 200, soft 404, redirect chain | `status`, `redirects` | Critical / Medium |
| 5 | http:// or the other host (www / non-www) serves a duplicate | `http`, `host` | High |
| 6 | Not in the XML sitemap | `sitemap` | Medium (part of #1 if noindexed) |
| 7 | Text only appears after JavaScript (client-rendered SPA) | `js_content` | High |
| 8 | No H1, or several visible H1s (responsive copies) | `h1`, `h1_visible`, `dup_h` | High |
| 9 | Main image lazy-loaded; LCP > 4 s; huge hero video on mobile | `lcp_lazy`, `lcp`, `video`, `weight` | High |
| 10 | Pop-up, chat or cookie bar covers the headline on mobile | `h1_cover`, `overlay` | High |
| 11 | Button / menu link to an anchor or page that doesn't exist | `anchors`, `broken` | High |
| 12 | Wrong photo, wrong link, card that never shows | reading `summary.md` sections + screenshots, `hidden_all` | High |
| 13 | Copy left over from another page or audience | reading the sections | Medium |
| 14 | Broken sentence, typo, placeholder text, "0+" counters in HTML | reading; `numeric_only` | Medium |
| 15 | Invisible characters (U+2028, zero-width) in title, headings, tags | `invisible` | Medium |
| 16 | Social tags stale or copied from another page | `og`, `og_stale`, `og_url`, `og_image` | Medium |
| 17 | Elements hidden on every device | `hidden_all` | Medium |
| 18 | Heading skips; headings used for styling; menus with headings before the H1 | `skips`, `before_h1` | Medium / Low |
| 19 | Empty alt, placeholder alt, camera file names, no width/height, JPEG/PNG only | `alt`, `bad_alt`, `camera`, `dims`, `formats` | Medium / Low |
| 20 | Heavy or unused scripts; render-blocking head scripts; big DOM | Lighthouse `unused-javascript`, `network-requests`; `blocking`, `dom` | Medium |
| 21 | Thin content (< 300 words of main content) | `words` | Medium |
| 22 | hreflang without self-reference or x-default | `hreflang` | Medium |
| 23 | Schema missing, invalid or out of date | `present`, `errors`, `lower`, `org`, `crumbs`, raw JSON-LD | Low (High if parse errors on product pages) |
| 24 | Accessibility failures | `a11y_*` | Low |
| 25 | Placeholder `#` links, links without names, internal redirects | `hash`, `nameless`, `redirecting` | Low |
| 26 | Title > 60 or description outside 70–160 characters | `title`, `description` | Low |
| 27 | Mixed content, missing HSTS | `mixed`, `hsts` | Medium / Low |
| 28 | AI crawlers blocked in robots.txt | `ai_bots` | Low (mention only if the owner wants AI search traffic) |

Severity meaning, as stated in the report: **Critical** blocks indexing or the launch; **High** hurts visitors or rankings right away; **Medium** is cleanup that matters; **Low** is cleanup.

Merge related checks into one issue (all alt-text findings, all heading findings, all schema findings). A check that passes is not an issue; it shows in "Already in good shape" automatically.

## 2. Where to fix it, by platform

Use `collect.platform` to name the right setting. If the platform is unknown, describe the HTML change.

| Platform | Locating elements | Indexing / canonical | Images & lazy-load | Notes |
|---|---|---|---|---|
| WordPress + Elementor | `[data-id="…"]` is the Elementor element ID (Navigator) | Yoast / Rank Math / AIOSEO › page › Advanced | Media Library alt; WP Rocket › Media › Excluded images or LiteSpeed › Image Optimization | Heading widget › HTML Tag; Advanced › Responsive to hide; CSS ID under Advanced |
| WordPress + Gutenberg / Divi / Bricks | block or module class in the locator | same SEO plugins | same | Divi: module › Advanced › Visibility |
| Shopify | section/block IDs `shopify-section-…` | theme.liquid / SEO fields in the product or page admin; robots.txt.liquid | Admin › image alt; theme `loading="lazy"` on first section | Apps inject scripts: Online Store › Apps |
| Wix | element IDs `comp-…` | Page › SEO Basics / Advanced SEO | Image settings › "What's in the image?" | limited code control; say so |
| Squarespace | `section[data-section-id]` | Page settings › SEO | Image block › alt (filename by default) | Code injection for head tags |
| Webflow | class names; Designer element | Page settings › SEO / Open Graph | Image settings › Alt text; Lazy load toggle | Custom code in page settings |
| Next.js / React / Vue | component name if visible in class names; otherwise the CSS locator | `metadata` / `<Head>` / `generateMetadata`; `robots.ts`, `sitemap.ts` | `next/image` `priority` for the LCP image | Check server rendering when `js_content` fails |
| Laravel + Inertia (Vue / React) | Inertia page component (`summary.md` shows it, e.g. `Pages/Pricing.vue` for `Pricing`); CSS locator inside it | `<Head>` from `@inertiajs/vue3` or `@inertiajs/react` for title/meta/canonical; turn on SSR (`ssr.js` + `php artisan inertia:start-ssr`) so head tags and text are in the HTML; `public/robots.txt`; sitemap with `spatie/laravel-sitemap` | `loading="eager"` + `fetchpriority="high"` on the hero `<img>` in the page component; Vite `build.assetsInlineLimit` | Without SSR, crawlers that skip JavaScript see an empty `<div id="app">`; this is usually the top issue |
| Laravel + Livewire / Blade | Blade view (`resources/views/...`), Livewire component class | `<title>` and meta in the layout (`resources/views/layouts/app.blade.php`) with `@yield`/`@section` or a package like `artesaos/seotools` | Blade `<img>` attributes | Server-rendered, so text is in the HTML; check `wire:navigate` pages update the title |
| Laravel (any) | — | `APP_DEBUG=false` in production; a 200 with a Whoops/Ignition or PHP fatal page is a Critical "soft error" | — | `php artisan route:list` to find the controller for a URL |
| Drupal / Joomla / others | CSS locator | Metatag module / SEO extension | media alt field | |

## 3. Wording patterns

- Cause, then consequence: "CSS hides one copy, but both are in the HTML, so search engines read two H1s."
- Say how it probably happened when it's clear: "The section was copied from the residential page and this heading wasn't updated."
- Fix with the platform's own labels: "In the Heading widget (`5ef6ca8`), set HTML Tag to `div`." / "In Shopify admin › Products › SEO, …"
- Give "Best:" and "Quick fix:" when both exist.
- Put proposed copy in quotes inside the Fix box.
- Numbers beat adjectives: "52 of 54 images", "21.9 MB", "15.7 s".
- Timing caveat (the metrics block adds it): "Real phones on Wi-Fi will be faster, but the ranking is the same."

## 4. Reading Lighthouse JSON

Most of what you need is already in `summary.md`. When you need more from `data/lighthouse.json`:
- Scores: `categories.<id>.score * 100` (performance, accessibility, best-practices, seo).
- LCP element: `audits["largest-contentful-paint-element"].details.items[0].items[0].node`.
- Heavy scripts: `audits["unused-javascript"].details.items[].url / wastedBytes`, `audits["network-requests"].details.items[].transferSize`, `audits["bootup-time"]`.
- Accessibility rows: failing audits in `categories.accessibility.auditRefs` with `audits[id].score === 0`; count = `details.items.length`; selectors in `details.items[].node.selector`.
- Metric colours (applied automatically): score 90/50, LCP 2.5/4 s, FCP 1.8/3 s, TBT 200/600 ms, CLS 0.1/0.25.
