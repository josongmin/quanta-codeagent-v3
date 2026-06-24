# jun-24 Wave-2 Handoff — northstar-3 RCA, repro/env infra bottleneck, evidence-packet sprint closeout

**Scope:** what shipped this session (evidence-packet sprint, on `main`), and the discovered
problems + backlog for the next session. Authoritative measurement source:
`.bench-pull/run-1782190012887/` (n=3 full run). Do NOT use the older n=1 `manual-jun23/`
snapshot for conclusions — it confounded an earlier RCA (see "Methodological corrections").

---

## A. DONE this session (closed — on `main`, pushed, engage-verified)

Evidence-packet pipeline: adversarial-audited (2 rounds) → fixed → wired → verified end-to-end.

| Fix | What | Status |
|---|---|---|
| A1 | adaptive router ran on the wrong model → opus-pin (`buildModelPinnedPort` / `buildAdaptiveRouterModelCall`), both drivers | engage-verified |
| A2/B1 | repair owner-evidence was path-only → forced router `localizationCertain:false`. Restored slice (readSource+issueSymbols) AND **ported the missing fix into the PROD apps driver** (two-driver-drift trap) | engage-verified, both drivers + selector path |
| A3 | infra crash mislabeled as `candidate_red` → `execution_failed` via validator outcome producer | engage-verified, both drivers |
| A5 / A5-drain | repro-vote outcome recorded + `drainReproVoteOutcomes()` → `InstanceResult.reproVoteOutcomes` (+ per-instance reset) | wired |
| B5 | module-smoke RESULT receipt → model (command withheld, answer-key fence) | wired via `proofSummaryReceipts` |
| A10 | `selection_explanation` packet re-contracted to `phase_routing` when fed to the router | wired |
| B7 / B9 | candidate edit-surface (touchedFiles/symbols) + candidate-local router facts | wired |
| static-witness A6/A7/B6 | `fromFile` direction consumed, dead `lifecycle-owner` removed, non-Python diagnostic | landed |
| packet cleanup A4/A8/B4/B8 | omitted-count fact, dead-wrapper removal, slice-precision, source-policy typing | landed |
| regression fixes | god-code (`runInstanceOnce` split), naive-cap-slice (`.filter`), driver-parity tests | green |

Commits: `fa7d33f7` (A5/B5/A10 wiring), `57b11e0d` (prod-driver parity reconciliation + ratchet
fixes), Wave-1/2 "done" commits. Plan: `docs/plans/jun-23-evidence-packet-impl-completeness.md`.
typecheck clean; sprint's own tests green.

**Key result:** the sprint is correct and landed, but it did NOT move northstar-3 (still 0/3) —
because the binding constraints there are infra (below the evidence layer), see B.

---

## B. Discovered problems (northstar-3 RCA — grounded in `.bench-pull/run-1782190012887/`)

**northstar-3 = 0/3, three DISTINCT binding constraints (not one).** These are hand-picked
ceiling instances, and "hard for the model" correlated with "hard to even run" → the set is
**confounded as a model-capability instrument**: 2/3 never get a clean shot.

### B1 — django-11138: repro EXECUTION is broken (infra) — **not** pure model ceiling
- `observe/django__django-11138.0.jsonl`: **`python: command not found` ×20**, `No such file or directory` ×2, repeated `/repo-*/reproduce_issue.py` invocations.
- Repro reproduced **4/10**, not 20/20. `summary.json` turns=228, termination = `harness_error` + `empty_patch` (`report.json`).
- Localization is correct (`DatabaseOperations`, right backends) and the oracle is healthy where it runs — but the repro is invoked with a bare `python` that isn't on the sandbox PATH, so the oracle is **noisy/unreliable** for this instance.
- **Implication:** you cannot read "model can't fix" off this instance until the repro actually runs. This is the #1 RCA.

### B2 — django-14315: shared-file COMPLETENESS miss (sprint-adjacent)
- `report.json`: ownerFiles = `[postgresql/client.py, base/client.py, dbshell.py]`. Candidates touched **only `postgresql/client.py`** (×2). `base/client.py` (an owner-family member) is never touched → incomplete patch → `candidate_red`.
- The family is **detected but not enforced**. This is a co-change/completeness gap — exactly the area static-witness override-family / closure co-change / B7 edit-surface exist for.

### B3 — astropy-13033: env/build hole (infra) — user already on it
- `report.json:62`: repro `installed:false`, `exec_failed ×10`, build-module failure (e.g. extension_helpers). Repro never installs → oracle dead → proof-required submits empty.
- The user's `project-env.ts` work targets this. (Earlier "setuptools.dep_util" string was from a stale snapshot — the current run shows a different missing module; verify on rerun.)

