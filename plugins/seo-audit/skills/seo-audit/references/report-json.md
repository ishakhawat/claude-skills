# report.json format

`build.mjs` turns this file into `report.html` and the PDF. You write only the judgment: the issues and their evidence. The header facts, severity counts, issue IDs, Lighthouse tiles, scorecard, checklist, "already in good shape" list and footer are generated.

```json
{
  "site": "Gemstone Lights",
  "page": "Commercial Outdoor page",
  "lede": "optional HTML; default describes the URL",
  "eyebrow": "SEO audit",
  "id_prefix": "B",
  "checklist_intro": "In launch order. Element IDs are the Elementor data-id values.",
  "footer_extra": "The Trustpilot widget could not load in the test environment and is not assessed.",
  "meta": { "page": "override any header fact: page, last_edited, reverified, tested" },
  "issues": [
    {
      "key": "anchor",
      "title": "The hero button scrolls to a section that doesn't exist",
      "short": "Hero CTA links to a missing anchor",
      "severity": "High",
      "where": "Hero, quote form",
      "loc": "Button <code>db0c3d0</code> → <code>#get-a-quote-section</code>; form container <code>95d2274</code>",
      "body": "HTML paragraph(s). A plain string becomes one <p>; start with <p>, <ul> or <ol> to write several.",
      "blocks": [ ],
      "capture": {"selector": "[data-id=\"db0c3d0\"]", "width": 390,
                  "after_js": "document.querySelector('[data-id=\"95d2274\"]').id='get-a-quote-section'"},
      "after_body": "optional HTML after the evidence",
      "fix": {"title": "Fix", "steps": ["Exact setting, field or file, with the new value", "…"]},
      "result": {"html": "Clicking the hero button scrolls to the quote form instead of doing nothing.",
                 "metrics": [["Hero button", "Does nothing", "Scrolls to the form"]],
                 "verify": "Click the button on a phone; the form should be in view."},
      "check": "Container <code>95d2274</code>: set CSS ID <code>get-a-quote-section</code>"
    }
  ]
}
```

