# ADR-0237 — LLM error 16-kind close-out: layer-owned arms wire

Status: Accepted (2026-05-25)

## Context

ADR-0214 extended `LLMErrorKind` from 11 → 16 arms by absorbing the Codex-spec
taxonomy. ADR-0234 then wired the two **provider-emitable** new arms at the
adapter boundary (`cyber_policy` from `permission_error` + policy markers;
`context_window_exceeded` from `code === "context_length_exceeded"` + context-
length markers — both gated to 400/422 status). The Codex-spec router
(`src/llm/retry/codex-spec-router.ts`) maps every one of the 16 kinds to a
`RecoveryAction`, including the three **layer-owned** arms:

- `too_many_failed_attempts` → `fatal`
- `thread_rollback_failed`   → `reactive_compaction`
- `sandbox_error`            → `hitl_handoff`

But until now, **no layer was emitting these three kinds**. They were
reachable only via the `classify(e: unknown)` router-stage heuristic ladder,
which leaves a layer-specific signal on the floor: the retry layer KNOWS the
budget is burned, the rollback API KNOWS the rebuild failed, the sandbox port
KNOWS its enforcement degraded. Each layer had the structural information; the
LLMError typing did not surface it.

The `recovery-router-codex-spec` catalog entry's `deliberate_hold` recorded
this gap explicitly. This ADR closes it.

## Decision

Three pure, default-OFF helpers — one per arm — each owned by the layer that
naturally KNOWS the failure condition. Every helper:

- Is purely **additive**. No existing code path changes when the knob is OFF
  (`enabled !== true`). The helper returns the inner port **verbatim** (same
  reference), so the byte-identical invariant holds at the reference level
  (`port === inner`), not just the behavior level.
- Has a closed `Knobs` shape (`Readonly<...>`) with `exactOptionalPropertyTypes`
  discipline (omitted fields, never `undefined`-set).
- Carries the original failure as `cause` on the typed `LLMError` so
  downstream sub-classification survives (e.g. `RestoreErrorCode`,
  `SandboxedSpawnResult.degradeReason`).

### A — `tooManyFailedAttempts`

**File**: `src/llm/retry/too-many-failed-attempts.ts` (new)

`withFailureCounter(inner: LLMPort, knobs?: LLMRetryKnobs)` wraps an
`LLMPort` and counts CONSECUTIVE pre-stream failures. When the count reaches
`maxConsecutiveFailures` (default **5**, clamped to ≥1), the next throw is
re-wrapped as `LLMError("too_many_failed_attempts", { cause: original })`.
Mid-stream throws (≥1 event yielded) DO NOT increment the counter — the
mid-stream rethrow is a transcript-corruption avoidance, not a "request
failed" event (mirrors the `RetryingLLM` contract). One successful iteration
RESETS the counter to 0. The helper also returns a small `FailureCounterHandle`
so callers can observe `getFailureCount()` or `reset()` per turn.

### B — `threadRollbackFailed`

**File**: `src/agent/per-tool-checkpoint/rollback-llm-error-bridge.ts` (new)

`withRollbackLlmErrorEmit(port: ThreeWayRestorePort, knobs?: RollbackLlmErrorKnobs)`
wraps the `ThreeWayRestorePort` 3-method surface
(`restoreFiles` / `restoreTask` / `restoreBoth`) and, when
`emitRollbackFailureAsLlmError === true`, converts every `ok:false`
`RestoreOutcome` into `LLMError("thread_rollback_failed", { cause: { outcome } })`.
Two conversion modes:

- `mode: "throw"` (default) — the wrapped method THROWS the typed error.
- `mode: "outcome-with-llm-error"` — the wrapped method returns the original
  outcome AUGMENTED with `llmError` so legacy callers branching on `.ok` keep
  working AND the observability hook fires.

All five `RestoreErrorCode` arms (`tag-not-found`, `shadow-odb-not-configured`,
`conversation-store-not-configured`, `task-snapshot-missing`,
`shadow-rewind-failed`) collapse to the same kind — sub-classification
survives on `cause.outcome.errorCode`. This matches the Codex-spec router's
single mapping to `reactive_compaction` (rebuild a shorter prefix).

