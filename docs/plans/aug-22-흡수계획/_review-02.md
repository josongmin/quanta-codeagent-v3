# _review-02 — RFC-02 (Review diff-source picker) adversarial read-only review

Reviewer: read-only. No code/doc mutated. Target `docs/plans/aug-22-흡수계획/rfc-02-review-diff-source.md`;
cross `docs/plans/aug-02-absorption/rfc-09-residual-gaps.md`.

---

## A. Snapshot (committed truth vs dirty overlay)

- **HEAD** `9d5369d310bba9cfcdf2508ca62e6274f184cdd4` on branch `main`.
- **origin/main** `9d5369d31…` — identical to HEAD (`merge-base == HEAD`). No divergence.
- **dirty**: 68 paths. All modifications are in the **bench / leaderboard-dashboard / batch-corpus** slices
  (`src/apps/bench/**`, `src/runner/batch/**`, `tools/leaderboard-dashboard/**`, related tests) plus untracked
  `adapters/terminal-bench/**` and `docs/plans/aug-21-*` / `docs/plans/aug-22-흡수계획/` (this RFC lives in the
  untracked user dir). **Zero dirty overlap** with the review/git/turn-diff/checkpoint slices this RFC touches
  (`src/tool/git/**`, `src/agent/turn-diff/**`, `src/agent/git-observability/**`, `src/runner/orchestrate/**`,
  `src/runner/diff-ops.ts`, `src/host/runtime/mcp-roots-provider.ts` all clean at HEAD).
- Every file:line verdict below is against **committed HEAD** (clean), not the dirty overlay. Dirty is the user's
  bench work — untouched.

---

## B. Per-source BUILD / DROP / PARK verdict table

| source | authoritative input | resolver | fail-closed "unavailable" condition | real consumer | verdict |
|---|---|---|---|---|---|
| **branch-base** | `{base?, head?}`, default `origin/main`/`HEAD` | today's `buildArgs` (review-diff.ts:139-147) → `git diff base...head` | n/a (always resolvable; missing base = default) | `extractDiff` → isolated reviewer (review-diff.ts:293-308,350-369) | **BUILD (trivial / formalize today's behavior)** — byte-identical when unset |
| **commit** | `{rev}` → `<rev>~1...<rev>` | NEW arm, reuses `validateRev` (review-diff.ts:135-137) + `buildArgs` shape | rev does not resolve (`git diff` exit>1 → existing `deny`, review-diff.ts:302) | same `extractDiff` path | **BUILD (cheap)** — model can already pass raw `{base,head}`; this adds the first-class picker |
| **commit-range** | `{from,to}` → `from...to` | NEW arm, same reuse | same as commit | same | **BUILD (cheap)** |
| **last-turn** | turn-start SHA `fromSha` (plain git) — **already emitted + durably recorded** as `turn_diff_updated.fromSha` (turn-diff/index.ts:120,140; stream/types.ts:626; jsonl-recorder.ts:587) when `QUANTA_TURN_DIFF` on | NEW arm = **retrieval reader** over newest recorded `fromSha` (OQ1-A) → `git diff <fromSha>` (== `computeTurnDiff` semantics, turn-diff/index.ts:96) | no `fromSha` recorded (gate off / no turn captured / non-git cwd) ⇒ typed `unavailable`, **never** working/branch-base fallback | isolated reviewer via `extractDiff` | **BUILD — but REVISE premise (see C/F).** Smaller than RFC frames; own gate; last |
| **all-repos** | discovered git roots (`git rev-parse --show-toplevel` per candidate; dedupe by `--git-common-dir`) | NEW fan-out arm; roots-discovery + dedup are genuinely new | <2 distinct roots ⇒ collapses to branch-base on the one root (not an error) | per-root reviewer, findings tagged per-root | **BUILD but PARK-LAST behind own gate** — correctness sink (submodule/worktree/sibling); `extraRoots` reuse is illusory (see D) |
| **generated filter** (toggle, orthogonal) | repo-declared `.gitattributes linguist-generated` via `git check-attr` | NEW file; **grep 0** for `linguist`/`check-attr` in `src/` | toggle off ⇒ `check-attr` never called ⇒ identical path set | path set feeding tree+diff+reviewer | **BUILD** — attribute-only is compliant; ban filename/ext fallback (see F) |
| **large-diff paging** (presentation, orthogonal) | resolved unified diff + per-file enumerator | reuse `reviewedPathsFromDiff`+`showBlob` (review-diff-canvas.ts:36-61), `splitHunks` (diff-ops.ts:154) | n/a | surface cursor UI | **BUILD** — reuses per-file producer, NOT a new diff engine; **cap-mismatch receipt gap (see F)** |

