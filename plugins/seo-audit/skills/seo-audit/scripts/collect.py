#!/usr/bin/env python3
"""Collect raw-HTML SEO evidence for one page, on any platform.

Usage: python3 -I collect.py <url> <out.json> [--no-linkcheck]

Reads the HTML a search engine receives (no JavaScript) and writes one JSON
file: status and redirects, indexability (robots meta, X-Robots-Tag,
robots.txt, sitemap, canonical, http/https and www variants), platform
(CMS, page builder, framework, SEO plugin, CDN), meta and social tags,
hreflang, heading outline, images, videos, links (internal link check),
in-page anchors, JSON-LD, scripts, mixed content and server headers.
Every heading, image and link carries a short CSS locator so the report can
say where it is. Standard library only; network work runs in parallel.
"""
import gzip, json, re, ssl, os, sys, time, urllib.request, urllib.error, urllib.parse, zlib
from html.parser import HTMLParser
from concurrent.futures import ThreadPoolExecutor

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
CAMERA = re.compile(r"(^|/)(DSC|DSCF|DSC_|IMG_|IMG-|_MG_|DJI_|GOPR|PXL_|P\d{7}|MVIMG|Screen[ _-]?Shot|"
                    r"image\d*|photo\d*|unnamed|download|untitled)[^/]*$", re.I)
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
INVISIBLE = re.compile("[​‌‍  ­﻿]")
AI_BOTS = ["GPTBot", "ChatGPT-User", "OAI-SearchBot", "ClaudeBot", "Claude-Web", "anthropic-ai",
           "PerplexityBot", "Google-Extended", "CCBot", "Bytespider", "Applebot-Extended"]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def ssl_context():
    # python.org builds on macOS ship without CA certs; fall back to certifi or the system bundle.
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    for f in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/opt/homebrew/etc/openssl@3/cert.pem"):
        if os.path.exists(f):
            return ssl.create_default_context(cafile=f)
    return ssl.create_default_context()


OPENER = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=ssl_context()))
_insecure = ssl.create_default_context(); _insecure.check_hostname = False; _insecure.verify_mode = ssl.CERT_NONE
LOCAL_OPENER = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=_insecure))


def is_local(url):
    h = urllib.parse.urlparse(url).hostname or ""
    return h in ("localhost", "127.0.0.1", "::1") or h.endswith((".test", ".localhost", ".local"))


def fetch(url, follow=True, timeout=20, read=True):
    """Return dict(status, final, headers, body, chain, ttfb, seconds). status 0 = network error."""
    chain, cur, t0 = [], url, time.time()
    for _ in range(10):
        req = urllib.request.Request(cur, headers={"User-Agent": UA, "Accept": "text/html,*/*",
                                                   "Accept-Encoding": "gzip, deflate"})
        try:
            # Local dev sites (Herd, Valet, Sail) use self-signed certificates.
            r = (LOCAL_OPENER if is_local(cur) else OPENER).open(req, timeout=timeout)
            ttfb = round(time.time() - t0, 2)
            body = r.read() if read else b""
            enc = (r.headers.get("Content-Encoding") or "").lower()
            if body and enc == "gzip": body = gzip.decompress(body)
            elif body and enc == "deflate": body = zlib.decompress(body)
            r.close()
            return dict(status=r.status, final=cur, headers={k.lower(): v for k, v in r.headers.items()},
                        body=body, chain=chain, ttfb=ttfb, seconds=round(time.time() - t0, 2))
        except urllib.error.HTTPError as e:
            loc = e.headers.get("Location")
            if e.code in (301, 302, 303, 307, 308) and loc:
                nxt = urllib.parse.urljoin(cur, loc)
                chain.append({"from": cur, "status": e.code, "to": nxt})
                if not follow:
                    return dict(status=e.code, final=nxt, headers={k.lower(): v for k, v in e.headers.items()},
                                body=b"", chain=chain, ttfb=None, seconds=round(time.time() - t0, 2))
                cur = nxt
                continue
            body = b""
            try: body = e.read() if read else b""
            except Exception: pass
            return dict(status=e.code, final=cur, headers={k.lower(): v for k, v in e.headers.items()},
                        body=body, chain=chain, ttfb=None, seconds=round(time.time() - t0, 2))
        except Exception as e:
            return dict(status=0, final=cur, headers={}, body=str(e).encode(), chain=chain, ttfb=None,
                        seconds=round(time.time() - t0, 2))
    return dict(status=0, final=cur, headers={}, body=b"too many redirects", chain=chain, ttfb=None, seconds=0)


def clean(s):
    return re.sub(r"\s+", " ", s or "").strip()


