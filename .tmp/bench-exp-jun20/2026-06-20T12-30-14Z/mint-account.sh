#!/bin/zsh
# Mint an extra ChatGPT-OAuth account into a bench auth slot.
# Usage: ./mint-account.sh <slot>     e.g. ./mint-account.sh 2
# Launches the quanta TUI under an isolated home; you run /login with a
# DIFFERENT ChatGPT account in the browser, then exit the TUI. The token is
# copied to ~/.quanta/auth/chatgpt-<slot>.json (0600) for run-phase-AB.sh.
set -o pipefail
ROOT=/Users/songmin/quanta-codeagent-v3
slot="$1"
if [ -z "$slot" ] || [ "$slot" = "1" ]; then
  echo "usage: ./mint-account.sh <slot>=2..N   (slot 1 is the default account)"; exit 1
fi
HOMEISO="$HOME/.quanta-acct${slot}"
SRC="$HOMEISO/auth/chatgpt.json"
DST="$HOME/.quanta/auth/chatgpt-${slot}.json"
mkdir -p "$HOMEISO/auth"
echo ">>> Launching quanta TUI with isolated home: $HOMEISO"
echo ">>> In the TUI, type:  /login   and sign in with ChatGPT ACCOUNT #$slot (a DIFFERENT account)."
echo ">>> When it says logged in, exit the TUI (Ctrl-C / /exit)."
QUANTA_PREFS_HOME="$HOMEISO" bun run "$ROOT/src/apps/cli/index.ts"
if [ ! -f "$SRC" ]; then
  echo "!! no token minted at $SRC — login did not complete. nothing copied."; exit 1
fi
cp "$SRC" "$DST"; chmod 600 "$DST"
echo ">>> minted slot $slot -> $DST"
