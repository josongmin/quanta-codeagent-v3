# Wave-2 handoff — repro-oracle reliability + CHA multi-site (jun-23→24)

**TL;DR.** Started from `agentless-v4-proof-clean` scoring **0/3** on 3 SWE-bench Verified picks
(astropy-13033, django-11138, django-14315). Root-caused it to **two untrustworthy oracles**
(env/build + repro), fixed the repro oracle to be reliable (**repro reproduces the bug 40% → 100%**),
and proved the *next* bottleneck is **multi-site fix completeness**. Built a CHA (class-hierarchy)
multi-site steer; it **changes agent behavior** (django-11138: edits 1 backend → 5 backends) but
does **not yet move the score** — it exposed a *third* bottleneck (multi-site execution/convergence)
plus measurement confounds. Score is still 0/3, but for crisp, addressable reasons now.

This doc = what LANDED (validated), what the MEASUREMENTS showed, and the OPEN problems with RCA +
prioritized next work.

---

## 1. What LANDED (validated, in `main`)

All unit/hellgate-validated. Repro/oracle pipeline (P1–P4) is **done — do not re-do**; the bottleneck
moved past it.

| Pillar | What | Pointer |
|---|---|---|
| **P0** env materialization | `[tool.uv.extra-build-dependencies]` injected into repo `pyproject.toml` at sandbox-prep (the `--with` flag is broken under uv 0.11.23). Wired into `withGitSnapshot` (both drivers) + `withCandidatePatch`. | `src/runner/batch/corpus/project-env.ts`, `src/runner/batch/eval/snapshot.ts` |
| **P1** pytest oracle | repro verdict from **pytest exit/JSON-sidecar**, not LLM-printed sentinel (`classifyStdout` deleted). `python <script>`→pytest bridge via `pytest.main([__file__])` footer (`__name__` guard load-bearing). | `src/agent/repro-test/{execute,generate}.ts` |
| **P2** canonical/hardening | repro generation split: **canonical** = core symptom (submit-gate, no over-strictness), **hardening** = adversarial (advisory only). Removed the 75%-FN "EVERY case" demand from the submit oracle. | `src/agent/repro-test/generate.ts`, knob `adversarial-repro` |
| **P3** non-vacuity | calibration also probes the **base** tree; `vacuous` (green-on-base) oracle fails open. | `src/runner/batch/eval/repro-oracle-calibration.ts` |
| **P4** proof-gate fail-open | `computeEffectiveProofRequired` lifts proofRequired when canonical oracle is gold-FN **or** vacuous. | `src/runner/batch/eval/driver.ts` |
| **W2** candidate build-env | `withCandidatePatch({repo})` materializes build-env after apply so the **proof/regression exec** also builds. | `src/runner/batch/eval/rematerialize.ts` |
| **CHA analyzer** | whole-repo **import-aware transitive** class-hierarchy → sibling method-override sites + steer. NOT a base-NAME heuristic (resolves class identity; transitive intermediate bases caught, same-named-different-module bases rejected). | `src/runner/batch/eval/cha-multisite.ts`, knob `cha-multisite-steer` (`QUANTA_BENCH_CHA_MULTISITE_STEER`, default-off) |

Hellgates: `project-env-sandbox-hellgate`, `project-env-snapshot-wiring-hellgate`,
`proof-gate-failopen-hellgate`, `cha-multisite-hellgate` (9 teeth incl. transitive + false-sibling),
+ the repro/vote/calibration suites. Local key-suite sweep was green (191–193 pass, 0 fail) at the
time of writing; the autonomous sweep keeps editing these files — **re-run before trusting**.

---

## 2. Measured results (full-remote box, gpt-5.4, `agentless-v4-proof-clean`)

Repro **oracle reliability** is the clean win (P1+P2):

| instance | repro reproduced — morning baseline | **after P1+P2** |
|---|---|---|
| django-11138 | 4/10 (40%) | **20/20 (100%)** |
| django-14315 | 4/10 (40%) | **20/20 (100%)** |

The oracle now reliably reproduces the bug AND correctly **rejects incomplete fixes** (stays RED until
all buggy sites are fixed). That is why the score is still 0/3 — the gate is honest, the *generation*
is incomplete.

**Proven completeness gap (the keystone finding):** django-11138 — the model's
`mysql/operations.py._convert_field_to_tz` hunk is **byte-identical to gold**, but it **missed the
oracle + sqlite3 sibling backends**. Gold = 4 files
(`mysql/operations`, `oracle/operations`, `sqlite3/base`, `sqlite3/operations`). The model submitted
**mysql only** → perfect repro stays RED → withheld. Correct fix, missing sites = a **completeness**
problem, not a correctness one.

