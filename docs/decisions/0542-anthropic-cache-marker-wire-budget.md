# ADR-0542 — The Anthropic `cache_control` budget is counted on the final wire, not on system sections

Status: Accepted (2026-08-24)
Slice: `src/llm/anthropic-messages-codec.ts`
Feature: `anthropic-cache-marker-wire-budget` (feature-catalog §8-llm)
Related: ADR-0004 (byte-stable cached prefix) · ADR-0319 (cache-control prefix-stability audit) · `prompt-cache-1h-ttl` (the `ttl` axis on the SAME markers)

## Context

Anthropic rejects any request carrying more than **4** `cache_control` blocks with an HTTP 400. Quanta had a budget for this, but it was enforced in the wrong layer, against the wrong denominator, and its verdict was discarded.

- `src/agent/prompt-sections.ts` declares `MAX_CACHE_BREAKPOINTS = 4` and `validateSectionsCacheBudget` counts only the **system sections**.
- `buildAnthropicMessagesRequest` then **always** adds one more marker via `cacheConversationPrefix` — the trailing conversation breakpoint — which no budget accounts for. Four cached sections therefore emit **five** markers on the wire.
- `src/agent/prompt.ts` calls `validateSectionsCacheBudget(sections)` and throws the result away, so even the partial check it does perform cannot warn. Its comment claims it "surfaces in dev"; it does not. *(State at the time of this ADR. That call was deleted in the follow-up pass — see "Residual resolution" below.)*

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
- The section-level `validateSectionsCacheBudget` is no longer load-bearing for correctness. **Residual closed (2026-08-24, follow-up pass): the discarded call in `src/agent/prompt.ts` was DELETED** rather than made to warn — see *Residual resolution* below.
- A future fourth cached section is now safe to add: it costs a fallback breakpoint, not an outage.

## Residual resolution — the discarded call in `prompt.ts` (2026-08-24)

The residual recorded above offered two honest closures: make the check real (consume the verdict, `logger.warn` the count and limit) or delete it. It was measured, not argued, and **deletion won**.

**The verdict at that call site is a constant.** `fourSectionPreset` pushes at most four cached sections — `base`, `project_md`, `session_ctx`, `user_append` — from four named slots, with no loop and no caller-extensible list. Applied to preset output, `validateSectionsCacheBudget` returns `{ok:true}` for every reachable input. Measured two ways: exhaustively over all 2^4 presence combinations of the optional caller-data channels (16/16 `ok:true`), and by temporarily replacing the discarded call with a `throw` on `!ok` and running the whole prompt/agent/cache surface — **2253 tests, 0 failures**. The false arm never fired. A `logger.warn` there would have been an unreachable branch, in a module that is pure today and imports no logger at all.

**The wire cap strictly subsumes the section check.** The section check permits 4 cached sections; `capSystemCacheMarkers` permits `MAX_ANTHROPIC_CACHE_MARKERS - reserved`, and `cacheConversationPrefix` reserves one in every real turn, so the live system budget is 3. Every state the section check could have flagged is already flagged one layer down — and *repaired* (trailing markers dropped, every block's text kept) rather than merely reported. Measured end-to-end: with `fourSectionPreset` mutated to emit a fifth cached section and no section-level check present at all, the assembled request carried **4 markers, with all 5 blocks intact** — no 400, no manual guard.

The "catch future growth" argument for keeping a warn is therefore answered twice over: the wire already handles growth non-fatally, and a drift-guard test now pins the four section names so a fifth cached section is a test-visible act rather than a silent one.

`validateSectionsCacheBudget` itself is **kept and re-documented** — tests use it to state the section-count invariant directly — but it now says truthfully that it is a diagnostic with no production caller and that the wire is the enforcement point.

Pinned by `tests/unit/agent/prompt-cache-budget-callsite-hellgate.test.ts` (A-1 exhaustive constancy, A-2 drift guard, A-3 live front door at the cap, B-1/B-2 wire subsumption, B-3 paired control).

### Follow-up (not taken here)

`capSystemCacheMarkers` drops markers **silently**. That is correct for availability — a degraded cache beats a 400 — but a live turn today sits at exactly the cap, so the first real drop would be an invisible cache regression. A dev-visible signal is worth having; it belongs at the wire where the drop actually happens and is reachable, not at the section level where it never was. Out of scope for this pass (`src/llm/anthropic-messages-codec.ts` was outside its write set).
