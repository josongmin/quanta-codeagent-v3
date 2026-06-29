# Handoff — jun-29 agent-1 (SWE-bench oracle lever + sphinx recovery)

Split-brain note: multiple agents active. **2 EC2 boxes were running at handoff time that
may belong to ANOTHER agent — do NOT terminate without checking.** All my work is committed
(hashes below). Branch: `feat/swe-bench-multi-dataset` (HEAD `dd8656b6f`); my code/leaderboard
fixes are also on `origin/main`.

---

## 1. WHAT WAS DONE

### A. sphinx -rA grader fix (origin/main, landed)
- **Root**: sphinx `test_cmd = tox -epy39 -v --` — the `-v` is TOX verbosity, NOT pytest, so the
  inner pytest prints only `1 passed` (no per-test `PASSED <id>` lines) → swebench parser →
  false-unresolved (grader_invalid) → discards correct patches; **even GOLD came back resolved=0**.
- **Fix** (`c89504d84`): `buildArgv` runs the harness via `python -c <SPHINX_RA_SHIM>` that appends
  `-rA` to tox `--` test_cmds. Box-verified gold 0→1. Also wired into the ssh grade-only path
  (`ssh.ts`, base64 shim, drift-proof test). e2e test fixed (`4780b70d7`/`9e6eab085` — the stub
  routed `python -m`, now routes `-c` on `case *run_evaluation*`).
- **Result**: recovered **18 sphinx net-new** (cluster 8595/8265/9658/9711 + sweep 14/24), all
  GENUINE (our patch ≠ gold byte, turns>0, our-file==gold-file verified). Folded to
  `docs/swebench-leaderboard.yaml` + SSOT dashboard (port 7878).

### B. box-reuse stale-code self-heal (origin/main, landed `ff9571c85` + `83987edbd`)
- `attachBox` reused a warm box WITHOUT re-syncing → graded with old src (this masked the sphinx
  fix once). `src-sync-guard.ts`: `ensureBoxSrcCurrent` (checksum rsync + `--delete`) +
  `ensureBoxConfigCurrent` (config drift → `bun install`). 3-round adversarial audit, 147 tests.

### C. patch hygiene (origin/main `bd2a7a1ad`, feat `54d728162`)
- `.quanta/tool-output` leaked into source-only patches (bloated sphinx-8638 to 445KB). Added
  `.quanta` to `DEFAULT_CACHE_DIR_NAMES` (`cache-pathspecs.ts`) — pruned at git-pathspec layer.

### D. competitor-gap probe → THE LEVER (the main thread)
- Ran the v6-singlepass config on competitor-solved-but-not-ours instances: **~3 net-new total**
  (sympy-21379, django-16560, astropy-13236); the hard tail = ~0. This (with measurement bugs
  removed) locks our gap = **synthesis convergence**, not localization.
- **competitor-study corpus** (`docs/analysis/competitor-study/`, feat): 23 of our fails that open
  scaffolds solved — competitor.diff + gold.diff + ours-FAIL.diff. Signatures:
  **under-edit** (django-11265: fix symptom, miss root cause) + **wrong-predicate** (sympy-23413:
  right structure, wrong condition). Both plausible-on-read but fail the test.
- **oracle loop infra ALREADY EXISTS** (`repair/index.ts`, gated by `closure-repair`). The validator
  runs the **AGENT'S OWN repro** (`validator.ts:4-7`), NOT the official FAIL_TO_PASS (that would be
  answer-key gaming) → oracle signal capped by repro quality.
- **Built (hellgate) the preset arms** (feat):
  - `agentless-v6-oracle` (`cb1a8ceb3`) = closure-tuned (closure-repair + repair-spec-gate) +
    **repro-grounding** (the audit-found prerequisite). All 3 knobs LIVE-wired (driver:5180/3558/1902).
  - `agentless-v6-oracle-hardened` (`dd8656b6f`) = oracle + **repro-vote + repair-strong-oracle**
    (PUBLIC-only: repro-vote.ts:13 / strong-oracle.ts:33 never read FAIL_TO_PASS).
- **Pilot RUN** (django-11265 + sympy-23413, on-demand): **0/2 official.** BUT the real finding ↓.

### E. oracle pilot finding + diagnostic patch (feat `c594a6023`)
- **LOCKED FINDING**: NOT "the oracle didn't run" — it's `oracleGapFalseGreen`: the agent-side
  canonical oracle CLEARED the repair gate (`repairValidationDecision = {canonical-sidecar,
  issueResolved:true, adoptable:true}`) but the OFFICIAL harness graded `resolved:false` (0/2).
  **The agent's repro is WEAKER than the held-out FAIL_TO_PASS.** Evidence:
  `~/Library/quanta-codeagent-v3/bench/full-remote/report-i-02e423634a4bd8eb4.json`.