Key run report ids (under `~/Library/quanta-codeagent-v3/bench/full-remote/`):
`report-i-0247c68dc7ed1dbbc` (proof-clean, knob off), `report-i-086bc619a66beebc4` (CHA on,
proof-clean), `report-i-0c49eb863740aeb38` (CHA on, "proof-off" — see Problem #2).

---

## 3. OPEN problems (RCA'd — these are the actual work)

### #1 — CHA over-inclusion: "all overrides" ⊋ "buggy sites" → spiral/timeout  🔴 highest-value
- **Evidence:** CHA-on run, django-11138 ran **322 turns → `timeout` ("agent aborted before
  verification")**, empty_patch. `observe` showed it edited **5 backends** (base, mysql, oracle,
  **postgresql**, sqlite3) vs gold's **3 backends**. postgresql + base/operations are NOT in gold.
- **RCA:** CHA returns *every* override of the method (structurally correct). But postgresql overrides
  `_convert_field_to_tz` with the **correct** (non-buggy) logic (postgres does tz natively), and the
  abstract base defines it. The steer ("apply the same fix to each sibling") made the agent chase
  **non-buggy** sites → wasted turns + churn on correct code → 322-turn spiral → 10-min wall.
- **Root cause:** CHA gives **structure** (where overridden) but not **symptom** (which overrides have
  THIS bug). `gold ⊆ overrides`, strictly.
- **Fix (why + ROI):** couple CHA siblings with **bug-presence** so the steer names only siblings that
  share the buggy pattern — e.g. (a) structural similarity of the sibling's method body to the
  target's *buggy* body, or (b) run the repro per-site and keep only the ones whose RED depends on
  that site. ROI: directly converts the proven behavior change (multi-site attempt) into a *bounded*,
  landable fix → the one lever with a measured path to resolving 11138/14315.

### #2 — `proof-required` env override does NOT beat the preset  🔴 measurement-blocking
- **Evidence:** ran with `QUANTA_BENCH_VERIFY_SELECT_PROOF_REQUIRED=0` but astropy still failed with
  *"verify-select **proof-required mode** produced no submittable candidate"*. The preset's
  `verify-select-proof-required:1` won.
- **Impact:** every "proof-off" A/B this session was secretly proof-on → the clean "does the submitted
  multi-site candidate resolve?" measurement was **never actually run**. This is why CHA's score
  effect is still unproven (candidates keep getting withheld, never graded).
- **Fix (why + ROI):** make an explicit env knob value override the preset value (knob precedence:
  env > preset). ROI: unblocks ALL future A/Bs — without it you cannot measure any
  generation/localization lever cleanly, because proof-clean withholds everything to empty_patch.

### #3 — astropy-13033 build still blocked at `setuptools.dep_util`
- **Evidence:** every astropy run → `reproTest execution_failed`, stderr `setuptools.dep_util`.
  P0 fixed `extension_helpers`; the build then needs `setuptools.dep_util` (removed in setuptools 60).
- **Status:** a `sourceImportShims` (`setuptools.dep_util`→`distutils.dep_util`) was added to
  `project-env.ts` + wired; the **local synthetic build still failed** (real astropy `setup.py`
  imports from `astropy.wcs.setup_package`, unimportable under build isolation). Unverified whether the
  latest shim closes the **real** astropy build on a fresh box.
- **Fix (why + ROI):** either pip-legacy `develop` install (no PEP-660 `build_editable` needed) OR
  a `setuptools/dep_util` shim materialized into the sandbox + correct sys.path. ROI: low (1 instance),
  but astropy is *fully* blocked (repro can't run), so it's a binary unblock.

### #4 — gold calibration `available:false` on the box (P3/P4 inert in full-remote)
- **Evidence:** every full-remote report has `reproOracleCalibration.available=false` →
  `vacuous`/`falseNegative` never computed → P3/P4 fail-open never engages.
- **Note:** `goldPatch` IS loaded (`dataset.ts:308`), so it's a wiring/materialization gap specific to
  the full-remote path (gold doesn't reach `calibrateProofOracle`, or materialize fails on the box).
- **Fix (why + ROI):** thread/verify goldPatch → calibrateProofOracle in the full-remote box path.
  ROI: low for *these* picks (the oracle is correctly rejecting, so there's nothing to fail-open ON),
  but needed for honest FN/FP telemetry across the corpus.

### #5 — multi-site EXECUTION convergence (the bottleneck CHA exposed)
- Even *given* the sites, the model spiralled (322 turns) instead of mechanically applying the same
  diff to each. "Knowing the sites" ≠ "landing the co-change cheaply."
- **Fix (why + ROI):** a **co-edit primitive** — apply one transform across N sites in a single
  bounded action (vs re-deriving per site + re-running the repro each time). ROI: caps the turn blow-up
  CHA introduced; complements #1.

---

## 4. Prioritized next work

1. **#2 env>preset precedence** — unblocks all measurement. Do FIRST; it's tiny.
2. **#1 symptom-coupled CHA** — filter siblings to the buggy-pattern subset. The actual score lever.
   Then re-A/B 11138/14315 (CHA-on vs off) **with proof-off actually working** + a real turn budget.
3. **#5 co-edit primitive** — if symptom-coupled CHA still spirals.
4. **#3 astropy build**, **#4 calibration wiring** — independent, lower ROI.

A/B readout that matters: **submitted patch file-count** (1 → all buggy sites) **+ resolved**. Not
empty_patch (that just means the gate withheld — uninformative until #2 is fixed).

---

## 5. Measurement infra / recipe / gotchas (save the next person hours)

- **Run a 3-pick full-remote:**
  `QUANTA_FULL_REMOTE_ONDEMAND=1 QUANTA_FULL_REMOTE_CONCURRENCY=3 QUANTA_BENCH_PRESET=agentless-v4-proof-clean [QUANTA_BENCH_CHA_MULTISITE_STEER=1] bun run src/apps/bench/cli.ts grade --mode full --allow-remote-secrets --auth-file <token.json> --dataset ~/.quanta/bench-picks/picks3.jsonl`
- **`box up` is the WRONG tool** for a direct run (it's a warm box for the *pool*). `grade --mode full`
  self-provisions + ships token + patch-gens + grades end-to-end.
- **USE on-demand, not spot** — spot got reclaimed mid-run (3/3 lost). `QUANTA_FULL_REMOTE_ONDEMAND=1`.
- **Durable dataset path** — `/tmp` got cleaned between attempt-1 and the auto-retry → "unreadable
  dataset" abort. Keep picks under `~/.quanta/bench-picks/`.
- **Account quota is the #1 confound.** `usage_limit_reached` (Pro plan, ~4-day reset) returns 429 →
  0 turns → spurious 0/3. Re-login via
  `bun run src/apps/bench/cli.ts auth login --auth-label acct-X --auth-file <path> --auth-pool ~/.quanta/auth/bench-pool.yaml`.
  acct-b/c tokens were stale (401) this session.
- **`QUANTA_BENCH_*` forwards to the box** generically (except PRESET/CONCURRENCY/RECORD/REPLAY, set
  explicitly). New knobs reach the box for free.
- **SSH the box:** key is `~/Downloads/pickinstead_korea.pem`, user `ubuntu`,
  `-o UserKnownHostsFile=/dev/null` (IP reuse → host-key churn). SG ingress for :22 is auto-added to
  your current IP by the provisioner — but an SG change to a NEW box / `0.0.0.0/0` is classifier-gated.
- **The box auto-terminates after the run** → `observe/` (per-turn trajectory) is GONE. To RCA a
  spiral, set `QUANTA_BENCH_RECORD_TRAJECTORY=$HOME/quanta/bench-trajectory.jsonl` and fetch it before
  teardown (or it's lost — this is why #1's spiral mechanism is inferred, not replayed).

---

## 6. Process notes / hazards hit
- The autonomous sweep edits the same files concurrently (calibration, project-env, dataset, cha,
  localize-guard). It converged WITH this work (it built the CHA knob/wiring + relative-import
  resolution). **Re-read + re-test before trusting any state here.**
- Worktree agents share the main repo's git stash + object store → a `git stash` for a tsc baseline
  dropped a parallel agent's work (recovered via `git fsck` unreachable commit). Don't `git stash` in a
  worktree. See `[[never-blind-git-stash-pop]]`, `[[worktree-node-modules-hazard]]`.
- Follow-up format here intentionally `(feature)+(why)+(ROI)` per `[[feedback-followup-format]]`.

Related memory: `[[jun-22-evidence-signal-audit-and-v5-seam]]`, `[[jun-20-bestofn-wrong-repro-oracle-root]]`,
`[[jun-20-throttle-swallow-and-measurement-hygiene]]`, `[[jun-16-full-remote-bench-bug-chain]]`,
`[[no-answer-key-regex-heuristics]]`.
