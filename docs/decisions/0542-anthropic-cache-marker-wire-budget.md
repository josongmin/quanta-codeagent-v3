# ADR-0542 — The Anthropic `cache_control` budget is counted on the final wire, not on system sections

Status: Accepted (2026-08-24)
Slice: `src/llm/anthropic-messages-codec.ts`
Feature: `anthropic-cache-marker-wire-budget` (feature-catalog §8-llm)
Related: ADR-0004 (byte-stable cached prefix) · ADR-0319 (cache-control prefix-stability audit) · `prompt-cache-1h-ttl` (the `ttl` axis on the SAME markers)

## Context

Anthropic rejects any request carrying more than **4** `cache_control` blocks with an HTTP 400. Quanta had a budget for this, but it was enforced in the wrong layer, against the wrong denominator, and its verdict was discarded.

- `src/agent/prompt-sections.ts` declares `MAX_CACHE_BREAKPOINTS = 4` and `validateSectionsCacheBudget` counts only the **system sections**.
- `buildAnthropicMessagesRequest` then **always** adds one more marker via `cacheConversationPrefix` — the trailing conversation breakpoint — which no budget accounts for. Four cached sections therefore emit **five** markers on the wire.
- `src/agent/prompt.ts` calls `validateSectionsCacheBudget(sections)` and throws the result away, so even the partial check it does perform cannot warn. Its comment claims it "surfaces in dev"; it does not.

Reachability was measured rather than assumed. `userAppend` currently has no producer in the loop, so the live preset tops out at 3 cached sections (`base`, `project_md`, `session_ctx`) plus 1 conversation marker — **exactly 4**. Today's requests sit *at* the cap, not over it.

That is the reason to fix it at the wire rather than shrug: the budget has **zero headroom**, and the moment a fourth cached section appears, *every* Anthropic request 400s — across all five providers that share this codec (public, Bedrock, Vertex, Foundry, Mantle).

## Decision

Count the markers on the **assembled request** (`tools + system + messages`), reserve the conversation marker first, and cap the system markers against what remains.

The conversation marker is never dropped: it covers the longest prefix — all of `system` plus the prior turns — so it is the highest-value breakpoint in the request.

**Which** system markers are dropped is not a heuristic. `prompt-sections.ts` declares its section order to *be* the cache prefix, emitted most-stable-first (`base` → `project_md` → `session_ctx` → `user_append`). Keeping the **leading** markers preserves the fallback ladder: when a late section drifts, an earlier breakpoint still hits. Dropping a middle marker instead would strand every later breakpoint behind a prefix that just changed. A dropped block always keeps its **text** on the wire; only the `cache_control` key is removed.

The cap is **inert at and under budget**: a legal request is returned by reference, byte-identical. Paired-control tests assert that, so the cap cannot degrade into a blanket stripper.

### Marker accounting is structural, not textual

An adversarial audit of the first cut found a defect worth recording. Counting occurrences of the literal `"cache_control"` in `JSON.stringify(part)` can be inflated by **message content**: a message whose text is exactly `cache_control` serializes as `"text":"cache_control"` and was counted as a marker, silently dropping a real system breakpoint. Any user could trigger that by typing, and enough such messages would strip every system breakpoint.

Marker accounting therefore walks **properties**, never content bytes. Pinned by test C1-8.

## Consequences

- `MAX_ANTHROPIC_CACHE_MARKERS` is exported from the codec as the single named authority. It is not configurable: 4 is Anthropic's hard API limit, not a policy choice.
- The section-level `validateSectionsCacheBudget` is no longer load-bearing for correctness. Its discarded verdict in `prompt.ts` remains a silent no-op and is recorded as a residual for the integration lane.
- A future fourth cached section is now safe to add: it costs a fallback breakpoint, not an outage.
