---
name: seo-audit
description: Full SEO audit of one live web page on any platform (WordPress, Elementor, Shopify, Wix, Squarespace, Webflow, Laravel with Inertia/Vue/Livewire, Next.js, Nuxt, React, Drupal or hand-coded), including local dev sites such as *.test, delivered as a designed HTML report and a single-page PDF. It has numbered issues with Critical/High/Medium/Low severity, live before/after HTML, desktop and 390px mobile screenshots, proposed-fix mockups, Lighthouse mobile metrics, a scorecard of 60+ automated checks, a fix checklist and a list of what already passes. Use this whenever the user asks to audit a page or URL, for an SEO report or PDF, a page build review, a technical SEO check, "what's wrong with this page", or an audit report to share with a developer or client, even if they only paste a URL and say "audit".
---

# SEO audit report

Produces a developer-ready audit of one page: a long single-page PDF plus the HTML it was printed from. Every issue says where the problem is (element locator, setting path, file) and how to fix it, with evidence from the live page next to the proposed fix.

Speed matters, and nothing is skipped to get it: the scripts collect everything in one parallel run (about 45–60 s) while the desktop Lighthouse run finishes in the background, writer agents write the issues in parallel while you take screenshots, and the build re-verifies the page and checks its own layout. Your time goes into judgment, not plumbing. Don't open the large JSON files unless `summary.md` leaves a question open.

`$SKILL` below means this skill's base directory (shown when the skill loads).

## Inputs

- **URL** (required). One page per report. For several pages, start one `seo-audit:page-auditor` agent per page in a single message (Agent tool, `subagent_type: "seo-audit:page-auditor"`), giving each its URL, this skill's path (`$SKILL`), and the project folder if there is one. They run at the same time; Lighthouse runs take turns automatically. Then open each PDF and summarise all pages together.
- Local dev URLs (Herd/Valet `*.test`, `localhost`) work; self-signed certificates are accepted. Skip findings that only exist because it's a dev environment (no HSTS, debug bar) unless the user asks.
- **Site name and page name** for the title, e.g. "Acme" and "Pricing page". Derive them from the title tag or H1 if not given.

The report goes in a new folder, `seo-audit-<host>-<slug>/`, inside the current project folder. When Claude was started without a project (the current folder is a temp or scratch folder, the home folder or a system folder), `audit.mjs` puts it in `~/SEO Audits/` instead so the user can find it later. If the user names a folder, pass it as `<out>`.

## Step 1: Setup (first run only, about 20 s)

```bash
node "$SKILL/scripts/setup.mjs"
```

Run it in the same command as Step 2 (`node setup.mjs && node audit.mjs ...`) to save a round trip. It installs puppeteer-core and Lighthouse into `~/.cache/claude-seo-audit` and checks for Chrome and Python 3. If Chrome or Python is missing, tell the user what to install and stop.

## Step 2: Collect everything (one command)

```bash
node "$SKILL/scripts/audit.mjs" <URL> [<out>]
```

The first line it prints is `Output folder: <absolute path>`. Use that absolute path as `<out>` in every later step, and give it to the user, because the current folder may not be where the report is.

It first measures TTFB (5 requests plus 2 cache-busted ones, split into DNS, connect, TLS and server wait), then runs these in parallel: Google PageSpeed Insights mobile and desktop (with real-user Chrome UX data), the raw-HTML collector (indexing, meta, headings, images, links, schema, platform), local Lighthouse mobile, and a Chrome session at 1440 px and 390 px. If PageSpeed is unavailable (no API key, quota used up, or a local site), desktop scores come from a local Lighthouse desktop run instead. PageSpeed needs a free Google API key for reliable use; if `summary.md` says the quota is used up, tell the user once how to add one: `node "$SKILL/scripts/setup.mjs" --pagespeed-key=KEY`, with a key from https://developers.google.com/speed/docs/insights/v5/get-started. It writes `data/summary.md`, `data/checks.json` (pass/warn/fail with suggested severity), the raw JSON, and `shots/desktop-top.png`, `shots/mobile-top.png` and `shots/desktop-full.jpg`. Use `--no-lighthouse` only if Lighthouse keeps failing, and say so in the report.

When PageSpeed has no desktop result, the local desktop Lighthouse run continues in the background after "done" (about 25 s). Don't wait for it: start Step 3. Its scores land in `data/summary-desktop.md`, and `build.mjs` waits for it before building.

## Step 3: Read the page

Read `data/summary.md` in full. It has the platform, the scores, every failed or warning check with details, the heading outline with locators, the rendered page section by section, TTFB, PageSpeed mobile and desktop scores, real-user data, and the "Road to 100" list (every failing Lighthouse audit with the files or elements behind it). Then look at `shots/mobile-top.png` and `shots/desktop-top.png`.

Read the section text like a visitor would. The checks find markup problems, but the most valuable findings usually come from reading: copy left over from another page or audience, an Inertia/Vue/React page whose text and head tags only exist after JavaScript (no SSR), a card that repeats another card's text, a photo of the wrong product, a counter that renders "0+" in the HTML, or a broken sentence. If a section looks suspicious, screenshot it (Step 5) to confirm.

## Step 4: Decide the issues

The report automatically includes a "PageSpeed and server response" section (scores, lab metrics, real-user data, TTFB with fixes) and a "Road to 100" section (every failing Lighthouse audit, what causes it on this page, and a fix, with WordPress/Shopify/Laravel/Next.js hints). You don't need to repeat those as issues. Raise the ones that matter most as issues with real evidence and a page-specific fix (for example the LCP, render-blocking files, a slow TTFB), and refer to the Road to 100 for the rest. To replace a generic Road to 100 fix with a page-specific one, use `road_notes` in report.json.

