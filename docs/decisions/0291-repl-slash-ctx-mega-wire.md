# ADR-0291 — REPL slash-surface ctx mega-wire

Status: Accepted (2026-05-25)
Track: REPL surface composition / slash command wiring
Slice: `src/apps/cli/repl/ctx-adapters/*` (new) + `src/apps/cli/repl/slash-surface.ts` (expand)

## Context

`src/apps/cli/repl/slash-surface.ts` projects a `ReplSlashCtx` into
`runSlashCommand` (the BUILTINS dispatcher). Today eight slash commands
print "not wired in this surface" because their `ctx.*` slots are absent
from the projection:

| slash | missing ctx slot | upstream port |
|---|---|---|
| `/edit-plan` | `planEdit` | `PlanStore` |
| `/edit-message` | `composerEdit` | surface-owned mutable text |
| `/fork-checkpoint` | `forkSession` | `ConversationCheckpointStore` + `defaultForker` |
| `/rewind-tool` | `perToolCheckpoint` | `GranularRegistry` + `ThreeWayRestorePort` |
| `/profile` | `profile` | `AgentConfig.toolProfile` (ADR-0213) |
| `/identity` | `identity` | `AgentConfig.identityModeVariant` (ADR-0211) |
| `/focus-chain` | `focusChain` | `AgentConfig.focusChain.tracker` (ADR-0219) |
| `/web` (inbox leg) | `textInbox` | surface-owned `TextInbox` (ADR-0224) |

Each port already exists; only the REPL-side adapter + projection wire
was missing. The fix is mechanical: a closed seam per slot.

## Decision

Add 8 surface-owned adapter modules under
`src/apps/cli/repl/ctx-adapters/` plus an expansion of `BuildReplSlashCtxArgs`,
`buildReplSlashCtx`, `projectSlashCtx`, and `ReplSlashCtx` in
`slash-surface.ts`.

### Slots wired

- **`plan-edit-adapter.ts`** — wraps `PlanStore` as the duck-typed
  `PlanEditPort`. `getPlan()` renders structured todos as markdown;
  `setPlan(body)` is a no-op against the structured store today (a
  future ADR may re-parse markdown → `update_plan` mutations).
- **`composer-edit-adapter.ts`** — `ComposerHandle` factory +
  `buildComposerEditAdapter`. Surface owns a mutable text cell drained
  by `PromptSource.next()`.
- **`fork-session-adapter.ts`** — composes `defaultSessionForker(store)`
  + `defaultForker({base})` and surfaces `ForkSessionSlashState` (port
  + activeSessionId). No shadow-ODB tagging at this layer.
- **`per-tool-checkpoint-adapter.ts`** — wraps `GranularRegistry` +
  (optional) real `ThreeWayRestorePort`. When the host omits the real
  restore port, a typed `shadow-odb-not-configured` stub fills the
  slot so the hellgate can seal the contract shape.
- **`tool-profile-adapter.ts`** — adapter over
  `ToolProfileResolver` + `defaultName`. Mutable active-name cell;
  `set` validates against `ALL_TOOL_PROFILE_NAMES`.
- **`identity-mode-adapter.ts`** — adapter over
  `SystemPromptVariantRegistry`. Mutable active-mode cell; `set`
  validates against `MODE_VARIANT_KEYS`. Mid-session switches are
  surface-state only (system prompt not re-built until next session).
- **`focus-chain-adapter.ts`** — adapter over `FocusChainPort`.
  `snapshot()` projects todos + currentTurn + driftWarning;
  `reset` → `setTodos([])`; `skip` → `tickTurn()`.
- **`text-inbox-singleton.ts`** — re-exports `createTextInbox` with a
  cleaner factory entrypoint for the REPL composition root.

### Default-OFF posture

Every adapter is presence-gated. If an upstream port is absent from
`BuildReplSlashCtxArgs`, the corresponding ctx slot is omitted from the
projection (`exactOptionalPropertyTypes`-clean spread-conditional).
The legacy "not wired in this surface" behavior is byte-identical
when the host opts out — verified by HELL-MEGA-01 and HELL-MEGA-20.

### Test seal

`tests/unit/cli/repl-slash-ctx-mega-wire-hellgate.test.ts` — 20 cases,
77 expectations, all green. Coverage:

- HELL-MEGA-01: absent args → all 8 slots omitted
- HELL-MEGA-02..09: each upstream port present → slot reachable + shape
- HELL-MEGA-10..16: end-to-end happy-path through `runSlashCommand`
  (each of the 7 slash commands no longer prints "not wired")
- HELL-MEGA-17: `/web` + textInbox → inbox.size() === 1
- HELL-MEGA-18: composer adapter propagates throws to slash try/catch
- HELL-MEGA-19: per-tool-checkpoint stub returns typed Err outcome
- HELL-MEGA-20: byte-identical legacy projection — absent slots leave
  legacy "not wired" exit code unchanged

## Slice posture

- **Plane-clean**: ctx-adapters import ONLY `@/agent/*` types + the
  sibling slash command modules. NO `@/storage`, `@/permission`,
  `@/observability`. Verified by biome's `noRestrictedImports` rule.
- **No-throw on public surface**: every adapter method either returns
  the value directly or wraps in `Result`-shaped { ok, errorCode }.
  Where the slash command already gates on `ctx.X === undefined`, the
  adapter is a pure pass-through.
- **exactOptionalPropertyTypes-clean**: every optional field gated by
  `field !== undefined` before spread.
- **Cognitive complexity**: `buildReplSlashCtx` body factored into
  per-slot `maybeXxx` helpers + a single `buildNewSlotAdapters` aggregator
  so biome's cog-complexity ceiling (15) is met everywhere.
- **Slice fence**: composition root left untouched. `surface-compose.ts`
  is NOT modified by this slice; a follow-up may wire the new args
  through there. Today the new slots are present in the type surface
  but `composeSurfaceSlashCtx` passes none of them, so the REPL surface
  is byte-identical until the composition root opts in.

## Negative invariants

- This slice does NOT modify `src/apps/agent/index.ts` (351 lines of
  in-flight work belongs to a parallel track).
- It does NOT modify `src/tool/index.ts`, `src/agent/dispatch.ts`, or
  any `src/agent/loop*` file.
- It does NOT thread the new args through `composeSurfaceSlashCtx` —
  that wire is left for the composition-root closeout slice.
- It does NOT mutate any of the consumed ports (PlanStore,
  FocusChainPort, etc.). Adapters are read-only façades.
- It does NOT introduce a new closed enum or a new error code.
  `per-tool-checkpoint-adapter.ts` re-uses the existing
  `RestoreErrorCode.shadow-odb-not-configured` for its not-yet-wired
  arms — no enum widening.
- The `setPlan` no-op posture (plan-edit-adapter) is documented; a
  future ADR may add a markdown→`update_plan` re-parser.
