# ADR-0545 — A truncated answer is a non-success outcome, and `StopCategory.reasonCode` is a closed type

Status: Accepted (2026-08-24)
Slice: `src/agent/recovery.ts` · `src/agent/stop-category.ts` · `apps/web-frontend/src/lib/stop-presentation.ts`
Feature: `truncated-output-nonsuccess` (feature-catalog §1-agent-loop)
Related: ADR-0242 (stop-reason policy) · the jun-25 loop-control cutoff fixes (`MALFORMED_TOOL_USE_REASON`) · the jul-3 empty-turn seal (`EMPTY_TURN_EXHAUSTED_REASON`) · the aug-23 Grok Build review §13 (competitor rails folding stalls into "Worked for 2m5s")

## Context

### Truncation was folded into success

When the model stops at `max_tokens`, the loop spends a continuation budget asking it to keep going. Once that budget was spent the turn sealed with `{ do: "proceed" }` — the ordinary text-completion path — and the run ended as `completed`.

So a mid-sentence answer, cut off because the token budget ran out, reported **success**. The only trace was `OUTPUT_TRUNCATED_MARKER` appended to the visible assistant text.

That marker is genuinely good: surfacing truncation **in-band** is more honest than any competitor rail examined in the aug-23 review, where a no-progress stop renders as "Worked for 2m5s". But a marker is not an outcome. Every programmatic consumer branches on `AgentOutcome.reason` — the subagent runner's `ok: outcome.reason === "completed"` map, the ci-bot's completed/stopped verb, a bench harness — and none of them can read a string buried inside assistant text.

This codebase already refuses this fold twice: a fumbled tool call seals `model.malformed_tool_use`, a produced-nothing stall seals `model.empty_exhausted`, both NON-success. Truncation is the third member of that family and was the one still folded.

### `reasonCode` was an open `string`

`StopCategory.reasonCode` was typed `string`, with the valid values listed in a **prose comment** above the interface. The prose went stale: it never gained `loop.no_progress`. An open type also means a typo produces a code no presentation table knows, and the fallback renders it as an unrecognized failure.

### The awaiting-approval path borrowed a shell-specific code

`awaitingApprovalCategory()` used `SHELL_NEEDS_APPROVAL`, whose own doc says it is "reserved for the gate seam". A turn paused on an approval decision is **tool-agnostic**; attributing every approval pause to the shell is wrong in analytics and contradicts the code's stated contract.

## Decision

1. **`OUTPUT_TRUNCATED_REASON`** — a `[output-truncated]`-prefixed non-success terminal, minted when `max_tokens` survives the continuation budget. The `error` recovery path appends the assembled message to working memory, so **the partial answer survives**: refusing to call it a success must not throw the model's words away. The in-band marker is kept and stays idempotent.
2. **`MODEL_OUTPUT_TRUNCATED` (`model.output_truncated`)** — its own code, classified from the prefix ahead of the provider patterns. Presented with tone `incomplete`, not `failed`: nothing went wrong, the answer is simply unfinished, which is the same shape as hitting the turn limit.
3. **`StopCategory.reasonCode: StopReasonCode`** — the type is the table. Adding an arm is now the only way to produce a code, and the stale prose list is replaced by a pointer to the table.
4. **`TURN_AWAITING_APPROVAL` (`turn.awaiting_approval`)** — split from `SHELL_NEEDS_APPROVAL`, which keeps its reserved gate-seam meaning.

## Consequences

- Four existing tests pinned `proceed` as the intended seal for a spent-budget truncation. They encoded the defect and were updated with the reason, not worked around.
- The two runtime drift guards did their job immediately: `assertStopPresentationInSync` refused the new code until it was given presentation, and the web-mirror drift hellgate refused it until `apps/web-frontend/src/lib/stop-presentation.ts` gained both new codes.
- Closing the type surfaced exactly one open-`string` assertion, in a test table. No production call site was constructing a code outside the table.
- A run that only ever truncates now ends `reason: "error"` end-to-end, verified through the real `runAgent` — and reverting the seal restores `completed`, which is what proves the fix reaches the outcome rather than only the decision.
