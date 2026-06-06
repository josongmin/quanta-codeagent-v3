# RFC — Time-based microcompaction (selective tool-result eviction)

> **Status: ✅ IMPLEMENTED (jun-06)** — Phase 1 (pure pre-pass + spill adapter) +
> Phase 2 (tier-1 wire in `compaction-wire.ts`) landed, default-OFF byte-identical.
> Phase 3 (`context_hint` / CLI surface) deferred. See **§10 as-built** below.
> Date: 2026-06-06
> Slice: NEW `src/agent/tool-result-evict/` (pure pre-pass) + wire in `src/agent/loop/compaction-wire.ts`
> Default posture: OFF (`QUANTA_MICROCOMPACT` unset ⇒ byte-identical; the pre-pass is never constructed)
> Context axis: context-management (a CHEAPER first tier in front of `compactIfNeeded`)

---

## 1. 요약

quanta reclaims context two ways today, and **neither shrinks a stale tool dump in place**:

1. **At capture time** — `output-spill.ts#capToolOutput` caps a SINGLE tool_result the moment it is produced (over `200_000` chars ⇒ persist to `.quanta/tool-output/<uuid>.txt` + substitute a `<persisted-output>` head/tail excerpt). This is a *per-result, one-shot* cap — once a result is under the cap it is **never revisited**, no matter how stale it becomes.
2. **At the token threshold** — `compactIfNeeded` summarizes the WHOLE prefix older than `keepRecentTurns` into one synthetic `<conversation summary>` user message via an LLM call. This costs an LLM round-trip and **collapses all reasoning** (assistant text, decisions, file paths) older than the suffix into one opaque sentence.

The gap: a transcript can sit *under* the summarization threshold yet still be bloated by a handful of large-but-individually-under-cap tool dumps from 20 turns ago (a 50 KB `grep`, a 30 KB file read, a directory listing) that are **no longer referenced** — the model has already acted on them. Reclaiming that space today requires either (a) waiting for the full-summarization threshold and paying an LLM call + losing all old reasoning, or (b) nothing.

**Candidate (cc-cli 2.1.150, verified — `tengu_time_based_microcompact`, fns `AQ8`/`VR_`/`vfK`):** BEFORE a full summarization, walk history, **keep the last `keepRecent` tool_results, and CLEAR THE CONTENT of older tool_result blocks in place** — replace each body with `"[Old tool result content cleared]"` (optionally persisting the original to disk with a `<persisted-output>` reference). Fires only when estimated `tokensSaved > floor`; idempotent (skips already-cleared); triggered time-based + on a context_hint. This reclaims context for **ZERO LLM cost** and **ZERO loss of conversational reasoning** — assistant text and decisions stay verbatim; only stale tool dumps shrink.

**Goal:** add a small, fence-clean PURE pre-pass that does exactly this, wired as a CHEAPER FIRST tier in front of `compactIfNeeded`. Default-OFF, byte-identical when the knob is unset.

---

## 2. 경쟁사 레퍼런스 (verified evidence)

### 2.1 cc-cli 2.1.150 — `tengu_time_based_microcompact` (round-4 absorption audit)

The candidate, as captured in the round-4 absorption audit:

