# ADR-0214: Flat LLMErrorKind 11→16 + RecoveryRouter port (Codex-spec verbatim)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0069 (typed per-failure-mode tool results),
  ADR-0094 (chatgpt-oauth provider), ADR-0192 (lib-swap retry-pretry),
  ADR-0217 (typed-error-routing slice — parallel design, see "Relationship
  to ADR-0217" below)
- **References**: `src/shared/errors.ts`, `src/shared/error-classifier.ts`,
  `src/llm/retry/{port,recovery-router,codex-spec-router,index}.ts`,
  `tests/unit/error-classifier-hellgate.test.ts`,
  `tests/unit/recovery-router-hellgate.test.ts`

## Context

We already had an 11-kind `LLMErrorKind` flat union in `src/shared/errors.ts`
(`overloaded | rate_limit | server_error | network | auth | bad_request |
not_found | not_implemented | stream_corrupt | aborted | unknown`) classified
ONCE at the LLM adapter boundary by `LLMError.fromSdkError`. Downstream
`src/agent/retry.ts` and `src/llm/fallback.ts` branch off `.kind`/`.statusCode`
only — no message re-sniff.

Gap: five Codex `CodexErr` arms carry actionable routing signal our 11-kind
set conflated. Specifically:
- `contextWindowExceeded` collapses into `bad_request` (provider returns 400),
  losing the "reactive compaction" recovery action.
- `cyberPolicy` has no representation — refusals route to `bad_request` or
  `unknown`, neither of which signal "HITL must resolve".
- `responseTooManyFailedAttempts` collapses into `rate_limit` (provider
  returns 429), losing the "budget burned, stop retrying" signal.
- `threadRollbackFailed` has no representation — surfaces as `server_error`
  or `unknown`, missing the "compact and rebuild" recovery.
- `sandboxError` has no representation — surfaces as `server_error` or
  `unknown`, missing the "HITL inspect host" recovery.

## Decision

### Extend `LLMErrorKind` flat union 11 → 16

`src/shared/errors.ts` adds five members to the existing flat union (no
payload, no nesting — set-membership only). The 11 existing members are
unchanged, preserving all downstream branching:

```
context_window_exceeded | cyber_policy | too_many_failed_attempts |
thread_rollback_failed | sandbox_error
```

### Add `classify(e: unknown) → LLMErrorKind` at `src/shared/error-classifier.ts`

Distinct from `LLMError.fromSdkError`:
- `fromSdkError` is the ADAPTER BOUNDARY — wraps and tags. Provider-aware.
- `classify` is the ROUTER BOUNDARY — consumes any thrown value (already-
  wrapped LLMError, raw Error, string, null, …) and returns a 16-kind tag.

The classifier honors a pre-wrapped `LLMError.kind` when it is definitive
(anything other than `"unknown"`). Otherwise it runs a documented heuristic
ladder in strict precedence:

1. AbortError / TimeoutError name → `aborted`
2. context-window markers → `context_window_exceeded` (BEFORE bad_request)
3. sandbox markers → `sandbox_error` (BEFORE server_error)
4. policy markers → `cyber_policy` (BEFORE bad_request)
5. too-many-failed markers → `too_many_failed_attempts` (BEFORE rate_limit)
6. thread-rollback markers → `thread_rollback_failed`
7. status-based (mirrors `errors.ts::classify` byte-for-byte)
8. Node `code` against `NETWORK_CODES` → `network`
9. fall-through → `unknown`

The classifier is pure, no-throw, deterministic. Circular objects and
throwing `toString` are safely handled.

### Add `RecoveryRouter` port + `CodexSpecRouter` at `src/llm/retry/`

Closed 6-arm `RecoveryAction` union:

```
"retry_same_turn"     — exists in the type but UNUSED by CodexSpecRouter today
"retry_after_backoff" — rate_limit (429) only
"hitl_handoff"        — auth, cyber_policy, sandbox_error
"fatal"               — bad_request, not_found, stream_corrupt, aborted,
                        too_many_failed_attempts, unknown
"fallback_provider"   — overloaded, server_error, network, not_implemented
"reactive_compaction" — context_window_exceeded, thread_rollback_failed
```

Routing table (16-kind × 6-action) is implemented as a single `switch` in
`codexSpecRoute(kind)`, guarded by `assertNever` so adding a 17th kind
fails to compile.

### Default-OFF byte-identical

Nobody imports the new router today. Existing `RetryingLLM` and `FallbackLLM`
decorators continue using the legacy `RETRYABLE_KINDS` and `FALLBACK_KINDS`
sets. The router is wired only where explicitly passed. The 5 new kinds are
NEVER emitted by current adapters (only by the new `classify` function); so
the legacy retry/fallback paths see exactly the 11 kinds they saw before.

## Relationship to ADR-0217

ADR-0217 ships a PARALLEL approach at `src/agent/error-routing/` with:
- A separate `TypedErrorKind` discriminated union (with payloads like
  `httpStatusCode{status}`).
- 5 actions (`retry-same-turn | retry-with-backoff | swap-fallback | hitl |
  abort`).
- Camelcase Codex names verbatim (`contextWindowExceeded`, etc.).

ADR-0214 (this ADR) chooses a different tradeoff:
- Flat 16-kind union extension of the existing `LLMErrorKind` (no payload).
- 6 actions (separates `retry_after_backoff` from `reactive_compaction` —
  important: a 429 backoff is NOT the same recovery as compacting context).
- snake_case names matching the existing `LLMErrorKind` style.
- Router slice lives in `src/llm/retry/` (closer to the LLM adapter
  boundary, since `LLMErrorKind` is an LLM concept).

The two approaches coexist as INDEPENDENT seams. ADR-0217 stays in
`src/agent/error-routing/` for the agent-loop-level superset (which captures
sandbox/steer/unifiedExec failures that AREN'T LLM errors). ADR-0214 stays
in `src/llm/retry/` for the LLM-layer routing (which is what the existing
`RetryingLLM`/`FallbackLLM` decorators consume). Neither slice imports the
other. A future ADR may unify them; today each closes its own gap.

The specific design difference that matters: ADR-0217 maps
`contextWindowExceeded → retry-same-turn`; ADR-0214 maps it to
`reactive_compaction`. The latter is a STRICTLY STRONGER signal — retrying
the same oversized prompt without compaction will fail identically, so
"retry-same-turn" alone is insufficient without an implicit compaction step.
The 6th action exists precisely to make that step explicit.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **Use ADR-0217 only** | Different action vocabulary (5 vs 6); `reactive_compaction` is the explicit signal we need. Different naming convention (camelCase) breaks our snake_case `LLMErrorKind` style. Slice location (`src/agent/`) puts router 2 layers from the LLM adapter it serves. |
| **Bake routing into `LLMError`** | Conflates "what failed" with "what to do". Two callers (RetryingLLM vs FallbackLLM) want different routing today; future ones (HITL queue, sandbox-review skill) will want more. Router as separate port keeps `LLMError` stable. |
| **Open the action union** | Defeats the point — every router action must be handled by every consumer's `switch`. Adding a new action is an intentional contract change. |
| **Throw on unknown kind in classifier** | A classifier MUST be total. Throwing makes the boundary itself a source of failures. `"unknown"` arm + `fatal` action is the safe degrade. |
| **Single payload-bearing arm `httpStatusCode{status}`** | Loses the 16-way exhaustive switch property at consumer sites. Forces every caller to re-classify 429-vs-5xx-vs-other. Worse DX, weaker invariant. |

## Consequences

- **Default-OFF byte-identical**: 5 new kinds are not emitted by any current
  adapter; the legacy `RETRYABLE_KINDS`/`FALLBACK_KINDS` sets in
  `src/agent/retry.ts` and `src/llm/fallback.ts` continue to handle the
  11-kind subset exactly as before.
- **Single source of truth for classification**: `classify(e)` in
  `src/shared/error-classifier.ts` is the ONLY place that runs the heuristic
  ladder for the 5 new kinds. Adapters MUST NOT match on message — that's
  the contract `fromSdkError` killed.
- **Exhaustive 16×6 routing**: `codexSpecRoute(kind)` uses `assertNever` in
  the default case + an exported `codexSpecRouterEmittedActions` set so a
  future contributor cannot silently drop an action mapping.
- **Negative invariants**: pinned in `recovery-router-hellgate.test.ts` —
  `context_window_exceeded` MUST be `reactive_compaction`, `cyber_policy`
  MUST be `hitl_handoff`, `aborted` MUST NOT be `retry_same_turn`,
  `too_many_failed_attempts` MUST be `fatal`.
- **Plane-clean leaves**: `src/shared/error-classifier.ts` imports only
  `./errors`. `src/llm/retry/` imports only `@/shared`.

## Limitations

- (a) **Adapters don't yet emit the 5 new kinds**. The classifier can produce
  them from raw thrown values, but `LLMError.fromSdkError` was NOT extended
  in this slice — adapters still emit one of the 11 original kinds. Wiring
  adapters to surface the new kinds (e.g. Anthropic 400 with
  "prompt is too long" → `context_window_exceeded`) is a follow-up.
- (b) **Router is not wired into RetryingLLM/FallbackLLM**. The existing
  decorators continue using `RETRYABLE_KINDS`/`FALLBACK_KINDS`. Wiring the
  router (and accepting the byte-shift) is a follow-up ADR.
- (c) **`retry_same_turn` action is unused**. It exists in the union for a
  future router (e.g. mid-turn-steerable provider). The hellgate guards that
  `CodexSpecRouter` does NOT emit it today.

## Invariants

- **byte-identical**: no production consumer wires the new router; every
  existing test passes unchanged.
- **closed-port**: `RecoveryRouter` is a 1-method port; pure typed mapping.
- **exhaustive**: `assertNever` guard in `codexSpecRoute` default branch
  + 16-kind table assertion in hellgate (length === 16, set.size === 16).
- **plane-clean**: classifier imports `./errors`; router slice imports only
  `@/shared`.
- **default-OFF**: 5 new kinds emitted only by `classify`; legacy retry/
  fallback sets unchanged; router never invoked by current callers.
