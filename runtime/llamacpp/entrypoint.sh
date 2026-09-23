#!/usr/bin/env sh
set -eu

case "${1:-}" in
  llama)
    shift
    exec /opt/llama/bin/llama-diffusion-gemma-server "$@"
    ;;
  api)
    shift
    exec python3 -m djev "$@"
    ;;
  *)
    echo "usage: entrypoint.sh {llama|api} [arguments...]" >&2
    exit 64
    ;;
esac
