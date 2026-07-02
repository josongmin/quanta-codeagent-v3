# Ticket — Finish SWE-bench-Live + Terminal-Bench end-to-end

- **Date:** 2026-07-01
- **Status:** Track A (A1/A2/A5) LANDED on `feat/swe-bench-multi-dataset` (hellgate + parallel hellaudit ×2 HOLDS); A3/A4 deferred; Track B (Terminal-Bench) pending box phase.
- **Provenance:** 2 read-only adversarial+objective audit agents (Terminal-Bench adapter; Live setup) + direct re-verification of the load-bearing claim (gap A1 confirmed at `full.ts:477` / `pool.ts:83`). De-duplicated against existing code — see **ALREADY DONE**.
- **Goal:** quanta can RUN + officially GRADE (and for Live, SUBMIT) on both benches, without rebuilding what already exists.

> Strategy frame (not in scope to change here): coding home stays the SWE-family (Verified / Pro-dataset / Live). **Live** = contamination-free signal, run on full-remote/ssh; sparse leaderboard ⇒ easy PR. **Terminal-Bench** = general-terminal axis (NOT coding) but scaffold-competitive + community gold-standard; exercises quanta's CORE loop, not the SWE machinery.

---

## ALREADY DONE — do NOT rebuild (anti-duplication)

**Live**
- Dataset-family seam (`verified|live|pro`): `dataset-family.ts` resolve/parse/grade-routing. Live parse ≡ Verified identity (`dataset-family.test.ts`). REAL.
- Patch-gen for live: `prepareTaskRepo` clones arbitrary GitHub repos at base_commit (bare-mirror + shallow-deepen, `corpus/dataset.ts:222-301`); repo-agnostic pytest testCmd fallthrough (`dataset.ts:402-452`). **REAL — no verified-only assumption.**
- Grade full-remote box/pool: Live-fork pip-spec + `starryzhang` namespace wired **via env** (`ec2-lifecycle.ts:441-450` + warm-box self-heal `:91`; `box-session.ts:376` namespace, `:160/164` forwards `QUANTA_SWEBENCH_DATASET_FAMILY`/`_NAME`).
- Grade ssh grade-only: family-aware (**commit `5a90b2cb7`**) — `GradeOptions.family` → `buildRemoteGradeScript(maxWorkers, fromSpec, namespace)` (`ssh.ts:102-129,196-206`), `cmdGrade` reads `--dataset-family` (`grade.ts:270`). Tests incl. red-on-injection (`ssh-grade-script-sphinx-ra.test.ts`).

**Terminal-Bench**
- Protocol core: `quanta_terminal_bridge/serve.py` + `protocol.py` (line-delimited JSON exec/cancel) + TS cross-end parity with `src/tool/container-exec/ipc-backend.ts` (`containerExecOverIpc`) + golden corpus. **21/21 tests.** REAL.
- RFC `docs/rfc/jun-29-rfc-terminal-bench-integration.md`: **P1 + P2a + P2b-bridge LANDED**.

---

## Track A — SWE-bench-Live: close the gaps (small; A1/A2/A5 need NO box)

> **LANDED (jul-01):** A1+A2+A5 done on `feat`. `bridgeDatasetFamilyToEnv` (dataset-family.ts) wired at `cli.ts main()` + the legacy `run-main.ts` entry (closes the direct-`index.ts` bypass both audits flagged); `localLiveGradeRefusal` (python-swebench.ts) guards local-Live (box-safe — box always sets a non-empty namespace via the total `resolveSwebenchNamespace`; fail-closed = infra-fail, never false-PASS); help documents the flag. Tests: bridge clobber/no-clobber + refusal box-safe + live-row parse + ssh-grade family — 77/0; tsc/biome/src-no-sketchy clean. Two adversarial audits (A1 chokepoint/order/forward/non-regression; A2 box-safety/false-pos-neg/fail-closed) both **HOLD**.

