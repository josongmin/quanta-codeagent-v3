# ADR-0456 — edit fuzzy ladder: scored-candidate recovery on the ambiguous path

**Status:** Accepted (2026-06-02)
**Type:** Tool-system robustness slice (edit fuzzy matcher).
**Scope:** `src/tool/edit/fuzzy.ts` (one pure `exactAnchorScore`, one pure
`tryScoredCandidate`, and a 4-line hook on the existing ambiguous branch of
`applyFuzzyEdit`) and its hellgate `tests/unit/fuzzy.test.ts`. No other files
touched. Additive on the ambiguous-fail path only; no env gate.

ADR-number note: 0450 was the highest existing decision; 0451 is the next clearly
free number (verified via `ls docs/decisions/`).

## Context

quanta's edit tool fuzzy matcher is a 3-rung ladder in `src/tool/edit/fuzzy.ts`:
exact → whitespace-flexible → anchored-trim. Each fuzzy rung locates the
`old_string` with `findLineWindows` (a per-line normalized projection). If a rung
finds **2+** windows it returns `kind:"ambiguous"` and the WHOLE edit fails
immediately — the ladder stops because "a more permissive rung can only be more
ambiguous, so stop." That is a safe default but it leaves recoverable edits on the
table: when several windows match only *after* normalization yet one window is
clearly what the model typed (matches more lines byte-for-byte), the current code
rejects it outright.

Competitor evidence: Codex bundles `utils/fuzzy-match` (the nucleo matcher:
`fuzzy_greedy` / `fuzzy_optimal`) that SCORES candidates and picks the best
instead of failing on ambiguity. We absorb the *spirit* (score, then pick) while
keeping quanta's safety posture: we never pick unless one candidate is the
decisive best, and we only run on the path that fails today.

## Decision

Add a FINAL rung — `tryScoredCandidate` — that runs ONLY when an earlier fuzzy
rung returns `ambiguous`. It scores each candidate window and recovers the edit
**iff a single candidate is the decisive best**; otherwise it returns `none` and
the original ambiguous failure is surfaced unchanged.

**The scoring is a MEASUREMENT, not a heuristic.** The score of a candidate
window is the **count of lines that match the needle line at the same position
VERBATIM** (character-for-character) — `exactAnchorScore`. This is an integer
count of an observable property (how many lines the model wrote byte-exactly),
Levenshtein-free, with **no tunable threshold, no ratio cutoff, no decay, no
fudge constant**. Every candidate already matches the needle under the rung's
normalization (that is *why* it is a candidate); the exact-line count tie-breaks
the candidates by literal fidelity to the text the model actually typed. This
mirrors the project no-unjustified-heuristics rule the same way ADR-0450's
windowed-rate did: a literal count over an explicit, observable set, not a
smoothing/threshold knob someone picked.

**The DECISIVE-best discriminator rule (exact wording):**

> Recover the edit if and only if exactly one candidate window has a STRICTLY
> higher verbatim-exact-line count than EVERY other candidate window. If two or
> more candidates share the maximum score (a tie at the top), there is no
> decisive best — keep failing ambiguous.

This is a strict-ordering / unique-strict-maximum discriminator. There is no
"score > 0.8" or "score gap ≥ k": the only comparison is `best.score >
runnerUp.score` where `runnerUp` is the second-highest score across ALL
candidates. A tie, a near-tie (gap shared at the top), or zero exact-anchor
advantage ⇒ still fails.

**Why a strict maximum, not a margin.** A margin ("top beats runner-up by ≥ N")
would reintroduce an arbitrary N. The strict-maximum rule has an exact definition
("unique top or fail") with no free parameter, and it is the most conservative
rule that can recover anything at all: anything weaker would either need a fudge
constant or risk picking among co-maximal windows.

## Safety (the cardinal sin: never edit the wrong location)

- This rung runs ONLY on the branch that returns `kind:"ambiguous"` today — i.e.
  the edit the current code already REJECTS. It can therefore only convert a
  current `fail` into either a recovered edit on the decisive-best window or the
  same `fail`. It can NEVER change a currently-applied edit, nor pick a different
  window than the current code would (the current code picks NO window on this
  path).
- The candidate pool is recomputed with the SAME projections the ambiguous rungs
  used (whitespace-flex ∪ anchored-trim, deduped by start). We never invent a
  window a normalizing rung wouldn't have surfaced.
- A tie at the top ⇒ `none` ⇒ the original ambiguous failure stands. Proven by
  the hellgate (`true tie` and `near-tie at the top` cases). The bias is
  deliberately toward the FALSE-NEGATIVE (fail, ask the model to retry) over the
  FALSE-POSITIVE (apply to the wrong window).
- `replaceAll` never reaches this rung: under `replaceAll` a multi-span match is
  APPLIED (not ambiguous) by `applyWindows`, so the ladder never produces the
  ambiguous result this rung consumes. Asserted by a regression test.

## Additive / byte-identical

- Exact, whitespace-flex, and anchored-trim rungs are UNTOUCHED (no edits inside
  `applyWindows`, `tryWhitespaceFlexible`, `tryAnchoredTrim`, `applyExactEdit`).
- Every currently-matched case (exact / ws-flex / anchored-trim with a unique
  match) returns before the ambiguous branch ever runs — byte-identical.
- Every currently-failed-with-no-strict-winner case falls through `tryScoredCandidate`
  → `none` → the SAME ambiguous outcome (same message, same `kind:"ambiguous"`),
  so the `[edit-mismatch:ambiguous]` marker the dispatcher (`index.ts`) appends is
  unchanged. The recovered case returns `ok:true` with no `kind`, which `index.ts`
  routes as a success exactly like any other matched outcome.
- All 8 pre-existing `fuzzy.test.ts` cases and the E2 `edit-recovery-hellgate`
  ambiguous case pass unchanged.

## Adversarial-review notes (2026-06-02)

- **Could it ever edit the wrong window?** Only if two distinct *intended*
  windows could both be the unique strict maximum — impossible by definition
  (a unique strict maximum is, by construction, a single window). Among
  co-maximal windows the rule refuses to choose. The worst case is a
  false-negative (no edit), never a wrong-location edit.
- **Exact-substring interaction.** A window that is verbatim on ALL needle lines
  makes the multi-line `old_string` a verbatim substring, so `applyExactEdit`
  matches it first (uniquely, or reports its own ambiguity) and the fuzzy ladder
  never runs. The scored rung therefore only ever sees windows that are
  *partially* verbatim — exactly the tie-break case it's built for. The hellgate
  uses 3-line needles whose last line is never verbatim to exercise this.
- **Candidate-pool fidelity.** The pool is the union of the two normalizing rungs'
  windows; we do not widen it. A window the ladder would not have surfaced cannot
  be picked.

## Non-goals (deferred)

- **Intra-line Levenshtein scoring.** The score is whole-line exact / not-exact;
  a window that is 90%-of-a-line closer scores the same as one that shares zero
  characters on that line. Adding edit-distance would reintroduce a threshold
  question (how close is "close"), so it is deliberately out of scope until
  there's a measured need.
- **Cross-rung scoring.** We score within a single ambiguous rung's candidate
  union; we do not blend scores across exact/ws-flex/anchored layers beyond the
  start-dedup union.
- **Tunable margin / confidence knob.** Explicitly rejected (would be the banned
  fudge constant). The rule stays "unique strict maximum or fail."
