# RFC: Verify-before-finalize gate (Terminal-Bench "fake green" fix)

**Date:** 2026-07-02 · **Status:** proposed · **Trigger:** TB full-89 review — CLAIMED-DONE is ~70% of failures
**Lever #2 of 2** (see [README](README.md)). Independent of [01-env-posture](01-env-posture-rfc.md).

## Problem

The dominant TB failure mode (~30 of ~42 failures) is **fake green**: the agent emits a final report claiming
*implemented / verified / green*, but the hidden verifier rejects it. The agent verified a **weak proxy** — "the
file exists", "it compiled", "exit 0 on the thing I chose to run" — not the task's real acceptance criterion.

Ground truth (finals read from the full-89 run):
- `path-tracing-reverse` (25 turns): *"verdict GREEN … Rendering complete … Wrote image to image.ppm"* — it
  rendered AN image but never diffed its output against the reference binary `/app/mystery`. The task is
  output-byte-equality; the agent checked "it runs", not "it matches".
- `configure-git-webserver` (9 turns): *"I created the requested server-side pieces …"* — created the repo + hook,
  but `test_hello_html_exists` failed; it never exercised the post-receive path end-to-end to confirm the artifact
  materialized.
- Pattern: **the agent proves *existence/execution*, the verifier checks *behavior against spec*.** Top-tier
  scaffolds close this by *exercising the deliverable end-to-end* before stopping.

## Why the obvious fix ("verify before submit" steer) is NOT enough — it was already reverted

`src/tool/terminal-capability-guide.ts:14-17` records: *a measure-to-gate / verify-before-submit / no-overfit
steer was tried here and REVERTED — zero solve-flips and it made the agent over-persist (an unsolvable task ran
~3× longer for no gain). Net-negative at n=1.* The operator guide already says *"Verify before declaring done"*
(line 28) and it doesn't work: it's a soft prompt line on the user turn, and a blanket "verify harder" makes the
agent thrash on the ~7-12 genuinely-unsolvable tasks (burning the turn budget) while not helping the solvable ones.

**Design consequence:** lever #2 must be **structural and selective**, not a stronger steer:
1. **Structural** — a gate the harness enforces at report time (evidence-checked), not a sentence the model may ignore.
2. **Selective** — escalate verification only where an oracle is *constructible* from the spec; do NOT ask the
   agent to keep trying on tasks it has already shown it cannot verify.
3. **Bounded** — a hard persistence budget so the gate can never produce the reverted steer's over-persist.
4. **Honest** — a verified-pass / verified-fail / **unverifiable** trichotomy; "unverifiable" is an accepted,
   non-penalized terminal state (this is what stops over-persistence).

## Design: a pre-report verification gate in the brain

The brain (`src/apps/terminal/brain-mode.ts` `runTerminalBrain`) drives the loop, then `writeReport(path, report)`
and signals EOF. Insert a gate **between loop-end and writeReport**:

- Before the report is accepted, the run must carry **evidence of an end-to-end exercise of the deliverable** —
  at least one tool interaction in the trajectory that (a) invokes the actual thing the task asks for (runs the
  binary / hits the server / executes the produced script against the given inputs) and (b) checks its output/
  behavior, not merely its existence. The brain already captures the event stream (`CapturingStream`), so this is
  an inspection over recorded tool calls, not new model capability.
- **The exercise contract MUST span BOTH terminal tools (review P1):** the surface is `container_exec` + `pty_*`
  (`src/apps/terminal/index.ts:37`), and the surface contract deliberately routes interactive work (REPL / TUI /
  long-lived server) to `pty_*` while `container_exec` handles one-shot commands
  (`src/tool/terminal-capability-guide.ts:23`). A container_exec-only inspector would mis-flag a genuinely
  exercised REPL/TUI/server as unverified. The inspector counts evidence from EITHER tool: a `container_exec` that
  runs+checks output, OR a `pty_*` session that drives the interactive deliverable and observes its responses.
- If no such evidence exists, the gate injects ONE bounded follow-up turn: *"You are about to finalize. Exercise
  your deliverable end-to-end against the task's success criterion and report the observed result (pass / fail /
  could-not-verify)."* — a single, budgeted nudge, not an open loop.
- The report gains a typed `verification: { state: "verified-pass" | "verified-fail" | "unverifiable", evidence:
  string }`. `unverifiable` finalizes immediately (no over-persist); `verified-fail` finalizes too (honest — better
  than a false green, and it surfaces the real state for analysis).

### Selectivity & budget (defeats the reverted steer's failure mode)
- The follow-up turn fires **at most once** and only when the trajectory shows no end-to-end exercise. It cannot
  loop. On the unsolvable tasks the agent replies "could-not-verify" → finalize. So the ~3× over-persist that
  killed the prior steer is structurally impossible.
