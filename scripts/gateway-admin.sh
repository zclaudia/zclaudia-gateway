#!/usr/bin/env bash
# Credential management for a running gateway (wraps /api/admin/credentials).
#
# Configuration (environment wins; unset values fall back to the repo .env,
# or GATEWAY_ENV_FILE if set):
#   GATEWAY_URL          e.g. https://gateway.example.com (no trailing slash);
#                        defaults to http://127.0.0.1:$GATEWAY_PORT on the host
#   GATEWAY_ADMIN_TOKEN  admin token — the root of trust for credential issuance
#
# Usage:
#   gateway-admin.sh issue-backend <namespace> <name> [inherit-backend-id]
#   gateway-admin.sh issue-device  <namespace> <name> [ttl-days] [backend-id,...]
#   gateway-admin.sh list
#   gateway-admin.sh backends                # known backend identities + last credential
#   gateway-admin.sh bind <credential-id> <backend-id>    # migrate a legacy backend credential in place
#   gateway-admin.sh scope <credential-id> all|<backend-id,...>   # device backend scope
#   gateway-admin.sh forget-backend <backend-id>          # delete an unused backend identity
#   gateway-admin.sh revoke <credential-id>
#   gateway-admin.sh purge [credential-id]   # delete revoked credentials (all if no id)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${GATEWAY_ENV_FILE:-$SCRIPT_DIR/../.env}"

# Read one key's last assignment from the .env file, stripping quotes.
env_lookup() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -1 \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

: "${GATEWAY_ADMIN_TOKEN:=$(env_lookup GATEWAY_ADMIN_TOKEN)}"
: "${GATEWAY_PORT:=$(env_lookup GATEWAY_PORT)}"
: "${GATEWAY_URL:=$(env_lookup GATEWAY_URL)}"
: "${GATEWAY_URL:=http://127.0.0.1:${GATEWAY_PORT:-3200}}"
: "${GATEWAY_ADMIN_TOKEN:?set GATEWAY_ADMIN_TOKEN (env or ${ENV_FILE})}"

# "a,b" -> ["a","b"]
json_ids() {
  python3 -c 'import json, sys; print(json.dumps([x for x in sys.argv[1].split(",") if x]))' "$1"
}

# Print success, or the error envelope and exit 1.
check_ok() {
  python3 -c '
import json, sys
r = json.load(sys.stdin)
if r.get("success"):
    print(sys.argv[1])
else:
    print("Error:", json.dumps(r.get("error"), ensure_ascii=False), file=sys.stderr)
    sys.exit(1)
' "$1"
}

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
if d.get("backendId"):
    print("backendId:", d["backendId"])
if d.get("allowedBackends"):
    print("backends: ", ", ".join(d["allowedBackends"]))
print()
print("token (shown ONCE, store it now):")
print(" ", d["token"])
'
}

case "${1:-}" in
  issue-backend)
    ns="${2:?usage: issue-backend <namespace> <name> [inherit-backend-id]}"; name="${3:?usage: issue-backend <namespace> <name> [inherit-backend-id]}"
    body="{\"type\":\"backend\",\"namespace\":\"$ns\",\"name\":\"$name\""
    [ -n "${4:-}" ] && body+=",\"backendId\":\"$4\""
    api POST /api/admin/credentials "$body}" | show_issued
    ;;
  issue-device)
    ns="${2:?usage: issue-device <namespace> <name> [ttl-days]}"; name="${3:?usage: issue-device <namespace> <name> [ttl-days]}"
    body="{\"type\":\"device\",\"namespace\":\"$ns\",\"name\":\"$name\""
    [ -n "${4:-}" ] && body+=",\"ttlDays\":$4"
    [ -n "${5:-}" ] && body+=",\"allowedBackends\":$(json_ids "$5")"
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
fmt = "{:<36}  {:<8}  {:<12}  {:<20}  {:<20}  {:<8}  {}"
print(fmt.format("id", "type", "namespace", "name", "expires", "status", "backend / scope"))
for c in rows:
    status = "REVOKED" if c.get("revokedAt") else "active"
    if c["type"] == "device":
        scope = "%d backend(s)" % len(c["allowedBackends"]) if c.get("allowedBackends") else "all backends"
    elif c["type"] == "backend" and not c.get("backendId"):
        scope = "LEGACY (unbound)"
    else:
        scope = c.get("backendId") or "-"
    print(fmt.format(c["id"], c["type"], c["namespace"], (c.get("name") or "-")[:20],
                     ts(c.get("expiresAt")), status, scope))
'
    ;;
  backends)
    api GET /api/admin/backends | python3 -c '
import json, sys
from datetime import datetime, timezone
def ts(v):
    if not v: return "-"
    return datetime.fromtimestamp(v / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
r = json.load(sys.stdin)
if not r.get("success"):
    print("Error:", json.dumps(r.get("error"), ensure_ascii=False), file=sys.stderr)
    sys.exit(1)
rows = r["data"]
if not rows:
    print("(no backends)")
    sys.exit(0)
fmt = "{:<36}  {:<12}  {:<20}  {:<16}  {:<7}  {:<20}  {}"
print(fmt.format("backendId", "namespace", "name", "instanceId", "status", "last seen", "last credential"))
for b in rows:
    status = "online" if b.get("online") else "offline"
    seen = b["online"]["connectedAt"] if b.get("online") else b.get("lastSeenAt")
    print(fmt.format(b["backendId"], b["namespace"], (b.get("name") or "-")[:20],
                     ("%s/%s" % (b["instanceId"], b["environment"]))[:16], status, ts(seen),
                     b.get("lastCredentialId") or "-"))
'
    ;;
  bind)
    id="${2:?usage: bind <credential-id> <backend-id>}"; backend="${3:?usage: bind <credential-id> <backend-id>}"
    api POST "/api/admin/credentials/$id/bind" "{\"backendId\":\"$backend\"}" | check_ok "bound (token unchanged)"
    ;;
  scope)
    id="${2:?usage: scope <credential-id> all|<backend-id,...>}"; scope="${3:?usage: scope <credential-id> all|<backend-id,...>}"
    if [ "$scope" = "all" ]; then value=null; else value="$(json_ids "$scope")"; fi
    api PATCH "/api/admin/credentials/$id" "{\"allowedBackends\":$value}" | check_ok "scope updated (live connections were closed)"
    ;;
  forget-backend)
    backend="${2:?usage: forget-backend <backend-id>}"
    api DELETE "/api/admin/backends/$backend" | check_ok "backend identity deleted"
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
  purge)
    body="{}"
    [ -n "${2:-}" ] && body="{\"ids\":[\"$2\"]}"
    api POST /api/admin/credentials/purge "$body" | python3 -c '
import json, sys
r = json.load(sys.stdin)
if r.get("success"):
    print("deleted %d revoked credential(s)" % len(r["data"]["deleted"]))
else:
    print("Error:", json.dumps(r.get("error"), ensure_ascii=False), file=sys.stderr)
    sys.exit(1)
'
    ;;
  *)
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
