#!/bin/sh
set -eu

case "${1:-run}" in
  run)  exec node /app/src/index.js ;;
  auth) exec node /app/src/auth.js ;;
  *)    exec "$@" ;;
esac
