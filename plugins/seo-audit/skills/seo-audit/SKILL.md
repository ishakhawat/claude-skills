---
name: seo-audit
description: Full SEO audit of one live web page on any platform (WordPress, Elementor, Shopify, Wix, Squarespace, Webflow, Laravel with Inertia/Vue/Livewire, Next.js, Nuxt, React, Drupal or hand-coded), including local dev sites such as *.test, delivered as a designed HTML report and a single-page PDF. It has numbered issues with Critical/High/Medium/Low severity, live before/after HTML, desktop and 390px mobile screenshots, proposed-fix mockups, Lighthouse mobile metrics, a scorecard of 60+ automated checks, a fix checklist and a list of what already passes. Use this whenever the user asks to audit a page or URL, for an SEO report or PDF, a page build review, a technical SEO check, "what's wrong with this page", or an audit report to share with a developer or client, even if they only paste a URL and say "audit".
---

# SEO audit report

Produces a developer-ready audit of one page: a long single-page PDF plus the HTML it was printed from. Every issue says where the problem is (element locator, setting path, file) and how to fix it, with evidence from the live page next to the proposed fix.

Speed matters: the scripts collect everything in one parallel run (about 30–60 s) and render the report from JSON, so your time goes into judgment and writing, not plumbing. Don't open the large JSON files unless `summary.md` leaves a question open.

`$SKILL` below means this skill's base directory (shown when the skill loads).

## Inputs

- **URL** (required). One page per report. For several pages, start all the `audit.mjs` runs at once in the background, each into its own folder. They run in parallel, and Lighthouse runs take turns automatically, because two at once make each other fail.
- Local dev URLs (Herd/Valet `*.test`, `localhost`) work; self-signed certificates are accepted. Skip findings that only exist because it's a dev environment (no HSTS, debug bar) unless the user asks.
- **Site name and page name** for the title, e.g. "Acme" and "Pricing page". Derive them from the title tag or H1 if not given.

Work in a new folder in the current directory, `seo-audit-<host>-<slug>/`, unless the user names one.

## Step 1: Setup (first run only, about 20 s)

```bash
node "$SKILL/scripts/setup.mjs"
```

Installs puppeteer-core and Lighthouse into `~/.cache/claude-seo-audit` and checks for Chrome and Python 3. If Chrome or Python is missing, tell the user what to install and stop.

## Step 2: Collect everything (one command)

```bash
node "$SKILL/scripts/audit.mjs" <URL> <out>
```

It runs these in parallel: the raw-HTML collector (indexing, meta, headings, images, links, schema, platform), Lighthouse mobile, and a Chrome session at 1440 px and 390 px. It writes `data/summary.md`, `data/checks.json` (pass/warn/fail with suggested severity), the raw JSON, and `shots/desktop-top.png`, `shots/mobile-top.png` and `shots/desktop-full.jpg`. Use `--no-lighthouse` only if Lighthouse keeps failing, and say so in the report.

## Step 3: Read the page

Read `data/summary.md` in full. It has the platform, the scores, every failed or warning check with details, the heading outline with locators, and the rendered page section by section. Then look at `shots/mobile-top.png` and `shots/desktop-top.png`.

Read the section text like a visitor would. The checks find markup problems, but the most valuable findings usually come from reading: copy left over from another page or audience, an Inertia/Vue/React page whose text and head tags only exist after JavaScript (no SSR), a card that repeats another card's text, a photo of the wrong product, a counter that renders "0+" in the HTML, or a broken sentence. If a section looks suspicious, screenshot it (Step 5) to confirm.

## Step 4: Decide the issues

Turn the checks and your reading into **8–16 issues**. Merge related findings (all alt-text problems in one issue, all heading problems in one). A page with 40 small issues is a page where nothing gets fixed. Use the suggested severity from the check as a starting point and adjust for impact. See `references/issue-catalog.md` for default severities, where to fix things on each platform, and wording.

