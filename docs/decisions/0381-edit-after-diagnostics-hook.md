# ADR-0381 — edit-after-diagnostics auto-injection hook

Status: Accepted — 2026-05-28
Supersedes: none
Extends: ADR-0015 (LSP diagnostics), ADR-0133 (`post_tool_use` hook +
`promptHook` fold via `subagentPendingPrompt`)

## Context

When the model edits a file, it does not learn about the type/lint errors it
just introduced until it explicitly calls the `diagnostics` tool — which it
often forgets to do. Competitors (Cursor, Codex) surface post-edit diagnostics
automatically as ambient context. quanta already has every primitive needed to
do this without touching the agent loop:

1. `dispatch.ts` fires a `post_tool_use` hook event after EVERY tool call
   (ADR-0133), carrying `{ name, input, ok, output }`.
2. `loop.ts` drains `cfg.subagentPendingPrompt` once per turn and folds each
   pushed `HookPromptInject` into the next turn's prompt (ADR-0133).
3. `src/lsp` exposes per-file diagnostics; `src/agent/lsp-bridge.ts` already
   adapts a real language server to the `DiagnosticsSession` shape.

The missing leg is a **hook handler** that joins (1)→diagnostics→(2).

## Decision

Add `attachLspDiagnosticsHook` (`src/agent/lsp-diagnostics-hook.ts`, new): a
factory that registers a `post_tool_use` handler which, after an edit-class
tool runs, fetches LSP diagnostics for the edited file and pushes a
`HookPromptInject` (`{ injectAfterSystem }`) through the caller's
`subagentPendingPrompt` port. The agent loop folds that into the NEXT turn via
the existing ADR-0133 mechanism — the model sees its errors immediately.

```typescript
attachLspDiagnosticsHook({
  hooks: HookBus,                                  // bus to register on
  push: { push(entry: HookPromptInject): unknown },// = subagentPendingPrompt
  editTools: Map<string, (input) => string | null>,// caller-injected
  open: (filePath, cwd) => Promise<DiagnosticsSession | null>,
  cwd: string,
}): { dispose(): Promise<void> }
```

### Zero loop/dispatch changes

`dispatch.ts` and `loop.ts` are **0-line changes** — verified by stash diff
(only `src/lsp/*`, `src/agent/lsp-bridge.ts`, `src/agent/lsp-diagnostics-hook.ts`,
`src/agent/index.ts`, the two LSP barrels, and tests are touched). The hook
rides entirely on the already-present `post_tool_use` fire + the already-present
`subagentPendingPrompt` drain.

### No-heuristics seam

The module owns NO tool-name knowledge. The caller injects `editTools` — a map
of tool-name → path-extractor — so WHICH tools are "edit-class" and HOW to read
the edited path from each tool's input is a composition-root decision (it
already owns the tool set). A tool absent from the map is ignored; a throwing
extractor is swallowed. This avoids any hard-coded `["edit","write",...]` set
inside the slice.

### Per-session client cache

Opening a fresh server on every edit is wasteful (start + handshake per hook).
The hook caches the opened `DiagnosticsSession` keyed by **file extension**
(deterministic grouping: same extension ⇒ same server), storing the in-flight
OPEN promise so concurrent same-language edits share ONE open. The cache is
disposed via the returned `dispose()` (NOT per-hook) — N edits to same-language
files reuse one server. Cache location:
`src/agent/lsp-diagnostics-hook.ts` (`sessions: Map<ext, Promise<Session|null>>`).

## Default-OFF / byte-identical

- A host that never calls `attachLspDiagnosticsHook` registers NO
  `post_tool_use` handler ⇒ the bus + loop are byte-identical to today.
- Clean file (no diagnostics) ⇒ nothing pushed (no prompt noise).
- Non-edit tool (not in `editTools`) ⇒ nothing pushed.

## Degrade-gracefully

`open()` returning `null` (no server / unsupported ext) or any
`diagnostics()` throw is swallowed — nothing pushed, no `promptHook`, handler
returns cleanly. A flaky LSP can NEVER turn a successful edit into a broken
turn. The `HookBus` already isolates throwing handlers; this is belt-and-braces.

## Wiring status

This ADR ships the **attachable seam + cache + tests**, not a CLI flag. Wiring
requires a composition point holding BOTH the `HookBus` AND the
`subagentPendingPrompt` push port simultaneously — those co-exist only inside
`runAgentInner` (`loop.ts`), which this ADR will NOT modify (the 0-line
constraint is the whole point). The real `open` is already available:
`lspDiagnosticsProvider().open` (bridge) is structurally an
`OpenDiagnosticsSession`. Caller-wire of the hook into a surface is a separate
ADR — mirrors the established "slot/seam first, surface-wire later" pattern
(e.g. ADR-0141's `lspPorts` slot).

## Test coverage

7 new cases (`tests/unit/lsp-diagnostics-hook-hellgate.test.ts`):

- default-OFF — not attached ⇒ no `post_tool_use` handler on the bus.
- injection — edit with diagnostics ⇒ promptHook pushed carrying the rendered
  text (path + message); non-edit tool ⇒ nothing.
- clean file (no diagnostics) ⇒ nothing pushed.
- per-session cache — 3 same-language edits ⇒ `open` called ONCE; cached
  session NOT stopped per-hook.
- degrade — `open()`→null ⇒ no push; `diagnostics()` throws ⇒ no push, no
  throw (emit returns `deny:null`).

## Non-goals

- Severity filtering / dedup across turns — the loop's `promptHook` trimmer
  already bounds accumulation per ADR-0133; emitting on every error-bearing
  edit is the intended ambient behavior.
- Multi-file diagnostics (only the edited file is checked) — a rename touching
  N files is the `lsp_rename_apply` path (ADR-0380), not this hook.