### B4 — `validation_fail_tail` head-cut bug (real code defect) — **USER-OWNED**
- `validator.ts:52` extracts failTail as a TAIL (`slice(-N)`), but `repair/llm-evidence.ts:148` re-truncates it with `boundHeadMarker(args.failTail, 1000)` = **HEAD** → the assertion (at the tail) can be cut. Legacy `context.ts:155` keeps the tail (`trimTail`). The repair packet IS on the runtime path (`driver.ts:2610`, `llm-evidence.ts:220`).
- Note: the agent still sees the tail via the `seedText` half of `seedMsg` (`buildRepairContext`), so this is a real inconsistency/defect but NOT a total blinding. **User is building the fix** (typed `ValidationFailureEvidence` SSOT so packet/seed/selection-repair all use one tail serializer; kill per-call-site head/tail decisions). Out of scope for this backlog.

---

## C. Backlog (what to solve next — excludes B4 failTail SSOT, user-owned)

Each: (function) + (why) + (ROI). No heuristics — fixes must be typed contracts / infra
correctness, not keyword/threshold matching.

| # | Item | Why | ROI |
|---|---|---|---|
| **A** | **django-11138 repro-execution RCA** — trace why the sandbox repro is called with bare `python` (`command not found ×20`); route repro through the verified venv/uv interpreter (`buildProjectEnvUvRunArgv` path); add a ratchet forbidding bare `python` invocation | oracle reliability is the foundation of proof-required; until repro runs, "model can't fix" is unreadable. This is the real content of the 11138 "RCA" (not model ceiling) | **highest** |
| **D** | **repro invocation reliability (generalize A)** — verify the bare-`python` breakage is/ isn't 11138-only across the corpus; contract "repro always runs under a verified interpreter" | any python-not-found instance silently invalidates every proof judgement for it | high |
| **B** | **django-14315 shared-file completeness contract** — owner-family is typed (static-witness); enforce "every owner-family member must be touched to be admissible" (or a generation steer toward the missing member) | detected-not-enforced gap; flag-flip won't fix it. Directly in the sprint's co-change area | high |
| **C** | **astropy env-hole verification** — confirm the user's `project-env.ts` materialization closes the build failure on rerun; repro must reach `installed:true` | env-prep incomplete kills the whole proof path; needs a rerun to confirm closure | med (user-driven) |
| **E** | **measurement re-baseline + pick hygiene** — make `.bench-pull` full run (n=3) the authoritative source; gate measurement picks on "repro oracle healthy" (base red + gold green verified), NOT just "hard". northstar-3 is a broken capability instrument | prevents the n=1-snapshot and confounded-instrument errors | hygiene |

**Sequence:** A (+D) first — make the instrument trustworthy. Then B (completeness contract).
C is user-driven (project-env rerun). Only after A/C close can you isolate genuine
candidate-generation/completeness failures from infra noise.

---

## D. Methodological corrections (so the next session doesn't repeat them)

This session produced **three self-retracted over-claims** — all from reading one artifact and
jumping to a whole-set conclusion:
1. "proof oracle is the bottleneck" — WRONG; the oracle is healthy where it runs (`falseNegative=0`); failures are env/exec, not oracle false-neg.
2. "django-11138 = pure timeout/model ceiling" — WRONG; authoritative run shows `harness_error`+`empty_patch`, 228 turns, repro 4/10 with `python: command not found` (infra), not a clean capability miss.
3. "failTail head-cut blinds the model" — PARTIALLY wrong; the tail still reaches the model via `seedText`. It's a real inconsistency, not a total blinding.

**Rules going forward:**
- Use the authoritative full run (`.bench-pull/...`, n≥3), never an n=1 snapshot, to close a set-level conclusion.
- Classify each instance's failure by **termination signal + reproTest + trajectory**, not the report's summary `error` string (it conflates env/exec/timeout/real-miss into one "no submittable candidate" bucket — `jun-20-leaderboard-throttle-miss-confound`).
- A pick only measures model capability if its repro oracle is verified healthy first.

---

## E. State at handoff
- `main`: evidence-packet sprint landed + pushed; working tree had user in-flight (LSP / project-env / fork-experiment) committed under separate provenance.
- Branches: stale merged branches deleted; `recover-thin-surface-loop-hoist` preserves orphaned loop-hoist WIP (separate feature, can't auto-merge — `loop.ts` 3098→16 decomposed on main).
- Authoritative bench artifacts: `.bench-pull/run-1782190012887/` (report.json, closure-diagnostics.json, observe/*.jsonl).
