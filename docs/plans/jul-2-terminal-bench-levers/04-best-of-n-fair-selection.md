# RFC: best-of-N with FAIR selection (Terminal-Bench f2p lever, Class-2)

**Date:** 2026-07-02 · **Status:** proposed · **Lever #3** (companion to
[03-verify-gate-v2](03-verify-gate-v2-compare-to-reference.md); the v2 reference-diff is best-of-N's *selector*).
**Target:** tasks the frontier solves only *sometimes* (variance) — pytorch-model-recovery (66%),
torch-tensor-parallelism (12%), query-optimize (11%) — where ONE attempt with gpt-5.5 misses but a re-attempt hits.

## 1. Problem + the hard constraint

Frontier "solve rate" for many residual tasks is 5-66% = **variance**: a capable model gets it *some* runs.
A single attempt leaves that on the table. best-of-N captures it — BUT Terminal-Bench has a cardinal constraint:

> **TB scores the final container state ONCE, against a HIDDEN verifier.** You cannot submit N and keep the
> pass — and cherry-picking the lucky run *using the hidden verifier* is **leaderboard-gaming**, not a real score
> (violates `no-answer-key-regex-heuristics`). So selection MUST use a FAIR, agent-constructible signal.

Two distinct things, never to be conflated:
- **Pass@K (ceiling, MEASUREMENT only):** run the task K times independently; "solved" if ANY run passed. Upper
  bound of what the model *can* do. NOT a reportable single-system score (it peeks at the hidden verifier K times).
- **Best@K (real, single-system SCORE):** the agent internally produces N candidates and SELECTS one via a fair
  signal (no hidden test); that one deliverable is scored once. This is the f2p lever.

## 2. Existing infra to REUSE (do not reinvent — knob-inventory checked)

- **`QUANTA_BENCH_BESTK_PASSK`** (`config/knob-schema/schemas/bench-gap-2.ts`; analyzer
  `apps/bench/analyze/bestk-passk-grade.ts`): offline Pass@K-ceiling-vs-Best@K grader over SWE **repair-candidate
  patches**, SERIAL. → REUSE its *measurement* concept for TB's Pass@K ceiling; it is SWE-patch-shaped so TB needs
  an adapter (N container runs, not N patches).
- **acceptance framework** (`runner/batch/eval/acceptance-selector.ts`, `llm-candidate-select.ts`,
  `acceptance-llm-rerank-wire.ts`, `repro-vote.ts`; `QUANTA_BENCH_ACCEPTANCE`): Agentless-style per-candidate
  score-once + vote + LLM-rerank + dual-guard (jun-28 reprovote→acceptance). → REUSE the *selection* machinery
  (SSOT `makeAcceptanceSelectCandidates`); it too is SWE-patch-shaped → adapt the candidate type to a TB deliverable
  + a fair TB signal.
- **verify-gate v2 reference-diff** (RFC 03): the FAIR per-candidate acceptance signal for TB (run + diff vs a
  task-provided reference). best-of-N's selector = v2's L1 check. They compose.

## 3. Industry scan (absorb / avoid)

`.extracted_source` + literature:
- **Agentless** (SWE SOTA-simple): sample N patches → run reproduction + regression tests → select by
  normalized test-pass + majority vote. *Absorb:* select by an EXECUTABLE signal, not model self-confidence.
- **AlphaCode:** massive sample → FILTER by public tests → CLUSTER by behavior → pick a cluster rep. *Absorb:*
  cluster/dedup by observed behavior to avoid N-near-duplicates; *avoid:* raw N without filtering (cost blowup).
- **Self-consistency (Wang et al.):** sample N reasoning paths → majority-vote the answer. *Absorb:* when no
  reference exists, agreement across independent attempts is a fair proxy for correctness.
- **Codex/SWE-agent best-of-N:** N rollouts + a selection model/heuristic. *Avoid:* a selector that peeks at
  ground truth.
**Net pattern to absorb:** *generate diverse N → filter/verify each by a FAIR executable/self-consistency signal
→ select → submit one.* The selector is the whole game.

## 4. Design — in-brain multi-attempt + fair self-selection (Best@K)

