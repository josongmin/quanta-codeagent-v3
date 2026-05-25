# ADR-0217: Typed error enum (16-variant) + retry routing port — Codex absorption extending ADR-0069

- **Status**: Accepted
- **Date**: 2026-05-25
- **Renumbered**: from initially-drafted ADR-0203 (collision with
  `0203-user-authored-playbook-frontmatter.md`). Per ADR-collision policy
  (memory `adr-collision-policy-2026-05-25`): user keeps original, ours
  renumber to next-free. Sibling ADR-0214 (`codex-spec` LLM-layer router) is
  unaffected and continues to cross-reference this slice under its new number.
- **Related ADRs**: ADR-0069 (typed per-failure-mode tool results — discriminated
  `ToolFailure` union), ADR-0044 (negative invariants — closed unions),
  ADR-0032 (OTel attribute vocabulary — `quanta.error.*` follow-up wiring slot),
  ADR-0094 (chatgpt-oauth provider — uses `unauthorized` arm), ADR-0192
  (lib-swap retry-pretry — calling shape this slice classifies against)
- **References**: `src/agent/error-routing/**`,
  `tests/unit/agent/error-routing-hellgate.test.ts`

## Context

ADR-0069 introduced typed `ToolFailure` for the tool slice: `not_found |
permission_denied | rejected | timeout | error`. That covers tool-execution
failures but does NOT classify the LARGER class of failures the agent loop
hits during a turn — provider HTTP failures, stream disconnects, sandbox
denials, mid-turn steer rejections, context-window exhaustion, usage-limit
caps, etc. Today those flow through ad-hoc try/catch sites and
`LLMError.kind` (11 arms in `@/shared/errors`), and the **routing decision**
("retry same turn? swap fallback? HITL? abort?") is scattered across
`@/llm/fallback`, `@/agent/retry`, and `@/agent/compaction-breaker`.

Codex (build 2867, `.extracted_source/codex/`) ships a **16-variant typed
error enum** with a single routing table mapping kind → action. The 16
arms — verbatim from their on-disk audit:

```
contextWindowExceeded | usageLimitExceeded | cyberPolicy |
httpConnectionFailed | httpStatusCode | responseStreamConnectionFailed |
responseStreamDisconnected | responseTooManyFailedAttempts |
internalServerError | unauthorized | badRequest | threadRollbackFailed |
sandboxError | activeTurnNotSteerable | unifiedExecStartup |
unifiedExecInteraction
```

Our gap: we have 11 `LLMErrorKind` arms (LLM-only), and tool-slice 5
`ToolFailure` arms — but no SUPERSET that names the loop-level failures
(`threadRollbackFailed`, `activeTurnNotSteerable`, `sandboxError`,
`unifiedExec*`, `cyberPolicy`) and no single port that says **"given this
typed error, what does the loop do next?"**.

## Decision

Add a **plane-clean leaf slice** at `src/agent/error-routing/` with two
closed ports:

- **`ErrorClassifier`** (`port.ts`):
  - `classify(e: unknown): TypedError` — pure function (no I/O), boundary
    of "raw thrown value" → 16-arm discriminant.
- **`RetryRouter`** (`port.ts`):
  - `decide(e: TypedError): RetryAction` — pure function, returns one of
    5 routing actions.

### `TypedErrorKind` (16-arm closed union — Codex verbatim)

```
contextWindowExceeded | usageLimitExceeded | cyberPolicy |
httpConnectionFailed | httpStatusCode | responseStreamConnectionFailed |
responseStreamDisconnected | responseTooManyFailedAttempts |
internalServerError | unauthorized | badRequest | threadRollbackFailed |
sandboxError | activeTurnNotSteerable | unifiedExecStartup |
unifiedExecInteraction
```

Each arm carries a `kind` discriminant plus arm-specific payload (e.g.
`httpStatusCode { status: number }`). The arms are exhaustive — adding one
forces an `assertNever`-guarded compile error at every consumer switch.

### `RetryAction` (5-arm closed union)

```
"retry-same-turn"     // context window / thread rollback → reactive compaction
"retry-with-backoff"  // 429 + transport/stream disconnects + re-exec
"swap-fallback"       // 5xx / internal server → alt provider
"hitl"                // policy / sandbox / steer-denied → human in the loop
"abort"               // usage limit / unauthorized / repeated failures / bad request
```

### Routing table (Codex verbatim)

| Kind                            | Action              |
|---------------------------------|---------------------|
| contextWindowExceeded           | retry-same-turn     |
| threadRollbackFailed            | retry-same-turn     |
| httpStatusCode (status=429)     | retry-with-backoff  |
| httpStatusCode (status 5xx)     | swap-fallback       |
| httpStatusCode (other)          | retry-with-backoff  |
| httpConnectionFailed            | retry-with-backoff  |
| responseStreamConnectionFailed  | retry-with-backoff  |
| responseStreamDisconnected      | retry-with-backoff  |
| unifiedExecStartup              | retry-with-backoff  |
| unifiedExecInteraction          | retry-with-backoff  |
| internalServerError             | swap-fallback       |
| cyberPolicy                     | hitl                |
| sandboxError                    | hitl                |
| activeTurnNotSteerable          | hitl                |
| usageLimitExceeded              | abort               |
| unauthorized                    | abort               |
| responseTooManyFailedAttempts   | abort               |
| badRequest                      | abort               |

### Default classifier (boundary)

`default-classifier.ts` maps:

