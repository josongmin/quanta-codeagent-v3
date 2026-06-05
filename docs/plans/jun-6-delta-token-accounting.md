# RFC — delta token accounting (incremental context estimate, not full re-scan per turn)

- Status: DRAFT (design only — no source changed by this RFC)
- Date: 2026-06-06
- Axis: `@/agent` loop context-token accounting (the `estimateTokens` re-scan)
- Default-OFF, byte-identical when the knob is unset (the loop keeps calling the existing
  full-transcript `estimateTokens` at every site).
- ROI: **LOW–MEDIUM** — the re-scan is O(total transcript chars) and runs multiple times
  per turn; on very long sessions it is a measurable but not dominant CPU cost. The win is
  bounded — `estimateTokens` is cheap per char, so the payoff is real only at large
  transcripts. Honest: not a hot-path crisis, a tidiness/scaling improvement.

---

## 1. 요약 (Summary)

The loop estimates the conversation's context-token footprint by re-scanning the ENTIRE
working-memory transcript through `estimateTokens(messages)` — a `Math.ceil(chars/4)` walk
over every block of every message (`compaction.ts:39-47`). This full re-scan runs at MULTIPLE
points per turn: the compaction pre-check (`loop.ts:960`), the speculative-summarize re-arm
(`loop.ts:1164`), the post-compaction measurement (`loop.ts:1107`), the microcompact path
(`microcompact/compactor.ts:103, 178, 198`), and the compaction internals
(`compaction.ts:393-394, 435, 475, 511`). Each call is O(total transcript size), so a long
session re-walks the whole history several times every turn — even though, between turns,
only a SMALL tail changed (the new user/assistant/tool messages appended this turn).

This RFC adds an OPTIONAL **delta token counter**: a tiny accumulator that tracks the
estimated token total incrementally — add the estimate of newly-appended messages, subtract
the estimate of messages removed by compaction — so the loop reads `counter.total()` (O(1))
instead of re-scanning (O(n)). The counter is seeded from the SAME `estimateTokens` so its
arithmetic is byte-identical to the full re-scan; it is purely a memoization of a pure
function over an append-mostly structure. Default-OFF: with the knob unset the loop keeps
calling `estimateTokens` directly, byte-identical. This is the project's "no new heuristic"
rule honored exactly — the divisor, the per-block char count, the image/PDF estimates are
ALL reused, not re-invented.

---

## 2. 경쟁사 레퍼런스 (Competitor reference)

근거: 백로그 기술. Long-running agent loops (Codex/Claude Code) track a running context-token
figure incrementally rather than re-tokenizing the whole transcript every turn — the
transcript is append-mostly, so a delta is the natural representation. No competitor's exact
counter shape is verified here; the design is grounded in quanta's own `estimateTokens` to
keep arithmetic identical (so this is a structural/perf absorption, not a behavior import).

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

### 3.1 `estimateTokens` is a full O(n) re-scan

`estimateTokens(messages: Message[])` (`compaction.ts:39-47`): nested loop over every
message → every content block → `blockChars(b)`, summed, `Math.ceil(chars/4)`. Pure, no
state. It does NOT memoize; each call re-walks the whole array. Image (`IMAGE_CHAR_ESTIMATE
= 6000`, `:54`) and PDF estimates are folded in per-block.

### 3.2 It runs MANY times per turn over the WHOLE transcript

`grep -rn "estimateTokens(" src` (excluding tests/`.js`) — the per-turn callers over the
full snapshot:
- `loop.ts:960` — `const before = estimateTokens(snapshot)` (compaction pre-check; `snapshot
  = [...wm.snapshot()]`, the WHOLE working memory).
- `loop.ts:1107` — `const after = estimateTokens(result.messages)` (post-compaction).
- `loop.ts:1164` — `estimateTokens([...wm.snapshot()])` (speculative re-arm — full snapshot
  AGAIN, same turn as :960).
- `loop.ts:1622, 1629` — another before/after pair on the bg-compaction path.
- `microcompact/compactor.ts:103, 178, 198` — `estimateTokens(input.messages ?? [])` (with a
  `tokenEstimate ?? …` fallback — already a partial memo seam, see §3.4).