Primary (reportable score): **in a single TB run**, the brain produces N candidate solutions and selects one:
1. **Generate N (diverse):** N attempts with varied seeds/approaches (temperature or explicit "try a different
   approach"), each writing its deliverable to an ISOLATED candidate workspace (`/tmp/cand-i/`), not the final path.
2. **Fair per-candidate acceptance (reuse v2):** for each candidate, run it + apply the v2 reference-diff (a
   task-provided reference: baseline command / computed expected / queryable original). Score = L1 pass/fail.
   - If a reference is constructible → rank by it (Agentless-style executable signal).
   - Else → **self-consistency**: cluster candidates by observed output; the majority-cluster rep wins.
   - Else (neither) → no fair signal → best-of-N is INERT for this task (honest — don't guess).
3. **Materialize the winner** into the real deliverable path; finalize (verify-gate stamps it).

Secondary (measurement ONLY, clearly labeled, never the reported score): **Pass@K ceiling** = K independent harbor
runs, "any passed". Reuses BESTK_PASSK adapter for TB. Tells us the model's headroom vs our selector's efficiency
(Best@K / Pass@K = selector quality).

**Knob:** `QUANTA_TB_BEST_OF_N` (int; unset/1 ⇒ single attempt, byte-identical). Register in `config/knob-inventory/*`.
Reuse the acceptance-selector SSOT for ranking; do NOT fork it.

## 5. Adversarial audit (≥5 rounds)

- **R1 — hidden-test gaming (CARDINAL).** Selection must NEVER read the hidden verifier / `tests/` / grader. The
  fair signal is task-provided-reference OR self-consistency only. Guard: the selector has no path to the verifier;
  Pass@K (which does touch the grader) is fenced to the OFFLINE measurement subcommand, never the live score path.
  This is the `no-answer-key` red line.
- **R2 — cost blowup.** N× LLM cost + turns. Bound: default N=1 (off); cap N (≤4); cluster/dedup (AlphaCode) so
  identical candidates don't re-verify; share the exploration prefix. Budget-gate via `budget.remaining()`.
- **R3 — determinism / measurement integrity.** N attempts must be independently seeded but reproducible
  (cassette/seed logging) so a Best@K result is re-runnable. SERIAL grading for any Pass@K (jun-19 concurrent
  false-neg).
- **R4 — selector false-confidence.** Self-consistency can agree on a WRONG answer (all-N-wrong). Then Best@K
  submits wrong (verified-fail, honest). Never claim self-consistency = correctness; it's a proxy. Prefer the
  reference-diff signal when available.
- **R5 — no-improvement / regression.** best-of-N must not LOWER single-attempt pass (e.g. selecting a worse
  candidate than attempt-1). Guard: attempt-1 is always a candidate; a candidate only wins if it STRICTLY passes
  the fair signal that attempt-1 failed. Measure-first: keep only on f2p gain.

## 6. Hellgate plan
- **P0 RED:** a task where attempt-1 fails its reference-diff but attempt-2 passes ⇒ assert best-of-N selects
  attempt-2 (via the fair signal), not attempt-1.
- **P1 candidate generation** (isolated workspaces + diverse seeds) — pure orchestration over the brain loop.
- **P2 fair selector** (reuse `makeAcceptanceSelectCandidates` + v2 reference-diff + self-consistency fallback),
  unit-tested incl. R1 (no verifier path), R4 (all-wrong ⇒ honest fail), R5 (attempt-1 floor).
- **P3 knob wiring** `QUANTA_TB_BEST_OF_N` (default 1, byte-identical) + inventory registration.
- **P4 adversarial ≥3 live rounds** (R1-R5), fix, document.
- **P5 measure-first A/B:** Best@N on {pytorch-model-recovery, torch-tensor-parallelism, query-optimize} +
  Pass@K ceiling for headroom. SERIAL. Classify grader-error vs real. Keep only on measured f2p gain.

## 7. Honest yield + limits
- **Where it wins:** variance tasks with a fair signal — pytorch-model-recovery (66% → N=3 near-certain, IF a
  fair signal exists for it; RFC 03 flagged its reference may be hidden → may fall to self-consistency only) +
  the 11-12% pair with N=3-4.
- **Where it's inert:** tasks with no constructible reference AND no self-consistency signal, and the 13
  never-solved (nobody's variance covers them).
- **Expected: +2-3** (63 → 65-66). Ceiling unchanged (85% physical, 84% union unreachable single-system).
- **Composition:** best-of-N REUSES verify-gate v2 as its selector; land v2 first. Cost is the main knob — default
  OFF, cap N, dedup.
