// PageSpeed Insights proxy for the seo-audit plugin.
//
// Lets everyone who installs the plugin get Google PageSpeed results without
// their own API key, while the key stays here as a Worker secret (PSI_KEY).
//
//   GET /?url=https://example.com/&strategy=mobile|desktop
//
// Only runPagespeed with the four Lighthouse categories is forwarded, so the
// key can't be used for anything else. Limits per visitor IP:
//   - BURST: requests per minute (Workers rate limiting binding)
//   - DAILY: requests per UTC day (one small Durable Object per IP)
// Errors use Google's shape, { error: { code, message } }, so the plugin
// handles them like any PageSpeed error and falls back to local Lighthouse.
import { DurableObject } from "cloudflare:workers";

const API = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const CATEGORIES = ["PERFORMANCE", "ACCESSIBILITY", "BEST_PRACTICES", "SEO"];

const fail = (code, message, headers = {}) =>
  Response.json({ error: { code, message } }, { status: code, headers });

// Google can only test public sites; refuse local and private addresses early
// instead of spending quota on them.
function badTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { return "url is not a valid URL"; }
  if (!/^https?:$/.test(u.protocol)) return "url must be http or https";
  if (raw.length > 2048) return "url is too long";
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || /\.(test|localhost|local|internal)$/.test(h)) return "url is a local address";
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) || h.startsWith("[")) return "url is a private address";
  return null;
}

export default {
  async fetch(req, env) {
    if (req.method !== "GET") return fail(405, "Use GET");
    const q = new URL(req.url).searchParams;
    const url = q.get("url") || "", strategy = q.get("strategy") || "mobile";
    if (!["mobile", "desktop"].includes(strategy)) return fail(400, "strategy must be mobile or desktop");
    const bad = badTarget(url);
    if (bad) return fail(400, bad);

    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const burst = await env.BURST.limit({ key: ip });
    if (!burst.success) return fail(429, "Too many PageSpeed requests from this address; wait a minute", { "Retry-After": "60" });
    const daily = await env.DAILY.get(env.DAILY.idFromName(ip)).hit(Number(env.DAILY_LIMIT) || 100);
    if (!daily.ok) return fail(429, `Daily limit of ${daily.limit} PageSpeed requests reached for this address; add your own free API key (setup.mjs --pagespeed-key=KEY)`);

    const g = new URLSearchParams({ url, strategy, key: env.PSI_KEY });
    for (const c of CATEGORIES) g.append("category", c);
    const r = await fetch(`${API}?${g}`, { headers: { "Accept": "application/json" } });
    // Pass Google's answer through unchanged.
    return new Response(r.body, {
      status: r.status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Daily-Remaining": String(daily.limit - daily.n) },
    });
  },
};

// One instance per IP: counts requests for the current UTC day.
export class DailyQuota extends DurableObject {
  async hit(limit) {
    const day = new Date().toISOString().slice(0, 10);
    let s = (await this.ctx.storage.get("s")) || { day, n: 0 };
    if (s.day !== day) s = { day, n: 0 };
    if (s.n >= limit) return { ok: false, n: s.n, limit };
    s.n++;
    await this.ctx.storage.put("s", s);
    return { ok: true, n: s.n, limit };
  }
}