### A1 — [HIGH / footgun] `--dataset-family` is a SILENT NO-OP on full-remote/pool
- **Symptom:** `quanta-bench grade --mode full --dataset-family live` is silently graded as **Verified** → KeyError / mis-grade on Live repos. Only `export QUANTA_SWEBENCH_DATASET_FAMILY=live` works today. Asymmetric with the ssh path (which reads the flag).
- **Where (verified):** `remote/full.ts:477` and `remote/pool.ts:83` resolve `resolveDatasetFamily(undefined, process.env)` — `undefined` ⇒ CLI flag dropped. `cmdGradeFullRemote` (`commands/grade.ts` ~100-169) never reads `argValue("--dataset-family")`.
- **Fix:** resolve `family = resolveDatasetFamily(argValue("--dataset-family"), process.env)` at the CLI command (`cmdGradeFullRemote`, mirroring `grade.ts:270`) and thread it into `full.ts` / `pool.ts` instead of their internal `undefined` resolve. (Env still wins as fallback; operator override semantics unchanged.)
- **Done-criteria:** `--mode full --dataset-family live` resolves live without env; unit test pins flag→family on the full-remote/pool entry.
- **Dup-check:** only `run-main.ts:370` + `grade.ts:270` read the flag today; full/pool do NOT ⇒ not a duplicate.

### A2 — [MED] local Docker grade of Live: raw KeyError, no guard
- **Where:** `python-swebench.ts:446` (host stock `swebench`), `harness/arch.ts:41` (`defaultNamespace()` never `starryzhang`). Live resolvers never called locally.
- **Reality:** local-arm64 grade of Live is **infeasible** (starryzhang images are amd64) — do NOT try to make local grade Live.
- **Fix:** detect `family==="live"` on the local grade path → **fail-loud** with guidance ("Live grading needs a remote amd64 backend / the SWE-bench-Live fork — use `--backend ec2|ssh` or `--mode full`"), instead of a cryptic KeyError. Fail-closed (never a fake PASS) is already the behavior; this only improves the message.
- **Done-criteria:** local live grade prints the guidance + exits non-zero; no silent-wrong.

### A5 — [LOW] `--dataset-family` undocumented in CLI help
- **Where:** `apps/bench/cli.ts` help block (documents `--dataset` but not `--dataset-family`).
- **Fix:** add `--dataset-family <verified|live|pro>` to the help text.

### A3 — [OPTIONAL] no HF auto-fetch of Live instances
- **Where:** `run-main.ts:629` accepts only a local JSONL.
- **Decision:** defer. Operator supplies the Live JSONL (pin a monthly snapshot for reproducibility). Revisit only if a one-command Live pull is wanted.

### A4 — [LOW / latent] `--prepare-images` hardcodes Verified
- **Where:** `run-main.ts:357` (`princeton-nlp/SWE-bench_Verified` + stock `prepare_images`). Not wired into remote/pool ⇒ bites only a manual `run --prepare-images --dataset-family live`.
- **Decision:** defer (latent). Make family-aware only if someone uses local image prep for Live.

### Track-A test gap
Current Live tests are resolver/parse-level only. Add ONE test asserting the **full-remote box command string** for `family=live` carries `starryzhang` + the Live fork (mirror the ssh-grade family test) so A1's wiring can't silently regress.

**Track A verdict:** Live is ~90% done. A1 (footgun) + A2 (guard) + A5 (doc) + the box-command test = "Live setup done well", **all landable today without a box.**

---

## Track B — Terminal-Bench: build to runnable (box-dependent; RFC P2→P4)

Ordered by what's needed first (audit + RFC). **Everything from B1 needs a box to verify** (Docker/Harbor) — do NOT start without one (can't validate locally). Build ON TOP of the existing protocol core — do not touch it.

