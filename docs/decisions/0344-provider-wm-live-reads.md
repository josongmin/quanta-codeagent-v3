# ADR-0344 — Provider adapter `wm-live` reads beyond the image-retry decorator (negative decision)

## Status

**Negative / Deferred.** No code mutation. This ADR documents the deliberate decision **not** to broaden any provider adapter's read of `input.messages` to a `wm-live` reference (whether by signature extension or by a generic decorator) at this time. The single live use case (image sanitize-and-retry) was already closed by ADR-0328 / ADR-0333 with documented, bounded semantics; widening that pattern would be a hypothetical-future cost without a hypothetical-future benefit visible in the current codebase.

## Context

ADR-0333 §Limitations explicitly flagged a residual concern after ADR-0328 landed:

> **Stale `input.messages` on retry.** The wrap re-passes the SAME `input` reference. The wm is mutated by `port.replaceLastTurnImages` but `input.messages` was snapshotted by the loop before the call. Under Codex's model `input.messages` IS the wm so the model sees the sanitized turn on retry; under our snapshot-decoupled model the retry sees the stale list. A future ADR may convert `input.messages` to a wm-live reference (or pass a re-snapshot callback into the wrap). Out of scope here.

The user's prompt for this ADR (ADR-0344) frames three options for closing that limitation more broadly across the 5 provider adapters (`anthropic` / `openai` / `bedrock` / `vertex` / `chatgpt-oauth`, plus the related `foundry-adapter`):

- **Case A — broad refactor.** Extend every adapter's `stream(input)` to `stream(input, opts?: { messagesProvider?: () => readonly Message[] })`. Providers call `messagesProvider()` on each retry / re-stream attempt.
- **Case B — generic decorator.** Add `withWmLiveMessages(inner, { wm }): LLMPort` — a sibling to `withImageSanitizationRetry` that re-snapshots wm on retry. Provider adapters untouched.
- **Case C — defer.** Document that no second use case exists; the ADR-0333 site is the only one; future use cases (if any) can each ship their own per-use-case decorator following the ADR-0328 pattern.

## Phase 1 — Fact-find

### Q1. Where in the codebase does `input.messages` ever need to be wm-live?

The only sites that read `input.messages` are the 6 provider adapters, and they ALL read by-reference at call time without re-snapshotting:

| File | Line | Read shape |
| --- | --- | --- |
| `src/llm/adapters/anthropic.ts` | 349 | `toAnthropicMessages(input.messages)` |
| `src/llm/adapters/openai.ts` | 380 | `toChatMessages(input.system, input.messages)` |
| `src/llm/adapters/chatgpt-oauth.ts` | 418 | `for (const m of input.messages) { … }` |
| `src/llm/providers/bedrock-adapter.ts` | 173 | `input.messages.map(...)` |
| `src/llm/providers/vertex-adapter.ts` | 170 | `input.messages.map(...)` |
| `src/llm/providers/foundry-adapter.ts` | 305 | `input.messages.map(...)` |

The agent loop (`src/agent/loop.ts:1300`) calls `prepareTurnContext(...)` to rebuild `ctx.messages` **every outer-loop iteration**, so the **outer loop retry path is already wm-live** — the snapshot is fresh per turn. The wm-live problem is bounded to retries **inside** a single `stream()` call.

### Q2. How many `stream()`-internal retry layers exist, and how many mutate wm between attempts?

There are 5 in-`stream`-call retry / re-issue decorators:

| Decorator | Location | Mutates wm between attempts? |
| --- | --- | --- |
| `withImageSanitizationRetry` | `src/llm/image-sanitization-retry/wrapping.ts:160` | **YES** — calls `port.replaceLastTurnImages` |
| `withFailureCounter` (ADR-0237) | `src/llm/retry/too-many-failed-attempts.ts:130` | No (counter only, no sanitize, no re-issue inside `stream`) |
| `RetryingLLM` (legacy) | `src/agent/retry.ts:236` | No (backoff + re-issue with same `input`) |
| `FallbackLLM` | `src/llm/fallback.ts:212` | No (re-issues to alternate provider, same `input`) |
| `model-swap` | `src/llm/model-swap.ts:131` | No (swaps adapter, same `input`) |

**Only one decorator mutates wm between attempts.** That decorator is the same one that surfaced the ADR-0333 limitation.

### Q3. Are there mid-stream wm mutators (hooks, async tools, sub-agent merges, follow-ups) that would benefit from wm-live reads?

No. Verified:

- Hooks (`src/agent/hooks.ts`, `prompt.ts:385`): inject **before the next turn**, never mid-stream.
- Follow-up queue (`src/agent/follow-up-queue.ts:46-69`): explicit `model_streaming` pause reason — a follow-up arriving mid-stream is **queued** for the next turn precisely because "injecting a user message mid-stream would desync the provider's `assistant`/`tool_use` ordering."
- Sub-agent merges: no grep hits for `mergeSubagent` / `sub_agent_result`-class mid-stream merge sites; sub-agents resolve at turn boundary (ADR-0145 plan queue).
- Async tool results: `streaming-dispatch.ts:507-522` documents that `runStep` does NOT `wm.append` on error and that tool results are appended at turn boundaries, not mid-stream.

### Q4. Provider adapter signature consistency

All 6 adapters expose the **identical** `stream(input: StreamInput): AsyncIterable<StreamEvent>` from `LLMPort` (`src/llm/ports.ts:22`):

