// Turns the collected evidence into pass / warn / fail checks and a condensed summary.
// Each check: { id, cat, status: pass|warn|fail|info, label, detail, sev }
// `sev` is the suggested report severity if the check becomes an issue.

export const CATEGORIES = ["Indexing", "Meta & social", "Content & headings", "Images & media", "Links",
  "Structured data", "Performance", "Mobile & UX", "Accessibility", "Security", "AI search"];

export const THRESHOLDS = { score: [90, 50], lcp: [2500, 4000], fcp: [1800, 3000], tbt: [200, 600], cls: [0.1, 0.25] };
export const grade = (v, [good, poor], higherIsBetter = false) =>
  v == null ? null : higherIsBetter ? (v >= good ? "ok" : v >= poor ? "mid" : "bad") : (v <= good ? "ok" : v <= poor ? "mid" : "bad");

export function lhMetrics(lh) {
  if (!lh?.audits || lh.runtimeError || lh.categories?.performance?.score == null) return null;
  const a = id => lh.audits[id]?.numericValue;
  const cat = id => lh.categories?.[id]?.score == null ? null : Math.round(lh.categories[id].score * 100);
  return { version: lh.lighthouseVersion, fetched: lh.fetchTime,
    performance: cat("performance"), accessibility: cat("accessibility"), best_practices: cat("best-practices"), seo: cat("seo"),
    lcp: a("largest-contentful-paint"), fcp: a("first-contentful-paint"), tbt: a("total-blocking-time"),
    cls: a("cumulative-layout-shift"), si: a("speed-index"), bytes: a("total-byte-weight"), dom: a("dom-size") };
}

const kb = b => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB";

