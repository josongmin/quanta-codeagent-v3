# Ticket — model-based fast-apply (apply-model merge rung)

**Date:** 2026-06-07
**Status:** Design (NOT implementation). This ticket proposes seams; it ships no code.
**Gap:** `docs/backlog/jun-7-gap-other-agent.md` §5.1 — `[ACTUAL-GAP] Model-based fast-apply 없음` (verified jun-07 src grep: `Morph`/`Relace`/`FastApplyModel`/`fast_apply_model` grep **0** in `src/`; the existing `FastApplyFallbackSeam` is a V4A-patch re-emit, a DIFFERENT mechanism).
**Slice:** `@/tool` edit-apply ladder (`src/tool/edit/`, `src/tool/apply-patch.ts`) + a **new closed `FastApplyPort`** declared in `@/agent/fast-apply-fallback` (sibling to the existing `FastApplyFallbackPort`) and mirrored into `@/tool/types` exactly like `FastApplyFallbackSeam` is today. Implemented over the EXISTING dual-provider LLM seam (`@/llm` `RoleModelResolver` + the side-conversation dispatcher) — NO new slice, NO Morph/Relace dependency.
**Candidate ADR:** next free (≥ 0497) — `docs/decisions/` is occupied through `0496`.
**Default posture:** OFF, byte-identical. The seam exists, but **absent the knob AND a configured apply-model, the fallback ladder is EXACTLY today's `exact → fuzzy → V4A re-emit`**, byte-for-byte. The model-apply is an OPTIONAL rung inserted into the ladder only when `QUANTA_FAST_APPLY_MERGE=on` AND `QUANTA_FAST_APPLY_MODEL` names a model. No knob ⇒ no `FastApplyPort` constructed, zero provider calls, the existing ladder unchanged. This is ADDITIVE: a new rung on a new optional port, never a replacement of the current path.
**Competitor source:** Cursor 3.5.33 (`.extracted_source/cursor/extensions/cursor-agent-exec/dist/main.js`).
**ROI:** cost 중, impact 중 — faster + cheaper large-file edits, fewer failed applies; net token cost depends on the apply-model being cheaper than a full re-emit (honest caveat, §8). Reuses the existing provider seam, so the integration cost is wiring + verification, not a new vendor.

---

## 1. Problem

When an `edit` fails to anchor (`applyExactEdit` then `applyFuzzyEdit` both miss — `src/tool/edit/index.ts:150-153`) or an `apply_patch` V4A block fails (`src/tool/apply-patch.ts:402-418`), quanta's recovery is to **re-emit a full V4A patch** through a side-conversation (`src/agent/fast-apply-fallback/runner.ts:40-64` `buildFastApplyPrompt` — "Re-emit the following change as a single V4A patch"). That re-emit:

- is **token-expensive** — it ships the prior patch + the full current file content (`runner.ts:53-58`) and asks the model to author a fresh, byte-precise V4A diff;
- is **still error-prone** — the re-emitted patch must itself anchor against the live file (`*** Begin Patch` … `*** End Patch` extraction at `runner.ts:28-35`, then re-parse + re-apply at `apply-patch.ts:tryFastApplyFallback`), so a re-emit can fail the same anchoring it was meant to fix;
- scales **worst on large files** — the file goes into the prompt and the model must reproduce a precise patch against it.

Cursor's answer is a **dedicated apply-model**: a specialized fast model that takes the original file + a terse/lazy edit sketch (`// ... existing code ...` elisions) and produces the **merged full file** directly — no second round of diff anchoring. This is the mechanism behind "Apply" being near-instant in Cursor. quanta has a seam shaped for re-emit but **no model-merge implementation**, so it always falls back to full re-emit.

---

## 2. Current state (src-verified)

**The existing seam is a re-emit, not a merge.**
- `FastApplyFallbackSeam` — `src/tool/types.ts:556-565`. Exact current shape:
  ```ts
  export interface FastApplyFallbackSeam {
    attempt(
      input: {
        failure: FastApplyFailureMirror   // { patch, errorKind, errorMessage }
        sourceFile?: string
        sourceContent?: string
      },
      signal?: AbortSignal,
    ): Promise<FastApplyAttemptResultMirror>   // { ok, newPatch: string|null, rationale, modelUsed? }
  }
  ```
  Input is a **failed V4A patch + reason**; output is a **`newPatch` string** (another V4A block). It is a *patch re-emitter*, not a file merger. The `@/tool` copy is a duck-typed mirror of the producer `FastApplyFallbackPort` in `src/agent/fast-apply-fallback/types.ts:59-64` (RFC §3.1 slice isolation; the mirror comment is at `types.ts:530-537`).