- **Issue files.** Issues can also live in `issues/*.json` next to `report.json` (one issue object, or an array, per file). `build.mjs` appends them after `report.json`'s own issues, so writer agents can work in parallel without editing the same file. Files are read in name order; severity sorting happens after merging.
- **Order and IDs.** Issues are sorted Critical → High → Medium → Low (keeping your order within a severity) and numbered `B1`, `B2`, …. To refer to another issue, give it a `key` and write `{{ref:key}}`; it becomes that issue's ID. Don't type IDs by hand.
- **severity**: exactly `Critical`, `High`, `Medium` or `Low`.
- **short**: the shorter title used in the "All issues" table. Defaults to `title`.
- **check**: the checklist line. Defaults to `short`. Set `"check": false` to leave an issue off the checklist (sitewide theme tasks, for example).
- **fix** can be a string, or `{"title": "Fix (on launch day)", "steps": ["…", "…"], "html": "optional extra"}` for a numbered list.
- **Every issue needs a picture and a result.** The build prints `LAYOUT:` warnings for an issue with no screenshot (`capture`, `shot`, `shots`), Google preview (`serp`) or load filmstrip (`filmstrip`), and for one with no `result`.
- **capture** takes the issue's screenshots during the build, so you don't write a shots.json for them: `shots/<key>-before.png` of `selector` (or the viewport) at `width`, and `shots/<key>-after.png` with `after_js` (inline JS) or `after_inject` (a JS file) applied first, as the "After · Proposed (mockup)" view. Other keys: `js` (run before both shots, e.g. open an accordion), `hide` (CSS list to hide pop-ups), `scroll`, `full`, `height`, `wait`, `label`, `before_cap`, `after_cap`, `after_label`. The pair goes right after `body`. Existing files are reused; `build.mjs --reshoot` retakes them. A failed shot prints `CAPTURE:` with the reason (usually a selector that doesn't match).
- **result** is the "After the fix" box: what changes for Google and visitors once fixed, a `metrics` table of `[measure, now, after]` rows (say "about" or "estimate" for numbers you can't measure yet, e.g. from Lighthouse savings), and `verify`, how to check the fix worked (a URL to test, a DevTools step, a Search Console report). A string is also accepted. `head` renames the table columns.
- HTML is allowed in `lede`, `loc`, `body`, `after_body`, `fix`, `check`, table cells and captions. Use `<code>` for IDs, files and URLs and `<b>` for the lead-in of a bullet.

## Evidence blocks

```json
{"type": "code", "before": "<meta name='robots' content='[-noindex, nofollow-]' />",
 "after": "<meta name='robots' content='{+index, follow+}' />",
 "before_label": "Before · Live HTML", "after_label": "After", "stack": false}
```
Plain text, escaped for you. Wrap removed parts in `[-…-]` (red) and added parts in `{+…+}` (green). `<!-- comments -->` are greyed. Trim long markup with `...`. `"stack": true` puts the two boxes on top of each other for wide code.

```json
{"type": "shots", "width": 390,
 "before": {"src": "shots/b3-before.png", "cap": "Pop-up covers the headline."},
 "after":  {"src": "shots/b3-after.png",  "cap": "Pop-up delayed; headline and button visible."}}
```
`width` < 768 places the two phones side by side with the label "Before · Live, 390 px"; otherwise they stack full width with "Before · Live, desktop". Override with `"layout": "phones"|"stack"` and per-shot `"label"`. Leave `after` out to show only the live shot.

```json
{"type": "metrics"}
```
Lighthouse tiles (score, LCP, first paint, total blocking, layout shift) with colours and the standard caption. Pass `"caption"` to change the note, or `"tiles": [{"k": "LCP", "v": "4.1 s", "c": "bad|mid|ok"}]` for your own numbers.

```json
{"type": "table", "head": ["What", "Size", "Fix"], "rows": [["Google Maps API", "392 KB", "Load on click"]]}
```

```json
{"type": "outline",
 "before": [["H1", "Smart Patio Lights"], ["H2", "Set the scene"], ["H4", "Warm glow", "← skips H3"]],
 "after":  [["H1", "Smart Patio String Lights"], ["H2", "Set the scene"], ["H3", "Warm glow"], ["p", "Join the community..."]]}
```
A third item marks the line red with that note.

```json
{"type": "serp", "after": {"title": "Free Website Design UK | Pay Monthly From £10 | FlickWebX", "desc": "…"}}
```
Google result preview, before and after, with Google's cut-off (about 60 characters of title, 2 lines of description). `before` defaults to the live title, description and URL; override any of `title`, `desc`, `url`, `site` (e.g. the title after JavaScript). The picture for title, description, canonical and indexing issues.

```json
{"type": "filmstrip", "source": "mobile", "cap": "optional caption"}
```
Frames of one real page load recorded by the build on throttled slow 4G with a 4× slower CPU (like Lighthouse mobile), with the real first-paint and LCP times and the LCP frame outlined in red. The picture for LCP, render-blocking, TTFB and heavy-script issues. `"source": "desktop"` records at 1440 px. `cap` is put before the standard caption; don't state times in it, since the recording sets them. `"after": {"css": "#home [data-reveal]{opacity:1!important}", "cap": "…"}` records a second load with that CSS injected before the page parses and shows it as "After · Same load with the fix applied in the browser": real proof of what a CSS-level fix changes. Only use CSS that does what the Fix box proposes. If recording fails, Lighthouse's own frames are used with a caption saying their times are unthrottled.

```json
{"type": "note", "html": "Small grey note."}
{"type": "html", "html": "<ul><li>Anything else</li></ul>"}
```

## Top-level switches

- `"scorecard": false` hides the scorecard; `"passes": false` hides "Already in good shape".
- `"speed": false` hides "PageSpeed and server response"; `"road": false` hides "Road to 100".
- `"road_notes": {"<lighthouse-audit-id>": "html"}` replaces the generic fix in a Road to 100 row with a page-specific one, e.g. `{"render-blocking-resources": "Defer <code>select2</code> and <code>tooltipster</code>; see {{ref:lcp}}."}`. Audit IDs are in `data/summary.md`.
- `"title"` overrides the heading (default "<page>: SEO audit"); `"pdf_name"` overrides the file name (default "<site> <page> - SEO Audit.pdf").
- `"reverified": "text"` skips the automatic re-check.