def stable_id(i):
    # Skip generated ids (hashes, long numbers) that won't help a developer find the element.
    return i and not re.search(r"[0-9a-f]{10,}|\d{5,}|^(:r|__)", i)


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []  # (tag, attrs, builder_id, hidden_set)
        self.meta, self.links_rel, self.imgs, self.anchors, self.scripts, self.resources = [], [], [], [], [], []
        self.videos, self.iframes, self.forms, self.ids, self.titles = [], [], 0, set(), []
        self.headings, self.in_title, self.in_head = [], False, True
        self.cur_h = self.cur_a = None
        self.body_class = self.html_lang = ""
        self.builder_els = {}  # Elementor data-id -> info
        self.jsonld, self.in_jsonld, self.jbuf = [], False, ""
        self.text_chunks, self.main_chunks, self.skip = [], [], 0

    def _ctx(self):
        ids, hidden = [], set()
        for _, _, bid, hid in self.stack:
            if bid: ids.append(bid)
            hidden |= hid
        return ids, hidden

    def _loc(self):
        """Short CSS locator: nearest stable #id or builder [data-id], plus landmark tags."""
        parts = []
        for tag, d, bid, _ in reversed(self.stack):
            if stable_id(d.get("id")):
                parts.append("#" + d["id"]); break
            if bid:
                parts.append(f'[data-id="{bid}"]'); break
            if tag in ("section", "header", "footer", "nav", "main", "article", "aside", "form"):
                c = (d.get("class") or "").split()
                parts.append(tag + ("." + c[0] if c else ""))
            if len(parts) >= 3: break
        return " > ".join(reversed(parts)) or "body"

    def _in_nav(self):
        for t, d, _, _ in self.stack:
            c = d.get("class", "")
            if t in ("nav", "header", "footer") or d.get("role") in ("navigation", "banner", "contentinfo") \
               or re.search(r"(^|[\s_-])(menu|navbar|nav|site-header|site-footer|location-header|location-footer)([\s_-]|$)", c):
                return True
        return False

    def handle_starttag(self, tag, a):
        d = {k: (v or "") for k, v in a}
        cls = d.get("class", "")
        if d.get("id"): self.ids.add(d["id"])
        if d.get("name") and tag == "a": self.ids.add(d["name"])
        bid = d.get("data-id") if ("elementor-element" in cls or d.get("data-element_type")) else None
        hid = set(re.findall(r"elementor-hidden-(desktop|tablet|mobile)", cls))
        if "hidden" in d and tag not in ("input",): hid |= {"desktop", "tablet", "mobile"}
        if tag == "html": self.html_lang = d.get("lang", "")
        if tag == "body": self.in_head = False; self.body_class = cls
        if bid:
            ids, ph = self._ctx()
            self.builder_els[bid] = {"type": d.get("data-widget_type", d.get("data-element_type", "")),
                                     "hidden_self": sorted(hid), "parents": ids[-3:], "text": "", "links": []}
        if tag not in VOID:
            self.stack.append((tag, d, bid, hid))
        _, hidden = self._ctx()
        where = {"loc": self._loc(), "hidden": sorted(hidden)}
        if tag == "title" and not any(t == "svg" for t, *_ in self.stack):  # <title> inside SVG is not the page title
            self.in_title = True; self.titles.append("")
        if tag == "meta": self.meta.append(d)
        elif tag == "link":
            self.links_rel.append(d)
            if "stylesheet" in d.get("rel", "").lower(): self.resources.append(("css", d.get("href", "")))
        elif tag == "img":
            self.imgs.append({**{k: d.get(k) for k in ("src", "data-src", "data-lazy-src", "srcset", "alt", "width",
                                                    "height", "loading", "fetchpriority", "class", "decoding")},
                              "has_alt": "alt" in d, **where, "in_nav": self._in_nav()})
            self.resources.append(("img", d.get("src", "")))
            if self.cur_a is not None: self.cur_a["img_alt"] += d.get("alt", "")
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.cur_h = {"level": int(tag[1]), "text": "", **where, "in_nav": self._in_nav()}
        elif tag == "a":
            self.cur_a = {"href": d.get("href"), "rel": d.get("rel", ""), "text": "", "img_alt": "",
                          "aria": d.get("aria-label") or d.get("title") or "", **where, "in_nav": self._in_nav()}
        elif tag == "video":
            self.videos.append({"src": d.get("src", ""), "autoplay": "autoplay" in d, "muted": "muted" in d,
                                "preload": d.get("preload"), "poster": d.get("poster", ""), "sources": [], **where})
        elif tag == "source" and self.videos and any(t == "video" for t, *_ in self.stack):
            self.videos[-1]["sources"].append(d.get("src", ""))
        elif tag == "iframe":
            self.iframes.append({"src": (d.get("src") or d.get("data-src") or "")[:200], "title": d.get("title", ""),
                                 "loading": d.get("loading"), **where})
            self.resources.append(("iframe", d.get("src", "")))
        elif tag == "form":
            self.forms += 1
        elif tag == "script":
            if "ld+json" in d.get("type", ""): self.in_jsonld, self.jbuf = True, ""
            elif d.get("src"):
                t = d.get("type", "")
                self.scripts.append({"src": d["src"], "head": self.in_head, "async": "async" in d, "defer": "defer" in d,
                                     "module": t == "module", "type": t,
                                     "delayed": bool(re.search(r"rocketlazyloadscript|litespeed|text/plain|nitropack", t))})
                self.resources.append(("js", d["src"]))
            self.skip += 1
        elif tag in ("style", "noscript", "template"):
            self.skip += 1

    def handle_endtag(self, tag):
        if tag == "title": self.in_title = False
        if tag == "script":
            if self.in_jsonld: self.jsonld.append(self.jbuf); self.in_jsonld = False
            self.skip = max(0, self.skip - 1)
        if tag in ("style", "noscript", "template"): self.skip = max(0, self.skip - 1)
        if self.cur_h and tag == f"h{self.cur_h['level']}":
            self.cur_h["raw"] = self.cur_h["text"]; self.cur_h["text"] = clean(self.cur_h["text"])
            self.headings.append(self.cur_h); self.cur_h = None
        if tag == "a" and self.cur_a is not None:
            self.cur_a["text"] = clean(self.cur_a["text"]); self.anchors.append(self.cur_a)
            ids, _ = self._ctx()
            if ids and ids[-1] in self.builder_els: self.builder_els[ids[-1]]["links"].append(self.cur_a["href"])
            self.cur_a = None
        for i in range(len(self.stack) - 1, -1, -1):  # tolerant close
            if self.stack[i][0] == tag:
                del self.stack[i:]; break

    def handle_data(self, x):
        if self.in_title: self.titles[-1] += x
        if self.in_jsonld: self.jbuf += x; return
        if self.skip: return
        if self.cur_h is not None: self.cur_h["text"] += x
        if self.cur_a is not None: self.cur_a["text"] += x
        if not self.in_head and x.strip():
            self.text_chunks.append(x)
            if not self._in_nav(): self.main_chunks.append(x)
            ids, _ = self._ctx()
            if ids and ids[-1] in self.builder_els and len(self.builder_els[ids[-1]]["text"]) < 300:
                self.builder_els[ids[-1]]["text"] += " " + clean(x)