- `compaction.ts:393-394, 435, 475, 489, 511, 642` — compaction-internal measurements.
So a single long turn can re-scan the full transcript 4–6×. On an N-message session each scan
is O(N·avg-blocks·avg-chars).

### 3.3 The transcript is append-mostly (delta-friendly)

Working memory grows by APPENDING this turn's user message + assistant message + tool
results, and shrinks ONLY at compaction (which replaces a prefix with a summary,
`compaction.ts:393-417`). Between turns the change is a small tail. So the full re-scan
re-computes a number that moved by a small, knowable delta — the classic memoization case.

### 3.4 A partial memo seam already exists (microcompact)

`compactor.ts:103` uses `input.tokenEstimate ?? estimateTokens(input.messages ?? [])` —
i.e. it ALREADY accepts a precomputed estimate and only falls back to a scan. This proves the
"pass the number in instead of re-scanning" pattern is already accepted in the codebase; the
delta counter is the producer of that `tokenEstimate`.

---

## 4. 설계 (Design)

### 4.1 A pure delta accumulator seeded from `estimateTokens`

```ts
// src/agent/token-delta/counter.ts — pure, imports only estimateTokens + Message
export interface TokenDeltaCounter {
  total(): number                                   // O(1) — the running estimate
  onAppend(added: readonly Message[]): void         // += estimateTokens(added)
  onRemove(removed: readonly Message[]): void       // -= estimateTokens(removed)
  reseed(messages: readonly Message[]): void        // = estimateTokens(messages) (compaction/fork)
}
export const createTokenDeltaCounter = (initial: readonly Message[]): TokenDeltaCounter => {
  let total = estimateTokens([...initial])          // SAME function ⇒ identical arithmetic
  return {
    total: () => total,
    onAppend: (a) => { total += estimateTokens([...a]) },
    onRemove: (r) => { total = Math.max(0, total - estimateTokens([...r])) },
    reseed:   (m) => { total = estimateTokens([...m]) },
  }
}
```

- **Arithmetic identity**: `total` is ALWAYS the sum of `estimateTokens` over the same
  messages a full re-scan would see — because `estimateTokens` is a pure sum over independent
  per-block char counts, `estimateTokens(A ++ B) === estimateTokens(A) + estimateTokens(B)`
  is EXACT (no rounding drift: `Math.ceil(chars/4)` is applied once at the leaf?). **Audit
  note (load-bearing):** `estimateTokens` applies `Math.ceil` ONCE at the end over the TOTAL
  char count (`compaction.ts:46`), not per-message. So naive `onAppend(estimateTokens(added))`
  could differ by ≤1 token from a single full-scan ceil (ceil of a sum ≠ sum of ceils). The
  counter therefore tracks the **char total**, applying `ceil(chars/4)` only in `total()`
  — making it BYTE-IDENTICAL to a full `estimateTokens`. (A `charsOf(messages)` helper is
  extracted from `estimateTokens` so both share the pre-ceil sum; see §9.)

### 4.2 `reseed` at the only non-append events (compaction / fork)

Compaction replaces a prefix with a summary (`compaction.ts:393-417`) and microcompact drops
a span (`compactor.ts:198`). At those exact points the loop calls `counter.reseed(result.messages)`
— a single full re-scan, which is unavoidable and CORRECT (the transcript changed
non-trivially). Between compactions, every per-turn read is O(1) `total()`. So the full scan
runs ONCE per compaction instead of 4–6× per turn.

### 4.3 Threading: the counter PRODUCES the number the call sites already want

Each `estimateTokens([...wm.snapshot()])` site becomes `counter.total()` WHEN the knob is on:
- `loop.ts:960` `before` ← `counter.total()`;
- `loop.ts:1164` re-arm ← `counter.total()` (the same value computed at :960 — currently
  re-scanned twice, now read twice for free);
- microcompact already accepts `tokenEstimate` (`compactor.ts:103`) — pass `counter.total()`;
- post-compaction `after`/`reseed` updates the counter.
The counter is updated wherever `wm` is mutated: `onAppend` after appending this turn's
messages, `reseed` after a compaction installs a new transcript. Working memory mutation is
already centralized (the `wm.snapshot()` accessor), so the update sites are few and known.