- **Patch**: serialized the typed-but-dropped `verifyRounds`/`primaryFalseGreen`/`primaryFalseRed`
  + derived **observe-only** `oracleGapFalseGreen` (computed from already-graded fields; NEVER fed
  into repair selection — no official-test leak). 5 tests, report.ts tsc 0.

---

## 2. WHAT'S NEXT

### NEXT = the A/B RUN (quota-blocked, NOT more solver code)
Control `agentless-v6-oracle` vs treatment `agentless-v6-oracle-hardened` on the regression set
`docs/analysis/oracle-ab/oracle-regression-set.jsonl` (15 synthesis targets + 7 controls).
**Compare**: `oracleGapFalseGreen` rate (now serialized) + `officialHarness` resolved + round/turn
cost. Hypothesis: PUBLIC oracle hardening (repro-vote consensus + declared-expected match) cuts the
false-green without leaking.
- **MUST use on-demand**: `QUANTA_FULL_REMOTE_ONDEMAND=1` — the long multi-round oracle runs got
  spot-reclaimed twice (LOST 2). Oracle runs are ~30-50min/instance.
- Pilot first (django-11265 + sympy-23413) before the full set.

### DO NOT (discipline — avoids blind search)
- Do NOT touch patch-reduction / localize / evidence-expander yet — the data says synthesis
  convergence, and the next move is MEASURED (the A/B), not guessed.
- Do NOT feed the official FAIL_TO_PASS into the repair loop (answer-key gaming). `oracleGapFalseGreen`
  is observe-only by construction.
- Do NOT claim canonical-0..4 are repair rounds (they are repro candidates, `driver.ts:1779`);
  do NOT claim "N rounds" from trajectory grep — use the now-serialized `verifyRounds` field.

### Open follow-ups (lower priority, evidence-based)
- 16 orphan QUANTA_* knob reads fail the registry ratchet (cost/budget/host-monitor — NOT mine,
  someone else's uncommitted work). Pre-existing.
- `tools/pro-measure-report.ts` + `driver-infra-hole.test.ts` have pre-existing tsc errors (others').

---

## 3. NOTES / GOTCHAS

- **Branch split**: my code+leaderboard on `origin/main` (`bd2a7a1ad`); analysis + oracle presets +
  diagnostic patch on `feat` only (`dd8656b6f`). e2e fix + .quanta prune cherry-picked to main via
  a temp worktree (feat working tree untouched). Reconcile on feat→main merge.
- **Account quota**: chatgpt-oauth Pro **usage limit** is the real blocker — heavy runs empty-patch
  (`patch=0B turns=0`) after ~5 instances; re-login restores the TOKEN but not the QUOTA. Watch for
  it on the FIRST bad signal (DEAD flag / 429 / "usage limit reached" / empty-patch streak), not at
  the end. (I failed this once — alert proactively.)
- **Spot vs on-demand**: long oracle runs → on-demand. `QUANTA_FULL_REMOTE_ONDEMAND=1`.
- **zsh word-split**: `aws ec2 terminate-instances --instance-ids $IIDS` (tab/space var) silently
  fails in zsh — use inline IIDs or `$(echo $IIDS)`.
- **Box reuse self-heal is live** — a reused box auto-rsyncs current src on attach (so preset/code
  changes propagate). Fresh boxes rsync the working tree.
- **Evidence locations**: per-instance grade = SSOT report `report-i-<box>.json` (has knobs.preset,
  gradeBreakdown, repairValidationDecision, reproTest, and now verifyRounds/oracleGapFalseGreen).
  Trajectories + repro outcomes = `observe-i-<box>.tar.b64` (`base64 -D | tar xz` →
  `run-*/repro/<inst>/canonical-N/outcome.json`). Both in
  `~/Library/quanta-codeagent-v3/bench/full-remote/`.
- **Memory**: `jun-29-gap-essence-synthesis-convergence-bottleneck.md` has the full chain (gap
  essence → corpus signatures → oracle preset landing → pilot oracleGapFalseGreen finding).

---

## Commit index (mine)
- origin/main: `c89504d84` sphinx-rA, `ff9571c85`+`83987edbd` self-heal, `4780b70d7` e2e fix,
  `bd2a7a1ad` .quanta prune, leaderboard folds.
- feat: `cb1a8ceb3` oracle preset, `dd8656b6f` oracle-hardened, `c594a6023` diagnostics+oracleGap,
  `b946e037c` corpus conclusion, `4ddb47204` corpus.
