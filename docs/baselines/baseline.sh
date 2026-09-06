#!/usr/bin/env bash
# Read-only security baseline of a deployed KMT host. GET, HEAD and OPTIONS only;
# nothing here signs in, submits, pays or cancels. Run: bash baseline.sh <host>
H="${1:-kmt.fly.dev}"
B="https://$H"
hdr() { curl -s -o /dev/null -D - "$@" | tr -d '\r' | grep -v '^$'; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
echo "# Baseline of $B, $(date -u +%Y-%m-%dT%H:%M:%SZ), read-only"
echo
echo "## TLS"
echo | openssl s_client -connect "$H:443" -servername "$H" 2>/dev/null | openssl x509 -noout -issuer -subject -dates -ext subjectAltName 2>/dev/null | sed 's/^/  /'
echo | openssl s_client -connect "$H:443" -servername "$H" -tls1_2 2>/dev/null | grep -E "Protocol|Cipher" | head -2 | sed 's/^/  tls1.2: /'
echo | openssl s_client -connect "$H:443" -servername "$H" -tls1_3 2>/dev/null | grep -E "Protocol|Cipher" | head -2 | sed 's/^/  tls1.3: /'
echo
echo "## Redirects"
echo "  http://$H/            -> $(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://$H/")"
echo "  http://$H/status      -> $(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://$H/status")"
echo "  https://www.$H/ (if any) -> $(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "https://www.$H/" 2>/dev/null || echo 'no such host')"
echo
echo "## Response headers, GET / (every header, verbatim)"
hdr "$B/" | sed 's/^/  /'
echo
echo "## Security headers present on / (name only)"
for h in strict-transport-security content-security-policy x-content-type-options x-frame-options referrer-policy permissions-policy cross-origin-opener-policy; do
  v=$(curl -s -o /dev/null -D - "$B/" | tr -d '\r' | grep -i "^$h:" | cut -d: -f2- | sed 's/^ //')
  echo "  $h: ${v:-ABSENT}"
done
echo
echo "## Compression (GET with Accept-Encoding: br, gzip)"
for p in / /api/catalog; do
  echo "  $p -> $(curl -s -o /dev/null -D - -H 'Accept-Encoding: br, gzip' -w 'downloaded=%{size_download}' "$B$p" | tr -d '\r' | grep -i -E '^content-encoding|downloaded' | tr '\n' ' ')"
done
echo
echo "## Routes and status codes"
for p in / /status /owner /owner/quotes /owner/ /nonsense-path /robots.txt /index.html /api/nope /api/health /api/catalog /api/owner/session /api/owner/inventory /api/owner/requests /api/owner/markup /api/owner/import-token /api/requests /api/requests/0123456789abcdef0123456789abcdef /brand/SOURCES.md /brand/og-1200x630.jpg /.env /backend/data/owner.sqlite /package.json; do
  printf '  %-48s %s  %s\n' "$p" "$(code "$B$p")" "$(curl -s -o /dev/null -D - "$B$p" | tr -d '\r' | grep -i '^content-type' | cut -d: -f2- | sed 's/^ //')"
done
echo
echo "## Method handling"
echo "  HEAD /               -> $(curl -s -o /dev/null -I -w '%{http_code}' "$B/")"
echo "  HEAD /api/health     -> $(curl -s -o /dev/null -I -w '%{http_code}' "$B/api/health")"
echo "  OPTIONS /api/owner/import (no Origin)      -> $(curl -s -o /dev/null -X OPTIONS -w '%{http_code}' "$B/api/owner/import")"
echo "  OPTIONS /api/owner/import (Origin evil)    -> $(curl -s -o /dev/null -X OPTIONS -H 'Origin: https://evil.example' -w '%{http_code}' "$B/api/owner/import")"
echo "  OPTIONS /api/owner/import (Origin giga)    -> $(curl -s -o /dev/null -D - -X OPTIONS -H 'Origin: https://www.giga-tires.com' -w 'code=%{http_code}' "$B/api/owner/import" | tr -d '\r' | grep -i -E 'access-control-allow-origin|code=' | tr '\n' ' ')"
echo "  TRACE /              -> $(curl -s -o /dev/null -X TRACE -w '%{http_code}' "$B/")"
echo
echo "## Bodies of the public JSON answers (shape, not values)"
echo "  /api/health: $(curl -s "$B/api/health")"
echo "  /api/owner/session: $(curl -s "$B/api/owner/session")"
echo "  /api/owner/inventory: $(curl -s "$B/api/owner/inventory")"
echo "  /api/requests/<unknown id>: $(curl -s "$B/api/requests/0123456789abcdef0123456789abcdef")"
echo "  /api/requests (no key): $(curl -s "$B/api/requests")"
echo "  /api/requests?customer=<key with no requests>: $(curl -s "$B/api/requests?customer=0123456789abcdef0123456789abcdef")"
curl -s "$B/api/catalog" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s).tires;const keys=new Set();for(const x of t)for(const k of Object.keys(x))keys.add(k);console.log('  /api/catalog: tires='+t.length+' sizes='+new Set(t.map(x=>x.size)).size+' keys=['+[...keys].sort().join(',')+']')})"
echo
echo "## Asset caching"
for p in /brand/og-1200x630.jpg "$(curl -s "$B/" | grep -o '/assets/index-[^"]*\.js' | head -1)"; do
  echo "  $p -> $(curl -s -o /dev/null -D - "$B$p" | tr -d '\r' | grep -i -E '^cache-control|^etag|^last-modified' | tr '\n' ' ')"
done
echo
echo "## Fly (read-only)"
FLY="${FLYCTL:-C:/Users/anune/.fly/bin/flyctl.exe}"
if [ ! -x "$FLY" ]; then echo "  (flyctl not found at $FLY; set FLYCTL to its path to include this section)"; fi
"$FLY" status -a kmt 2>/dev/null | grep -v "handle is invalid" | grep -E "Hostname|Image|VERSION|d89459" | sed 's/^/  /'
"$FLY" checks list -a kmt 2>/dev/null | grep -v "handle is invalid" | grep -E "health" | sed 's/^/  /'
"$FLY" secrets list -a kmt 2>/dev/null | grep -v "handle is invalid" | awk 'NR>1 && NF {print "  secret: " $1}'
"$FLY" certs list -a kmt 2>/dev/null | grep -v "handle is invalid" | sed 's/^/  certs: /' | head -6