**Proof current basis is fixed to `origin/main` (call path):** `gitReviewDiffInputSchema` has **no** `scope`/`source`
field (review-diff.ts:47-56). `buildArgs` (review-diff.ts:139-147): `base = input.base ?? "origin/main"`,
`head = input.head ?? "HEAD"`, emits `["diff", "${base}...${head}"]`. `parseAndBuildArgs` (review-diff.ts:406-422)
re-defaults identically. Tool description literally advertises "Default range is origin/main...HEAD"
(review-diff.ts:326-327). The model *can* pass raw `{base,head}` but there is **no picker, no scope, no range UI**.
Confirmed fixed.

---

## C. RFC-09 obsolete vs still-valid sentences (precise)

- **RFC-09:75** — "A `last_turn` scope is PARKED **until a durable, canonical edit-batch boundary exists**; no
  fallback to `working`." → the **"until…" precondition is now MET** ⇒ the *park's gating rationale is OBSOLETE*.
  It is met on **TWO** independent counts, not one:
  1. RFC-01 A2 rewind checkpoint (ShadowOdb boundary) — durable, but ShadowOdb not plain git
     (`thread-rollback-checkpoint.ts`, `verify-checkpoint-bridge.ts:18`). RFC-02 credits this. ✓
  2. **(RFC-02 MISSED)** the turn-diff `fromSha` — a **plain-git** turn-start SHA, emitted in
     `turn_diff_updated` and **durably recorded** ("recovery" trajectory class, jsonl-recorder.ts:587) when
     `QUANTA_TURN_DIFF` is on. This is a *durable, git-diffable* last-turn base that RFC-02 mischaracterizes as
     dead/ephemeral (see D/F).
- **RFC-09:50** — "no first-class scope selector (uncommitted vs branch vs last-turn)". → **STILL VALID (factual
  gap)**, not obsolete. This is the gap RFC-02 *fills*.
- **RFC-09:125 STOP conditions** — "inferred last-turn base / fallback from an unavailable scope / duplicate
  finding contract / category enum / strict-schema migration". → **ALL STILL VALID.** None obsolete. RFC-02
  must (and claims to) honor every one; the review confirms it does *on paper*.
- Net: **exactly one sentence is obsolete — RFC-09:75's "until a durable boundary exists" precondition.** The
  three STOP guards and the RFC-09:50 gap description remain in force.

---

## D. Duplicate store / resolver / diff-engine risk

- **Diff engine — NO duplication if built as designed.** The resolver only maps `DiffSource → {base,head,paths}`;
  `git diff` math stays in `extractDiff` (review-diff.ts) and line-math in `diff-ops.ts`. Paging reuses the
  existing per-file producer (`reviewedPathsFromDiff`/`showBlob`, review-diff-canvas.ts:36-61) + `splitHunks`
  (diff-ops.ts:154). **Do not** let paging spawn a second per-file diff walker.
- **Scope resolver — genuinely NEW (no dup).** There is no scope/source resolver today. Sound to add ONE
  surface-agnostic authority (SSOT). ✓
- **Cap constant — DUPLICATION HAZARD.** Two caps already exist and differ: the review tool's **own**
  `MAX_DIFF_BYTES = 50_000` (review-diff.ts:29) vs `diff-ops` `DEFAULT_MAX_BYTES = 64*1024` +
  `resolveEnvCaps().maxBytes`/`QUANTA_DIFF_MAX_BYTES` (diff-ops.ts:23,36-40). RFC-02 T5 says paging reuses
  `QUANTA_DIFF_MAX_BYTES` but the review path today truncates at 50_000 — a **different** threshold. Reconcile,
  do not add a third.
- **last-turn persistence — DUPLICATION HAZARD.** RFC-02 OQ1-A proposes persisting a **new** `lastTurnBaseSha`.
  But `turn_diff_updated.fromSha` is **already durably recorded** (jsonl-recorder.ts:587). Prefer reading the
  existing record (or a session-field bound to the existing `endTurn` emit) over minting a second persistence
  store for the same fact.
