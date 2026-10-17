#!/usr/bin/env python3
"""TTFB (time to first byte) for one URL, broken into DNS, connect, TLS and
server wait, measured several times from this machine.

    python3 -I ttfb.py <url> <out.json> [samples]

It follows redirects first (and reports what they cost), then times the final
URL `samples` times (default 5) on fresh connections, plus 2 cache-busted
requests (a random query string) that usually skip the page cache and show how
fast the origin server builds the page. Standard library only.
"""
import json, os, random, socket, ssl, statistics, sys, time, urllib.parse
from urllib.parse import urlsplit, urlunsplit

LOCAL = (".test", ".localhost", ".local")
CACHE_HEADERS = ("server", "cache-control", "age", "cf-cache-status", "x-cache", "x-cache-status", "x-cache-hits",
                 "x-litespeed-cache", "x-wp-cf-super-cache", "x-kinsta-cache", "x-proxy-cache", "x-varnish",
                 "x-served-by", "x-vercel-cache", "x-nf-request-id", "server-timing", "x-powered-by", "cf-ray",
                 "x-amz-cf-pop", "x-fastly-request-id", "via")
# An honest tool UA: some bot filters return 403 to a fake browser UA without browser headers.
UA = "seo-audit-ttfb/1.1 (+https://github.com/ishakhawat/claude-skills)"


def is_local(host):
    return host in ("localhost", "127.0.0.1", "::1") or host.endswith(LOCAL)


def _verified_context():
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


def ctx_for(host):
    c = _verified_context()
    if is_local(host):
        c.check_hostname = False
        c.verify_mode = ssl.CERT_NONE
    return c


def follow(url):
    """Resolve redirects with the same raw requests as the samples; return (final_url, hops)."""
    hops, cur = [], url
    for _ in range(10):
        try:
            r = sample(cur)
        except Exception:
            hops.append((0, cur, 0))
            return cur, hops
        hops.append((r["status"], cur, r["ttfb_ms"] / 1000))
        loc = r["location"]
        if r["status"] in (301, 302, 303, 307, 308) and loc:
            cur = urllib.parse.urljoin(cur, loc)
            continue
        return cur, hops
    return cur, hops


def sample(url):
    u = urlsplit(url)
    host, https = u.hostname, u.scheme == "https"
    port = u.port or (443 if https else 80)
    path = urlunsplit(("", "", u.path or "/", u.query, ""))
    t0 = time.perf_counter()
    info = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    t_dns = time.perf_counter()
    sock = socket.create_connection(info[0][4][:2], timeout=20)
    t_conn = time.perf_counter()
    if https:
        sock = ctx_for(host).wrap_socket(sock, server_hostname=host)
    t_tls = time.perf_counter()
    req = (f"GET {path} HTTP/1.1\r\nHost: {u.netloc}\r\nUser-Agent: {UA}\r\nAccept: text/html,*/*\r\n"
           f"Accept-Encoding: gzip, br\r\nConnection: close\r\n\r\n")
    sock.sendall(req.encode())
    first = sock.recv(1)
    t_first = time.perf_counter()
    buf = first
    while b"\r\n\r\n" not in buf and len(buf) < 65536:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
    sock.close()
    head = buf.split(b"\r\n\r\n")[0].decode("latin-1").split("\r\n")
    status = int(head[0].split()[1]) if head and len(head[0].split()) > 1 else 0
    headers = {}
    for line in head[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    ms = lambda a, b: round((b - a) * 1000)
    return {"status": status, "dns_ms": ms(t0, t_dns), "connect_ms": ms(t_dns, t_conn), "tls_ms": ms(t_conn, t_tls),
            "wait_ms": ms(t_tls, t_first), "ttfb_ms": ms(t0, t_first), "ip": info[0][4][0],
            "location": headers.get("location"),
            "headers": {k: headers[k][:160] for k in CACHE_HEADERS if k in headers}}


def summarize(samples):
    ok = [s for s in samples if "ttfb_ms" in s]
    if not ok:
        return None
    med = lambda k: round(statistics.median(s[k] for s in ok))
    return {k: med(k) for k in ("dns_ms", "connect_ms", "tls_ms", "wait_ms", "ttfb_ms")} | {
        "min_ms": min(s["ttfb_ms"] for s in ok), "max_ms": max(s["ttfb_ms"] for s in ok), "n": len(ok)}


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    url, out = sys.argv[1], sys.argv[2]
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 5
    final, hops = follow(url)
    runs, busted = [], []
    for _ in range(n):
        try:
            runs.append(sample(final))
        except Exception as e:
            runs.append({"error": str(e)[:200]})
    sep = "&" if urlsplit(final).query else "?"
    for _ in range(2):
        try:
            busted.append(sample(f"{final}{sep}seo_audit_nocache={random.randint(10**8, 10**9)}"))
        except Exception as e:
            busted.append({"error": str(e)[:200]})
    headers = next((s["headers"] for s in runs if "headers" in s), {})
    hit = " ".join(f"{k}={v}" for k, v in headers.items() if "cache" in k and k != "cache-control")
    res = {"url": url, "final_url": final, "local": is_local(urlsplit(final).hostname or ""),
           "redirects": [{"status": s, "url": u, "ms": round(t * 1000)} for s, u, t in hops[:-1]],
           "redirect_ms": round(sum(t for _, _, t in hops[:-1]) * 1000),
           "samples": runs, "cached": summarize(runs), "busted_samples": busted, "busted": summarize(busted),
           "headers": headers, "cache_status": hit or None,
           "measured_from": socket.gethostname(), "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    with open(out, "w") as f:
        json.dump(res, f, indent=1)
    c = res["cached"]
    print(f"ttfb: median {c['ttfb_ms']} ms (wait {c['wait_ms']} ms)" if c else "ttfb: failed")


if __name__ == "__main__":
    main()