def meta_all(metas):
    out = {}
    for m in metas:
        k = m.get("name") or m.get("property") or m.get("http-equiv") or m.get("itemprop")
        if k: out.setdefault(k.lower(), []).append(m.get("content", ""))
    return out


def detect_platform(html, headers, gen):
    h = html[:600000]
    def has(*pats): return any(re.search(x, h, re.I) for x in pats)
    hk = " ".join(f"{k}:{v}" for k, v in headers.items())
    cms = ""
    if has(r"/wp-content/", r"/wp-includes/") or "wordpress" in gen.lower(): cms = "WordPress"
    elif has(r"cdn\.shopify\.com", r"Shopify\.theme") or "x-shopid" in headers: cms = "Shopify"
    elif has(r"static\.wixstatic\.com", r"wix-bolt|wixBiSession") or "x-wix-request-id" in headers: cms = "Wix"
    elif has(r"static1\.squarespace\.com", r"SQUARESPACE_CONTEXT"): cms = "Squarespace"
    elif has(r"data-wf-page", r"data-wf-site") or "webflow" in gen.lower(): cms = "Webflow"
    elif has(r"drupal-settings-json", r"Drupal\.settings", r"/sites/default/files/") or "drupal" in (gen + hk).lower(): cms = "Drupal"
    elif "joomla" in gen.lower() or has(r"/media/jui/", r"/components/com_"): cms = "Joomla"
    elif has(r"/static/version\d+/frontend/", r"Magento_"): cms = "Magento"
    elif has(r"cdn\d*\.bigcommerce\.com"): cms = "BigCommerce"
    elif has(r"hs-sites\.com|hubspotusercontent"): cms = "HubSpot CMS"
    elif has(r"framerusercontent\.com", r"data-framer-"): cms = "Framer"
    elif "ghost" in gen.lower(): cms = "Ghost"
    elif "laravel_session" in headers.get("set-cookie", "") or has(r'name="csrf-token"', r"/build/assets/[^\"']+\.js", r"livewire", r"Illuminate\\"): cms = "Laravel"
    elif gen: cms = gen.split(" ")[0]
    builder = next((n for n, p in [("Elementor", r"elementor-element"), ("Divi", r"et_pb_section"),
                                   ("WPBakery", r"vc_row|wpb_wrapper"), ("Beaver Builder", r"fl-builder-content"),
                                   ("Bricks", r"brxe-"), ("Oxygen", r'class="[^"]*\bct-section\b'), ("Breakdance", r"bde-section"),
                                   ("Gutenberg", r"wp-block-")] if has(p)), "") if cms == "WordPress" else ""
    stack = [n for n, p in [("Inertia", r'data-page="|id="app" data-page|@inertiajs'), ("Livewire", r"wire:(id|snapshot|model|click)|livewire(\.min)?\.js"),
                            ("Alpine.js", r"x-data=|alpinejs"), ("Vite", r"/build/assets/|@vite/client"), ("Tailwind", r"tailwind")] if has(p)]
    framework = next((n for n, p in [("Next.js", r"__NEXT_DATA__|/_next/static"), ("Nuxt", r"__NUXT__|/_nuxt/"),
                                     ("Gatsby", r"___gatsby"), ("Astro", r"astro-island|data-astro-cid"),
                                     ("SvelteKit", r"__sveltekit"), ("Remix", r"__remixContext"),
                                     ("Angular", r"ng-version="), ("Vue", r"data-v-[0-9a-f]{6}|data-server-rendered"),
                                     ("React", r"data-reactroot|react-dom")] if has(p)), "")
    if "Inertia" in stack and not framework:
        framework = "Inertia + " + ("Vue" if has(r"@inertiajs/vue3|data-v-|vue") else "React" if has(r"@inertiajs/react|react") else "Svelte" if has(r"svelte") else "JS")
    seo_plugin = next((n for n, p in [("Yoast SEO", r"yoast-schema-graph|Yoast SEO plugin"), ("Rank Math", r"rank-math|rankmath"),
                                      ("All in One SEO", r"aioseo"), ("SEOPress", r"seopress"),
                                      ("The SEO Framework", r"The SEO Framework")] if has(p)), "")
    cache = next((n for n, p in [("WP Rocket", r"wp-rocket|rocketlazyloadscript"), ("LiteSpeed Cache", r"litespeed"),
                                 ("W3 Total Cache", r"W3 Total Cache"), ("NitroPack", r"nitropack"),
                                 ("Autoptimize", r"autoptimize"), ("WP Super Cache", r"WP-Super-Cache")] if has(p)), "")
    cdn = next((n for n, k in [("Cloudflare", "cf-ray"), ("Vercel", "x-vercel-id"), ("Netlify", "x-nf-request-id"),
                               ("CloudFront", "x-amz-cf-id"), ("Fastly", "x-served-by"), ("Akamai", "x-akamai-transformed"),
                               ("SiteGround", "x-sg-cache"), ("Kinsta", "x-kinsta-cache"), ("WP Engine", "x-wpe-backend")]
                if k in headers), "")
    return {"cms": cms, "builder": builder, "framework": framework, "seo_plugin": seo_plugin,
            "cache_plugin": cache, "cdn_host": cdn, "generator": gen, "stack": stack}