### 4.4 Default-OFF = direct `estimateTokens` (byte-identical)

When the knob is unset, the loop does NOT construct the counter and calls `estimateTokens`
directly at every site exactly as today — zero behavior change, zero new allocation. The
counter is an OPT-IN memoization, never a required dependency.

### 4.5 No clock, no randomness, no env in the slice

The counter is a pure arithmetic accumulator over `Message[]` — no `Date.now()`, no
`Math.random()`, no `process.env` (the no-sketchy-code scanner bans these outside
runtime-config). The knob is resolved at the composition root and passed as a boolean.

---

## 5. 통합 (Integration)

### 5.1 Knob (default-OFF, byte-identical)

- `QUANTA_DELTA_TOKEN_COUNT` (`runtime-config.ts` beside `mcpSampling`, `:606-611`). Unset ⇒
  the counter is not constructed; the loop calls `estimateTokens(...)` directly at every site
  ⇒ **byte-identical** (and the produced numbers are identical even ON, by §4.1 — the knob
  guards CONSTRUCTION/perf, not arithmetic).
- No tool, no manifest row (an internal accounting optimization).

### 5.2 Feature catalog (fc)

`delta-token-accounting.yaml` under the context-management subsystem:
`depends_on: [compaction-estimate]`, `labels: ["perf", "scaling"]`, `status: planned`.

### 5.3 Slice / fence

- New `src/agent/token-delta/` slice: `counter.ts` (pure). Imports only
  `@/agent/compaction`'s `charsOf`/`estimateTokens` + `@/llm`'s `Message` type — same import
  posture as `usage-breakdown.ts`, which already injects `estimateTokens` as a closed port
  (`context/usage-breakdown.ts:31, 74`). No new external dep.
- `src/agent/compaction.ts` — extract `charsOf(messages): number` (the pre-ceil sum) from
  `estimateTokens` so the counter shares the EXACT char arithmetic (§4.1). `estimateTokens`
  becomes `Math.ceil(charsOf(m)/4)` — itself byte-identical.
- `src/agent/loop.ts` — gated: construct the counter, call `onAppend`/`reseed` at the wm
  mutation points, read `total()` at the estimate sites (behind the knob).

---

## 6. 테스트 계획 (Test plan)

### 6.1 Hellgate (adversarial, pure — the identity is the whole point)

- **delta == full-scan (the load-bearing invariant):** for 500 randomized
  append/remove/reseed sequences, assert `counter.total()` EXACTLY equals
  `estimateTokens(currentMessages)` at every step — including the ceil-of-sum vs sum-of-ceils
  edge (§4.1): build sequences where per-message char counts are NOT multiples of 4, and
  assert NO ±1 drift (this is what the `charsOf` extraction guarantees).
- **remove never goes negative:** `onRemove` of more than present ⇒ `total()` clamps to 0
  (and a reseed restores truth) — a corrupt-state guard.
- **reseed = full recompute:** after `reseed(m)`, `total() === estimateTokens(m)`.
- **image/PDF blocks:** sequences including image (`IMAGE_CHAR_ESTIMATE`) and document blocks
  ⇒ delta still equals full-scan (the per-block estimates are inside the shared `charsOf`).
- **default-OFF byte-identical:** with the knob unset, the loop's compaction decisions and
  the recorded token figures are bit-identical to a run with the counter never constructed
  (drive the same fixture both ways; assert identical compaction trigger points + recorded
  `before`/`after`).

### 6.2 e2e / differential

A long-transcript fixture (many turns) run BOTH ways (counter on / off) must produce
identical compaction events, identical speculative-summarize re-arms, and identical
recorded token numbers — proving the optimization is observationally invisible except for
CPU. (Optionally assert `estimateTokens` is invoked O(compactions) times with the counter on
vs O(turns·sites) times off — the perf claim, measured not assumed.)

---

## 7. 단계 (Phasing)