- **mark-as-viewed (OQ4) — would be a NEW store.** No review-state store exists today. Keep ephemeral unless a
  consumer forces durability (RFC already leans ephemeral — hold that line).
- **all-repos root source (OQ3) — `extraRoots` reuse is ILLUSORY.** `workspaceRootsProvider(cwd, extraRoots=[])`
  accepts `extraRoots`, but the only production builder `buildRootsWiring` calls it **without** them
  (mcp-roots-provider.ts:50-66,91-94) ⇒ `extraRoots` is never populated. Worse, MCP roots are *workspace folders
  advertised to MCP servers*, **not** git repos — reusing it is a category mismatch, not a real reuse. All-repos
  needs its own git-root discovery.

---

## E. Minimal write-set + shared-owner conflicts

- **New files (additive, no shared-owner conflict):** `review-diff-source.ts` (resolver), `generated-file-filter.ts`,
  `review-diff-paged.ts`. All greenfield.
- **Shared-owner EDITS:**
  - `review-diff.ts` — add optional `source` field to the input schema (additive; byte-identical when unset,
    same pattern as the already-landed optional `verdict/category/shortSummary` fields at review-diff.ts:87-92).
    LOW risk.
  - **`last-turn` retrieval — the ONLY hot-path shared-owner touch.** OQ1-A must read the recorded `fromSha`
    (or persist a session `lastTurnBaseSha` on the existing `endTurn` emit path, turn-diff-emit.ts:76-89 /
    turn-closeout.ts:97-99). This is the observability/loop hot path — per the jul-15 lesson (observer-sink
    gating for byte-identical OFF), it MUST stay behind its gate and not perturb the `QUANTA_TURN_DIFF`-off path.
    MEDIUM risk; do last, own gate.
  - `diff-ops.ts` / `review-diff-canvas.ts` — **reuse only, no edit expected.**
- **Concurrent-session hazard:** the 68 dirty files are the user's bench sweep and are **disjoint** from this
  write-set. Safe to land the review/git slice without colliding — but re-verify `HEAD` before any commit
  (concurrent sessions commit to this repo).

---

## F. Receipts for the five load-bearing claims

1. **turn-2-only last-turn content (roundtrip).** Achievable and *stronger* than RFC states: `computeTurnDiff`
   runs `git diff <fromSha>` (turn-diff/index.ts:96) capturing committed+working edits since turn start. With
   `fromSha` = turn-2 start SHA, the diff is turn-2-only by construction. Hellgate #3 is sound **provided** the
   anchor read is the turn-2 `fromSha`, not the branch base. ✓ (build receipt achievable)
2. **missing-anchor fail-closed.** REQUIRED and honored on paper (RFC line 70,107,133). **CORRECTION to the
   gate:** RFC-02:95 says "reuse `QUANTA_REWIND_CAPTURE`" — but the plain-git `fromSha` path (OQ1-A) is gated by
   **`QUANTA_TURN_DIFF`** (runtime-compose.ts:77; knob-inventory/extra.ts:852), a DIFFERENT gate than
   `QUANTA_REWIND_CAPTURE` (which feeds the ShadowOdb checkpoint, knobs-a.ts:246). Fail-closed must trigger when
   *the relevant* gate is off. Hellgate #2 is the right red-on-injection guard.
3. **generated = repository metadata only.** `git check-attr linguist-generated` reads a **repo-authored
   declarative attribute**, not content/filename/extension — compliant with `no-answer-key-regex-heuristics`
   **iff** the design's explicit ban on any filename/extension fallback (RFC line 75, T2, R2) is enforced. Red-
   on-injection hellgate #4 (a `dist/` file WITHOUT the attribute must survive the filter) is the correct
   receipt. grep confirms 0 `linguist`/`check-attr` in `src/` — clean build. ✓
4. **multi-root.** `git rev-parse --show-toplevel` primitive already exists (env-context.ts:325,
   file-tree-summary:371) but there is **no** multi-root iteration and **no** `git-common-dir` dedup anywhere —
   genuinely new. Hellgate #5 (sibling repos fan-out + linked-worktree dedup) is the right receipt; PARK-last is
   correct. ✓ (gap real)