export function buildChecks(c, r, lh) {
  const out = [];
  const add = (cat, id, ok, label, detail = "", sev = "Medium", warnOnly = true) =>
    out.push({ id, cat, status: ok === null ? "info" : ok ? "pass" : warnOnly ? "warn" : "fail", label, detail, sev });
  const ix = c.indexing, m = c.meta, h = c.headings, im = c.images, L = c.links;
  const d = r?.desktop, mo = r?.mobile, og = m.og;
  const local = /\.(test|localhost|local)$|^localhost$|^127\./.test(new URL(c.final_url).hostname);

  // Indexing
  add("Indexing", "status", c.status === 200, `Page returns HTTP ${c.status}`, "", "Critical", false);
  if (c.soft_error) add("Indexing", "soft_error", false, `HTTP ${c.status} but the page shows a ${c.soft_error.kind}`, c.soft_error.snippet, "Critical", false);
  add("Indexing", "redirects", !c.redirect_chain.length, c.redirect_chain.length ? `URL redirects ${c.redirect_chain.length}× before loading` : "No redirect on the URL",
    c.redirect_chain.map(x => `${x.status} ${x.from} → ${x.to}`).join("; "), "Medium");
  add("Indexing", "noindex", !ix.noindex, ix.noindex ? "Page is set to noindex" : "Page is indexable",
    `robots meta: ${ix.robots_meta || "none"}; X-Robots-Tag: ${c.x_robots_tag || "none"}`, "Critical", false);
  add("Indexing", "robots_txt", !ix.robots_txt_blocks_googlebot, ix.robots_txt_blocks_googlebot ? "robots.txt blocks this URL for Googlebot" : "robots.txt allows this URL",
    ix.robots_txt_blocking_rules.join(", "), "Critical", false);
  add("Indexing", "robots_exists", ix.robots_txt_status === 200, ix.robots_txt_status === 200 ? "robots.txt exists" : `robots.txt returns ${ix.robots_txt_status}`, "", "Low");
  if (!ix.canonical) add("Indexing", "canonical", false, "No canonical tag", "", "High");
  else add("Indexing", "canonical", ix.canonical_matches_final, ix.canonical_matches_final ? "Canonical points to itself" : "Canonical points to a different URL",
    ix.canonical, "Critical", false);
  if (ix.canonical_count > 1) add("Indexing", "canonical_multi", false, `${ix.canonical_count} canonical tags`, "", "High", false);
  if (ix.canonical_relative) add("Indexing", "canonical_rel", false, "Canonical URL is relative", ix.canonical, "Low");
  add("Indexing", "sitemap", !!ix.sitemap.found_in, ix.sitemap.found_in ? "Listed in the XML sitemap" : "Not found in the XML sitemap",
    ix.sitemap.found_in || `checked ${ix.sitemap.sitemaps_checked} sitemap file(s): ${(ix.sitemap.declared || []).join(", ") || "none declared in robots.txt"}`, "Medium");
  if (c.security.https && !local) add("Indexing", "http", [301, 308].includes(ix.http_variant.status),
    ix.http_variant.status === 200 ? "http:// version loads without redirecting" : `http:// redirects (${ix.http_variant.status})`, `→ ${ix.http_variant.to}`, "High");
  if (!local) add("Indexing", "host", ix.alt_host_variant.status !== 200,
    ix.alt_host_variant.status === 200 ? `${ix.alt_host_variant.host} also serves the page (duplicate host)` :
      ix.alt_host_variant.status === 0 ? `${ix.alt_host_variant.host} does not resolve` : [301, 308].includes(ix.alt_host_variant.status) ? `${ix.alt_host_variant.host} redirects (${ix.alt_host_variant.status})` :
      `${ix.alt_host_variant.host} returns ${ix.alt_host_variant.status}${[302, 307].includes(ix.alt_host_variant.status) ? " (temporary redirect; use 301)" : ""}`, "", "High", ![302, 307].includes(ix.alt_host_variant.status));
  if (ix.meta_refresh) add("Indexing", "refresh", false, "Meta refresh redirect", ix.meta_refresh, "High");
  if (ix.hreflang.length) add("Indexing", "hreflang", ix.hreflang_self && ix.hreflang_x_default,
    `hreflang: ${ix.hreflang.length} alternates${ix.hreflang_self ? "" : ", no self-reference"}${ix.hreflang_x_default ? "" : ", no x-default"}`, "", "Medium");
  if (r && d?.robots_rendered && /noindex/i.test(d.robots_rendered) !== ix.noindex)
    add("Indexing", "js_robots", false, "JavaScript changes the robots meta", `raw: ${ix.robots_meta} / rendered: ${d.robots_rendered}`, "Critical", false);

  // Head tags that only exist after JavaScript (Inertia/Vue/React without SSR, client-side <Head>)
  if (d) {
    const jsOnly = [];
    if (!m.title && d.title) jsOnly.push("title");
    if (!m.description && d.description_rendered) jsOnly.push("meta description");
    if (!ix.canonical && d.canonical_rendered) jsOnly.push("canonical");
    if (!og["og:title"] && d.og_title_rendered) jsOnly.push("og:title");
    if (m.title && d.title && m.title.trim() !== d.title.trim()) jsOnly.push(`title changes to "${d.title.slice(0, 70)}"`);
    add("Indexing", "js_head", !jsOnly.length, jsOnly.length ? `Head tags set only by JavaScript: ${jsOnly.join(", ")}` : "Head tags are in the server HTML",
      c.inertia ? `Inertia page ${c.inertia.component}${c.inertia.ssr ? " (SSR)" : " (no SSR)"}` : "", "High");
  }
  if (c.inertia) add("Content & headings", "inertia_ssr", c.inertia.ssr, c.inertia.ssr ? `Inertia SSR on (${c.inertia.component})` : `Inertia page ${c.inertia.component} is rendered in the browser only (no SSR)`,
    "Social previews, Bing and AI crawlers that don't run JavaScript see an empty <div id=\"app\">", "High");

  // Meta & social
  add("Meta & social", "title", m.title_len >= 25 && m.title_len <= 60, m.title ? `Title is ${m.title_len} characters` : "No title tag",
    m.title, m.title ? "Low" : "High");
  if (m.title_count > 1) add("Meta & social", "title_multi", false, `${m.title_count} title tags`, "", "Medium");
  add("Meta & social", "description", m.description_len >= 70 && m.description_len <= 160,
    m.description ? `Meta description is ${m.description_len} characters` : "No meta description", m.description || "", m.description ? "Low" : "Medium");
  add("Meta & social", "og", !!(og["og:title"] && og["og:description"] && og["og:image"]),
    og["og:title"] ? "Open Graph tags present" : "Open Graph tags missing", ["og:title", "og:description", "og:image"].filter(k => !og[k]).map(k => "missing " + k).join(", "), "Medium");
  if (og["og:title"] && m.title && og["og:title"].trim() !== m.title.trim())
    add("Meta & social", "og_stale", null, "og:title differs from the title tag", `og:title: ${og["og:title"]}`, "Medium");
  if (og["og:image"]) add("Meta & social", "og_image", m.og_image_status === 200, `og:image returns ${m.og_image_status}`, og["og:image"], "Medium");
  if (og["og:url"] && ix.canonical && og["og:url"].replace(/\/$/, "") !== ix.canonical.replace(/\/$/, ""))
    add("Meta & social", "og_url", false, "og:url differs from the canonical", og["og:url"], "Medium");
  add("Meta & social", "twitter", !!m.twitter["twitter:card"], m.twitter["twitter:card"] ? "Twitter card set" : "No twitter:card", "", "Low");
  add("Meta & social", "invisible", !Object.keys(m.invisible_characters).length,
    Object.keys(m.invisible_characters).length ? "Invisible characters (U+2028, zero-width) in tags or headings" : "No invisible characters in tags",
    Object.entries(m.invisible_characters).map(([k, v]) => `${k} (${v})`).join("; "), "Medium");
  add("Meta & social", "lang", !!m.lang, m.lang ? `<html lang="${m.lang}">` : "No lang attribute on <html>", "", "Low");
  add("Meta & social", "viewport", !!m.viewport, m.viewport ? "Viewport meta set" : "No viewport meta", "", "High", false);
  add("Meta & social", "favicon", m.favicon, m.favicon ? "Favicon declared" : "No favicon link", "", "Low");

  // Content & headings
  add("Content & headings", "h1", h.h1_count === 1, `${h.h1_count} H1 in the HTML`, h.h1s.map(x => `${x.text} (${x.loc})`).join(" | "), h.h1_count ? "High" : "High", h.h1_count > 1);
  if (d) add("Content & headings", "h1_visible", d.visible_h1_count === 1 && mo.visible_h1_count === 1,
    `Visible H1: desktop ${d.visible_h1_count}, mobile ${mo.visible_h1_count}`, "", "High");
  add("Content & headings", "skips", !h.skips.length, h.skips.length ? `${h.skips.length} heading level skips` : "Heading levels in order",
    h.skips.slice(0, 5).map(s => `H${s.after_level}→H${s.level} "${s.text}"`).join("; "), "Medium");
  if (h.empty) add("Content & headings", "empty_h", false, `${h.empty} empty heading tags`, "", "Low");
  if (h.headings_before_h1.length > 3) add("Content & headings", "before_h1", false, `${h.headings_before_h1.length} headings before the H1 (menus, banners)`,
    h.headings_before_h1.slice(0, 4).join("; "), "Low");
  if (h.numeric_only.length) add("Content & headings", "numeric_h", false, `${h.numeric_only.length} headings that are only numbers`, h.numeric_only.slice(0, 6).join(", "), "Low");
  if (h.duplicated_text.length) add("Content & headings", "dup_h", false, `${h.duplicated_text.length} headings repeated on the page`,
    h.duplicated_text.slice(0, 4).map(x => `"${x.text}" ×${x.copies.length}`).join("; "), "Medium");
  add("Content & headings", "words", c.word_count_main >= 300, `${c.word_count_main} words of main content in the HTML`, "", "Medium");
  if (d) {
    const jsDependent = d.words_rendered > 150 && c.word_count_raw < d.words_rendered * 0.5;
    add("Content & headings", "js_content", !jsDependent, jsDependent ? "Most text only appears after JavaScript runs" : "Text is in the server HTML",
      `raw HTML ${c.word_count_raw} words, rendered ${d.words_rendered}`, "High");
  }
  if (c.builder_hidden_everywhere.length) add("Content & headings", "hidden_all", false,
    `${c.builder_hidden_everywhere.length} elements hidden on every device`, c.builder_hidden_everywhere.slice(0, 6).map(x => x.id).join(", "), "Medium");

  // Images & media
  add("Images & media", "alt", !im.content_missing_or_empty_alt, `${im.content_missing_or_empty_alt} of ${im.content} content images have no alt text`, "", "Medium");
  if (im.bad_alt_values.length) add("Images & media", "bad_alt", false, "Placeholder or file-name alt text", im.bad_alt_values.slice(0, 5).join(" | "), "Medium");
  if (im.camera_file_names.length) add("Images & media", "camera", false, `${im.camera_file_names.length} camera or generic file names`, im.camera_file_names.slice(0, 6).join(", "), "Low");
  add("Images & media", "dims", !im.no_dimensions.length, im.no_dimensions.length ? `${im.no_dimensions.length} images without width/height` : "Images have width/height", im.no_dimensions.slice(0, 5).join(", "), "Low");
  const legacy = (im.formats.jpg || 0) + (im.formats.jpeg || 0) + (im.formats.png || 0);
  if (im.content) add("Images & media", "formats", legacy <= im.content / 2, `${legacy} of ${im.content} images are JPEG/PNG`, JSON.stringify(im.formats), "Low");
  const dupImgs = Object.keys(im.duplicate_files).length;
  if (dupImgs > 3) add("Images & media", "dup_img", null, `${dupImgs} images appear more than once (sliders, marquees)`, "", "Low");
  if (d?.broken_images?.length) add("Images & media", "broken_img", false, `${d.broken_images.length} broken images`, d.broken_images.slice(0, 4).join(", "), "High", false);
  const lcp = mo?.lcp_candidate;
  if (lcp) add("Images & media", "lcp_lazy", !(lcp.loading === "lazy" || lcp.lazy_attr), (lcp.loading === "lazy" || lcp.lazy_attr) ? "Main (LCP) image is lazy-loaded" : "Main image is not lazy-loaded",
    lcp.src, "High", false);
  const vids = (mo?.media_requests || []).filter(x => x.bytes);
  const bigVid = vids.find(x => x.bytes > 5 * 1048576);
  const vidTotal = vids.reduce((t, x) => t + x.bytes, 0);
  if (bigVid) add("Images & media", "video", false, `${kb(bigVid.bytes)} video downloaded on mobile (${kb(vidTotal)} of video in total)`, bigVid.url, "High", false);
  else if (vidTotal > 3 * 1048576) add("Images & media", "video", false, `${kb(vidTotal)} of video downloaded on mobile`, vids.slice(0, 3).map(x => `${x.url.split("/").pop()} ${kb(x.bytes)}`).join(", "), "Medium");

  // Links
  const broken = L.redirecting_or_broken.filter(x => x.status >= 400 || x.status === 0);
  const redirecting = L.redirecting_or_broken.filter(x => x.status === 200 && x.hops);
  add("Links", "broken", !broken.length, broken.length ? `${broken.length} broken internal links` : `No broken internal links (${L.checked} checked)`,
    broken.slice(0, 5).map(x => `${x.status} ${x.url}`).join("; "), "High", false);
  add("Links", "redirecting", !redirecting.length, `${redirecting.length} internal links redirect`, redirecting.slice(0, 5).map(x => `${x.url} → ${x.final}`).join("; "), "Low");
  const missing = [...new Set([...(L.in_page_missing_targets || []).map(x => x.target), ...(d?.missing_anchor_targets || [])])];
  const reallyMissing = d ? missing.filter(t => d.missing_anchor_targets.includes(t)) : missing;
  add("Links", "anchors", !reallyMissing.length, reallyMissing.length ? `In-page links to missing targets: #${reallyMissing.join(", #")}` : "In-page anchor links resolve",
    (L.in_page_missing_targets || []).filter(x => reallyMissing.includes(x.target)).map(x => `"${x.text}" in ${x.loc}`).join("; "), "High", false);
  if (L.hash_or_js.length) add("Links", "hash", false, `${L.hash_or_js.length} placeholder links (href="#")`, L.hash_or_js.slice(0, 5).map(x => x.text || x.loc).join(", "), "Low");
  add("Links", "nameless", !L.nameless, `${L.nameless} links without a name`, L.nameless_sample.slice(0, 4).map(x => x.href).join(", "), "Low");
  if (L.nofollow_internal.length) add("Links", "nofollow", false, `${L.nofollow_internal.length} internal links are nofollow`, L.nofollow_internal.slice(0, 4).join(", "), "Medium");
  add("Links", "count", L.internal >= 3, `${L.internal} internal and ${L.external} external links`, "", "Low");

  // Structured data
  const sc = c.schema;
  add("Structured data", "present", sc.types.length > 0, sc.types.length ? `JSON-LD: ${[...new Set(sc.types)].join(", ")}` : "No JSON-LD structured data", "", "Medium");
  if (sc.parse_errors.length) add("Structured data", "errors", false, `${sc.parse_errors.length} JSON-LD blocks don't parse`, sc.parse_errors[0], "High", false);
  if (sc.lowercase_types.length) add("Structured data", "lower", false, `Invalid lowercase @type: ${sc.lowercase_types.join(", ")}`, "", "Low");
  if (sc.types.length) {
    add("Structured data", "org", sc.types.some(t => /Organization|LocalBusiness|Corporation|Store|Person/.test(t)), "Organization / LocalBusiness schema", "", "Low");
    add("Structured data", "crumbs", sc.types.some(t => /BreadcrumbList/.test(t)), "BreadcrumbList schema", "", "Low");
  }

  // Performance
  const P = lhMetrics(lh);
  if (P) {
    const g = (v, t, hi) => grade(v, t, hi);
    const push = (id, v, t, label, hi, sevBad) => { const x = g(v, t, hi); out.push({ id, cat: "Performance", status: x === "ok" ? "pass" : x === "mid" ? "warn" : "fail", label, detail: "", sev: x === "bad" ? sevBad : "Medium" }); };
    push("score", P.performance, THRESHOLDS.score, `Lighthouse mobile performance ${P.performance}`, true, "High");
    push("lcp", P.lcp, THRESHOLDS.lcp, `LCP ${(P.lcp / 1000).toFixed(1)} s`, false, "High");
    push("fcp", P.fcp, THRESHOLDS.fcp, `First contentful paint ${(P.fcp / 1000).toFixed(1)} s`, false, "Medium");
    push("tbt", P.tbt, THRESHOLDS.tbt, `Total blocking time ${Math.round(P.tbt)} ms`, false, "Medium");
    push("cls", P.cls, THRESHOLDS.cls, `Layout shift ${P.cls.toFixed(3)}`, false, "High");
    add("Performance", "weight", P.bytes < 3 * 1048576, `Page weight ${kb(P.bytes)}`, "", P.bytes > 6 * 1048576 ? "High" : "Medium", P.bytes < 6 * 1048576);
    add("Performance", "dom", P.dom < 1500, `${Math.round(P.dom)} DOM elements`, "", "Low");
  }
  add("Performance", "blocking", c.scripts.render_blocking_head.length <= 2, `${c.scripts.render_blocking_head.length} render-blocking scripts in <head>`,
    c.scripts.render_blocking_head.slice(0, 5).map(s => s.split("?")[0].split("/").slice(-2).join("/")).join(", "), "Medium");
  if (c.ttfb_seconds != null) add("Performance", "ttfb", c.ttfb_seconds < 0.8, `Server response ${c.ttfb_seconds} s (from this machine)`, "", "Medium", c.ttfb_seconds < 1.8);
  if (P && lh.audits["uses-text-compression"]) add("Performance", "compression", lh.audits["uses-text-compression"].score !== 0, "Text compression", "", "Medium");

  // Mobile & UX
  if (mo) {
    const cov = mo.after_wait?.h1_covered_by || [];
    add("Mobile & UX", "h1_cover", !cov.length, cov.length ? `Something covers the headline on mobile: ${cov.join(", ")}` : "Headline is not covered on mobile", "", "High", false);
    const ov = mo.after_wait?.large_overlays || [];
    add("Mobile & UX", "overlay", !ov.length, ov.length ? `Pop-up or overlay covers ${Math.round(ov[0].share * 100)}% of the first mobile screen` : "No large overlay on the first mobile screen",
      ov.map(o => o.loc).join(", "), "High");
    add("Mobile & UX", "overflow", !mo.horizontal_overflow.length, mo.horizontal_overflow.length ? "Page scrolls sideways on mobile" : "No horizontal scroll on mobile",
      mo.horizontal_overflow.map(o => o.loc).join(", "), "Medium");
    add("Mobile & UX", "cta", mo.first_button_above_fold, mo.first_button ? `First button on mobile at ${mo.first_button.top}px ("${mo.first_button.text}")` : "No button found", "", "Low");
    if (mo.console_errors.length) add("Mobile & UX", "console", false, `${mo.console_errors.length} JavaScript console errors`, mo.console_errors.slice(0, 3).join(" | "), "Low");
    const failed = (mo.failed_requests || []).filter(x => x.status >= 400);
    if (failed.length) add("Mobile & UX", "failed", false, `${failed.length} resources fail to load`, failed.slice(0, 4).map(x => `${x.status} ${x.url}`).join("; "), "Medium");
  }

  // Accessibility (Lighthouse)
  if (P && lh.categories?.accessibility) {
    const s = P.accessibility;
    add("Accessibility", "a11y_score", s >= 90, `Lighthouse accessibility ${s}`, "", "Low");
    for (const ref of lh.categories.accessibility.auditRefs) {
      const a = lh.audits[ref.id];
      if (a?.score === 0 && ref.weight > 0) add("Accessibility", "a11y_" + ref.id, false, `${a.title} (${a.details?.items?.length ?? "?"})`, "", "Low");
    }
  }
  if (P && lh.categories?.seo) for (const ref of lh.categories.seo.auditRefs) {
    const a = lh.audits[ref.id];
    if (a?.score === 0 && ref.weight > 0 && !["is-crawlable", "canonical", "document-title", "meta-description", "image-alt", "link-text", "hreflang"].includes(ref.id))
      add("Indexing", "lhseo_" + ref.id, false, `Lighthouse SEO: ${a.title}`, "", "Medium");
  }

  // Security
  add("Security", "https", c.security.https, c.security.https ? "Served over HTTPS" : "Not served over HTTPS", "", "Critical", false);
  if (c.security.https) add("Security", "mixed", !c.security.mixed_content.length, c.security.mixed_content.length ? `${c.security.mixed_content.length} http:// resources on an https page` : "No mixed content",
    c.security.mixed_content.slice(0, 4).join(", "), "Medium", false);
  add("Security", "hsts", !!c.security.headers["strict-transport-security"], "HSTS header", "", "Low");
  add("Security", "nosniff", !!c.security.headers["x-content-type-options"], "X-Content-Type-Options header", "", "Low");

  // AI search (informational)
  add("AI search", "ai_bots", !c.indexing.ai_crawlers_blocked.length, c.indexing.ai_crawlers_blocked.length ? `robots.txt blocks AI crawlers: ${c.indexing.ai_crawlers_blocked.join(", ")}` : "AI crawlers are allowed", "", "Low");
  add("AI search", "llms", c.indexing.llms_txt ? true : null, c.indexing.llms_txt ? "llms.txt present" : "No llms.txt (optional)", "", "Low");

  return out;
}

