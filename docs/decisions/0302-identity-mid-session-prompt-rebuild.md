# ADR-0302 — `/identity <mode>` mid-session system-prompt rebuild

Status: Accepted (2026-05-26)
Track: REPL surface / identity-mode last-mile (closes ADR-0291 gap)
Slice: `src/runner/assemble/session-state.ts` (canonical owner) +
`src/apps/cli/repl/ctx-adapters/identity-mode-adapter.ts` (surface adapter)

## 2026-07-20 implementation addendum

The former CLI-local rebuilder was removed. `SystemSource` already belonged to
runner session state, so `SystemPromptRebuilderPort` moved beside it and host
bootstrap now constructs and consumes the same canonical factory. This removes
the inline duplicate while preserving the slash callback as a thin surface port.

## Context

ADR-0291 wired `ctx.identity = { get, set, list }` over the
`IdentityModeVariantRegistry`. Today `set("plan")` mutates the surface's
identity-mode state cell, but the LLM keeps seeing the OLD system
prompt that was built ONCE at session bootstrap:

```
bootstrapSession()
  → identity = pickIdentity()
  → system   = buildSystemPrompt(cwd, { persona, identity })   // CAPTURED ONCE
  → SessionDeps.system = boot.system                            // FROZEN
  → per turn: assembleConfig(messages, d) reads d.system        // STALE
```

The state cell flips, but the cached prefix never does — so a user who
types `/identity plan` after the first turn gets a `default`-flavoured
system prompt for the rest of the session.

The fix lives in the IDENTITY adapter / slash command layer — NOT in
the agent loop. The loop receives `system` via `AgentConfig.system` at
each `runAgent` invocation; the surface is responsible for refreshing
that string before the next turn.

## Decision

Introduce two tiny seams under `src/apps/cli/repl/`:

### 1. `SystemPromptRebuilderPort` + `createSystemPromptRebuilder`

A pure closure over `(mode: () => ModeVariantKey | undefined, cwd,
baseBuilder)` that recomputes the system-prompt string on demand. The
`mode` argument is a CLOSURE so the rebuilder picks up the LIVE
identity-mode cell each call rather than a snapshot.

`rebuild()` is no-throw: a thrown `baseBuilder` is caught and returns
the typed fallback `"(prompt rebuild failed: <reason>)"` (with
newlines stripped from the reason so the fallback never forges a
section header inside the cached prefix).

### 2. `SystemSource` + `createSystemSource`

A surface-owned mutable cell holding the current system prompt string.
The per-turn `AgentConfig` assembler reads `get()`; the rebuilder
writes `set(rebuilder.rebuild())` on every mode swap. `set` is
idempotent on equal values (`===` short-circuit).

### 3. Identity-mode adapter `onChange` callback

`buildIdentityModeAdapter` gains an optional `onChange?: (mode:
ModeVariantKey) => void` arg. After a successful `set(mode)` swap,
the adapter fires `onChange(mode)`. NEVER fired on rejected (unknown)
modes. Wrapped in `try/catch` so a misbehaving callback (the rebuilder
threw, the source threw) NEVER bubbles back to the slash dispatcher —
`/identity` stays a stable 0-exit command even if the rebuilder
hiccups.

## Wiring (left for follow-up)

The surface composes the three together:

```ts
const rebuilder = createSystemPromptRebuilder({
  mode: () => adapter.get() as ModeVariantKey,
  cwd: setup.cwd,
  baseBuilder: (mode, cwd) =>
    buildSystemPromptForMode({ mode: mode ?? "default", persona, registry, ... }),
})
const systemSource = createSystemSource(boot.system)
const adapter = buildIdentityModeAdapter({
  registry,
  defaultMode,
  onChange: () => {
    sessionDeps.system = rebuilder.rebuild()  // mirror into SessionDeps
    systemSource.set(sessionDeps.system)      // for future per-turn reads
  },
})
```

`SessionDeps.system` is a plain `string` (not readonly) field, so
mirroring through assignment keeps the loop byte-identical with zero
config-shape change. THIS WIRE IS DELIBERATELY OUT OF SCOPE for ADR-
0302 — the surface-compose / loop layer is Track A/B territory and
gets a follow-up ADR. ADR-0302 ships the seams; ADR-0303+ will ship
the surface wire.

## Default-OFF

The adapter takes `onChange?` — absent ⇒ behavior is byte-identical to
ADR-0291 (state-only swap, stale prompt). Surfaces that don't import
the new module pay zero. The rebuilder + source are allocated only by
the surface that wires them.

## Tests

`tests/unit/cli/identity-prompt-rebuild-hellgate.test.ts` — 15 cases /
45 expects:

- 5 cases on the rebuilder (live closure, throw fallback, non-Error
  coercion, newline stripping).
- 3 cases on `SystemSource` (seed, idempotent set, replace).
- 7 cases on the adapter (onChange fires, doesn't fire on reject,
  back-compat absent onChange, end-to-end composition, swallowed
  throw, `list()` honesty, idempotent set still fires onChange).

## SOLID + plane-clean

- New file imports `@/agent/system-prompt` (for `ModeVariantKey`) only.
  NO `@/storage`, `@/permission`, `@/agent` (the base builder is
  injected by the surface — the rebuilder is provider-agnostic).
- Adapter file gains ONE optional field. Existing call site in
  `slash-surface.ts` passes no `onChange` — unchanged contract.
- `session-loop.ts` UNTOUCHED. `surface-compose.ts` UNTOUCHED.
  `session-bootstrap.ts` UNTOUCHED. `prompt-pipeline.ts` UNTOUCHED.

## Out of scope

- The actual surface wire (composing rebuilder + source + adapter +
  SessionDeps mirror). Follow-up ADR.
- Re-build of memory / per-turn reminder paths — those are already
  per-turn dynamic (`buildTurnContext`); only the cached SYSTEM
  prompt is the gap.
- A per-mode `onChange` debounce — the SystemSource's `===` short-
  circuit is enough for today; the rebuilder is pure + cheap (string
  concat).

## Negative invariants

- The rebuilder MUST NOT call IO, the clock, or env. The `baseBuilder`
  callback is the seam where any non-purity lives.
- The adapter MUST NOT fire `onChange` on a rejected mode — tests
  HELL-0302-10 + HELL-0302-11 lock this.
- `SystemSource.set` MUST NOT throw on equal values (idempotent
  short-circuit; HELL-0302-07).