**The producer.** `createFastApplyFallback` (`src/agent/fast-apply-fallback/runner.ts:66-127`) resolves an `executor` role model (`roleResolver.resolve("executor", defaultModel)`), dispatches `buildFastApplyPrompt(...)` through a `SideConversationLike`, and extracts a `*** Begin Patch … *** End Patch` block (`extractPatchBlock`, `runner.ts:28-35`). Every dep failure collapses to `{ ok:false, newPatch:null }` (NO-THROW). The prompt is V4A-centric (`runner.ts:46-63`).

**The edit-apply ladder today (the baseline this ticket extends):**
1. `edit` tool — `planEdit` (`src/tool/edit/index.ts:119-170`): `applyExactEdit` (`:150`) → if `input.fuzzy`, `applyFuzzyEdit` (`:151-153`) → on miss, `buildMismatchResult` returns a typed `not-found`/`ambiguous`/`fuzzy-no-confident` failure (`:154-164`, `src/tool/edit/strategy-hint.ts`). The edit tool itself **does not** invoke the fast-apply fallback — it returns the mismatch to the model, which re-reads and retries (or escalates to `apply_patch`).
2. `apply_patch` tool — `src/tool/apply-patch.ts:384-418`: if `ctx.fastApplyFallback === undefined` (default) ⇒ parse+apply once, throw on failure, **byte-identical pre-ADR-0421** (`:387-395`). If wired ⇒ on a recoverable V4A failure, `tryFastApplyFallback` makes ONE re-emit attempt + retry (`:402-418`); a non-rescue path re-throws the ORIGINAL error.
3. The re-emit is the **terminal rung** of the apply ladder: `exact → fuzzy → [V4A re-emit]`.

**Wiring of the existing rung (already gated).** `src/agent/optional-ports.ts:85-110`: a `QUANTA_FAST_APPLY` env gate (`QUANTA_FAST_APPLY_ENV = "QUANTA_FAST_APPLY"`, `:14`) wires `createFastApplyFallback` onto `AgentConfig.fastApplyFallback`, which `dispatch.ts:756-757` threads into `ToolContext.fastApplyFallback` (`types.ts:244-246`). **OFF ⇒ unwired ⇒ no fallback, no provider call.** Note: the name `QUANTA_FAST_APPLY` is **already taken** by the re-emit rung — the new merge rung needs distinct knobs (§6).

**Absent (verified):** `Morph` / `Relace` / `FastApplyModel` / `fast_apply_model` / `mergeFile` / `apply-model` grep **0** in `src/`. There is no `apply(original, editSketch) → merged` port; the only model-backed recovery is the V4A re-emit above.

**fc catalog:** existing entries `tools/feature-catalog/features/09-integration/fast-apply-fallback.yaml` + `fast-apply-wire.yaml` cover the re-emit rung. The new merge rung needs its own entry.

---

## 3. Competitor mechanism (verified — `cursor-agent-exec/dist/main.js`, Cursor 3.5.33)

Cursor's apply is a **separate model call that merges a terse edit into the full file**, NOT a diff re-anchor. Ground truth from the protobuf field/enum definitions:

**It is a first-class, typed request field.** The slash-edit / apply request carries:
- `use_fast_apply` — scalar bool, field `no:19`.
- `fast_apply_model_type` — enum, field `no:20`.
- a `fast_apply` message — field `no:9`.
- `FastApplySource` enum: `FAST_APPLY_SOURCE_UNSPECIFIED` / `_CLICKED_APPLY` / `_COMPOSER` / `_CACHED_APPLY` / `_COMPOSER_AGENT` — i.e. apply is invoked both from manual UI ("Apply" button) AND from the agent loop (`COMPOSER_AGENT`).

