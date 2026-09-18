#!/usr/bin/env bash
# Local dev launcher (not used in production).
set -euo pipefail
cd "$(dirname "$0")"
set -a; [ -f .env ] && . ./.env; set +a
exec node server/index.js
