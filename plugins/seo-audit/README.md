# seo-audit

An SEO audit of one live page that a developer can act on. You give Claude a URL; it collects evidence from the live page, decides what matters, and produces:

- **`report.html`** and **`<Site> <Page> - SEO Audit.pdf`**: one long page with numbered issues (Critical / High / Medium / Low). Each issue has the exact location, live HTML before and after, desktop and 390 px mobile screenshots with "after" mockups, Lighthouse tiles, and a Fix box written in the platform's own settings language.
- A **scorecard** of 60+ automated checks across indexing, meta and social, content and headings, images and media, links, structured data, performance, mobile UX, accessibility, security and AI search.
- **PageSpeed report**: Google PageSpeed Insights mobile and desktop scores and lab metrics, real-user Core Web Vitals from the Chrome UX Report, and **TTFB** split into DNS, connect, TLS and server wait, with cached vs uncached timing and cache/CDN headers.
- **Road to 100**: every Lighthouse check that keeps Performance, Accessibility, Best practices or SEO below 100, with the files or elements causing it on this page and how to fix it, ranked by impact.
- A **fix checklist** in priority order, and an **"Already in good shape"** list so nobody breaks what works.

## Works on any stack

It detects the platform and writes fixes for it:

- WordPress (Elementor, Gutenberg, Divi, Bricks…) with Yoast, Rank Math or AIOSEO
- Shopify, Wix, Squarespace, Webflow, Framer
- Laravel with Inertia (Vue/React), Livewire or Blade
- Next.js, Nuxt, Astro, Gatsby and SPAs
- Drupal, Joomla, Magento, or hand-coded sites

It compares the raw HTML with the rendered page, so it catches:
- Inertia/Vue/React pages whose text and head tags only exist after JavaScript runs.
- Soft errors: a 200 response that is really a PHP or Laravel error page.

Local dev URLs (`*.test`, `localhost`) work too.

## Usage

```
/seo-audit https://example.com/pricing/
```

or just: "audit this page and make a report: https://…"

## How it stays fast

| Step | Time |
|---|---|
| Setup (first run only) | about 20 s |
| Evidence: raw HTML, link check, sitemap lookup, Lighthouse and a desktop + mobile Chrome session, all in parallel | 20–45 s |
| Before/after screenshots, in one browser session | about 10 s |
| Report: Claude writes only `report.json`; `build.mjs` renders HTML and PDF and re-verifies the page | about 10 s |

Claude reads a condensed `summary.md` instead of large JSON files.

## Google PageSpeed API key (optional, free)

Without a key, Google's shared PageSpeed quota is usually used up, so scores come from Lighthouse run locally (same engine, no real-user data). With a key you get Google's own PageSpeed numbers and real-user Core Web Vitals:

1. Get a key: https://developers.google.com/speed/docs/insights/v5/get-started (Get a Key).
2. Save it once: `node <plugin>/skills/seo-audit/scripts/setup.mjs --pagespeed-key=YOUR_KEY`, or set `PAGESPEED_API_KEY`.

## Requirements

- Node.js 18+
- Python 3
- Google Chrome (or Chromium/Edge; set `CHROME_PATH` for a custom location)

The first run installs `puppeteer-core` and `lighthouse` into `~/.cache/claude-seo-audit`. No browser is downloaded.

## Scripts

You can also run the scripts yourself:

```bash
S=plugins/seo-audit/skills/seo-audit/scripts
node $S/setup.mjs
node $S/audit.mjs https://example.com/ out/        # evidence + data/summary.md
node $S/browser.mjs shots https://example.com/ out/shots.json
node $S/build.mjs out/                              # out/report.json -> report.html + PDF, then opens the PDF
```

The report format is described in [references/report-json.md](skills/seo-audit/references/report-json.md).

## Where reports are saved

In the folder Claude Code is working in, as `seo-audit-<host>-<page>/`. When Claude runs without a project folder (a temp or scratch folder), reports go to `~/SEO Audits/` instead. Set `SEO_AUDIT_OUT` to choose another folder, and `SEO_AUDIT_NO_OPEN=1` to stop the PDF from opening when the build finishes.