def parse_robots(txt):
    """Return {agent_lower: {"allow": [...], "disallow": [...]}} and declared sitemaps."""
    groups, cur, last_was_agent = {}, [], False
    for line in txt.splitlines():
        line = line.split("#", 1)[0].strip()
        if ":" not in line: continue
        k, v = [x.strip() for x in line.split(":", 1)]
        k = k.lower()
        if k == "user-agent":
            if not last_was_agent: cur = []
            cur.append(v.lower()); groups.setdefault(v.lower(), {"allow": [], "disallow": []}); last_was_agent = True
        elif k in ("allow", "disallow"):
            last_was_agent = False
            for a in cur: groups[a][k].append(v)
    return groups, re.findall(r"(?im)^\s*sitemap:\s*(\S+)", txt)


def robots_blocks(groups, agent, path):
    g = groups.get(agent.lower()) or groups.get("*") or {"allow": [], "disallow": []}
    def match(rule):
        if not rule: return 0
        pat = re.escape(rule).replace(r"\*", ".*")
        if pat.endswith(r"\$"): pat = pat[:-2] + "$"
        return len(rule) if re.match(pat, path) else 0
    d = max((match(r) for r in g["disallow"]), default=0)
    a = max((match(r) for r in g["allow"]), default=0)
    return d > a, [r for r in g["disallow"] if match(r)]