Turn the checks and your reading into **8–16 issues**. Merge related findings (all alt-text problems in one issue, all heading problems in one). A page with 40 small issues is a page where nothing gets fixed. Use the suggested severity from the check as a starting point and adjust for impact. See `references/issue-catalog.md` for default severities, where to fix things on each platform, and wording.

| Severity | Meaning |
|---|---|
| Critical | Blocks indexing or the launch: noindex, canonical elsewhere, robots.txt block, 4xx/5xx |
| High | Hurts visitors or rankings right away: broken main CTA, LCP > 4 s, headline covered on mobile, several H1s, content only rendered by JS |
| Medium | Cleanup that matters: wrong or leftover copy, alt text, heavy scripts, stale social tags, hidden elements |
| Low | Cleanup: schema details, accessibility counts, `#` links, sitewide menu issues |

Write titles as plain statements with the number that matters: "Hero image is lazy-loaded, giving a 22-second LCP on mobile", not "LCP optimisation".

## Step 5: Brief the writers, then take screenshots while they write

Writing the issues is the slowest part, so it runs in parallel. Before anything else, write `<out>/report.json` with the top-level fields only (`site`, `page`, `footer_extra`, `road_notes`, `"issues": []`), then split the issues into 2–3 groups of 3–5 and start one `seo-audit:issue-writer` agent per group **in a single message** (Agent tool, `subagent_type: "seo-audit:issue-writer"`, in the background). Give each writer:

- `<out>` and the skill path `$SKILL` (for `references/report-json.md` and `references/issue-catalog.md`);
- for each issue: the file to write (`<out>/issues/<NN>-<key>.json`, numbered in severity order), the `key`, severity, title idea, the exact evidence (check IDs, locators, numbers, file paths and line numbers you found, markup to quote), the fix direction, and the screenshot file names it should reference;
- the project folder, if the site's code is open.

A good brief is a few precise lines per issue; the writer turns it into body, evidence blocks and a fix. Keep the 1–3 issues that need the most judgment (the ones based on reading the page or the code) for yourself and write them into `report.json` while the writers work.

**Screenshots, at the same time.** Only for issues where a picture helps (layout, pop-ups, wrong images, missing sections). Write `<out>/shots.json` and take them all in one browser session:

```json
[{"out": "shots/b3-before.png", "width": 390},
 {"out": "shots/b3-after.png", "width": 390, "js": "document.querySelector('#popup')?.remove()"},
 {"out": "shots/b5-before.png", "selector": "[data-id=\"fc9f1de\"]"},
 {"out": "shots/b5-after.png", "selector": "[data-id=\"fc9f1de\"]", "inject": "data/b5-after.js"}]
```

```bash
node "$SKILL/scripts/browser.mjs" shots <URL> <out>/shots.json
```

`js` or `inject` edits the page in the local browser before the shot, which is how you make an "After · Proposed" mockup. Keep mockups honest: show only what the Fix box proposes. If a pop-up, cookie bar or chat bubble gets in the way of a shot that is not about it, add `"hide": "#popup-id, .cookie-bar"` (the overlay locators are in `summary.md`). Use the locators from `summary.md` as selectors. `shots/mobile-top.png` and `shots/desktop-top.png` already exist, so reuse them as "before" shots where they fit. Decide the shot file names before briefing the writers so they can reference them.

For a page with few issues (under 6), skip the writers and write everything yourself; starting agents costs more than it saves.

## Step 6: Build

Each issue has `title`, `short`, `severity`, `where`, `loc`, `body`, optional evidence `blocks` (`code`, `shots`, `metrics`, `table`, `outline`, `note`), `fix` and `check` (format: `references/report-json.md`). For each issue:
1. **loc**: the exact place, such as the element locator or builder ID, the plugin or setting path, or the file. If you know the same problem exists on other pages, say so here.
2. **body**: 2–4 sentences covering what is wrong, why it matters to Google or visitors, and how it probably happened. Define jargon once, in passing.
3. **blocks**: real evidence. Show the live markup trimmed with `...` against the corrected markup, or screenshots, or metric tiles, or a table.
4. **fix**: name the exact setting, field or file, in the platform's own words. Give a Best fix and a Quick fix when both exist, and put any proposed copy in quotes.

When the writers report back, skim their files for invented facts or wrong severities (a quick read, not a rewrite), then build:

```bash
node "$SKILL/scripts/build.mjs" <out>
```

It merges `report.json` with `issues/*.json`, waits for the background desktop run, re-fetches the page (in parallel) to confirm it hasn't changed, writes `report.html` and `<Site> <Page> - SEO Audit.pdf`, checks the layout, and opens the PDF in the user's default viewer (`--no-open` skips that when rebuilding). The severity counts, IDs, scorecard, Lighthouse tiles, PageSpeed and TTFB section, Road to 100, checklist, passing checks and footer are generated for you.

Read the build output instead of screenshotting the PDF: lines starting with `LAYOUT:` name clipped code blocks, over-wide tables or missing screenshots; fix those in the issue file and rebuild with `--no-open --no-reverify`. If it warns that the page changed, re-check the affected issues and rebuild.

## Step 7: Hand it over

Give the user:
- the absolute PDF and HTML paths, as clickable links where the interface supports them, and say the PDF has been opened
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