**It is a DEDICATED model, separate from the main agent model.** The `FastApplyModelType` enum enumerates apply-specialized models, distinct from the chat model:
> `FAST_APPLY_MODEL_TYPE_DEFAULT`, `_DEEPSEEK`, `_SONNET`, `_OPUS_DIFF`, `_SMART_REWRITE`, `_GPT4_NOSPEC`, `_SMART_REWRITE_NOSPEC`, `_OPUS`, `_HAIKU`, `_GPT4O_DIFF`, `_CODESTRAL_REWRITE`, `_DEEPSEEK_33B`, `_SONNET_35_DIFF`, `_SONNET_35_REWRITE`, `_PROMPTED_DEEPSEEK_V2`, `_CODESTRAL_REWRITE_OLD`/`_FP16`, `_DEEPSEEK_33B_V2`, `_CODESTRAL_V4`…`_V7` (verbatim from the enum field list).

Two signals worth lifting:
- **`DIFF` vs `REWRITE` variants** (e.g. `OPUS_DIFF` vs `SONNET_35_REWRITE`): the apply model is configured to emit either a diff or a full rewrite. The "rewrite" flavor is the merged-full-file mode this ticket targets.
- **`NOSPEC` variants** (`GPT4_NOSPEC`, `SMART_REWRITE_NOSPEC`): a "no speculative-decoding" flavor — Cursor uses **speculative decoding** to make apply near-instant (the original file is the speculation prior). Out of scope for v1 (we have no spec-decode control over our provider); noted for honesty.

