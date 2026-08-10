# FINAL code-grounded audit — efficacy A/B for default-OFF absorbed features

HEAD `c46c60f4e`. Read-only. Question: what measurement infra ALREADY exists, and what is the minimal work to measure ONE absorbed feature's efficacy.

## TL;DR verdict

**No new bench/eval CODE is needed. A full A/B harness already exists end-to-end.** The efficacy A/B is a **purely operational run** (pick preset → launch full-remote → `wave2-ab` on the two report.json). The real catch is a **scoping correction**: most of the "absorbed" features named in the brief (hooks event-breadth, guardian `auto_review`, MCP hot-reload, worktree user-mode, observation kernel) are **NOT reachable from the bench surface at all** — they are interactive/CLI-surface features with no bench knob, so they cannot be measured on SWE-bench. The only aug-02 absorbed features that ARE bench-measurable today are **`subagent`** and **`skills`** (ProposeSkills machinery).

## (1) Inventory of existing measurement infra (file:line)

- **Knob A/B mechanism (SSOT):** `src/runner/knobs/presets.ts` — named, frozen, versioned presets; each is a `knob-id → string` map applied as lowest-priority overlay (`presets.ts:1-26`). `baseline: {}` is byte-identical to no-preset (`presets.ts:49`). Env var always wins over preset (documented layer precedence in `resolve.ts`).
- **A/B baseline pairs already authored:** `agentless-v1` vs `agentless-v1-nosteer` (`presets.ts:57-85`) is an explicit single-variable A/B pair; the closure `control`/`repair`/`tuned` triple (`presets.ts:141-203`) is a 3-arm attribution design. Same pattern is reused for any new flag.
- **`everything` preset carries subagent+skills for A/B** (`presets.ts:380-388`): `subagent:"1"`, `skills:"1"` — comment at `presets.ts:56` says agentless-v1 "Excludes subagent/skills deliberately — no measured win yet; those live in `everything-v1` for A/B." This is the pre-declared A/B arm for exactly the two bench-reachable absorbed features.
- **Bench knob defs:** `src/runner/knobs/knobs/` (~60 knobs). `subagent.ts:19` surfaces = `["bench"]`; `skills.ts:18` surfaces = `["bench","agent-batch","agent-interactive"]`. Registered centrally via `register-bench-knobs.ts`.
- **Run entry / preset selection:** `src/apps/bench/cli.ts` — subcommand dispatcher; `run` subcommand (`cli.ts:111`), `--preset` flag, selector precedence `QUANTA_BENCH_PRESET > QUANTA_BENCH_SOTA > QUANTA_KNOBS_PRESET > --preset` (`cli.ts:92-93`). `bun run bench` = `src/apps/bench/cli.ts` (package.json:57).
- **Grader:** official python harness `swebench.harness.run_evaluation` wired in `src/apps/bench/python-swebench.ts:9,411,464-470`; local `testCmd` fallback (`dry-run.ts:78`). SERIAL grading enforced (concurrent grading = false-negatives, `full.ts:223`). Note memory: swebench==2.1.6 `--namespace` removed; Apple-Silicon recipe = prebuilt namespace + max_workers=1 + local dataset.
- **report.json = SSOT, resolve-rate delta:** `src/apps/bench/run-report.ts:28-41` (per-instance verdict FAIL/degraded/env_prep_failed/grader_invalid), `run-report.ts:64-68` (`resolved/total (pct%)`), `resolvedTotals`/`scoreTotals` from `./observe`. `resolved_ids` persisted in report meta (`analyze.ts` reads `meta.resolved_ids`).
- **Built-in A/B delta tool:** `quanta-bench wave2-ab <control-report.json> <treatment-report.json> --control-predictions … --treatment-predictions …` (`src/apps/bench/commands/analyze.ts:108-133`, `renderWave2AbMarkdown`/`buildWave2AbRail`). Companion `wave2-coverage`, `wave2-backlog`, `leaderboard`, offline `bestk-passk` ceiling analyzer (`analyze.ts:180+`).
- **Full-remote/EC2 canonical path:** `src/apps/bench/remote/full.ts` — `runFullRemoteAttempt` (`full.ts:491`), `--preset` forwarded verbatim to the box (`full.ts:217,297,423,485`), `--grade-backend local`, SERIAL grading. Pool/auth/box-session/ec2 all present under `src/apps/bench/remote/`. Full-remote forwards `--preset` ONLY (this is exactly why the nosteer A/B baseline is a preset, not an env var — `presets.ts:70-73`).
- **Frozen picks-N sets + costs:** `tests/smoke/swebench/` — `picks-3.jsonl` (~10min/$0.30), `picks.jsonl` (6, ~25min/$1), `picks-10.jsonl` (10, tier-stratified for A/B, ~60min/$2/trial). README documents the record→certify→gate model.