### C — `sandboxError`

**File**: `src/runtime/os-sandbox/llm-error-bridge.ts` (new)

`withSandboxLlmErrorEmit(sandbox: OsSandbox, knobs?: SandboxLlmErrorKnobs)`
wraps the `OsSandbox.spawn` surface and, when `emitFailureAsLlmError === true`,
converts every degraded-enforcement result into
`LLMError("sandbox_error", { cause: { result } })`. The bridge fires iff
`sandboxApplied: false` AND `degradeReason` is present + non-empty — explicit
`profile: "off"` / `"danger-full-access"` (no `degradeReason`) is the caller's
choice and never fires. The `spawn-failed` reason (exit 127) DOES fire — the
agent cannot tell "binary missing" from "policy rejected" without re-parsing
stderr (forbidden by the downstream classify ban). Same two `mode` arms as B
(`throw` / `result-with-llm-error`).

## Default-OFF guarantees

Every knob defaults to `false`. When OFF, each helper returns the inner port
by reference — no allocation, no extra try/catch, no behavior delta. The
hellgate tests pin reference equality (`expect(port).toBe(inner)`) so a
future refactor that introduces an identity-but-not-same-object wrapper turns
red here, not in production.

## Hellgate

Three new test files in `tests/unit/`, 47 cases total:

- `llm-retry-too-many-failed-attempts-hellgate.test.ts` (18 cases): default-OFF
  parity / counter semantics N-1/N/N+1 / reset / mid-stream non-counting /
  wrap shape preservation (provider, statusCode, cause) / knob clamps.
- `checkpoint-rollback-failed-emit-hellgate.test.ts` (15 cases): default-OFF
  parity / throw-mode (3 methods) / outcome-with-llm-error mode / success
  passthrough / every `RestoreErrorCode` maps uniformly.
- `sandbox-error-emit-hellgate.test.ts` (14 cases): default-OFF parity / each
  documented `degradeReason` (`bwrap-missing` / `sandbox-exec-missing` /
  `spawn-failed` / `profile-uncompilable` / `unsupported-platform:*`) / non-
  firing conditions (success, explicit-off, empty reason).

All 47 pass; 153 expect calls. Hermetic — every dependency is a hand-rolled
in-memory fake (no real provider / no real `ShadowOdb` / no real
`ConversationCheckpointStore` / no real Seatbelt / Landlock / Bubblewrap).

## Consequences

**Closes the `deliberate_hold` on the `recovery-router-codex-spec` catalog
entry** — every one of the 16 kinds in `LLMErrorKind` is now reachable from
its natural emitter (2 provider-side via ADR-0234, 3 layer-owned via this
ADR, 11 already provider-emitable since the original 11-kind set).

The wire to `RetryingLLM` / `FallbackLLM` / `runAgent` composition root is
**still deferred** — these helpers are seams. The composition root (or a
future ADR per slice) decides when to compose them around the existing
decorator chain. Three new `AgentConfig` slots (one per knob set) would be
the natural extension; the current ADR keeps the agent slot surface
unchanged so a future wire-up ADR can decide the slot shape without breaking
this ADR's contract.

**Negative invariants** pinned in the hellgates:

- `tooManyFailedAttempts`: mid-stream throws MUST NOT increment the counter
  (the budget is for pre-stream failures only).
- `threadRollbackFailed`: success outcomes MUST NOT carry `llmError` even
  when the wrapper is wired in `outcome-with-llm-error` mode.
- `sandboxError`: explicit-off results (no `degradeReason`) MUST NOT fire —
  the caller asked for no sandbox.

## Numbering

This ADR was assigned 0237 (next free above the existing 0236
`composition-root-mega-wire.md`). No collision.

## Memory

A short memory entry `llm-error-16-kind-layer-owned-arms-wire-2026-05-25`
records the file inventory + the default-OFF discipline so a future
absorption pass does not re-implement the same shim.