export function summaryMarkdown({ url, collect: c, rendered: r, lh, sections, checks, status }) {
  const P = lhMetrics(lh), p = c.platform, L = [];
  const line = s => L.push(s);
  line(`# Evidence summary: ${url}`);
  line(""); line(`Fetched ${c.fetched_at_utc}. Final URL ${c.final_url} (HTTP ${c.status}).`);
  line(`Platform: ${[p.cms, p.builder, p.framework, ...(p.stack || []).filter(x => !(p.framework || "").includes(x)), p.seo_plugin && "SEO plugin " + p.seo_plugin, p.cache_plugin && "cache " + p.cache_plugin, p.cdn_host && "host/CDN " + p.cdn_host].filter(Boolean).join(", ") || "unknown"}` +
    `${c.page_id ? ` · page ID ${c.page_id}` : ""} · last modified ${c.modified_time || "unknown"}`);
  if (c.inertia) line(`Inertia page component: ${c.inertia.component} · SSR ${c.inertia.ssr ? "on" : "off"} · props: ${(c.inertia.props || []).join(", ")}`);
  line(`Tool status: lighthouse ${status.lighthouse}; browser ${status.browser}`);
  if (P) line(`Lighthouse ${P.version} mobile: performance ${P.performance}, accessibility ${P.accessibility}, best practices ${P.best_practices}, SEO ${P.seo} · LCP ${(P.lcp / 1000).toFixed(1)} s · FCP ${(P.fcp / 1000).toFixed(1)} s · TBT ${Math.round(P.tbt)} ms · CLS ${P.cls.toFixed(3)} · weight ${kb(P.bytes)}`);
  line(""); line(`Title (${c.meta.title_len}): ${c.meta.title}`); line(`Description (${c.meta.description_len}): ${c.meta.description || "—"}`);
  line(`OG title: ${c.meta.og["og:title"] || "—"} · OG image: ${c.meta.og["og:image"] || "—"}`);

  line(""); line("## Failed and warning checks");
  for (const s of ["fail", "warn", "info"]) for (const x of checks.filter(k => k.status === s))
    line(`- **${s.toUpperCase()}** [${x.cat}] ${x.label}${x.detail ? ` — ${x.detail.slice(0, 300)}` : ""} _(suggested: ${x.sev})_`);
  line(""); line(`Passed: ${checks.filter(k => k.status === "pass").map(k => k.label).join("; ")}`);

  line(""); line("## Heading outline (main content, raw HTML)");
  for (const h of c.headings.outline.slice(0, 60)) line(`${"  ".repeat(h.level - 1)}- H${h.level} ${h.text}${h.hidden.length ? ` [hidden: ${h.hidden.join("/")}]` : ""}  \`${h.loc}\``);

  if (r) {
    const d = r.desktop, m = r.mobile;
    line(""); line("## Rendered page");
    line(`Desktop: ${d.visible_h1_count} visible H1, first button "${d.first_button?.text || "—"}" at ${d.first_button?.top ?? "—"}px, ${d.words_rendered} words, ${d.dom_nodes} DOM nodes.`);
    line(`Mobile: H1 covered by ${m.after_wait.h1_covered_by.join(", ") || "nothing"}; overlays ${m.after_wait.large_overlays.map(o => `${o.loc} ${Math.round(o.share * 100)}%`).join(", ") || "none"}; chat ${m.after_wait.chat_widgets.join(", ") || "none"}.`);
    if (m.lcp_candidate) line(`Mobile LCP image: ${m.lcp_candidate.src} (loading=${m.lcp_candidate.loading}, fetchpriority=${m.lcp_candidate.fetchpriority}, alt="${m.lcp_candidate.alt ?? ""}") \`${m.lcp_candidate.loc}\``);
    if (m.videos.length) line(`Videos on mobile: ${m.videos.map(v => `${v.src} playing=${v.playing}`).join("; ")}`);
    if (m.media_requests.length) line(`Media transferred on mobile (bytes received, first ~8 s): ${m.media_requests.map(x => `${x.url} ${x.bytes ? kb(x.bytes) : "?"}`).join("; ")}`);
  }

  if (P) {
    const net = lh.audits["network-requests"]?.details?.items || [];
    line(""); line("## Heaviest requests (Lighthouse, mobile)");
    for (const x of [...net].sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0)).slice(0, 10))
      line(`- ${kb(x.transferSize || 0)} ${x.resourceType} ${x.url.slice(0, 140)}`);
    const unused = lh.audits["unused-javascript"]?.details?.items || [];
    if (unused.length) { line(""); line("Unused JavaScript: " + unused.slice(0, 6).map(x => `${x.url.split("?")[0].split("/").slice(-2).join("/")} ${kb(x.wastedBytes)}`).join("; ")); }
    const lcpEl = lh.audits["largest-contentful-paint-element"]?.details?.items?.[0]?.items?.[0]?.node;
    if (lcpEl) line(`Lighthouse LCP element: ${lcpEl.nodeLabel} \`${lcpEl.selector}\``);
  }

  line(""); line("## Page, section by section (desktop, rendered)");
  for (const s of sections) {
    line(""); line(`### ${s.n}. \`${s.loc}\` (top ${s.top}px, ${s.height}px tall)`);
    if (s.headings.length) line("Headings: " + s.headings.join(" · "));
    line(s.text);
    if (s.images.length) line("Images: " + s.images.map(i => `${i.file} [alt="${i.alt ?? "MISSING"}"]`).join(", "));
    if (s.links.length) line("Links: " + s.links.join(" | "));
  }
  line(""); line("Screenshots: shots/desktop-top.png, shots/mobile-top.png, shots/desktop-full.jpg. Full data in data/*.json.");
  return L.join("\n") + "\n";
}
