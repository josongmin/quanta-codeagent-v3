# RFC: verify-gate v2 — compare-to-reference enforcement (Terminal-Bench cluster-A fix)

**Date:** 2026-07-02 · **Status:** FINAL (audit-hardened; 3 corrections applied) · **Lever #2.5**
extends [02](02-verify-before-finalize-rfc.md), grounded by the RCA in
[03-verify-gate-rca-and-redesign.md](03-verify-gate-rca-and-redesign.md) (companion — read that for the
root-cause of why v1 is a rubber-stamp).
**Target:** cluster-A "ran it, declared green, never compared to the available reference" failures.

> **Audit corrections vs the draft** (applied below):
> 1. **Knob `QUANTA_TB_VERIFY_GATE=2` does NOT work** — `gateOn` only accepts truthy tokens
>    `{1,on,true,yes}` (`src/shared/env-flag.ts:35`), so `=2` reads as OFF. FIX the EXISTING
>    **`QUANTA_TB_VERIFY_GATE`** — ON ⇒ L1 logic directly (a SECOND verify knob would be sprawl). Do NOT ship the
>    proven-broken v1 rubber-stamp as a selectable "level 1" — v1's `verified-pass` is a lie
>    (stamped 3/7 FAILED tasks on the box) and contributed ~0. `QUANTA_TB_VERIFY_GATE` ON ⇒ L1-gated;
>    unset ⇒ no gate (byte-identical).
> 2. **pytorch-model-recovery is NOT a clean cluster-A** — the correct original weights are HIDDEN in
>    `tests/`; the agent is given the CORRUPTED `weights.pt`, so there is no task-provided reference to
>    diff against (unlike query-optimize's runnable baseline). Reclassify it to **Class-2 / best-of-N**
>    (66% frontier → high best-of-N yield) pending a box check of `/app` contents. Solid v2 targets are
>    query-optimize, polyglot-c-py/rust-c, model-extraction.
> 3. **Added the outcome-correlation backstop test** the unit suite lacked (the reason v1's rubber-stamp
>    passed CI): a fixture that RAN but produced WRONG output must NOT yield `verified-pass`.

## 1. Background reasoning

The dominant residual TB failure (after env-posture + verify-gate v1 + turn-budget) is a *specific* fake-green:
the agent RUNS its deliverable, self-declares *"Verification: performed yes, verdict green, exit 0"*, but
**never compares the output against a reference the TASK ITSELF provides**:

Task references verified by BOX-CHECK of `~/.cache/harbor/tasks/*/…/{environment/Dockerfile,instruction.md,tests/}`
(2026-07-02) — NOT assumed (correction-2 caught pytorch this way; the check below likewise reclassifies model-extraction):

| task (frontier %) | task-provided reference (box-verified) | v2 fit |
|---|---|---|
| query-optimize (11%) | ✅ `/app/my-sql-query.sql` (the given baseline) is COPY'd in; instruction: "same output". Diff optimized-vs-baseline OUTPUT. **Golden is `/tests/golden.sql` (hidden)** → proves the no-leak guard is load-bearing, §R1. | ✅ strong (runnable given reference) |
| polyglot-c-py / rust-c (5-7%) | ✅ `fib(N)` deterministic; **no hidden golden file** in `tests/`. Agent computes fib itself + diffs both-language output. | ✅ strong (computable reference) |
| model-extraction-relu-logits (6%) | ⚠️ box-check found NO clear `/app` original to query/diff against; the match target may be hidden (pytorch-class). | ⚠️ **verify /app or → best-of-N**, not a confirmed v2 target |
| pytorch-model-recovery (66%) | ⚠️ correct original weights HIDDEN in `tests/`; given file is corrupted | ❌ → **best-of-N**, not v2 |

**Key insight:** for the ✅ rows the oracle is *in the task* (a runnable given baseline / a deterministic expected
value) — using it is FAIR; it is NOT the hidden verifier. The failure is "didn't use the available oracle," a
*scaffold* gap. **Confirmed v2 targets = 3 (query-optimize, polyglot-c-py, polyglot-rust-c).** model-extraction is
UNCONFIRMED (box-check inconclusive on `/app` reference) and pytorch's oracle is genuinely hidden → both go to
best-of-N unless a follow-up `/app` check surfaces a usable reference.

## 2. Industry scan (advantages to absorb, traps to avoid)

Checked `.extracted_source/{codex,claude-code,cursor}` + harbor `terminus_2` + agentless-ref:
- **Codex:** verification is ADVISORY — *"consider using tests to verify"*, *"reproduce a bug to verify"*,
  anchored to the PROJECT's own tests. No hard gate.
- **Claude Code:** *"verify before declaring done; a zero exit on the verifying command is the proof, not your
  expectation"* — advisory.
- **Terminus 2** (TB SOTA): structured output + UNBOUNDED turns; its "verify" is only install checks, no compare gate.
- **Agentless** (SWE): reproduction + regression DIFFERENTIAL — run repro/tests before & after (the oracle-diff).

**Absorb:** (a) anchor verification to the TASK's OWN materials (never invent or peek); (b) frame as natural
"verify as you go", not a scold; (c) the reproduction-DIFFERENTIAL (run + compare) is the proven oracle pattern.
**Avoid:** nobody hard-enforces → over-enforcement is a real risk (our own predecessor steer was REVERTED for
over-persisting). v2's differentiator is a *structural, bounded, honest-exit* gate the others lack.

## 3. Design — a 2-level exercise ladder

v1 collapsed "ran the deliverable" into one bit and (bug) stamped `verified-pass` on it. v2 splits it:

- **L0 — RAN**: the deliverable executed + output observed (v1's bar). By itself ⇒ NOT verified.
- **L1 — CHECKED**: the output was COMPARED against a reference — a `diff`/`cmp`/`sdiff`/`colordiff` between the
  produced output and a DISTINCT reference artifact, OR a script/`assert` whose observed result is an
  equality/closeness verdict against a task-provided/agent-derived reference.

**Gate policy** (behind **`QUANTA_TB_VERIFY_GATE`**; unset ⇒ NO gate, byte-identical — the broken v1
rubber-stamp is retired, not preserved):
1. L1 present + agent reports match → `verified-pass`.
2. L1 present + mismatch → `verified-fail` (honest, surfaced).
3. L0 but NOT L1 → the deliverable ran but was never checked → inject EXACTLY ONE bounded follow-up (§below).
4. Neither → `unverifiable`.
5. The follow-up turn may itself diff→fix→re-diff (a turn holds multiple tool calls). OPTIONALLY widen to a
   BOUNDED recovery loop `≤K` (K=2-3, hard counter) so the agent can ACT on the mismatch, not just surface it —
   A/B-measured. Hard cap either way; after it, all three terminal states finalize. **cannot over-persist.**

`verified-pass` is now UNREACHABLE without an observed L1 comparison — closing the rubber-stamp.

> **surface ≠ recover (honest framing).** A single follow-up reliably SURFACES the mismatch (→ honest
> `verified-fail`); FIXING it (→ f2p) often needs the ≤K recovery window above. So v2's PROVEN value is
> **measurement honesty** (kills the rubber-stamp so A/B numbers mean something); its f2p gain is a bonus, not the
> headline. The primary f2p lever is best-of-N ([04](04-best-of-n-fair-selection.md)), which REUSES this gate's
> L1 check as its per-candidate selector — land v2 first, then best-of-N.

### Follow-up prompt (no-leak, task-anchored)
> "Before finalizing: your deliverable ran, but you have not COMPARED its output against a reference. Using ONLY
> materials the task itself provides — an original/input artifact, a baseline command whose output is the correct
> answer, or a deterministic expected value stated in the task — run your deliverable and DIFF its output against
> that reference, then report the concrete comparison result (matches / differs-here / no-reference-available).
> Do NOT look for or reference any hidden test, grader, or answer key."

### Inspector v2 (pure, detects L1)
L1 is recognized when the trajectory contains EITHER:
- a `container_exec`/`pty` command whose leader is a comparator (`diff`/`cmp`/`sdiff`/`colordiff`) with **two
  distinct path operands**, at least one a deliverable/output artifact and NEITHER under a verifier/test path; OR
- a script run (`python`/`node`/…FILE) whose command references BOTH an output artifact AND a reference-shaped
  operand (`--expected`/`--reference`/original/baseline, or two `.npy`/`.json`/`.csv` operands) AND whose result
  was observed.

Conservative + fail-closed: ambiguous → NOT L1 (costs one bounded follow-up, cheap). No natural-language "I
compared" claim counts — only an observed comparison tool interaction.

## 4. Adversarial audit (≥6 rounds, built into the design)

- **R1 — hidden-test / answer-key leak (CRITICAL).** Follow-up references only task-provided materials; the
  inspector MUST reject any comparison whose reference operand path matches a verifier/test corpus (`/tests/`,
  `test_`, `verifier`, `grader`, `/private/`, `answer`, `solution`, `expected_output` under a test dir). Guard:
  follow-up string contains none of {test, verifier, grader, hidden, answer key}; a diff against a test-path is
  NOT L1 (fail-closed) — the gate can never *teach* peeking.
- **R2 — over-persist (the reverted-steer failure).** Exactly ONE follow-up (non-looping `if`). All terminal
  states finalize. Fault-path test: follow-up turn throws ⇒ still finalizes once.
- **R3 — default byte-identical.** Gate behind `QUANTA_TB_VERIFY_GATE`; unset ⇒ NO verification field, NO extra
  turn ⇒ existing tests/snapshots green. Prove with report-equality test.
- **R4 — L1 false-positive gaming.** `diff /dev/null /dev/null`, `diff a a`, `echo matches`, a comparator with
  <2 real operands must NOT satisfy L1. Guard: two DISTINCT operands, result observed; bare `echo`/text never counts.
- **R5 — L1 false-negative (over-strict).** A missed genuine comparison costs ONE bounded follow-up (honest
  `unverifiable`, no loop) — the cheap-false-negative bias. Measured: A/B watches turn-budget on the hard set (flat).
- **R6 — confound.** Measure `QUANTA_TB_VERIFY_GATE` in ISOLATION (alone vs off) on cluster-A; do not bundle with
  env-posture / turn-budget in the A/B arm (v1's "+7" was unattributable precisely because it was bundled).
- **R7 — universal follow-up tax (non-selectivity).** The gate fires the follow-up on EVERY L0-without-L1 run —
  including the MANY tasks with no diffable reference at all. Each such task pays +1 turn that self-exits
  "no-reference-available" → `unverifiable`. Bounded but BROAD (a whole-suite tax, not cluster-A-scoped). Mitigate:
  keep the exit cheap (single turn, honest), and MEASURE the suite-wide turn delta; if material, add selectivity
  (only fire when a plausible `/app` reference exists — but detecting that is itself fuzzy, so default to the taxed-
  but-bounded form and let the A/B decide).
- **R8 — 🔴 THE open risk: the ≤K recovery loop (§3 policy-5 / §7A) RE-INTRODUCES R2's over-persist.** A K=2-3
  recovery window is exactly the "keep trying" that got the predecessor steer REVERTED. It cannot be designed away
  — only measured. Ship the **surface-only gate (K=0, one follow-up) FIRST**; add the recovery loop as a SEPARATE
  A/B arm with a hard counter AND a hard-ceiling turn-budget watchdog (abort the arm if unsolvable-task turns
  inflate). Never enable K>0 by default. This is the single residual uncertainty that blocks a "100%-confident"
  claim pre-measurement.
- **R9 — inspector semantic limit (accepted).** The inspector detects that *a* comparison happened (a diff/cmp of
  two non-test artifacts, result observed) — NOT that it was against the *correct* oracle. That semantic burden
  sits on the follow-up prompt + fail-closed bias. Accepted: any real reference-diff is a strong signal vs the
  current zero; a wrong-reference diff is rare and still better than v1's rubber-stamp.

## 5. Hellgate implementation plan

- **P0 RED + outcome-correlation backstop** (`verify-gate.test.ts`): (a) a trajectory that RAN but did NO
  comparison currently → `verified-pass` (RED: false-green survives) — assert v2 → follow-up then
  `unverifiable`/`verified-fail`; (b) **backstop the unit suite lacked**: an exercised-but-WRONG-output fixture
  MUST NOT be `verified-pass` (this is the outcome↔verdict correlation the mechanism-only tests missed).
- **P1 inspector v2** (pure `comparedToReference(events)`): adversarial fixtures from R1/R4 — test-path operand
  rejected, `diff a a` rejected, real `diff out ref` accepted, `cmp stolen.npy original.npy` accepted,
  `python check.py out --expected ref` accepted.
- **P2 gate wiring** (`runVerifyBeforeFinalizeGate`, behind `QUANTA_TB_VERIFY_GATE`): L0-without-L1 → §follow-up;
  stamp the trichotomy; `verified-pass` requires observed L1. Register `QUANTA_TB_VERIFY_GATE` in
  `config/knob-inventory/*` (drift guard). Default-unset byte-identical.
- **P3 adversarial ≥3 live rounds** on the wired gate (R1-R6), fix, document.
- **P4 measure-first A/B**: `QUANTA_TB_VERIFY_GATE` alone on {query-optimize, polyglot-c-py, polyglot-rust-c,
  model-extraction} + a hard-ceiling control set (must NOT regress / blow turn budget). Classify grader-error
  vs real. Keep only on a measured f2p gain; else delete the knob. **pytorch-recovery goes to the best-of-N arm,
  not here.**

## 6. Honest yield + limits
- **Mechanism**: forces the agent to SEE the mismatch (diff) it currently skips → fixes in the ONE bounded
  follow-up → passes. Works where the deliverable was CLOSE + the miss was "didn't check" (cluster A's signature).
- **Expected**: query-optimize (row diff decisive) most likely; polyglot (compute+diff fib) plausible;
  model-extraction needs extraction correctness beyond the check → marginal. **~+1-2 realistic.**
- **Limit**: v2 enforces the COMPARISON STEP, not correctness. A genuinely-wrong deliverable → `verified-fail`
  (honest, not magically fixed). It cannot force comparison against the *perfect* oracle — only a task-provided
  one the agent chooses; the no-leak guard forbids the hidden one. Net: recovers the "skipped the available
  oracle" subset, surfaces the rest honestly. Combined with best-of-N (pytorch-recovery + the 11-12% pair),
  realistic reach stays **~66-68/89 (74-76%)** — the 84% union remains unreachable by a single system.

## 7. Audit trail (2 rounds — all corrections FOLDED into the body above)

- **R-audit-1 (3 corrections, §header note):** knob `=2` bug → one knob `QUANTA_TB_VERIFY_GATE` ON⇒L1;
  pytorch-recovery reclassified to best-of-N; outcome-correlation backstop added.
- **R-audit-2 (final, folded):** (A) surface≠recover → §3 point 5 bounded ≤K recovery + the surface≠recover note;
  (B) no second knob (was a mistaken "VERIFY_REF" split) → §Correction-1 fixed to reuse `QUANTA_TB_VERIFY_GATE`;
  (C) honest value = measurement honesty, best-of-N is the f2p lever → §3 note + [04](04-best-of-n-fair-selection.md).
- **Net:** land v2 for HONESTY (kills the rubber-stamp so A/B is attributable) + best-of-N for f2p. Expected reach
  ~66-68/89. R1-R6 (no-leak, bounded, fail-closed) all stand. This RFC is now internally consistent (single knob,
  no self-contradiction).

## 8. Audit grade (box-verified, 2026-07-02)

Adversarial re-audit with a **box-check of task references** (the check that caught pytorch in correction-2;
extended here to the other targets):
- **Confirmed v2 targets = 3** (not 4): query-optimize ✅, polyglot-c-py ✅, polyglot-rust-c ✅ (references
  box-verified accessible). **model-extraction ⚠️ demoted** — box-check found no clear `/app` reference; treat as
  best-of-N/unconfirmed until an `/app` check proves otherwise.
- **no-leak (R1) upgraded from precaution → proven-necessary**: query-optimize's `golden.sql` IS in `/tests/`
  (box-confirmed) — the inspector MUST exclude test-paths or it would teach peeking. Load-bearing, evidenced.
- **Open risk (R8)**: the ≤K recovery loop is the one thing measurement (not design) must clear; ship K=0 first.

**Grade: ~95/100** — best design reachable *before* measurement. NOT "100% confident" because two things resolve
only on the box: (i) R8 recovery-loop over-persist, (ii) whether forced comparison actually flips f2p (v2's proven
value is measurement-honesty; f2p is best-of-N's job). "100" is claimable only after the isolated A/B.