def sitemap_search(base, url, declared):
    maps = declared or [urllib.parse.urljoin(base, "/sitemap.xml"), urllib.parse.urljoin(base, "/sitemap_index.xml")]
    seen, level, found_in, target = set(), list(dict.fromkeys(maps)), None, url.rstrip("/")
    path_bits = [b for b in urllib.parse.urlparse(url).path.split("/") if b]
    def get(sm):
        r = fetch(sm, timeout=15)
        return sm, r["status"], r["body"].decode("utf-8", "ignore")
    with ThreadPoolExecutor(8) as ex:
        while level and len(seen) < 30 and not found_in:
            level = [s for s in level if s not in seen][:30 - len(seen)]
            seen.update(level)
            nxt = []
            for sm, st, txt in ex.map(get, level):
                locs = re.findall(r"<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)", txt)
                if "<sitemapindex" in txt:
                    kids = [l for l in locs if not re.search(r"(image|video|author|category|tag|product_cat)", l, re.I)]
                    # likely children first (page/post sitemaps, or ones named after the URL's first segment)
                    kids.sort(key=lambda l: 0 if re.search(r"page|post|" + "|".join(map(re.escape, path_bits[:1])) if path_bits else r"page|post", l) else 1)
                    nxt += kids
                elif target in (l.rstrip("/") for l in locs):
                    found_in = sm; break
            level = nxt
    return {"declared": declared, "sitemaps_checked": len(seen), "found_in": found_in}


def schema_nodes(blocks):
    nodes, errors = [], []
    for b in blocks:
        try:
            o = json.loads(b)
        except Exception as e:
            errors.append(f"{e}: {b.strip()[:120]}"); continue
        for it in (o if isinstance(o, list) else [o]):
            if isinstance(it, dict) and "@graph" in it: nodes += [n for n in it["@graph"] if isinstance(n, dict)]
            elif isinstance(it, dict): nodes.append(it)
    return nodes, errors


