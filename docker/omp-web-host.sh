#!/usr/bin/env bash
set -euo pipefail

exec nsenter -t 1 -m -u -i -p --wdns=/opt/homelab/builds/omp-web -- \
  /root/.bun/bin/bun --bun /opt/homelab/builds/omp-web/node_modules/next/dist/bin/next \
  start -H "${OMP_WEB_HOSTNAME:?OMP_WEB_HOSTNAME is required}" -p "${PORT:-30141}"