## (2) Verdict: new CODE needed? — NO (for the measurable subset)

For `subagent` and `skills` the entire loop is built: preset overlay → CLI `--preset` → full-remote forward → official grader → report.json resolve-rate → `wave2-ab` delta. **Zero new code.** Running the A/B is `config + launch + compare`.

CODE **would** be needed only if you insist on measuring a feature that has no bench knob today (hooks/guardian/mcp-hot-reload/observation-kernel/worktree-user-mode). Those would each require: a new bench-surface knob + schema + an apply that wires the feature into `AgentConfig` on the bench path. But that is arguably out-of-scope / measure-first-violating: `hooks.ts:6-9` explicitly excludes bench "because the hook bus changes dispatch timing + can rewrite tool input, which is a measurement-altering channel; bench callers stay byte-identical." I.e. the codebase deliberately kept these OUT of bench. Recommend NOT building bench knobs for them — they are interactive-UX features whose "quality" is not a SWE-bench resolve-rate quantity.

## (3) Minimal concrete experiment (single highest-value default-OFF feature)

Highest-value **bench-measurable** absorbed feature = **`subagent`** (Tier-1 subagent system; the most plausible resolve-rate lever, and the pre-declared A/B arm exists). Isolate it single-variable — do NOT use `everything` (it flips subagent+skills+localize-phase+branch-search together and confounds).

Steps (operational only):
1. Add a one-line single-variable treatment preset locally (a config edit, not new machinery) = `agentless-v6-singlepass-execfull` + `"subagent":"1"`. The measured-winner baseline is `agentless-v6-singlepass-execfull` (`presets.ts:96-107`). This mirrors the existing `agentless-v1` vs `agentless-v1-nosteer` single-variable pattern.
2. Control arm: `--preset agentless-v6-singlepass-execfull`. Treatment arm: `--preset <the +subagent preset>`. Dataset = `tests/smoke/swebench/picks-10.jsonl` (tier-stratified, ~$2/trial).
3. Run both via full-remote SPOT box (`src/apps/bench/remote/full.ts`), SERIAL grading, official harness. Emit `--report` + `--predictions` per arm.
4. `quanta-bench wave2-ab control-report.json treatment-report.json --control-predictions … --treatment-predictions …` → resolve-rate delta.

Caveat: picks-10 n=10 is a smoke/signal set, not a significance-grade sample — treat a delta as directional. For a real ship decision, re-run on the fuller Verified corpus (`bench:verified`, package.json:59). Memory warns n=1/small-N loop changes without measurement; a 1-trial picks-10 delta is a screen, not proof.

## (4) Blockers

- **Auth (recurring #1 crater):** box needs a fresh `~/.codex/auth.json` scp'd (rotated refresh_token → server-side 401 → brain crashes ~25s "no API key", scores 0/N and masquerades as a lever). Pre-flight auth canary required (`reward=1 && runtime>100s`) before trusting any arm. Delete stale `chatgpt.json` on box.
- **Box = SPOT, always** (on-demand is a manual-CLI trap); `stop` when idle; restart changes IP + re-triggers auth canary. Right-size by RAM/$ not vCPU (`-n = RAM/~3GB`); `-n` change needs supervisor restart, not just a file sed.
- **Grading must be SERIAL** (concurrent = false-negatives) and needs a Docker-capable host for the official harness; Apple-Silicon uses the prebuilt-namespace + max_workers:1 recipe.
- **Long runs must use a self-heal supervisor**, not `nohup … &` (env reaps background ~15-20min → orphaned box); auto-rsync results to local (don't leave artifacts on box).
- **Confound hygiene:** single-variable preset only (not `everything`); classify ❌ into real-miss vs throttle(429)/empty-patch before reading the delta (`perInstance.error`/`patchBytes`).
- **NOT a blocker:** no missing harness, no missing knob-flip mechanism, no missing grader, no missing delta tool — all built.

## Scoping correction (do NOT over-build)

Of the brief's named absorbed features, bench-reachable = **`subagent`, `skills` only**. `hooks` (`hooks.ts:19,30` surfaces cli+agent-batch, explicitly not bench), guardian `auto_review`, MCP hot-reload, worktree user-mode, observation kernel = **no bench knob** (grep of `src/config/knob-schema/` and `src/runner/knobs/` returns nothing for observation/auto_review/mcp-hot-reload). Measuring those on SWE-bench would require building new bench knobs AND is contra the codebase's own byte-identical-bench stance — recommend leaving them as interactive-surface features judged by UX, not resolve-rate. The one true efficacy experiment worth running now is subagent (then skills) via the existing full-remote + wave2-ab path.