def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    url, out = sys.argv[1], sys.argv[2]
    linkcheck = "--no-linkcheck" not in sys.argv
    t_start = time.time()

    r = fetch(url)
    if r["status"] == 0:
        sys.exit(f"Could not fetch {url}: {r['body'].decode('utf-8', 'ignore')}")
    final, headers, body = r["final"], r["headers"], r["body"]
    html = body.decode("utf-8", "ignore")
    p = Page(); p.feed(html)
    mm = meta_all(p.meta)
    m1 = {k: v[0] for k, v in mm.items()}
    pu = urllib.parse.urlparse(final)
    host, base, path = pu.netloc, f"{pu.scheme}://{pu.netloc}", pu.path or "/"
    canon_all = [l.get("href") for l in p.links_rel if l.get("rel", "").lower() == "canonical"]
    canon = urllib.parse.urljoin(final, canon_all[0]) if canon_all else None
    plat = detect_platform(html, headers, m1.get("generator", ""))

    # --- links (gather before the parallel network stage) ---
    internal, hash_links, nameless, anchors_inpage, external, nofollow_internal = [], [], [], [], 0, []
    for a in p.anchors:
        href = (a["href"] or "").strip()
        name = a["text"] or a["aria"] or a["img_alt"]
        if not name.strip(): nameless.append({"href": href[:120], "loc": a["loc"], "in_nav": a["in_nav"]})
        if href in ("#", "") or href.lower().startswith("javascript"):
            hash_links.append({"text": a["text"][:60], "loc": a["loc"], "in_nav": a["in_nav"]}); continue
        absu = urllib.parse.urljoin(final, href)
        u = urllib.parse.urlparse(absu)
        if href.startswith("#") or (u.netloc == host and u.path == pu.path and u.fragment):
            anchors_inpage.append({"target": u.fragment, "text": a["text"][:60], "loc": a["loc"], "in_nav": a["in_nav"]})
            continue
        if not u.scheme.startswith("http"): continue
        if u.netloc.replace("www.", "") == host.replace("www.", ""):
            internal.append({"url": absu.split("#")[0], "text": a["text"][:60], "in_nav": a["in_nav"], "hidden": a["hidden"]})
            if "nofollow" in a["rel"].lower(): nofollow_internal.append(absu)
        else:
            external += 1
    uniq = sorted({l["url"] for l in internal if l["url"]})

    # --- parallel network checks ---
    alt_host = host[4:] if host.startswith("www.") else "www." + host
    jobs = {
        "robots": lambda: fetch(base + "/robots.txt", timeout=12),
        "http": lambda: fetch(f"http://{host}{path}", follow=False, timeout=12, read=False),
        "alt_host": lambda: fetch(f"{pu.scheme}://{alt_host}{path}", follow=False, timeout=12, read=False),
        "llms": lambda: fetch(base + "/llms.txt", timeout=10, read=False),
    }
    ogi = m1.get("og:image")
    if ogi: jobs["og_image"] = lambda: fetch(urllib.parse.urljoin(final, ogi), timeout=12, read=False)
    with ThreadPoolExecutor(6) as ex:
        futs = {k: ex.submit(f) for k, f in jobs.items()}
        res = {k: f.result() for k, f in futs.items()}
    robots_txt = res["robots"]["body"].decode("utf-8", "ignore") if res["robots"]["status"] == 200 else ""
    groups, declared = parse_robots(robots_txt)
    blocked, blocking_rules = robots_blocks(groups, "googlebot", path)
    ai_blocked = [b for b in AI_BOTS if b.lower() in groups and robots_blocks(groups, b, "/")[0]]

    link_status = {}
    with ThreadPoolExecutor(16) as ex:
        sm_f = ex.submit(sitemap_search, base, final, declared)
        if linkcheck and uniq:
            def chk(u):
                x = fetch(u, timeout=12, read=False)
                return u, {"status": x["status"], "final": x["final"], "hops": len(x["chain"])}
            link_status = dict(ex.map(chk, uniq[:200]))
        sitemap = sm_f.result()
    bad_links = [{"url": u, **s, "texts": sorted({l["text"] for l in internal if l["url"] == u})[:3],
                  "in_nav_only": all(l["in_nav"] for l in internal if l["url"] == u)}
                 for u, s in link_status.items() if s["status"] != 200 or s["hops"]]

    # --- headings ---
    content_h = [h for h in p.headings if not h["in_nav"]]
    first_h1 = next((i for i, h in enumerate(p.headings) if h["level"] == 1), None)
    skips, prev = [], 0
    for h in content_h:
        if prev and h["level"] > prev + 1:
            skips.append({"text": h["text"][:90], "level": h["level"], "after_level": prev, "loc": h["loc"]})
        prev = h["level"]
    dup = {}
    for h in content_h: dup.setdefault(h["text"].lower(), []).append(h)
    duplicates = [{"text": v[0]["text"][:100], "copies": [{"level": h["level"], "loc": h["loc"], "hidden": h["hidden"]} for h in v]}
                  for v in dup.values() if len(v) > 1 and v[0]["text"]]

    # --- images ---
    imgs = []
    for im in p.imgs:
        src = im.get("data-lazy-src") or im.get("data-src") or im.get("src") or ""
        fname = "" if src.startswith("data:") else urllib.parse.unquote(urllib.parse.urlparse(src).path.rsplit("/", 1)[-1])
        cls = im.get("class") or ""
        imgs.append({"file": fname, "src": src[:200], "alt": im.get("alt"), "has_alt": im["has_alt"],
                     "width": im.get("width"), "height": im.get("height"),
                     "lazy": bool(im.get("loading") == "lazy" or im.get("data-lazy-src") or im.get("data-src") or "lazy" in cls),
                     "fetchpriority": im.get("fetchpriority"),
                     "cms_image_id": (re.search(r"wp-image-(\d+)", cls) or [None, None])[1],
                     "camera_name": bool(CAMERA.search(fname)),
                     "format": fname.rsplit(".", 1)[-1].lower() if "." in fname else "",
                     "loc": im["loc"], "hidden": im["hidden"], "in_nav": im["in_nav"]})
    content_imgs = [i for i in imgs if not i["in_nav"] and i["file"]]
    img_summary = {
        "total": len(imgs), "content": len(content_imgs),
        "content_missing_alt_attr": sum(1 for i in content_imgs if not i["has_alt"]),
        "content_missing_or_empty_alt": sum(1 for i in content_imgs if not (i["alt"] or "").strip()),
        "camera_file_names": sorted({i["file"] for i in content_imgs if i["camera_name"]})[:30],
        "no_dimensions": sorted({i["file"] for i in content_imgs if not (i["width"] and i["height"])})[:20],
        "duplicate_files": {f: n for f in {i["file"] for i in content_imgs}
                            if (n := sum(1 for i in content_imgs if i["file"] == f)) > 1},
        "first_content_images": content_imgs[:4],
        "bad_alt_values": sorted({i["alt"] for i in imgs if i["alt"] and re.search(
            r"['+]alt['+]|placeholder|^(image|img|photo|picture|logo)\s*\d*$|\.(jpe?g|png|webp|gif|svg)$", i["alt"], re.I)}),
        "formats": {f: sum(1 for i in content_imgs if i["format"] == f) for f in {i["format"] for i in content_imgs}},
    }

    # --- builder elements (Elementor) hidden on every device ---
    hidden_all = [{"id": k, "type": v["type"], "text": v["text"][:120], "links": v["links"][:5]}
                  for k, v in p.builder_els.items() if set(v["hidden_self"]) >= {"desktop", "tablet", "mobile"}]

    # --- schema ---
    nodes, schema_errors = schema_nodes(p.jsonld)
    types = []
    for n in nodes:
        t = n.get("@type")
        types.append(t if isinstance(t, str) else ",".join(map(str, t)) if isinstance(t, list) else str(t))
    faq_q = sum(len(n.get("mainEntity", []) or []) for n in nodes if n.get("@type") == "FAQPage")
    lowercase_types = sorted(set(re.findall(r'"@type"\s*:\s*"([a-z][A-Za-z]+)"', " ".join(p.jsonld))))
    date_modified = next((n.get("dateModified") for n in nodes if n.get("dateModified")), None)

    # --- scripts, resources, security ---
    blocking = [s["src"] for s in p.scripts if s["head"] and not (s["async"] or s["defer"] or s["module"] or s["delayed"])
                and s["type"] in ("", "text/javascript", "application/javascript")]
    mixed = sorted({src for kind, src in p.resources if pu.scheme == "https" and (src or "").startswith("http://")})[:20]
    sec = {k: headers.get(k) for k in ("strict-transport-security", "content-security-policy", "x-content-type-options",
                                         "x-frame-options", "referrer-policy", "permissions-policy")}

    # --- hreflang ---
    hreflang = [{"lang": l.get("hreflang"), "href": l.get("href")} for l in p.links_rel
                if l.get("rel", "").lower() == "alternate" and l.get("hreflang")]

    # --- invisible characters (U+2028 etc. pasted from documents) ---
    invis = {}
    for label, val in [("title", "".join(p.titles)), ("description", m1.get("description", "")),
                       ("og:title", m1.get("og:title", "")), ("og:description", m1.get("og:description", "")),
                       ("twitter:title", m1.get("twitter:title", "")), ("twitter:description", m1.get("twitter:description", ""))] + \
                      [(f"H{h['level']} {h['text'][:40]}", h.get("raw", "")) for h in content_h]:
        n = len(INVISIBLE.findall(val or ""))
        if n: invis[label] = n

    inertia = None
    # Inertia 1.x: <div id="app" data-page="{json}">; 2.x: <script data-page="app" type="application/json">{json}</script>
    m_ip = re.search(r'<script[^>]+data-page="[^"]*"[^>]*>(.*?)</script>', html, re.S) or re.search(r'data-page="(\{[^"]+)"', html)
    if m_ip:
        import html as _h
        try:
            po = json.loads(_h.unescape(m_ip.group(1)))
            inertia = {"component": po.get("component"), "url": po.get("url"), "version": po.get("version"),
                       "ssr": len(p.headings) > 0 or len(re.findall(r"\w+", " ".join(p.main_chunks))) > 50,
                       "props": sorted((po.get("props") or {}).keys())[:20]}
        except Exception:
            inertia = {"component": None, "parse_error": True}
    soft_error = None
    for label, pat in [("PHP fatal error", r"<b>(Fatal|Parse) error</b>|PHP (Fatal|Parse) error|Uncaught (Error|Exception)"),
                       ("Laravel error page", r"Whoops, looks like something went wrong|<title>[^<]*\\(Illuminate|Symfony)\\|window\.ignite|ignition-ui"),
                       ("WordPress critical error", r"There has been a critical error on this website|Error establishing a database connection"),
                       ("stack trace", r"Stack trace:\s*#0"), ("Next.js error", r"Application error: a (client|server)-side exception"),
                       ("server error text", r"<title>\s*(500|502|503|Internal Server Error|Server Error|Service Unavailable)")]:
        m_e = re.search(pat, html[:200000])
        if m_e: soft_error = {"kind": label, "snippet": clean(re.sub(r"<[^>]+>", " ", html[max(0, m_e.start() - 80):m_e.start() + 220]))[:260]}; break
    title = clean(p.titles[0]) if p.titles else ""
    desc = m1.get("description")
    text = clean(" ".join(p.text_chunks))
    main_text = clean(" ".join(p.main_chunks))
    page_id = (re.search(r"\b(?:page-id|postid)-(\d+)", p.body_class) or [None, None])[1]
    result = {
        "url": url, "final_url": final, "status": r["status"], "redirect_chain": r["chain"],
        "ttfb_seconds": r["ttfb"], "fetch_seconds": r["seconds"], "html_bytes": len(body),
        "content_encoding": headers.get("content-encoding"), "cache_control": headers.get("cache-control"),
        "server": headers.get("server"), "x_robots_tag": headers.get("x-robots-tag"),
        "platform": plat, "page_id": page_id, "inertia": inertia, "soft_error": soft_error,
        "modified_time": m1.get("article:modified_time") or m1.get("og:updated_time") or date_modified or headers.get("last-modified"),
        "published_time": m1.get("article:published_time"),
        "indexing": {
            "robots_meta": m1.get("robots"), "googlebot_meta": m1.get("googlebot"),
            "noindex": bool(re.search(r"noindex|none", " ".join(mm.get("robots", []) + mm.get("googlebot", []) + [headers.get("x-robots-tag") or ""]), re.I)),
            "canonical": canon, "canonical_count": len(canon_all),
            "canonical_relative": bool(canon_all and not canon_all[0].startswith("http")),
            "canonical_matches_final": (canon or "").rstrip("/") == final.rstrip("/") if canon else None,
            "robots_txt_status": res["robots"]["status"], "robots_txt_blocks_googlebot": blocked,
            "robots_txt_blocking_rules": blocking_rules, "robots_txt_sitemaps": declared,
            "ai_crawlers_blocked": ai_blocked, "llms_txt": res["llms"]["status"] == 200,
            "sitemap": sitemap,
            "http_variant": {"status": res["http"]["status"], "to": res["http"]["final"]},
            "alt_host_variant": {"host": alt_host, "status": res["alt_host"]["status"], "to": res["alt_host"]["final"]},
            "meta_refresh": m1.get("refresh"),
            "hreflang": hreflang,
            "hreflang_self": any((h["href"] or "").rstrip("/") == final.rstrip("/") for h in hreflang),
            "hreflang_x_default": any(h["lang"] == "x-default" for h in hreflang),
        },
        "meta": {
            "title": title, "title_len": len(title), "title_count": len(p.titles),
            "description": desc, "description_len": len(desc or ""), "description_count": len(mm.get("description", [])),
            "og": {k: v for k, v in m1.items() if k.startswith("og:")},
            "og_image_status": res.get("og_image", {}).get("status"),
            "twitter": {k: v for k, v in m1.items() if k.startswith("twitter:")},
            "viewport": m1.get("viewport"), "charset": bool(re.search(r"<meta[^>]+charset", html[:3000], re.I)),
            "lang": p.html_lang,
            "favicon": any("icon" in l.get("rel", "").lower() for l in p.links_rel),
            "invisible_characters": invis,
        },
        "headings": {
            "h1_count": sum(1 for h in p.headings if h["level"] == 1),
            "h1s": [{"text": h["text"][:120], "loc": h["loc"], "hidden": h["hidden"]} for h in p.headings if h["level"] == 1],
            "headings_before_h1": [f"H{h['level']} {h['text'][:60]}" for h in p.headings[:first_h1]] if first_h1 else [],
            "outline": [{"level": h["level"], "text": h["text"][:110], "loc": h["loc"], "hidden": h["hidden"]} for h in content_h],
            "skips": skips, "empty": sum(1 for h in p.headings if not h["text"]),
            "numeric_only": [h["text"] for h in content_h if re.fullmatch(r"[\d.,#+%]+", h["text"] or "x")],
            "duplicated_text": duplicates,
        },
        "images": img_summary,
        "videos": p.videos[:10], "iframes": p.iframes[:15], "forms": p.forms,
        "builder_hidden_everywhere": hidden_all,
        "links": {"total": len(p.anchors), "internal": len(internal), "internal_unique": len(uniq), "external": external,
                  "checked": len(link_status), "redirecting_or_broken": bad_links, "hash_or_js": hash_links,
                  "nameless": len(nameless), "nameless_sample": nameless[:15],
                  "in_page_anchors": anchors_inpage[:40],
                  "in_page_missing_targets": [a for a in anchors_inpage if a["target"] and a["target"] not in p.ids][:20],
                  "nofollow_internal": sorted(set(nofollow_internal))[:20]},
        "schema": {"types": types, "faq_questions": faq_q, "parse_errors": schema_errors,
                   "lowercase_types": lowercase_types, "blocks": len(p.jsonld),
                   "has_microdata": "itemtype=" in html},
        "scripts": {"total": len(p.scripts), "render_blocking_head": blocking},
        "security": {"https": pu.scheme == "https", "headers": sec, "mixed_content": mixed},
        "word_count_raw": len(re.findall(r"\w+", text)),
        "word_count_main": len(re.findall(r"\w+", main_text)),
        "text_sample": main_text[:4000],
        "fetched_at_utc": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
        "collect_seconds": round(time.time() - t_start, 1),
    }
    with open(out, "w") as f:
        json.dump(result, f, indent=1, ensure_ascii=False)
    ix, h = result["indexing"], result["headings"]
    print(f"{r['status']} {final} | {plat['cms'] or '?'} {plat['builder'] or plat['framework']} | "
          f"noindex={ix['noindex']} canonical={'yes' if canon else 'NO'} sitemap={'yes' if sitemap['found_in'] else 'NO'} | "
          f"H1={h['h1_count']} | alt-missing={img_summary['content_missing_or_empty_alt']}/{img_summary['content']} | "
          f"bad links={len(bad_links)} | {result['collect_seconds']}s -> {out}")


if __name__ == "__main__":
    main()