| Severity | Meaning |
|---|---|
| Critical | Blocks indexing or the launch: noindex, canonical elsewhere, robots.txt block, 4xx/5xx |
| High | Hurts visitors or rankings right away: broken main CTA, LCP > 4 s, headline covered on mobile, several H1s, content only rendered by JS |
| Medium | Cleanup that matters: wrong or leftover copy, alt text, heavy scripts, stale social tags, hidden elements |
| Low | Cleanup: schema details, accessibility counts, `#` links, sitewide menu issues |

Write titles as plain statements with the number that matters: "Hero image is lazy-loaded, giving a 22-second LCP on mobile", not "LCP optimisation".

## Step 5: Screenshots for before/after (one command)

Only for issues where a picture helps (layout, pop-ups, wrong images, missing sections). Write `<out>/shots.json` and take them all in one browser session:

```json
[{"out": "shots/b3-before.png", "width": 390},
 {"out": "shots/b3-after.png", "width": 390, "js": "document.querySelector('#popup')?.remove()"},
 {"out": "shots/b5-before.png", "selector": "[data-id=\"fc9f1de\"]"},
 {"out": "shots/b5-after.png", "selector": "[data-id=\"fc9f1de\"]", "inject": "data/b5-after.js"}]
```

```bash
node "$SKILL/scripts/browser.mjs" shots <URL> <out>/shots.json
```

`js` or `inject` edits the page in the local browser before the shot, which is how you make an "After · Proposed" mockup. Keep mockups honest: show only what the Fix box proposes. If a pop-up, cookie bar or chat bubble gets in the way of a shot that is not about it, add `"hide": "#popup-id, .cookie-bar"` (the overlay locators are in `summary.md`). Use the locators from `summary.md` as selectors. `shots/mobile-top.png` and `shots/desktop-top.png` already exist, so reuse them as "before" shots where they fit.

## Step 6: Write report.json and build

Write `<out>/report.json`. Its format is in `references/report-json.md`; read that file the first time. Each issue has `title`, `short`, `severity`, `where`, `loc`, `body`, optional evidence `blocks` (`code`, `shots`, `metrics`, `table`, `outline`, `note`), `fix` and `check`.

For each issue:
1. **loc**: the exact place, such as the element locator or builder ID, the plugin or setting path, or the file. If you know the same problem exists on other pages, say so here.
2. **body**: 2–4 sentences covering what is wrong, why it matters to Google or visitors, and how it probably happened. Define jargon once, in passing.
3. **blocks**: real evidence. Show the live markup trimmed with `...` against the corrected markup, or screenshots, or metric tiles, or a table.
4. **fix**: name the exact setting, field or file, in the platform's own words. Give a Best fix and a Quick fix when both exist, and put any proposed copy in quotes.

Then build:

```bash
node "$SKILL/scripts/build.mjs" <out>
```

This re-fetches the page to confirm it hasn't changed, then writes `report.html` and `<Site> <Page> - SEO Audit.pdf`. The severity counts, IDs, scorecard, Lighthouse tiles, checklist, passing checks and footer are generated for you. If it warns that the page changed, re-check the affected issues and rebuild.

Check the PDF before handing it over: look for clipped code blocks or missing screenshots, either by viewing the HTML or by rendering crops of the PDF.

## Step 7: Hand it over

Give the user:
- the PDF and HTML paths
- the severity counts
- the 2–3 issues to fix first
- anything you could not test (a widget that didn't load, Lighthouse failing)

Offer to publish the HTML as a shareable link if that's available.

## Writing rules

- Report only what you verified on the live page, and say how: raw HTML, rendered page, or a Lighthouse run. If a tool failed, say what you used instead.
- Quote real element IDs, file names and URLs in `<code>`.
- Use sentence case for titles. No exclamation marks, no marketing tone.
- Write for a developer who has never seen the page.
- Measurements from this machine (TTFB, Lighthouse) are lab data. Say so where it matters.