- **B1 [BLOCKER]** implement `QuantaAgent.run()` — `adapters/terminal-bench/quanta_agent.py:77` is `raise NotImplementedError("P2 box phase")`. Spawn the quanta brain subprocess, adapt its stdin/stdout into `serve(lines, write, adapter)`, populate `context` (tokens/cost/trajectory).
- **B2** implement `QuantaAgent.setup()` — `quanta_agent.py:61` (empty `return None`): install/verify the quanta brain binary in/alongside the container.
- **B3** brain-side duplex: a quanta CLI **"brain mode"** that drives the agent loop emitting the JSON-line exec frames + a production caller of `containerExecOverIpc` (`ipc-backend.ts:38`, currently **0 callers**).
- **B4 [LANDED `80fe6bbad`, box-INDEPENDENT]** `src/apps/terminal/` composition root — `assembleTerminalSurface(deps)` / `terminalSurfaceOverDuplex(duplex, pty?)` assemble the BASE-free `buildTerminalTools` registry (container_exec + pty_*, both `terminal:'on'` default-ON) + inject `terminalOperatorGuide`; container_exec backed by `containerExecOverIpc` over the brain↔hands JSON-line duplex. Closes the 0-production-caller gap on all three. Hellgate: RED→GREEN→adversarial audit (HOLD); round-trip test observes the REAL wire; paired-control per port; biome surface-isolation fence for `src/apps/terminal/**` (RFC §10, negative-control proven). 6/6, tsc+biome clean, guard 68/68. NOTE: NO `main()` yet — the box phase (B1/B3) drives it; this is the box-independent wiring only.
- **B5** TB harness registration (missing): `Dockerfile` installing quanta + bridge, `pyproject.toml` so `harbor` can import `QuantaAgent`, the `--agent module:Class` entry.
- **B6** auth/model: provider credential into the container for the brain.
- **B7** real `DockerRun` / standalone backend + orphan-reap (RFC P2 remainder, non-Harbor path).

**Dup-check:** protocol core (`serve.py`/`protocol.py`) + parity tests already exist and pass — B1–B7 are additive; do not rebuild the protocol.

**Track B verdict (UPDATED jul-01 — box-independent build COMPLETE + box-VERIFIED on real Docker/harbor):**
- **B1–B7 all landed** (commits `75fdf6091` B7 · `8b45b645d` B3+buildRealLlm · `4fc0b8f1e` B1/B2/B5/B6 · `cae17d777` box fixes), each hellgate (RED→GREEN→self-audit), each agent finding+fixing a real bug (report-then-EOF order; non-dict-tokens crash; host-env key leak; setup `--version`). brain↔hands contract grep-proven identical; TS 58/0, python 27/0.
- **Box-VERIFIED** (live Docker daemon + real harbor 0.16.1, jul-01): image builds end-to-end (1.7GB; fixed missing `git` for harbor's VCS pip dep); `quanta_agent:QuantaAgent` import_path resolves to a CONCRETE `harbor.agents.base.BaseAgent` subclass (zero abstract methods); real `AgentContext` accepts our token/cost/metadata fold (`rollout_details` is list[RolloutDetail] → report rides `metadata`); brain shim `--version`→0. Correct run flag is **`--agent-import-path`** (NOT `--agent` = built-in enum); harbor shells HOST docker to provision task containers.
- **Remaining = a LIVE `tb run` only** (no new code): host harbor + a downloaded task + LLM tokens + the brain credential. Then score quanta+Opus-4.8 vs standardized-scaffold Opus-4.8 (58.3%).

---

## Sequencing

1. **Today (no box):** A1 → A2 → A5 → Track-A box-command test. Small, high-value (closes the Live footgun); lands now. Each behind the existing default-OFF / fail-open invariants.
2. **Defer:** A3 (HF fetch, optional), A4 (prepare-images, latent).
3. **Dedicated box session:** Track B (B1→B7) on EC2/box. Separate effort; do not begin without a box (unverifiable otherwise).

## Done = ticket closed when
- Live: `--mode full --dataset-family live` runs+grades correctly (A1), local-live fails loud (A2), flag documented (A5), box-command test guards it; **a real Live slice graded end-to-end on full-remote** (smoke, picks).
- Terminal-Bench: `tb run --agent quanta` solves + TB grades ≥1 task end-to-end (B1–B7); quanta+Opus-4.8 score recorded vs the standardized-scaffold Opus-4.8 baseline (58.3%).
