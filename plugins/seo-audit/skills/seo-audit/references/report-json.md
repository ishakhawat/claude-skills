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
      "after_body": "optional HTML after the evidence",
      "fix": "Plain fix paragraph (rendered after a bold Fix.)",
      "check": "Container <code>95d2274</code>: set CSS ID <code>get-a-quote-section</code>"
    }
  ]
}
```

- **Order and IDs.** Issues are sorted Critical → High → Medium → Low (keeping your order within a severity) and numbered `B1`, `B2`, …. To refer to another issue, give it a `key` and write `{{ref:key}}`; it becomes that issue's ID. Don't type IDs by hand.
- **severity**: exactly `Critical`, `High`, `Medium` or `Low`.
- **short**: the shorter title used in the "All issues" table. Defaults to `title`.
- **check**: the checklist line. Defaults to `short`. Set `"check": false` to leave an issue off the checklist (sitewide theme tasks, for example).
- **fix** can be a string, or `{"title": "Fix (on launch day)", "steps": ["…", "…"], "html": "optional extra"}` for a numbered list.
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
{"type": "note", "html": "Small grey note."}
{"type": "html", "html": "<ul><li>Anything else</li></ul>"}
```

## Top-level switches

- `"scorecard": false` hides the scorecard; `"passes": false` hides "Already in good shape".
- `"title"` overrides the heading (default "<page>: SEO audit"); `"pdf_name"` overrides the file name (default "<site> <page> - SEO Audit.pdf").
- `"reverified": "text"` skips the automatic re-check.