- Existing `LLMError.kind` (ADR-0069 sibling 11-arm union) into the
  16-arm enum (e.g. `overloaded → httpStatusCode{status:529}`,
  `rate_limit → httpStatusCode{status:429}`, `auth → unauthorized`,
  `bad_request → badRequest`, `server_error → internalServerError`,
  `network → httpConnectionFailed`, `aborted → activeTurnNotSteerable`,
  `stream_corrupt → responseStreamDisconnected`,
  `not_implemented → badRequest`, `not_found → httpStatusCode{status:404}`,
  `unknown → internalServerError`).
- `PermissionDeniedError` → `cyberPolicy`.
- `ToolExecutionError` with `code: "tool_execution"` → preserve as
  `internalServerError` (unknown tool failure surface).
- `Error` carrying `code === "ETIMEDOUT"` or matching `NETWORK_CODES`
  → `httpConnectionFailed`.
- `e instanceof AbortSignal`-style aborts → `activeTurnNotSteerable`.
- Unknown / non-Error throws → `internalServerError` (safe default;
  surfaces as `swap-fallback` so the loop tries one more provider before
  aborting).

This is a PURE boundary translator — no I/O, no state. Programmer-bug
inputs (non-thrown values, primitives) round-trip into
`internalServerError` deterministically.

### Default router (table)

`default-router.ts` is a single `switch` on `kind` implementing the table
above. `httpStatusCode` is the only arm that branches on payload (429 vs
5xx vs other) — locked by `HELL-ER-25`.

### Default-OFF wire

Nobody imports `@/agent/error-routing` today. The barrel re-exports the
ports + types + default impls; until a consumer (loop, retry, fallback)
opts in by injecting the port, the existing ad-hoc routing in
`@/llm/fallback` and `@/agent/retry` is byte-identical. The slice ships
ONLY the typed enum, classifier, router, and 25-case hellgate. Wiring is
a follow-up.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **Extend `LLMErrorKind` to 16 arms** | Mixes loop-level concerns (sandbox, steer, thread rollback) into the LLM-boundary enum. ADR-0069 is explicit that adapters classify ONCE at the LLM boundary; sandbox/steer/etc. happen LATER in the loop. Wrong layer. |
| **Single `TypedError = string`** | Loses payload (`httpStatusCode.status` 429 vs 5xx) and exhaustive switch enforcement. |
| **Open enum (allow `"custom-..."`)** | Defeats the point — Codex's design is closed-default-deny so router never has an "unknown action" fall-through. |
| **Bake router into classifier** | Two concerns drift if collapsed: classification is provider-shape-dependent; routing is policy-dependent (different surfaces may want different actions later — e.g. desktop swallows `hitl` into a modal, CI exits non-zero). Two ports keep them testable in isolation. |
| **Throw on unknown error** | A pure classifier MUST be total — throwing makes the boundary itself a source of additional failures. Returning `internalServerError` (which routes to `swap-fallback`) is the safe degrade. |

## Consequences

- **Default-OFF byte-identical**: nobody wires the port today; existing
  `@/llm/fallback` + `@/agent/retry` paths are unchanged. Locked by
  HELL-ER-01..16 (classify-only) and the absence of any production
  consumer in this slice.
- **Closed-port DI seam**: `ErrorClassifier` and `RetryRouter` are 1-method
  interfaces; test doubles satisfy them in 3 lines.
- **OTel follow-up slot**: per ADR-0032, when a consumer wires this port,
  emit `quanta.error.kind` (string) + `quanta.error.action` (string) so
  the existing OTel vocabulary captures the new dimension. NOT shipped in
  this slice — the slice has no `@/observability` import.
- **Exhaustive switch**: `assertNever` guard at every consumer
  `switch (e.kind)` — adding a 17th arm forces compile errors at the
  router and at every wired consumer.
- **Plane-clean leaf**: imports only `@/shared` (for `Result`, `LLMError`,
  `PermissionDeniedError`, `ToolExecutionError`, `assertNever`). No
  `@/llm`, no `@/tool`, no `@/permission`.

## Limitations

- (a) The slice ships **ports + default impls + hellgate only** — wiring
  into the agent loop / fallback chain is a follow-up ADR. This is the
  same posture ADR-0069 took (typed `ToolFailure` shipped as seam; tool
  adoption was follow-up).
- (b) The classifier does NOT touch SDK-specific shape directly — it
  reads `LLMError.kind` which was already classified at the LLM boundary
  (ADR-0069). New raw-SDK paths must classify via `LLMError.fromSdkError`
  first; the typed-error classifier is the SECOND stage.
- (c) `unifiedExec*` arms map to `retry-with-backoff` as a placeholder;
  the v3 shell wrapper does not yet emit a typed startup-vs-interaction
  signal. When ADR-0192 (shell-execa swap) gains that signal, the
  classifier learns to produce these arms; today they're constructible
  but unreachable from `classify(unknown)`.

## Invariants

- **byte-identical**: no production consumer imports this slice yet; every
  existing test passes unchanged.
- **closed-port**: `ErrorClassifier` + `RetryRouter` are 1-method ports;
  no leak of impl types to the port.
- **exhaustive**: `assertNever` in the router's default case + the
  `ALL_TYPED_ERROR_KINDS` literal tuple as runtime cross-check.
- **plane-clean**: leaf — only `@/shared` is imported.
- **default-OFF**: feature is opt-in via DI; surfaces decide when to wire.
