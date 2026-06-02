# ADR-0452 — session-startup LLM prewarm + Time-To-First-Message metric

**Status:** Accepted (2026-06-02)
**Type:** Startup-latency + observability slice (Codex `session_startup_prewarm`
absorption — LLM-connection half).
**Scope:** `src/llm/prewarm.ts` (NEW — optional `LlmPrewarmPort` capability +
`prewarmLlm` best-effort helper), `src/llm/index.ts` (barrel re-export),
`src/agent/startup-prewarm.ts` (NEW — `runSessionPrewarm` + once-fire
`TtfmMarker`), `src/agent/metrics.ts` (`AgentRecorder.prewarm` + `.timeToFirstMessage`
+ 3 `METRIC` keys), `src/observability/vocabulary.ts` (NEW `quanta.startup.*`
namespace), `src/agent/turn-context.ts` (`TurnSession.ttfm` slot),
`src/agent/types.ts` (`AgentConfig.prewarm` block), `src/agent/loop.ts`
(`maybeRunSessionPrewarm` gate + once-fire marker at the LLM-request boundary).
Default-OFF, env-gated (`QUANTA_PREWARM`).

ADR-number note: 0450 is the highest existing decision; 0451 is left for a
concurrently-active sibling session. This slice took the next clearly-free
number, 0452, per the user-deference renumber policy.

## Context

Codex's startup runs a `session_startup_prewarm` step and emits
`codex.startup_prewarm.{age_at_first_turn_ms, duration_ms}` telemetry. Two
distinct things are prewarmed: (a) the *capabilities* (tools / skills /
classifier) and (b) the *LLM connection* (DNS + TLS + HTTP handshake) so the
first user turn does not pay that cost on its critical path.

For quanta, half is already done: `buildSessionFeatures` (`src/agent/features.ts`)
is EAGER — tools, skills and the auto-mode classifier are all materialized once
at session start. So (a) is covered. The genuine gaps were:

1. **No LLM-connection warm.** `grep src/llm` confirms no keep-alive / ping /
   pre-handshake exists. The first model stream pays DNS+TLS on the user's first
   message.
2. **No TTFM metric.** There is a per-request TTFT (`gen_ai.response.time_to_first_token_ms`,
   ADR-0077) but nothing measuring session-start → first-turn dispatch.

## The honest LLM-warm boundary

`LLMPort` (`src/llm/ports.ts`) exposes exactly ONE behavioral method:
`stream(input)`. The concrete adapters wrap the official vendor SDKs
(`new OpenAI()`, `new Anthropic()`). Those SDK clients own a private,
fetch-based HTTP agent with its own connection pool. **There is no public method
on the SDK client — and therefore none reachable through `LLMPort` — that opens
a pooled connection without also issuing a model request.** Issuing a throwaway
model request purely to warm a socket would be wasteful and bill the user, which
the brief forbids.

So this slice does **not** ship a fake request. It ships an OPTIONAL, OPT-IN
capability:

- `LlmPrewarmPort { prewarm(signal?): Promise<void> }` — a structural
  (duck-typed) extension of `LLMPort`. An adapter (or a custom transport) that
  *can* genuinely pre-open a connection — e.g. a real HTTP/2 handshake, a
  connection-pool warm, or a provider-native ping — MAY implement it.
- `prewarmLlm(port, opts)` detects the capability via `hasPrewarm` and calls it
  best-effort; a port without `prewarm` is a true no-op (returns `"skipped"`,
  nothing touched).
- The stock SDK-wrapping adapters do **not** implement `prewarm` today (no clean
  SDK hook), so the connection warm is currently a **documented seam**, not an
  active pre-open. The TTFM metric is fully wired and active. This is the honest
  state: seam now, real pre-open when an adapter can implement it cleanly.

## Decision

`AgentConfig.prewarm` (default-OFF, set by `QUANTA_PREWARM`):

```
prewarm?: {
  enabled: boolean
  now?: () => number      // injected clock for TTFM (default Date.now)
  warmSignal?: AbortSignal // abort a slow warm so it never delays turn 1
}
```

When `enabled === true`, `maybeRunSessionPrewarm` (in `loop.ts`, called once
inside `createRunAgentContext` after `cfg.llm` is finalized):

1. Stamps `startedAt = now()`.
2. Best-effort `prewarmLlm(cfg.llm)` — no-op unless the adapter opts in; records
   `quanta.startup.prewarm_duration_ms` (gauge) + `quanta.startup.prewarm_outcome.{skipped|warmed|failed}`
   (counter).
3. Returns a once-fire `TtfmMarker` placed on `TurnSession.ttfm`.

The stream dispatcher (`streamConsume`) calls `session.ttfm?.markFirstDispatch()`
at the LLM-request boundary (immediately before `emitLlmRequest`). The FIRST
reach records `quanta.startup.time_to_first_message_ms = now() - startedAt`
(gauge); later turns are no-ops, so TTFM is a single per-session value (Codex
`age_at_first_turn_ms` parity).

### Metric keys (`quanta.startup.*`, canonical vocabulary)

| key | type | meaning |
| --- | --- | --- |
| `quanta.startup.time_to_first_message_ms` | gauge | session start → first-turn LLM dispatch |
| `quanta.startup.prewarm_duration_ms` | gauge | cost of the connection warm (0 when skipped) |
| `quanta.startup.prewarm_outcome` | counter (`.skipped`/`.warmed`/`.failed`) | warm result |

## Consequences

- **Default-OFF, byte-identical.** `prewarm` absent / `enabled !== true` ⇒
  `maybeRunSessionPrewarm` returns `undefined` ⇒ no clock read, no prewarm call,
  no `ttfm` slot on the session, no metric. The loop is identical to the
  pre-slice path.
- **Best-effort.** A `prewarm()` rejection is swallowed (recorded as `"failed"`,
  logged) and NEVER blocks or fails turn 1.
- **Testable.** TTFM is sourced entirely from the injected clock; tests assert
  exact ms with a fake clock. No `Date.now`/`performance.now`/real timer in the
  slice body (the loop reads `cfg.prewarm.now ?? Date.now` — the default is only
  reached when no clock is injected).
- **Seam for the real warm.** A future adapter that can pre-open cleanly just
  implements `prewarm`; no loop change needed — the helper auto-detects it.
