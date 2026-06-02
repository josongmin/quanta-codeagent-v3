# ADR-0447 — user-customizable keybinding layer

**Status:** Accepted (2026-06-02)
**Type:** UX/DX slice — RFC-11 (`docs/plans/jun-2-misc/11-external-editor-and-keybindings.md`), feature B.
**Scope:** new leaf dir `src/apps/cli/keybindings/` (`types.ts` / `defaults.ts`
/ `normalize.ts` / `load.ts`) + a remap step in `raw-line-reader.ts`, threaded
through `prompt-pipeline.ts` → `session-loop.ts` → `surface-compose.ts`
(`buildPromptUx`) → `repl.ts`. Default-OFF (no map injected ⇒ the hardcoded
if-chain runs verbatim, byte-identical).

## Context

The reader's keypress→action mapping is a hardcoded if-chain. vim users want
ctrl-p/ctrl-n, emacs users want ctrl-a/ctrl-e; a fixed keymap is permanent
friction. Codex loads a closed-enum `KeybindingsSpec` from config and rejects
bad specs explicitly (`invalid keybinding` / `missing key` / `duplicate
modifier`). `~/.quanta/knobs.json` already establishes the config-load fail-safe
pattern (`persist.ts` read returns `null` on any defect; `resolve.ts` declines
`__proto__`/`prototype`/`constructor`).

## Decision

A CLOSED action enum (`KEY_ACTIONS`) names the 14 intents the if-chain already
has (submit / abort / reverse-search / complete / menu-close / history-prev|next
/ cursor-* / delete-* / open-editor). `DEFAULT_KEYBINDINGS` is the SSOT
projection of the current hardcoded keys onto that enum, plus `ctrl+x ctrl+e →
open-editor`.

`~/.quanta/keybindings.json` (schema `{version:1, bindings:{<keyspec>:<action>}}`)
is loaded by `loadKeybindings` — REUSING the knobs fail-safe: read failure /
parse failure / wrong version / non-object ⇒ the default map, NO throw. The merge
`mergeOverDefaults` declines the three prototype-pollution keys (the
`resolve.ts:34` guard) and drops bad entries INDIVIDUALLY with a Codex-style
warning (`invalid keybinding` / `unknown action` / `duplicate modifier` /
`missing action` / `duplicate keybinding`) — the rest of the file + the default
map survive. `loadKeybindings` always returns a usable map.

`normalizeKeySpec` canonicalizes a spec (lower-case, modifiers in fixed order,
space-separated chord SEQUENCE), rejecting malformed tokens and repeated
modifiers. `keyOf` projects a runtime keypress to the SAME canonical single
chord.

The reader's dispatch is a **remap, not a rewrite**: when a map is injected, an
incoming key is projected to its bound action; if that action's canonical
default key differs, the event is rewritten IN PLACE to the default key so the
existing if-chain (with all its context logic — menu vs history, heredoc,
search) handles it unchanged. `open-editor` is intercepted directly. The default
bindings are an identity remap, so even an injected DEFAULT map is behaviorally a
no-op. Chord SEQUENCES (`ctrl+x ctrl+e`) are owned by the ADR-0446 prefix
machine, never the single-chord remap.

## Consequences

- Users remap keys via a JSON file with the same location, permissions, and
  fail-safe philosophy as knobs.json.
- Minimal regression surface: the if-chain bodies are untouched; only an
  upstream key-translation step is added, gated behind map presence.
- `shift+tab` (RFC-08 backtab) is intentionally NOT routed through the keymap —
  the existing guard owns it; the remap never projects shift onto letter keys.
- Default-OFF: absent map ⇒ no projection, byte-identical.
- Gated by `QUANTA_KEYBINDINGS=1` in `buildPromptUx`.

## Non-goals

Modal vim state machine, per-surface (Web/Tauri) keymaps, remote dynamic config.