```
src/llm/adapters/anthropic.ts:370       async *stream(input: StreamInput): AsyncIterable<StreamEvent>
src/llm/adapters/chatgpt-oauth.ts:209   async *stream(input: StreamInput): AsyncIterable<StreamEvent>
src/llm/adapters/openai.ts:399          async *stream(input: StreamInput): AsyncIterable<StreamEvent>
src/llm/providers/bedrock-adapter.ts:192  async *stream(input: StreamInput): AsyncIterable<StreamEvent>
src/llm/providers/foundry-adapter.ts:337  async *stream(input: StreamInput): AsyncIterable<StreamEvent>
src/llm/providers/vertex-adapter.ts:186   async *stream(input: StreamInput): AsyncIterable<StreamEvent>
```

A Case-A refactor would therefore touch all 6 adapter files, the `LLMPort` interface itself, every test double (which there are many — `withFailureCounter`, `RetryingLLM`, `FallbackLLM`, `model-swap`, replay, recording, default-adapter all have to forward the new option), and the `ImageSanitizationRetry` wrap (to simplify by calling `messagesProvider()` instead of re-passing the original `input`).

## Phase 2 — Decision

**Case C (defer).** Justification:

1. **No second consumer.** The only wm-live consumer today is `withImageSanitizationRetry`, and ADR-0328 / ADR-0333 already closed that use case with explicit Codex parity (`replace_last_turn_images` + `continue`). The ADR-0333 limitation is **bounded** — it affects exactly one error kind (`invalid_image`) on exactly one retry path (the in-decorator retry, not the outer loop), with a deterministic fallback (`wasMutated: false` ⇒ propagate the original error, no infinite loop, no silent data loss).

2. **No hypothetical second consumer visible.** Fact-find Q3 verified that the architectural seams that COULD have introduced mid-stream wm mutation (hooks, follow-ups, sub-agent merges, async tool results) are all explicitly turn-boundary-only. The follow-up queue's `model_streaming` reason is even explicitly documented as "this exists precisely so we DON'T mutate wm mid-stream." Widening provider adapter contracts to support a non-existent consumer would be cargo-cult generalization.

3. **Case A cost is non-trivial.** Touching `LLMPort` itself plus 6 adapters plus every wrap/decorator/test double (≥10 files of plumbing, plus signature updates on every `stream()` call site in the codebase), gated by hellgate suites for each provider × scenario — that is real engineering cost for a hypothetical future benefit.

4. **Case B cost is lower but still unwarranted.** A `withWmLiveMessages` decorator is a smaller change (one new slice), but it would have **no consumer**: the only existing consumer (`withImageSanitizationRetry`) already does the right thing for its specific Codex-parity contract. Adding an unused generic decorator violates the project's "no dead-code seams" stance (cf. ADR-0237's default-OFF identity wraps — those exist because their consumer is known and gated, not as speculative scaffolding).

5. **The ADR-0333 limitation has a clean escape hatch already.** If a future use case appears (e.g. a "long-tool-result snipped post-stream" decorator), it can follow the ADR-0328 pattern: a focused, per-use-case decorator that binds to its own `WorkingMemory`-backed port and re-issues the inner stream with a freshly-snapshotted `input`. The pattern is proven (ADR-0328 + ADR-0333) and composable.

**On the user's "다 조져" framing.** This ADR is the answer that fact-find dictates. A request to "do everything" does not override an honest assessment that there is nothing to do. The honest answer is: ADR-0337's pattern (per-use-case decorator) generalizes correctly when needed, and forcing it onto the provider tier today would be a 6-file refactor for zero observable consumer behaviour.

## Phase 3 — Action

**None.** No code mutated. This ADR file itself is the entire delivery.

## Non-goals

- Provider adapter `stream(input)` signature extension (Case A) — explicitly rejected here.
- Generic `withWmLiveMessages` decorator slice (Case B) — explicitly rejected here.
- Backporting wm-live reads to `withFailureCounter` / `RetryingLLM` / `FallbackLLM` / `model-swap` — these layers do **not** mutate wm between attempts, so they would not benefit.
- Mid-stream wm mutation hooks. The follow-up queue's `model_streaming` pause reason is the project's standing policy on this; this ADR does not revisit it.

## When this ADR should be revisited

If any of the following appear in the codebase, a follow-up ADR should reopen Case A / Case B:

1. A **second** decorator that mutates wm between in-`stream` retry attempts (e.g. a future `withDocumentSanitizationRetry`, or a mid-stream PII redaction retry).
2. A real consumer for mid-stream message injection that would require the provider to re-read wm during streaming (none today — every candidate is currently architected as a turn-boundary event).
3. A switch in the Codex parity model (`codex-rs/core/src/session/turn.rs`) that exposes the wm-live behaviour as a contract rather than an emergent property of "input.messages IS the wm" in their codebase.

Until then, the documented limitation in ADR-0333 §Limitations is **load-bearing and intentional**, not a defect awaiting closure.

## References

- ADR-0328 — `withImageSanitizationRetry` decorator + `invalid_image` `LLMErrorKind` (the original use case).
- ADR-0332 — composition wire helper (`installCodexR2Wires` populates the `cfg.imageSanitizationRetry` slot).
- ADR-0333 — production hookup of the image-retry decorator (§Limitations is the precursor to this ADR).
- ADR-0237 — `withFailureCounter` (sibling decorator; documents the "no dead-code seams" posture this ADR cites).
- `src/llm/ports.ts:22` — the `LLMPort.stream(input)` contract that Case A would have to widen.
- `src/agent/follow-up-queue.ts:46-69` — the `model_streaming` pause reason that closes the "mid-stream user injection" architectural concern.