- **Trigger.** Two firing paths: a **time-based** cadence (fires periodically, not every turn) and a **`context_hint`** (an explicit "context is filling" nudge). Both run BEFORE the full-summarization decision.
- **Algorithm.** Walk the message history collecting `tool_use_id`s in order. Keep the **last `keepRecent`** tool_results intact. For every OLDER tool_result, **clear the body in place** — rewrite the `content` to the literal placeholder `"[Old tool result content cleared]"` — optionally first persisting the original to disk and leaving a `<persisted-output>`-style reference so it can be re-read.
- **Gate.** Estimate `tokensSaved` across the candidate clears; only commit if `tokensSaved > floor`. A microcompact that frees almost nothing is a no-op (don't churn the transcript for 40 tokens).
- **Idempotent.** A tool_result whose body is already the placeholder is SKIPPED (no double-clear, no re-persist, no re-count).
- **Result.** Context reclaimed with no LLM call and no loss of assistant reasoning — only the *stale tool dumps* shrink. Full summarization remains the fallback when microcompaction alone is insufficient.

The key structural insight the audit flags: clearing the **content** of a tool_result (not removing the block) means the `tool_use` ↔ `tool_result` pairing is **never disturbed**. The block stays; only its body shrinks. This is a strictly simpler invariant than removal-based compaction.

### 2.2 What cc actually does, distilled

A tiered context strategy: **(tier 0) capture-time per-result cap** (quanta has this — `output-spill.ts`); **(tier 1) microcompaction** = retroactively null out OLD tool-result bodies, cheap + lossless-for-reasoning; **(tier 2) full LLM summarization** = expensive + lossy-for-reasoning, only when tier-1 isn't enough. quanta has tier 0 and tier 2 but is **missing tier 1**. This RFC adds tier 1.

---

## 3. 현재 quanta 상태 (grep-verified)

### 3.1 RE-AUDIT verdict — the candidate does NOT exist

A prior absorption shipped a slice literally NAMED `microcompact` (`src/agent/microcompact/`, ADR-0409). **It is a DIFFERENT mechanism** and does NOT satisfy this candidate. Grep-verified:

- `createMicroCompactor` (`src/agent/microcompact/compactor.ts`) **drops whole MESSAGES** — `assembleDropResult` walks `droppedFlags` and materializes a `kept` array EXCLUDING the dropped indices (`compactor.ts:191-197`). It removes the oldest `floor(len * dropRatio)` messages verbatim. It does **NOT** clear tool_result bodies in place.
- It has **NO orphan-safety**: `selectDrops` walks `[0, total - preserveRecentTurns)` dropping the first `target` non-system messages (`compactor.ts:145-161`) with **no `tool_use`/`tool_result` pairing check**. Dropping a message that produced a `tool_use` whose `tool_result` survives in the suffix would orphan it (Anthropic 400). This is exactly the problem content-clearing sidesteps.
- It does **NO disk persistence** — dropped messages are gone, not spilled.
- It is **UNWIRED**: `grep -rn "createMicroCompactor|@/agent/microcompact" src/ --include=*.ts` outside the slice itself returns only a doc-comment reference in `recovery-reason/types.ts:40`. No non-test peer imports it. It is a default-OFF leaf seam that was never consumed (`types.ts:14-17`: "Default-OFF: nobody wires this port today").

So the existing `microcompact` is **whole-message drop**; the candidate is **in-place tool-result content clearing**. Different algorithm, different safety profile, different cost. **The candidate is NOT built. Proceed.**

Additional grep confirmation:
- `grep -rniE "keepRecent|evictToolResult|toolsCleared|content cleared|cleared\]"` across `src/` → only the `keepRecentTurns` *turn-boundary* knob (a summarization parameter, not tool-result eviction) and the microcompact-slice's own identifiers. NO "clear tool_result content" primitive anywhere.

### 3.2 What quanta HAS today (the two adjacent mechanisms)

**Capture-time cap — `src/tool/output-spill.ts`.** `capToolOutput(output, {maxChars, spillDir})`: over `DEFAULT_TOOL_OUTPUT_MAX = 200_000` chars ⇒ `write(spillPath, output)` to `<spillDir>/<uuid>.txt`, prune the dir to `DEFAULT_SPILL_KEEP = 50` newest, return a `<persisted-output>` head(`8_000`)+tail(`4_000`) excerpt marker. Sub-cap ⇒ byte-identical, no IO. **This is the EXISTING disk-spill primitive the candidate's "persist the original" step should reuse** (§4.4). It is per-result and one-shot — it never revisits an already-emitted result.

**Threshold summarization — `src/agent/compaction.ts` + `compaction-wire.ts`.** `compactIfNeeded`: over `resolveThreshold()` (`DEFAULT_THRESHOLD = 120_000` tokens) ⇒ `findBoundary(messages, keepTurns)` picks an orphan-safe cut, summarize the prefix via an LLM call into one `<conversation summary>` synthetic user message, `wm.replace([synthetic, ...suffix])`. `findBoundary` is the **removal-based orphan guard**: it expands the boundary *backwards* until no retained `tool_result` references a `tool_use` in the summarized prefix (`compaction.ts:141-175`). `maybeCompact` (`compaction-wire.ts:18`) is the loop wire that drives it (plus the bg controller + breaker + archive).

### 3.3 The orphan-safety contrast (the central design win)

`findBoundary`'s entire complexity (`compaction.ts:152-173`, the backward-walk `suffixIds` set) exists **solely to avoid orphaning a tool_result when REMOVING messages**. Content-clearing **eliminates that problem class**: we never remove a block, so a `tool_use` always keeps its paired `tool_result` block — only the body string shrinks. The pre-pass needs **no boundary walk, no orphan set, no backward expansion**. It is strictly simpler than `findBoundary` *and* strictly safer than the unwired `createMicroCompactor` (which has no orphan guard at all). This is the headline reason to add a NEW pre-pass rather than extend either existing path.

### 3.4 The delta-token counter interaction (just landed — the key risk)

`src/agent/token-delta/{counter,wm-decorator}.ts` (RFC jun-6-delta-token-accounting) memoizes `estimateTokens(snapshot())` in O(1) by tracking the PRE-CEIL char sum (`charsOf`) at the wm mutation chokepoints. Its byte-identity invariant is: `tokenTotal() === estimateTokens(snapshot())` at every step. It re-anchors ONLY on `append` / `replace` / `clear` / `tokenReseed` (`wm-decorator.ts:63-87`).

**The hazard:** if the pre-pass mutates tool_result `content` strings **in place** on the live backing buffer (`wm.messages[i].content[j] = …`) WITHOUT flowing through `replace`/`append`, the counter will NOT observe the shrink — `tokenTotal()` would over-report by the freed chars and drift from `estimateTokens(snapshot())`, breaking the load-bearing invariant. §4.6 pins the contract that resolves this (the pre-pass MUST install via `wm.replace(...)` OR call `wm.tokenReseed()` after an in-place edit).

---

## 4. 설계

### 4.1 Slice placement + fence

New slice `src/agent/tool-result-evict/` (a sibling of `src/agent/microcompact/`, NOT a modification of it — the existing slice stays as-is; this is the content-clearing alternative). Fence posture, mirroring the compaction slices:

- The pre-pass is a **PURE function over `readonly Message[]`** plus an injected clock and an injected spill port. It imports `@/llm` only for the `Message`/`ContentBlock` types (same as `compaction.ts`), `@/shared` for `runtimeConfig`, and the spill port TYPE.
- It imports **NO** `@/agent/loop`, no LLM port (it never calls a model — that is the whole point), no permission, no dispatch.
- An arch-scan/biome ratchet rule restricts `src/agent/tool-result-evict/**` to `node:*`, `@/llm` (type-only), `@/shared`, and the spill-port type — same shape memory records for the other leaf slices.

### 4.2 The pure pre-pass contract

```ts
// src/agent/tool-result-evict/types.ts
export const EVICTED_PLACEHOLDER = "[Old tool result content cleared]"

/** Persist seam: hand the original body to disk, get back a retrieval ref
 *  (the `<persisted-output>` marker string) to embed in the cleared block.
 *  Returns `undefined` ⇒ clear with the bare placeholder (no spill).
 *  Injected so the pre-pass is pure + testable; the default adapter wraps
 *  the EXISTING `output-spill.ts` (§4.4). NO-THROW: a spill failure degrades
 *  to a bare-placeholder clear, never aborts the pre-pass. */
export interface EvictionSpillPort {
  persist(body: string, toolUseId: string): string | undefined  // → ref marker, or undefined
}

export interface MicrocompactInput {
  readonly messages: readonly Message[]
  /** Keep the LAST N tool_results intact (default 3 — see §4.7). */
  readonly keepRecent: number
  /** Commit ONLY if estimated tokensSaved > this floor (default — see §4.7). */
  readonly tokensSavedFloor: number
  /** Injected — persist originals before clearing. Omit ⇒ bare-placeholder clear. */
  readonly spill?: EvictionSpillPort
}

export interface MicrocompactResult {
  /** New message array IFF a clear happened; otherwise the input ref unchanged. */
  readonly messages: readonly Message[]
  readonly changed: boolean
  readonly toolsCleared: number
  readonly tokensSavedEstimate: number
}

export const microcompactToolResults = (input: MicrocompactInput): MicrocompactResult
```

### 4.3 Algorithm (pure, no clock, no IO except through the injected port)

1. **Single forward scan** collecting the indices `(i, j)` of every `tool_result` block (`b.type === "tool_result"`), in order. (Each `ToolResultBlock` carries `content: string` + `tool_use_id` + optional `contentBlocks` — `src/llm/types.ts:91-112`.)
2. The **last `keepRecent`** tool_results are PROTECTED (kept verbatim). Everything earlier is a clear-candidate.
3. For each candidate, **skip if already cleared** (`content === EVICTED_PLACEHOLDER` OR it already starts with the `<persisted-output>` clear marker) — idempotent (§4.5).
4. **Estimate `tokensSaved`** = `ceil(sum(blockChars(old) - blockChars(cleared)) / 4)` over all candidates, using the SAME `blockChars` accounting `compaction.ts` uses (a `tool_result`'s char weight is `b.content.length` — `compaction.ts:80-81`). Note: `EVICTED_PLACEHOLDER` plus any spill-ref marker has a small positive length, so the per-block saving is `old.content.length - cleared.content.length`.
5. **Gate:** if `tokensSaved <= tokensSavedFloor` ⇒ return `{messages: input.messages, changed: false, toolsCleared: 0, tokensSavedEstimate}` (NO new array allocated — byte-identical pass-through, like `buildPassThrough` in the existing slice).
6. Otherwise **rebuild** a new `messages` array where each cleared block is a NEW `ToolResultBlock` with `content` rewritten to `EVICTED_PLACEHOLDER` (or `spill.persist(...)`'s ref marker), the `tool_use_id` and `is_error` preserved, and `contentBlocks` DROPPED (the image/document parts are exactly the heavy stale payload we are reclaiming — see §4.8). Every OTHER block (and the protected recent tool_results, and all assistant text/thinking/tool_use) is carried by reference — verbatim.

The function is **pure**: no `Date.now()`, no `Math.random()`, no env read, no IO except the single injected `spill.persist` call. The clock/time-based trigger lives in the WIRE (§4.6), not the pure core (mirrors how `compaction.ts` keeps the clock in the controller, and the memory discipline "no Date.now in prose/impl of pure cores").

### 4.4 Disk persistence — reuse `output-spill.ts`

The default `EvictionSpillPort` adapter wraps the EXISTING `capToolOutput` primitive rather than rolling a new writer:

- `persist(body, toolUseId)` ⇒ write `body` to `<spillDir>/<uuid>.txt` and return a `<persisted-output>`-style marker string pointing at that path, EXACTLY the marker `capToolOutput` already produces (`output-spill.ts:215-226`), so the model sees a familiar "the full output is at: …; Read that file" reference and can re-read the original. The spill dir is the same `.quanta/tool-output/` and the same `pruneSpillDir(keep=50)` bound applies — no new on-disk surface, no new retention knob.
- The cleared block's `content` becomes that marker (a head/tail excerpt + path), NOT the bare `EVICTED_PLACEHOLDER`, when a spill port is wired. The bare placeholder is the fallback when no spill port is injected OR `persist` returns `undefined` / throws (NO-THROW: a spill failure degrades to the bare placeholder).
- Reusing `capToolOutput` means the idempotency check in §4.3 step 3 must recognize BOTH `EVICTED_PLACEHOLDER` and the `<persisted-output>` marker as "already cleared" (otherwise a second pass would re-spill an already-spilled excerpt). The simplest robust marker is a 1-line sentinel prefix the pre-pass owns, e.g. content begins with `EVICTED_PLACEHOLDER` then the marker on the next line — so the idempotency test is a single `startsWith(EVICTED_PLACEHOLDER)`.

### 4.5 Idempotency

A block is "already cleared" iff `content.startsWith(EVICTED_PLACEHOLDER)`. Re-running the pre-pass on a transcript that was already microcompacted:
- finds the old cleared blocks, skips them (no re-clear, no re-spill, no double-count),
- considers only NEW tool_results that have since aged past `keepRecent`,
- if no new candidate clears enough ⇒ `tokensSaved <= floor` ⇒ no-op pass-through.

This makes the pre-pass safe to fire every turn the trigger says to, with cost bounded by a single scan.

### 4.6 Wiring — a CHEAPER FIRST tier in `compaction-wire.ts`

The pre-pass runs **inside `maybeCompact`, BEFORE `compactIfNeeded`** (`compaction-wire.ts:64-105`), guarded by the knob:

```
maybeCompact:
  snapshot = wm.snapshot()
  before   = wm.tokenTotal?.() ?? estimateTokens(snapshot)

  // ── NEW: tier-1 microcompaction (knob ON + time-based trigger due) ──
  if (microcompactGate(env) && microcompactDue(clock)) {
     r = microcompactToolResults({ messages: snapshot, keepRecent, tokensSavedFloor, spill })
     if (r.changed) {
        wm.replace([...r.messages])          // ← flows through the decorator ⇒ counter reseeds (§3.4)
        resetMicrocompactClock(clock)
        emit context_compacted / a microcompact event for observability
        snapshot = wm.snapshot()              // re-read for the tier-2 decision below
        before   = wm.tokenTotal?.() ?? estimateTokens(snapshot)
     }
  }

  // ── existing tier-2: full summarization (now sees the shrunk transcript) ──
  result = (borrowed install) ?? await compactIfNeeded({ messages: snapshot, ... })
  ...
```

Key wiring decisions:
- **`wm.replace(...)`, NOT in-place mutation.** This is the resolution of the §3.4 delta-counter hazard: `replace` re-anchors the counter via `counter.reseed(inner.snapshot())` (`wm-decorator.ts:74-77`), so `tokenTotal()` stays byte-identical to `estimateTokens(snapshot())` after the clear. We DELIBERATELY do NOT edit `wm.messages[i].content` in place (which would bypass the counter and drift). If a future perf need forces in-place editing, the contract is: call `wm.tokenReseed()` immediately after — but `replace` is the simpler, proven path.
- **Tier ordering = cost ordering.** Microcompaction (zero LLM, one scan) runs first; if it frees enough, `compactIfNeeded` then sees a transcript under threshold and no-ops (`currentTokens <= threshold` ⇒ `under_threshold`). The expensive LLM summarization becomes the FALLBACK only when microcompaction alone is insufficient. This is the central ROI: most context pressure is resolved without an LLM call or any reasoning loss.
- **Time-based trigger.** `microcompactDue(clock)` is a min-interval gate (e.g. "at most once per N seconds / N turns") held in the wire, injected clock. The pure core never sees the clock. Plus the implicit `context_hint`: the pre-pass also runs opportunistically when `before` is already near the summarization threshold (the cheap tier is exactly what you want as you approach the cliff). The exact cadence constant is a NAMED config, not a magic literal (memory: no arbitrary thresholds — make it a knob, §4.7).
- **bg-compaction controller interaction.** `bgController.maybeStart(...)` already runs at the end of `maybeCompact` reading `wm.tokenTotal?.() ?? estimateTokens(wm.snapshot())` (`compaction-wire.ts:144-150`). Because the pre-pass installs via `replace` BEFORE that read, the speculative summarizer's `getPrefix` thunk (`() => wm.snapshot()`) and its start-gate see the ALREADY-microcompacted transcript — no double accounting, no stale prefix. The bg controller is strictly downstream and needs no change.

### 4.7 Config (default-OFF, byte-identical)

- `QUANTA_MICROCOMPACT === "1"` ⇒ `runtimeConfig().microcompact: boolean` (default `false`), parsed strict like the other `=== "1"` knobs. OFF ⇒ `maybeCompact` never constructs the pre-pass, never reads the clock, never calls `microcompactToolResults` — the existing tier-2-only flow is **byte-identical** (proven by a "no replace / no spill IO when off" hellgate case + the tool-surface/threshold drift guards).
- `QUANTA_MICROCOMPACT_KEEP_RECENT` ⇒ `keepRecent` (default `3` — keep the last few tool results intact; the recent ones are the live working set the model is reasoning over right now).
- `QUANTA_MICROCOMPACT_FLOOR_TOKENS` ⇒ `tokensSavedFloor` (the saving floor; default chosen to mirror the reactive-squeeze magnitude `REACTIVE_MIN_INPUT_TOKENS = 4_000` — below a few thousand tokens of saving, churning the transcript is not worth it; this is a knob, not a hard-coded heuristic).
- `QUANTA_MICROCOMPACT_INTERVAL_MS` (or a turn-count) ⇒ the time-based cadence in the wire.
- The spill dir / retention reuse the EXISTING `QUANTA_TOOL_OUTPUT_*` knobs (no new on-disk knob — §4.4).

### 4.8 `contentBlocks` (image/document parts) handling

A `ToolResultBlock` may carry `contentBlocks` (image/document parts — `src/llm/types.ts:102-110`). Those are often the HEAVIEST stale payload (a screenshot from 20 turns ago). When clearing an old tool_result, the rebuilt cleared block DROPS `contentBlocks` entirely (the placeholder/spill-ref `content` is its whole body). This is intentional — reclaiming a stale image is a primary win — but the `IMAGE_CHAR_ESTIMATE = 6000` / `DOCUMENT_CHAR_ESTIMATE = 12000` weights (`compaction.ts:63,70`) must be included in the `tokensSaved` estimate so a tool_result whose weight is mostly an image is correctly seen as a big save. (If we kept only the string-length saving we'd under-count and the floor gate could wrongly skip an image-heavy clear.)

---

## 5. 통합

### 5.1 Files

- `src/agent/tool-result-evict/types.ts` — `EVICTED_PLACEHOLDER`, `EvictionSpillPort`, `MicrocompactInput`, `MicrocompactResult`.
- `src/agent/tool-result-evict/evict.ts` — `microcompactToolResults` (the pure pre-pass).
- `src/agent/tool-result-evict/spill-adapter.ts` — default `EvictionSpillPort` wrapping `output-spill.ts#capToolOutput` (the ONLY impure file; injectable writer for tests).
- `src/agent/tool-result-evict/index.ts` — barrel.

### 5.2 Touch (wire only)

- `src/agent/loop/compaction-wire.ts` — the tier-1 pre-pass block in `maybeCompact` (§4.6), behind the knob; inject the clock (the loop already threads one for the bg controller) + the default spill port.
- `src/shared/runtime-config.ts` — add `microcompact` / `microcompactKeepRecent` / `microcompactFloorTokens` / `microcompactIntervalMs` (+ env parse), mirroring the existing `compactTokens` field.
- `src/agent/recovery-reason/types.ts` — the `RecoveryReason` union ALREADY has `"microcompact"` (`types.ts:49`); reuse it for the emitted provenance/event so observability attributes a tier-1 clear distinctly from a tier-2 summarization.
- `biome.json` / arch-scan — fence ratchet for `src/agent/tool-result-evict/**`.
- `tools/feature-catalog/features/04-context-management/…` — new yaml (`maturity: L3` once wired; `config_refs.env: [QUANTA_MICROCOMPACT, QUANTA_MICROCOMPACT_KEEP_RECENT, QUANTA_MICROCOMPACT_FLOOR_TOKENS]`; `depends_on: [persisted-output, quantacompacttokens]`; evidence.code listing the new files + the wire). NOTE: the existing `compaction-visibility.yaml` (ADR-0409) describes the *whole-message-drop* microcompact — keep it; this is a SEPARATE feature (clarify the distinction in both yamls so the catalog doesn't conflate them).

---

## 6. 테스트 계획

### 6.1 Hellgate (adversarial) — `tests/unit/microcompact-evict-hellgate.test.ts`

- **keeps last N intact.** A transcript with 6 tool_results, `keepRecent:3` ⇒ the 3 most-recent tool_results are byte-identical in the output; the 3 oldest have `content === EVICTED_PLACEHOLDER` (or a spill-ref marker).
- **clears older to placeholder.** Each cleared block's `content.startsWith(EVICTED_PLACEHOLDER)`; its `tool_use_id`/`is_error` are preserved; its `contentBlocks` is gone.
- **tokensSaved-floor gate.** When the candidate clears would free `<= floor` tokens ⇒ `changed:false`, the EXACT input array reference returned (no allocation), no spill IO. When `> floor` ⇒ `changed:true` and `tokensSavedEstimate` matches a fresh `estimateTokens(before) - estimateTokens(after)` (the estimate is honest).
- **idempotent.** Run the pre-pass twice; the second run finds the cleared blocks, skips them, and (absent new aged candidates) returns `changed:false` — no double-spill, no double-count, no re-allocation.
- **ORPHAN-SAFE (the headline invariant).** Every `tool_use.id` in the output still has a `tool_result` block with the matching `tool_use_id` — the count and pairing of tool_use/tool_result blocks is IDENTICAL before and after (only bodies shrank). Contrast-test: assert the output passes the same orphan check `findBoundary` enforces, with NO boundary walk performed.
- **original retrievable from spill.** With the default spill adapter (injected in-memory writer), a cleared block's marker points at a path whose persisted content equals the ORIGINAL body byte-for-byte; reading it back round-trips.
- **NO-THROW spill failure.** A `spill.persist` that throws ⇒ the block clears to the bare `EVICTED_PLACEHOLDER`, the pre-pass still succeeds (degraded, not aborted).
- **image-heavy save counted.** A tool_result whose weight is mostly `contentBlocks` (image) is correctly estimated using `IMAGE_CHAR_ESTIMATE`, so the floor gate fires on it.
- **default-OFF byte-identical.** `QUANTA_MICROCOMPACT` unset ⇒ `maybeCompact` produces an IDENTICAL `wm` sequence and touches NO `.quanta/tool-output/` path (the pre-pass is never constructed).

### 6.2 Counter-consistency hellgate — `tests/unit/microcompact-x-token-delta-hellgate.test.ts`

The §3.4 risk, pinned:
- Wrap a `DeltaTokenWorkingMemory` (knob ON), run the pre-pass via the wire (`wm.replace(...)`), then assert `wm.tokenTotal() === estimateTokens(wm.snapshot())` EXACTLY after the eviction — the counter reseeded and did not drift.
- Adversarial: a hand-rolled in-place edit of `wm.messages[i].content` WITHOUT `replace`/`tokenReseed` is asserted to DRIFT (documents WHY the wire must use `replace` — a guard against a future regression that "optimizes" the wire into in-place mutation).

### 6.3 E2E — `tests/integration/microcompact-tier-e2e.test.ts`

- A transcript under the summarization threshold but bloated with old tool dumps ⇒ tier-1 microcompaction fires, frees enough, and `compactIfNeeded` then no-ops (`under_threshold`) — assert ZERO summarizer LLM calls and that the assistant text/decisions are byte-identical (only tool dumps shrank).
- A transcript so large microcompaction alone is insufficient ⇒ tier-1 shrinks it, THEN tier-2 summarization still fires on the remainder (the two tiers compose; the summarizer sees the shrunk prefix).
- Interaction with bg controller: with `QUANTA_BG_COMPACTION` also on, the speculative `getPrefix` snapshot reflects the post-microcompaction transcript (no stale-prefix double-accounting).

---

## 7. 단계

- **Phase 1 — pure pre-pass + spill adapter (default-OFF seam).** `src/agent/tool-result-evict/{types,evict,spill-adapter,index}.ts`, runtime-config knobs, fence ratchet, hellgate §6.1 + §6.2, feature-catalog yaml. NO wire change. Fully tested in isolation (the pure core + the spill adapter against an injected writer).
- **Phase 2 — wire tier-1 in `compaction-wire.ts`.** The `maybeCompact` pre-pass block (§4.6) behind the knob, the time-based cadence gate, the `wm.replace` install + counter reseed, the `microcompact` provenance/event emit, e2e §6.3. This is the only hot-path edit — land it alone and regression-verify the compaction suite (the memory discipline: hot-path wiring is surgery, one knob at a time).
- **Phase 3 (optional) — `context_hint` integration + CLI surface.** Hook the pre-pass to the existing context-change/`context_hint` signal so it fires on demand as well as on cadence; a `/compact --tool-results` or status line showing "N stale tool results cleared, ~Mk tokens reclaimed". Deferred — Phase 1+2 deliver the core value.

---

## 8. 리스크 / 대안 / 비결정

- **Delta-counter drift (THE key risk — §3.4).** The pre-pass shrinks tool_result bodies; the just-landed delta-token counter memoizes `estimateTokens(snapshot())` and only re-anchors on `append`/`replace`/`clear`/`tokenReseed`. **Mitigation pinned in §4.6:** the wire installs the result via `wm.replace([...r.messages])`, which reseeds the counter, keeping `tokenTotal() === estimateTokens(snapshot())` byte-identical. The §6.2 hellgate locks this (including an adversarial "in-place edit drifts" case to fence a future regression). This is the single most important correctness interaction and the reason the wire MUST NOT mutate `wm.messages` in place.
- **Orphan-safety — a WIN, not a risk (§3.3).** Because we clear CONTENT and never remove a block, the `tool_use`↔`tool_result` pairing is structurally preserved with no boundary walk. This is strictly simpler than `findBoundary`'s removal-based backward expansion AND strictly safer than the unwired `createMicroCompactor` (which has no orphan guard). The §6.1 orphan-safe case asserts the pairing is identical before/after.
- **Reasoning-fidelity is the differentiator.** Tier-2 summarization collapses ALL old reasoning into one opaque sentence; tier-1 microcompaction keeps every assistant decision/text verbatim and only nulls stale *tool dumps*. The risk is clearing a tool result the model STILL needs — bounded by `keepRecent` (the live working set stays intact) and by the original being retrievable from spill (the model can `Read` the persisted path if it must). The honest tradeoff: a *cleared-then-needed* old result costs one extra `Read` round-trip; we judge that far cheaper than an LLM summarization call + total reasoning loss.
- **Do NOT extend `createMicroCompactor` (§3.1).** Tempting to reuse the existing `microcompact` slice's name/port. Rejected: it is a fundamentally different algorithm (whole-message drop), it has no orphan guard, and force-fitting content-clearing into its "drop indices" shape would conflate two distinct mechanisms in the catalog and the code. A new sibling slice is the lower-complexity, honest decision. (The existing slice stays — it is a separate, still-unwired option.)
- **`tokensSaved` estimate fidelity.** The estimate uses the SAME `blockChars` accounting as `compaction.ts`/the counter (including `IMAGE_CHAR_ESTIMATE`/`DOCUMENT_CHAR_ESTIMATE` for dropped `contentBlocks`), so it is consistent with the threshold the loop gates on. A mis-estimate only affects the floor gate (fire/skip), never correctness — a too-low estimate skips a beneficial clear (safe), a too-high one fires a clear that frees less than hoped (still safe, still lossless-for-reasoning).
- **Cadence constant.** The time-based interval is a guess; per the no-heuristics discipline it is a knob (`QUANTA_MICROCOMPACT_INTERVAL_MS`), not a hard-coded literal, and the floor gate makes an over-eager cadence harmless (a too-frequent fire just no-ops via the floor). Revisit the default only with measurement.

---

## 9. 코드 위치 요약

**Create:**
- `src/agent/tool-result-evict/types.ts` — `EVICTED_PLACEHOLDER`, `EvictionSpillPort`, `MicrocompactInput`, `MicrocompactResult`.
- `src/agent/tool-result-evict/evict.ts` — `microcompactToolResults` (pure pre-pass: scan → keep last N → skip-cleared → floor-gate → rebuild with cleared bodies).
- `src/agent/tool-result-evict/spill-adapter.ts` — default `EvictionSpillPort` over `output-spill.ts#capToolOutput`.
- `src/agent/tool-result-evict/index.ts` — barrel.
- `tests/unit/microcompact-evict-hellgate.test.ts`, `tests/unit/microcompact-x-token-delta-hellgate.test.ts`, `tests/integration/microcompact-tier-e2e.test.ts`.
- `tools/feature-catalog/features/04-context-management/microcompact-tool-result-evict.yaml`.

**Touch:**
- `src/agent/loop/compaction-wire.ts` — tier-1 pre-pass block in `maybeCompact` (knob-gated, time-based cadence, `wm.replace` install + counter reseed, `microcompact` event emit).
- `src/shared/runtime-config.ts` — `microcompact` / `microcompactKeepRecent` / `microcompactFloorTokens` / `microcompactIntervalMs` (+ env parse).
- `biome.json` + arch-scan — fence ratchet for `src/agent/tool-result-evict/**`.
- `tools/feature-catalog/features/09-integration/compaction-visibility.yaml` — clarify it describes the whole-MESSAGE-drop microcompact (ADR-0409), distinct from this content-clearing tier.

---

## 10. AS-BUILT (jun-06)

Landed exactly to the §4 design. Notes where reality refined the plan:

**Files created (Phase 1):**
- `src/agent/tool-result-evict/types.ts` — `EVICTED_PLACEHOLDER`, `EvictionSpillPort`, `MicrocompactInput`, `MicrocompactResult`.
- `src/agent/tool-result-evict/evict.ts` — `microcompactToolResults` (the pure pre-pass). Forward-scan → keep last N → skip-cleared → floor-gate → rebuild. No `Date.now`/`Math.random`/env/IO except the injected `spill.persist`. `toolResultWeight` mirrors `compaction.ts#blockChars` AND adds `IMAGE_CHAR_ESTIMATE`/`DOCUMENT_CHAR_ESTIMATE` for `contentBlocks` so an image-heavy result clears under the floor (§4.8).
- `src/agent/tool-result-evict/spill-adapter.ts` — default `EvictionSpillPort`. **As-built refinement:** it REUSES the `output-spill.ts` on-disk surface (`.quanta/tool-output/<uuid>.txt` + `pruneSpillDir(keep)` + `QUANTA_TOOL_OUTPUT_SPILL_KEEP`) but emits a COMPACT one-line `<persisted-output path=…>` ref rather than reusing `capToolOutput`'s 8k-head/4k-tail EXCERPT marker — the excerpt would keep ~12k of the original and DEFEAT the shrink for a mid-sized stale dump. The point of eviction is a true shrink; the model still gets the path and can `Read` the full original. NO-THROW: a writer failure throws → the pre-pass degrades to the bare placeholder.
- `src/agent/tool-result-evict/index.ts` — barrel.

**Wire (Phase 2) — `compaction-wire.ts#maybeCompact`:** the `maybeMicrocompact` helper runs BEFORE the bg-controller reconcile and `compactIfNeeded`, behind `runtimeConfig().microcompact` + a per-session min-interval cadence gate (`lastMicrocompactAt` map, injected `Date.now()`). On a change it installs via **`wm.replace([...r.messages])`** and re-reads `snapshot`/`before`, so the bg controller and tier-2 see the shrunk transcript.

**The wm.replace / counter-reseed decision (THE correctness pin, §3.4/§4.6).** The just-landed delta-token counter re-anchors ONLY on `append`/`replace`/`clear`/`tokenReseed`. The wire installs the evicted array via `wm.replace`, which flows through `decorateWithDeltaCounter` and calls `counter.reseed(snapshot())` — so `tokenTotal() === estimateTokens(snapshot())` stays byte-identical after the clear. An in-place `wm.messages[i].content = …` would BYPASS the counter and DRIFT (over-report by the freed chars). The §6.2 hellgate locks BOTH the correct path (replace ⇒ no drift) AND the adversarial in-place edit (⇒ drifts), fencing a future "optimize into in-place mutation" regression.

**Orphan-safety WIN (§3.3).** We clear CONTENT and never remove a block, so every `tool_use`↔`tool_result` pairing is structurally preserved — no boundary walk, no orphan set. The §6.1 orphan-safe case asserts the tool_use/tool_result id sets are IDENTICAL before/after; only bodies shrank.

**Event provenance.** The stream-recovery union (`src/agent/recovery.ts`) has no `"microcompact"` variant; widening it would ripple into the recovery state machine. So the tier-1 emit reuses `recovery:{reason:"compact", detail:"microcompact"}` to attribute the clear distinctly without touching the state machine. (`recovery-reason/types.ts`'s separate `"microcompact"` provenance variant is left for a typed-event follow-up.)

**Config.** `QUANTA_MICROCOMPACT` (`=== "1"`, default OFF) + `QUANTA_MICROCOMPACT_KEEP_RECENT` (3) / `QUANTA_MICROCOMPACT_FLOOR_TOKENS` (4000, mirrors `REACTIVE_MIN_INPUT_TOKENS`) / `QUANTA_MICROCOMPACT_INTERVAL_MS` (30000) — all positive-int knobs with NAMED wire defaults, no magic literals. The spill dir/retention reuse the existing `QUANTA_TOOL_OUTPUT_*` knobs.

**Fence.** No explicit `biome.json` fence block was added — the sibling slices (`token-delta`, `microcompact`) are not individually fenced either; the slice already obeys the import discipline (`@/llm` types, `@/shared`, `@/tool/output-spill`, `node:*` only — no loop/permission/dispatch).

**Tests (red→green).** `tests/unit/microcompaction-evict-hellgate.test.ts` (10, §6.1: keep-last-N / clear-to-placeholder / floor-gate same-ref-no-IO / idempotent / orphan-safe / spill round-trip / NO-THROW / image-heavy / default-adapter writer), `tests/unit/microcompaction-x-token-delta-hellgate.test.ts` (3, §6.2: replace ⇒ no drift, adversarial in-place ⇒ drifts, tokenReseed self-heals), `tests/integration/microcompaction-tier-e2e.test.ts` (2, §6.3: REAL `runAgent` knob-ON clears old dumps with ZERO summarizer calls + reasoning verbatim; knob-OFF byte-identical no-clear/no-event). 15 tests, 0 fail.
