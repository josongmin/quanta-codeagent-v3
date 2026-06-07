# ADR-0498: model-based fast-apply MERGE rung (apply-model elision merge)

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - `src/agent/fast-apply-fallback/types.ts` (`FastApplyPort` + `FastApplyMergeResult` + `FastApplyMergeDeps`, sibling to the re-emit port)
  - `src/agent/fast-apply-fallback/merge-runner.ts` (`createFastApplyMerge` + `buildMergePrompt` + `extractMergedFile` + `verifyMergeStructural`)
  - `src/agent/fast-apply-fallback/index.ts` (barrel export)
  - `src/tool/types.ts` (`FastApplyMergeSeam` duck-typed mirror + `ToolContext.fastApplyMerge?` slot)
  - `src/tool/edit/index.ts` (the OPTIONAL merge rung, inserted after fuzzy / before the typed mismatch)
  - Knobs: `QUANTA_FAST_APPLY_MERGE` (gateOnStrict) + `QUANTA_FAST_APPLY_MODEL` (`runtimeConfig().fastApplyMerge` / `.fastApplyModel`)
  - Tests: `tests/unit/fast-apply-merge-runner-hellgate.test.ts`, `tests/unit/edit-fast-apply-merge-rung-hellgate.test.ts`
  - Absorbs: Cursor 3.5.33 apply-model (`use_fast_apply` / `FastApplyModelType` REWRITE flavor, `// ... existing code ...` IO shape) — see `docs/tickets/misc-jun-7/06-model-based-fast-apply.md`
  - Sibling-of: ADR-0417 / ADR-0421 (the V4A re-emit fallback — a DIFFERENT mechanism)

## Context

When an `edit` fails to anchor (`applyExactEdit` then `applyFuzzyEdit` both miss) quanta returns a typed
mismatch to the model for a re-read/retry, and `apply_patch` falls back to a full V4A patch re-emit
(ADR-0417). The re-emit ships the prior patch + the whole current file and asks the model to author a fresh
byte-precise diff that must ITSELF re-anchor — token-expensive, still error-prone, worst on large files.

Cursor's answer is a DEDICATED apply model: it takes the original file + a terse/lazy edit sketch
(`// ... existing code ...` elisions) and returns the MERGED full file directly — no second diff anchoring.
quanta had a re-emit seam but NO model-merge implementation. (Verified jun-07: `Morph`/`Relace`/
`FastApplyModel`/`mergeFile` grep 0 in `src/`.)

## Decision

A NEW closed `FastApplyPort` (merge direction) sibling to the existing re-emit `FastApplyFallbackPort`,
inserted as an OPTIONAL rung in the `edit` ladder: `exact → fuzzy → [model MERGE] → typed mismatch`. The
rung is reached ONLY when the deterministic exact/fuzzy ladder misses AND `ctx.fastApplyMerge` is wired.

- **Provider seam, not a hosted vendor** (Open-Q §9.1 resolved: own-seam first). The apply model reuses
  quanta's existing `@/llm` provider seam + side-conversation dispatcher, resolved under a NEW `"apply"`
  role from the operator-set `QUANTA_FAST_APPLY_MODEL` — NEVER the main agent model (that defeats the cost
  win). No new egress endpoint / vendor dep. A hosted Morph/Relace adapter is deferred (its own future knob).
- **Derive the sketch, don't change the output contract** (Open-Q §9.5: DERIVE). v1 builds the terse
  `// ... existing code ...` sketch from the already-failed `old_string`/`new_string`. The main model's
  output contract is unchanged. (Native terse-sketch emission is a larger follow-up, out of scope.)
- **After fuzzy, before the typed mismatch** (Open-Q §9.4: after-fuzzy). Only spend a model call once the
  free deterministic rungs miss.
- **The merge is a PROPOSAL, never a blind write** (the load-bearing safety property). Two-layer verification:
  (1) runner-level STRUCTURAL check (non-empty, changed-vs-original, no leftover elision marker, complete
  fenced block); (2) edit-scoped bounded check in the tool (must contain `new_string`, must not still
  contain `old_string` unless `new_string` legitimately re-introduces it, must differ from original). The
  accepted merge then flows through the SAME gated commit + `ToolDiffSink` path as any edit — there is NO
  code path that writes a merged file without verification + the normal gate.
- **NO-THROW / fail-closed**: a role-resolve throw, dispatch throw, non-ok reply, empty/truncated reply, or
  any verification miss ⇒ `{ ok:false, merged:null, rationale }` ⇒ the ladder falls through to the existing
  byte-identical typed mismatch (and `apply_patch`'s re-emit remains the terminal patch fallback).

## Default posture

OFF, byte-identical. `QUANTA_FAST_APPLY_MERGE` is `gateOnStrict` (`=== "1"`) AND a `QUANTA_FAST_APPLY_MODEL`
must be set (advertise-iff-able) for the port to be constructed. Absent either ⇒ `ctx.fastApplyMerge` is
undefined ⇒ `tryFastApplyMergeRung` is a single `undefined` check that returns `null` ⇒ the edit ladder is
the byte-identical `exact → fuzzy → typed mismatch` with ZERO apply-model dispatch. Distinct from the
existing `QUANTA_FAST_APPLY` (the V4A re-emit rung) — the two knobs are independent.

## Consequences

- Faster + cheaper recovery on failed applies; fewer applies that fail outright (the apply model resolves
  elisions the deterministic ladder cannot). Honest caveat: the merge rung adds one extra model call, so net
  token cost is a WIN only when the apply model is cheaper than a full re-emit of the same edit — clearest on
  LARGE files. On small files the re-emit was already cheap; the rung is OFF-by-default and after-fuzzy, so
  it never spends on edits that already landed.
- A model merge can hallucinate / drop content — mitigated STRUCTURALLY (verified proposal behind the normal
  edit gate), not hopefully. The red-on-injection hellgate asserts a broken/hallucinated/injecting merge is
  REJECTED and NEVER written.
- Out of scope for v1 (noted for honesty): speculative-decoding parity (`NOSPEC`), hosted apply APIs, and
  native terse-sketch emission (which would let the merge run on the FIRST attempt, Cursor's actual flow).
  No model default is pinned (`no-heuristics-only-validated`): the apply model is operator-set and must be
  measured against the re-emit baseline.
