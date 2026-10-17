# PageSpeed proxy

A Cloudflare Worker that lets everyone who installs the seo-audit plugin use Google PageSpeed Insights without their own API key. The key is stored as a Worker secret and never leaves Cloudflare.

- `GET /?url=https://example.com/&strategy=mobile|desktop` returns Google's PageSpeed JSON unchanged.
- Only PageSpeed requests with the four Lighthouse categories are forwarded, so the key can't be used for anything else.
- Local and private addresses are refused before any quota is spent.
- Limits per IP: 12 requests a minute (`[[ratelimits]]` in `wrangler.toml`) and 100 a UTC day (`DAILY_LIMIT`, counted by a small Durable Object per IP).
- Errors use Google's format, so the plugin falls back to local Lighthouse on any failure.

## Deploy

```bash
cd proxy/pagespeed
npx wrangler login
npx wrangler secret put PSI_KEY
npx wrangler deploy
```

Put the `workers.dev` URL that `deploy` prints into `PROXY` in `plugins/seo-audit/skills/seo-audit/scripts/pagespeed.mjs`.

In Google Cloud Console, restrict the key to the PageSpeed Insights API. Google allows about 25,000 PageSpeed requests a day per project; that is the total for all users.

## Local test

```bash
npx wrangler dev --var PSI_KEY:YOUR_KEY
curl "http://127.0.0.1:8787/?url=https://example.com/&strategy=mobile"
```