**The IO shape (the edit sketch).** The terse edit the apply model consumes is the lazy/elided format the MAIN model is prompted to emit (verbatim, from the agent's citation/edit instructions in the same bundle):
> ` ```startLine:endLine:filepath`
> `// ... existing code ...`
> ` ``` `
> "Do not add anything besides the startLine:endLine:filepath (no language tag, line numbers)"; "Code blocks should contain the code content from the file"; example ` ```12:14:app/components/Todo.tsx\n// ... existing code ...\n``` `.

So the contract is: **main model emits a terse edit with `// ... existing code ...` elisions → apply model receives `{original file, terse edit}` → returns the merged full file.** The apply model is the one that resolves the elisions against the original — the main model never re-types the unchanged regions. (No literal `Morph`/`Relace` vendor string in this bundle — Cursor self-hosts the apply models in the enum above; the public "Morph/Relace style" naming in the gap doc refers to the *category* of hosted apply-model services, not a string we can cite here.)

---

## 4. Design

A new closed `FastApplyPort` for the **merge** direction, sitting alongside (not replacing) the existing re-emit port, inserted as an OPTIONAL rung in the apply ladder. Default-OFF byte-identical.

### 4.a The port (closed, NO-THROW, provider-agnostic)

New in `src/agent/fast-apply-fallback/` (the slice already owns the V4A re-emit; the merge port is its sibling):

```ts
/** Merge a terse/lazy edit sketch into the full original file via a dedicated
 *  apply model. NO-THROW: every dep/verification failure ⇒ { ok:false }. */
export interface FastApplyMergeResult {
  readonly ok: boolean
  readonly merged: string | null          // null on failure
  readonly rationale: string              // always nonempty
  readonly modelUsed?: string
}
export interface FastApplyPort {
  apply(
    input: { original: string; editSketch: string; path?: string },
    signal?: AbortSignal,
  ): Promise<FastApplyMergeResult>
}
```

- **Implemented over the EXISTING LLM provider seam.** Reuse `RoleModelResolver` + the side-conversation dispatcher already plumbed for the re-emit rung (`optional-ports.ts:96-110`). The apply model is **operator-configurable** via `QUANTA_FAST_APPLY_MODEL` (e.g. a small/cheap model id the provider exposes). Resolve it as a new role (`"apply"`) or directly from the knob; do NOT default it to the main agent model (that defeats the cost win — §8). **No Morph/Relace dependency** unless the user explicitly wants a hosted apply API (Open Q §9).
- **Prompt = `{original, editSketch}` → merged file.** Mirror Cursor's contract: name the elision convention (`// ... existing code ...`), hand the model the original verbatim + the terse edit, ask for the FULL merged file (REWRITE flavor) as the only output. Deterministic decode: temperature 0 / greedy where the provider supports it.
- **NO-THROW at the boundary** (parity with `runner.ts`): role-resolve throw, dispatch throw, empty reply, verification failure ⇒ `{ ok:false, merged:null, rationale }`.

### 4.b Ladder insertion (one new rung, conditional)

The apply ladder becomes:
```
exact → fuzzy → [fast-apply MERGE, if enabled+configured+verified] → V4A re-emit (existing)
```
- The merge rung sits **before** the V4A re-emit (so the cheaper/faster merge is tried first; re-emit stays the terminal fallback). Whether it sits before or after fuzzy is an Open Question (§9) — default proposal: **after fuzzy, before re-emit** (only spend a model call once the deterministic exact/fuzzy ladder has missed).
- **Where it hooks.** Two candidate hook points (decide in design review, §9):
  - `apply_patch` path — the natural home (it already has the fallback control flow at `apply-patch.ts:398-418` and a wired port slot). The V4A failure → instead of (or before) re-emit, feed `{original=current file bytes, editSketch=the failed patch reinterpreted as a terse edit}` to the merge port. Requires deriving a terse edit from the failed patch (or carrying the model's original terse edit).
  - `edit` tool path — when exact+fuzzy miss (`edit/index.ts:154`), feed `{original=source, editSketch=old_string→new_string framed as an elided edit}` to the merge port instead of returning a bare mismatch. This is the higher-value home (the §3 mechanism is edit-centric) but touches the edit tool's output contract (§9).
- **Default-OFF byte-identity.** No `FastApplyPort` on `ToolContext` ⇒ the ladder is exactly today's. The rung is reached ONLY when the port is wired AND returns `ok:true` AND verification passes.

### 4.c Verification — the merge is a PROPOSAL, never a blind write

This is the load-bearing safety property. **A model-merged file MUST be verified before acceptance and MUST still pass the normal edit gate.**
- **Round-trip / structural check.** The merged file is re-parsed / round-tripped (at minimum: non-empty, valid for the file's syntax where a parser exists — quanta already has tree-sitter chunking surfaces; reuse, don't add). A merge that drops the file to empty, truncates, or fails to parse ⇒ verification FAILS ⇒ fail-closed.
- **Diff against original + reviewer gate.** The merged file is diffed against the original and surfaced to the normal reviewer/diff gate **exactly like any edit** (the same `ToolDiffSink` / reviewer path edits already flow through — `types.ts:521-528`). The model-merged result is a candidate `next` handed to `commitEdit` (`edit/index.ts:180-197`) / the apply commit — it is NEVER written without passing the gate the human/reviewer already controls.
- **Fail-closed.** ANY apply-model error, empty/invalid merge, or verification failure ⇒ fall through to the **existing V4A re-emit rung** (and then to the existing typed mismatch). The merge rung can only ever *improve* recovery; it can never break the current behavior or write an unverified file.

### 4.d Determinism / safety summary

Temperature 0 / deterministic decode where the provider allows; merged file diffed against original; result gated by the normal reviewer/diff path; fail-closed to V4A re-emit on any error or verification miss; default-OFF ⇒ ladder byte-identical.

---

## 5. Risk (honest)

- **A model-merge can hallucinate or silently drop content.** This is the central risk and the reason the merge can NEVER be a trusted blind apply. A "rewrite" model handed `original + // ... existing code ...` can drop an elided region, reorder, or invent code. **Mitigation is structural, not hopeful:** the merge is a *verified proposal* behind the normal edit gate (§4.c) — round-trip/structural check THEN reviewer/diff gate THEN commit. No verification ⇒ no acceptance ⇒ fail-closed to re-emit. The hellgate (§7) asserts this with a deliberately broken merge.
- **Extra model call = cost + latency.** Every reached merge rung is an additional provider round-trip. It only pays off if the apply model is cheaper/faster than the full re-emit it replaces (§8). Gate it after the deterministic exact/fuzzy ladder so we never spend it on edits that already landed.
- **Provider availability.** The apply model may be unconfigured, rate-limited, or erroring. Fail-closed to V4A re-emit (which itself fails-closed to the typed mismatch). No new hard dependency on the apply call succeeding.
- **Hosted apply services (Morph/Relace) = a NEW surface.** They are external hosted models = a new **egress endpoint + dependency + cost + trust** surface. The default design therefore uses **quanta's OWN provider seam** (the dual-provider abstraction already in `@/llm`) to avoid adding any of that. A hosted Morph/Relace adapter is an opt-in only if the user explicitly wants it (§9) — and would carry the same default-OFF + verification + fail-closed discipline.
- **Edit-sketch contract creep.** If the high-value `edit`-tool home is chosen (§4.b), the main model may need to be prompted to emit the terse `// ... existing code ...` sketch — which touches the edit tool's output contract (§9). v1 can avoid this by deriving the sketch from the already-failed `old_string`/`new_string` (or failed patch) rather than changing what the main model emits.

---

## 6. Files to touch

- `src/agent/fast-apply-fallback/types.ts` — add `FastApplyPort` + `FastApplyMergeResult` (merge direction), sibling to the existing `FastApplyFallbackPort`. Closed, NO-THROW.
- `src/agent/fast-apply-fallback/merge-runner.ts` *(new)* — `createFastApplyMerge(deps)`: build the `{original, editSketch}` → merged-file prompt (name the `// ... existing code ...` convention), dispatch via the injected provider seam, run the round-trip/structural verification, collapse every failure to `{ ok:false }`.
- `src/agent/fast-apply-fallback/index.ts` — export the new port + runner.
- `src/tool/types.ts` — add the duck-typed mirror `FastApplyMergeSeam` (mirrors `FastApplyPort` exactly as `FastApplyFallbackSeam:556-565` mirrors `FastApplyFallbackPort`) + an optional `ctx.fastApplyMerge?` slot next to `ctx.fastApplyFallback` (`types.ts:244-246`).
- `src/tool/apply-patch.ts` and/or `src/tool/edit/index.ts` — insert the merge rung into the ladder (after fuzzy / before re-emit, §4.b), gated on the port being present; the merged file goes through the SAME commit + diff-sink path as any edit (`commitEdit` / `ToolDiffSink`). OFF (no port) ⇒ byte-identical to `index.ts:150-164` / `apply-patch.ts:384-418`.
- `src/agent/optional-ports.ts` — wire `createFastApplyMerge` onto the config when the new gate is ON AND a model is configured (mirror the existing `:85-110` block; reuse the same `roleModelResolver` + side-conversation seam). Resolve the apply model from `QUANTA_FAST_APPLY_MODEL`.
- `src/agent/dispatch.ts` — thread `fastApplyMerge` from `AgentConfig` to `ToolContext` (mirror `:756-757`).
- `src/shared/` (runtime-config / env-flag SSOT) — new knobs `QUANTA_FAST_APPLY_MERGE` (default-OFF; distinct from the existing `QUANTA_FAST_APPLY` re-emit gate at `optional-ports.ts:14`) and `QUANTA_FAST_APPLY_MODEL` (operator picks the apply model). Register both in the gate-vocabulary SSOT.
- `tools/feature-catalog/features/09-integration/fast-apply-merge.yaml` *(new)* — register the merge rung as a feature, distinct from `fast-apply-fallback.yaml` / `fast-apply-wire.yaml`.

---

## 7. Test / hellgate plan

- **OFF ⇒ ladder byte-identical, NO provider call (ratchet).** No `QUANTA_FAST_APPLY_MERGE` / no `QUANTA_FAST_APPLY_MODEL` ⇒ no `FastApplyPort` constructed, `ctx.fastApplyMerge` undefined, `planEdit` / `apply_patch` produce byte-identical output and make zero apply-model dispatches. (Guard against drift in both ladder files.)
- **ON, correct merge ⇒ rung used, STILL gated.** With a fake apply-model returning a correct merged file: the merge rung fires (after fuzzy, before re-emit), and the merged result flows through the normal diff/reviewer + commit path (`ToolDiffSink` sees before/after; the commit is the gated one) — the merge is accepted as a *proposal*, not a side-channel write.
- **ON, broken/hallucinated merge ⇒ verification catches it ⇒ fail-closed (red-on-injection).** Fake apply-model returns a merge that (a) drops content / is empty, (b) fails round-trip/structural parse, (c) injects unrelated content. Verification REJECTS it; the ladder falls through to the existing V4A re-emit (and then the typed mismatch). **Assert the broken merge is NEVER written.** This is the core security test — an unverified merge must never reach disk.
- **Provider error ⇒ fail-closed.** Apply-model dispatch throws / returns non-ok ⇒ `{ ok:false }` ⇒ fall through to re-emit; the turn is unaffected.
- **Never-blind-write invariant.** Assert across all the above: the merged file passes through `commitEdit` / the apply commit (the gated path), and there is NO code path that writes `merged` without verification + the normal gate.
- **Knob isolation.** `QUANTA_FAST_APPLY` (re-emit) ON but `QUANTA_FAST_APPLY_MERGE` OFF ⇒ exactly today's re-emit behavior, no merge rung. Both ON ⇒ merge tried first, re-emit as fallback.

---

## 8. ROI / cost

- **Cost: 중.** No new dependency (reuses the `@/llm` provider seam + the side-conversation plumbing already built for re-emit). The spend is: the new port + merge-runner, the verification step, ladder insertion in one or two tool files, and the two knobs. The hard part is **verification calibration** (round-trip vs structural vs judge — §9), not LOC.
- **Impact: 중.** Faster + cheaper recovery on failed applies, and fewer applies that fail outright (a merge model resolves elisions the deterministic ladder can't). **Honest caveat:** the merge rung adds an extra model call, so net token cost is a WIN only when the apply model is cheaper than a full V4A re-emit of the same edit. State this plainly — the biggest, clearest win is **large files**, where the re-emit is most expensive (the model must reproduce a precise diff against a big file) and the merge (small terse edit + one cheap-model pass) is most favorable. On small files the re-emit is already cheap and the extra call may not pay off — which is fine, because it's an OFF-by-default, after-fuzzy rung.

---

## 9. Open questions (calibrate — no magic)

1. **Provider seam vs hosted apply API.** Default: reuse quanta's OWN `@/llm` provider seam (no new egress/dep/cost). A hosted Morph/Relace adapter is opt-in only — does the user want that surface? It buys a purpose-built apply model (lower latency, spec-decode) at the cost of a new egress endpoint + vendor dep + per-call billing. **Recommendation: own-seam first; hosted adapter behind its own knob only on explicit request.**
2. **Which model is cost-effective as the apply model?** Cursor uses small specialists (Codestral REWRITE, DeepSeek-33B, Haiku). `QUANTA_FAST_APPLY_MODEL` is operator-set; what's the recommended default for our providers? Needs measurement (per `no-heuristics-only-validated` — do NOT pin a model without a cost/quality measurement vs the re-emit baseline).
3. **Verification method.** Round-trip parse vs structural diff (e.g. token/AST delta bounded) vs LLM-judge. Round-trip is cheapest + deterministic but weak (catches truncation/syntax break, not semantic drop). LLM-judge is stronger but adds *another* model call and is itself untrustworthy (per `claim-100-needs-3-adversarial-audits`). **Recommendation: ship round-trip + structural (bounded-delta vs the terse edit's claimed scope) first; the reviewer/diff gate is the real backstop; defer judge.**
4. **Ladder position.** Before or after fuzzy? Default proposal: **after fuzzy, before V4A re-emit** (only spend a model call once the free deterministic rungs miss). Before-fuzzy would cut latency on edits fuzzy could've landed deterministically — measure before moving.
5. **Edit-sketch as an output contract.** Is the terse `// ... existing code ...` sketch something the MAIN model must be prompted to emit (touching the `edit` tool's output contract), or do we derive it from the already-failed `old_string`/`new_string` (or failed V4A patch)? v1 should **derive** (no contract change). Emitting native terse sketches is a larger follow-up that would also let the merge rung run on the *first* attempt (Cursor's actual flow), not just on recovery — but that is a bigger change to the edit tool's IO and is out of scope here.
6. **Speculative decoding (`NOSPEC` parity).** Cursor's near-instant apply leans on spec-decode (original file = speculation prior). We have no spec-decode control over our provider. Accepted as out-of-scope for v1; the latency win is therefore smaller than Cursor's. Note honestly rather than claim parity.
