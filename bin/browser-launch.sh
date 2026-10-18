#!/bin/sh
# Playwright owns the private stdio pipe; no debugging port is opened.
set -eu
umask 077
if [ -n "${PORTAL_BROWSER_PIDFILE:-}" ]; then printf '%s' "$$" > "$PORTAL_BROWSER_PIDFILE"; fi
profile=$(printf '%s' "$PORTAL_BROWSER_PROFILE" | /usr/bin/sed "s/__PORTAL_BROWSER_PID__/$$/g")
exec /usr/bin/sandbox-exec -p "$profile" "$PORTAL_BROWSER_BIN" "$@"