- No task-specific hints (no answer-key): the gate asks the agent to exercise the deliverable against *the spec it
  was already given*, never against the hidden test. (Honors `no-answer-key-regex-heuristics`.)

## Scope: philosophically sticky-red, but code-wise a NEW terminal classifier (review P2 — do NOT undersell)
- The *idea* mirrors the SWE-bench "don't accept until verified" concept (`QUANTA_BENCH_MUST_PASS=sticky`,
  `jun-27-11141` memory). But the existing `verify-guard` machinery **cannot be reused as-is**: its `isVerify`
  only recognizes the `test_runner` tool or a `bash` test-like command (`src/agent/verify-guard.ts:152-157`), and
  its "mutating" notion is FS edit tools (`src/agent/mutating-tools.ts:21`). The terminal brain has **none** of
  these — no `bash`, no `test_runner`, no FS edit tools; only `container_exec`/`pty_*` — and it does not wire
  `verifyGuardConfig` at all (`brain-mode.ts:136` sets it `undefined`). So this is honestly **new work: a
  terminal-specific exercise classifier + a bounded follow-up gate**, not a reuse of the existing guard. (The
  existing guard is a design *reference* for the sticky-red philosophy, not a code dependency.)
- The operator guide's existing "verify before declaring done" line is *promoted and made concrete* by the gate;
  when lever #1 lands, the OWNED_ENV_RULES install-on-demand text and this verify text sit together at system
  priority (no longer undercut by R-ENV).

## Plan (phased, hellgate)

### Phase 0 — Hellgate RED
- Using the existing `FakeLlm`/`CapturingStream` in `brain-mode.test.ts`: script a run whose trajectory only
  *creates* an artifact (no end-to-end exercise) and assert the report today is accepted as-is (RED). Assert
  (target) that the gate injects exactly one follow-up and stamps `verification.state`.

### Phase 1 — Evidence inspector (pure)
- A pure function over the recorded event stream → `{ exercised: boolean, evidence?: string }`: does any
  `container_exec` OR `pty_*` interaction both run the deliverable and observe its output/behavior (review P1)?
  Leaf, unit-tested against fixtures for both tools; no model calls.

### Phase 2 — The gate (in `runTerminalBrain`, default-OFF)
- Wire the inspector before `writeReport`; on `!exercised`, run one bounded follow-up turn; stamp
  `verification` on the report. Behind a knob (`QUANTA_TB_VERIFY_GATE`, default-OFF ⇒ byte-identical today).
  Register the knob in `config/knob-inventory/*` (drift guard).

### Phase 3 — Honesty trichotomy + budget cap
- `unverifiable` / `verified-fail` finalize immediately; hard cap of ONE gate turn; a global turn-budget check so
  the gate never fires if the run is already at budget.

### Phase 4 — Adversarial audit ≥3R + structural TDD
- No over-persist: prove (test) the gate adds ≤1 turn and cannot loop.
- No answer-key leak: the follow-up prompt references only the task's own spec, never the verifier.
- No-regression: default-OFF byte-identical; SWE-bench path untouched (this is terminal-surface only).

### Phase 5 — Measure-first A/B (must beat the prior reverted steer)
- A/B `QUANTA_TB_VERIFY_GATE` on the CLAIMED-DONE subset (path-tracing-reverse, configure-git-webserver, and the
  solvable-by-top-tier cases). Success = f2p flips on solvable tasks **without** a turn-budget blowup on the
  hard-ceiling tasks (the metric the prior steer failed). Classify grader-error vs real per the
  `leaderboard-throttle-miss` protocol. Kill the knob if it doesn't beat baseline (it lost once already).

## Non-goals / guards
- Not a re-run of the reverted blanket steer — this is a bounded structural gate with an honest exit.
- No hidden-test access, no answer-key hints (`no-answer-key-regex-heuristics`).
- Terminal-surface only; SWE-bench acceptance path unchanged.
- Default-OFF byte-identical until measured (hard invariant).

## Open question
- Does the evidence inspector generalize across task types (a rendered-image diff, a server handshake, a script
  run, an interactive REPL/TUI flow) without becoming a per-task heuristic? If it can only reliably detect "ran the
  deliverable at all" (not "checked output correctly"), the gate degrades to "did you run it once" — still better
  than nothing, but the A/B must confirm that weaker signal moves f2p. Resolve during Phase 1 by classifying the
  CLAIMED-DONE finals: how many *ran* the deliverable but mis-checked, vs never ran it at all, vs require PTY-only
  evidence the first inspector cannot yet score.
