#!/bin/zsh

set -u

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR" || exit 1

URL="http://127.0.0.1:4177"

if curl --silent --fail "$URL/api/health" >/dev/null 2>&1; then
  open "$URL"
  exit 0
fi

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [[ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]]; then
  NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
else
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
    fi
  done
fi

if [[ -z "$NODE_BIN" ]]; then
  osascript -e 'display dialog "No encuentro Node.js. Instala Node 20 o posterior para abrir el MVP." buttons {"Cerrar"} default button "Cerrar" with icon stop'
  exit 1
fi

"$NODE_BIN" server.mjs &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

for attempt in {1..50}; do
  if curl --silent --fail "$URL/api/health" >/dev/null 2>&1; then
    open "$URL"
    wait "$SERVER_PID"
    exit $?
  fi
  sleep 0.1
done

osascript -e 'display dialog "El MVP no ha podido arrancar. Revisa esta ventana para ver el error." buttons {"Cerrar"} default button "Cerrar" with icon stop'
wait "$SERVER_PID"