5. **paging.** Per-file producer reuse is real (review-diff-canvas.ts:36-61, splitHunks diff-ops.ts:154) — NOT a
   new engine. **Receipt GAP:** the byte-identical/threshold claim conflates two caps — today's review truncation
   is `MAX_DIFF_BYTES=50_000` (review-diff.ts:29), while the paging trigger cites `resolveEnvCaps`/64KB. There is
   a **[50KB, 64KB] behavioral window** where today truncates but paging would not engage; the T7 snapshot must
   pin whichever single cap governs, and the "byte-identical below cap" claim needs the caps reconciled first.

**Overturned RFC claim (load-bearing):** RFC-02 §Current-state:35 and R1 audit:165-166 assert
`wireTurnDiffEmit`/`TurnDiffSession` has **"NO production caller … dead seam."** This is **FALSE at HEAD.** The
seam is fully wired and gated by `QUANTA_TURN_DIFF`:
`runtime-compose.ts:77 (gitObservability.enabled) → buildTurnDiffSession (loop-helpers.ts:87-93) →
session-bootstrap.ts:196,354 → turn-loop.ts:81-82 (startTurn) → turn-closeout.ts:97-99 /
flushTurnObservability (endTurn → stream.emit) → recorded (jsonl-recorder.ts:587)`. Only the *anchor Map* is
in-memory/consumed-once (turn-diff-emit.ts:68,71,79); the *emitted event* carrying `fromSha` is durable-class
recorded. RFC conflates the two.

---

## G. Recommended build order (corrected)

1. **Resolver skeleton + branch-base/commit/commit-range arms + exhaustive `Record<kind>` guard.** Cheap,
   byte-identical when unset (defaults to today's `origin/main...HEAD`). Snapshot-pin the unset argv (T7). Land
   first, independently.
2. **Generated-file filter** (`git check-attr --stdin`, attribute-only, explicit filename/ext ban, red-on-
   injection hellgate). Default-OFF. Independent.
3. **Large-diff paging** — but FIRST reconcile the `MAX_DIFF_BYTES` (50KB) vs `resolveEnvCaps` (64KB) cap so the
   trigger and truncation agree; then reuse the per-file producer. Independent.
4. **last-turn (OQ1-A, corrected)** — implement as a **retrieval reader** over the already-live+recorded
   `turn_diff_updated.fromSha` (or a session `lastTurnBaseSha` bound to the existing `endTurn` emit), gated by
   **`QUANTA_TURN_DIFF`**, fail-closed `unavailable` when no anchor. Do **not** frame as "reviving a dead seam"
   and do **not** default to the ShadowOdb checkpoint (OQ1-B is the larger, foreign-diff path). Own gate, after
   1–3.
5. **all-repos** — own git-root discovery (`--show-toplevel` + `--git-common-dir` dedup), per-root tagging.
   Correctness sink; own gate; last. Do not reuse `extraRoots`.

---

## H. Verdict: **REVISE** (buildable after correction — not READY as written)

The RFC's *shape* is sound: reuse `ReviewFinding` verbatim, one new resolver as SSOT, no new diff engine, no
new mutation path, fail-closed last-turn, attribute-only generated filter, PARK all-repos/last-turn behind own
gates. Cross-references to RFC-09 (lines 50/75/125) are accurate, and it correctly identifies that RFC-09:75's
park precondition is now met.

But it rests on a **factually wrong load-bearing claim** — the turn-diff seam is *not* a dead seam; it is a
live, `QUANTA_TURN_DIFF`-gated, durably-recorded plain-git anchor. This error:
- inflates last-turn to an "M-effort dead-seam revival / critical-path risk" when the smaller authoritative
  path is a **retrieval reader over already-durable `fromSha`** (OQ1-A wins decisively over the ShadowOdb bridge);
- names the wrong gate (`QUANTA_REWIND_CAPTURE` instead of `QUANTA_TURN_DIFF`) for the fail-closed condition;
- risks a duplicate `lastTurnBaseSha` store for a fact already recorded.

Plus two smaller receipt gaps: the paging **cap mismatch** (50KB vs 64KB — the byte-identical claim is
imprecise) and the **illusory `extraRoots` reuse** (empty seam + MCP-roots≠git-roots category error).

**Required before READY:** (1) correct the dead-seam mischaracterization and re-resolve OQ1 to A on the corrected
basis; (2) fix the gate name; (3) reconcile the two diff caps and re-pin the byte-identical snapshot; (4) drop the
`extraRoots` reuse claim, give all-repos its own root discovery. None demolishes the RFC — after these, BUILD
order G is safe. all-repos and last-turn stay PARK-behind-own-gate.
