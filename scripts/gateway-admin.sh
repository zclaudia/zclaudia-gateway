#!/usr/bin/env bash
# Credential management for a running gateway (wraps /api/admin/credentials).
#
# Required environment:
#   GATEWAY_URL          e.g. https://gateway.example.com (no trailing slash)
#   GATEWAY_ADMIN_TOKEN  admin token (never the shared GATEWAY_SECRET)
#
# Usage:
#   gateway-admin.sh issue-backend <namespace> <name>
#   gateway-admin.sh issue-device  <namespace> <name> [ttl-days]
#   gateway-admin.sh list
#   gateway-admin.sh revoke <credential-id>
set -euo pipefail

: "${GATEWAY_URL:?set GATEWAY_URL, e.g. https://gateway.example.com}"
: "${GATEWAY_ADMIN_TOKEN:?set GATEWAY_ADMIN_TOKEN}"

api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" "${GATEWAY_URL%/}${path}" \
    -H "Authorization: Bearer ${GATEWAY_ADMIN_TOKEN}")
  [ -n "$body" ] && args+=(-H "Content-Type: application/json" -d "$body")
  curl "${args[@]}"
}

# Pretty-print an issue response; the token is shown once and never again.
show_issued() {
  python3 -c '
import json, sys
from datetime import datetime, timezone
def ts(v):
    if not v: return "never"
    return datetime.fromtimestamp(v / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
r = json.load(sys.stdin)
if not r.get("success"):
    print("Error:", json.dumps(r.get("error"), ensure_ascii=False), file=sys.stderr)
    sys.exit(1)
d = r["data"]
print("id:       ", d["id"])
print("type:     ", d["type"], " namespace:", d["namespace"], " name:", d.get("name") or "-")
print("expires:  ", ts(d.get("expiresAt")))
print()
print("token (shown ONCE, store it now):")
print(" ", d["token"])
'
}

case "${1:-}" in
  issue-backend)
    ns="${2:?usage: issue-backend <namespace> <name>}"; name="${3:?usage: issue-backend <namespace> <name>}"
    api POST /api/admin/credentials "{\"type\":\"backend\",\"namespace\":\"$ns\",\"name\":\"$name\"}" | show_issued
    ;;
  issue-device)
    ns="${2:?usage: issue-device <namespace> <name> [ttl-days]}"; name="${3:?usage: issue-device <namespace> <name> [ttl-days]}"
    body="{\"type\":\"device\",\"namespace\":\"$ns\",\"name\":\"$name\""
    [ -n "${4:-}" ] && body+=",\"ttlDays\":$4"
    api POST /api/admin/credentials "$body}" | show_issued
    ;;
  list)
    api GET /api/admin/credentials | python3 -c '
import json, sys
from datetime import datetime, timezone
def ts(v):
    if not v: return "never"
    return datetime.fromtimestamp(v / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
r = json.load(sys.stdin)
if not r.get("success"):
    print("Error:", json.dumps(r.get("error"), ensure_ascii=False), file=sys.stderr)
    sys.exit(1)
rows = r["data"]
if not rows:
    print("(no credentials)")
    sys.exit(0)
fmt = "{:<36}  {:<8}  {:<12}  {:<20}  {:<20}  {}"
print(fmt.format("id", "type", "namespace", "name", "expires", "status"))
for c in rows:
    status = "REVOKED" if c.get("revokedAt") else "active"
    print(fmt.format(c["id"], c["type"], c["namespace"], (c.get("name") or "-")[:20],
                     ts(c.get("expiresAt")), status))
'
    ;;
  revoke)
    id="${2:?usage: revoke <credential-id>}"
    api DELETE "/api/admin/credentials/$id" | python3 -c '
import json, sys
r = json.load(sys.stdin)
if r.get("success"):
    print("revoked (live connections on it were closed)")
else:
    print("Error:", json.dumps(r.get("error"), ensure_ascii=False), file=sys.stderr)
    sys.exit(1)
'
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