- **Phase 1 — counter + the two hottest read sites (this RFC).** `charsOf` extraction, the
  pure counter, gated wiring at `loop.ts:960/1164` (the same-turn double scan) and the
  microcompact `tokenEstimate` producer. Default-OFF. Shippable; the identity hellgate is
  the gate.
- **Phase 2 — cover the bg-compaction + compaction-internal sites** (`loop.ts:1622/1629`,
  `compaction.ts` internals) once Phase 1 proves the identity holds in production.
- **Phase 3 — authoritative reconciliation.** When a provider `usage` event arrives with the
  real prompt token count, optionally reseed the counter to the provider truth (the estimate
  is chars/4; the provider count is exact) — turning the delta counter into a
  provider-anchored running figure. Opt-in, since it changes the number from "estimate" to
  "last-known-authoritative + delta."

---

## 8. 리스크 / 대안 (Risks / alternatives)

- **Arithmetic drift is the ONLY real risk — and it is designed out.** A naive delta of
  `Math.ceil`-per-message would drift ±1 from the single end-ceil that `estimateTokens` does
  (`compaction.ts:46`). The `charsOf` extraction (§4.1, §5.3) makes the counter track the
  pre-ceil CHAR total and apply `ceil` only in `total()`, so it is provably byte-identical to
  a full scan. The 500-case identity hellgate (§6.1) is the enforcement. This is the load-
  bearing correctness argument — without it, a "perf" change would silently shift compaction
  thresholds.
- **Stale counter after an un-tracked mutation.** If some code path mutates working memory
  without calling `onAppend`/`reseed`, the counter drifts. Mitigation: wm mutation is
  centralized behind the snapshot accessor (§4.3); a Phase-1 belt-and-suspenders is a
  periodic `reseed` (e.g. at each compaction boundary, which already calls `reseed`) so any
  drift self-heals within one compaction cycle. Default-OFF also means a bug can't affect the
  shipped path.
- **ROI is modest.** `estimateTokens` is cheap per char, so the win is real only at large
  transcripts (where it scans megabytes 4–6× per turn). For short sessions the saving is
  negligible. Honest: this is a scaling tidy-up, not a hot-path emergency — hence default-OFF
  and a measured perf claim (§6.2), not an assumed one. Cost is low (one pure slice).
- **Alternative — just call `estimateTokens` fewer times.** A simpler win: compute `before`
  ONCE per turn and reuse it at `:960` and `:1164` (which currently both re-scan the same
  snapshot). That is a strict subset of this RFC and could ship first as a zero-risk
  micro-fix; the counter generalizes it across compaction. (Documented as the cheap partial.)
- **Alternative — a real tokenizer.** Out of scope and explicitly against the project rule
  (no new heuristic / `tiktoken` is wrong for Claude per the claude-api skill). The counter
  reuses the EXISTING chars/4 convention; it does not change the estimator.

---

## 9. 코드 위치 요약 (Code-location summary)

**Create:**
- `src/agent/token-delta/counter.ts` — `TokenDeltaCounter` / `createTokenDeltaCounter`
  (pure; reuses `charsOf`/`estimateTokens`).
- `…/__tests__/token-delta.hellgate.test.ts` — the 500-case delta==full-scan identity (§6).
- `tools/feature-catalog/…/delta-token-accounting.yaml`.

**Touch:**
- `src/agent/compaction.ts:39-47` — extract `charsOf(messages): number`; `estimateTokens`
  becomes `Math.ceil(charsOf(m)/4)` (byte-identical).
- `src/agent/loop.ts:960, 1107, 1164` (Phase 1; `1622, 1629` Phase 2) — gated
  `counter.total()` reads + `onAppend`/`reseed` at the wm mutation points.
- `src/agent/microcompact/compactor.ts:103, 178, 198` — feed `counter.total()` into the
  existing `tokenEstimate ?? …` seam.
- `src/shared/runtime-config.ts:606-611` — `QUANTA_DELTA_TOKEN_COUNT` flag.

**Read-only (referenced):**
- `src/agent/compaction.ts:39-47, 393-417` — the estimator + the compaction (reseed point).
- `src/agent/context/usage-breakdown.ts:31, 74` — the `estimateTokens`-as-injected-port
  precedent.
