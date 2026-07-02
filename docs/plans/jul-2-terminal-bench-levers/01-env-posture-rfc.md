# RFC: Environment Posture for Prompt Rules (Terminal-Bench install-block fix)

**Date:** 2026-07-01 · **Status:** proposed (v2, post adversarial+objective audit) · **Trigger:** Terminal-Bench full-89 run RCA

> v2 changelog: rewritten after a 2-viewpoint hellaudit against the code. Major corrections:
> escalation tier dropped (bash-only, dead weight for TB); brain wiring re-based on the existing
> bootstrap-owned `systemSource` seam (not a fake `input.system` path); **posture is PROMPT-TEXT-ONLY and MUST NOT touch runtime
> enforcement** (the dangerous conflation the v1 "Codex unifies prompt+policy" framing invited);
> R-NO-SHIM split (it hides a frozen-env tail); existing `packs.test.ts`/snapshot pins enumerated.

## Problem (confirmed against code + live run)

`CORE_RULES` (`src/agent/prompt-rules/core.ts:35-106`) hard-codes SWE-bench env guardrails rendered into
**every** surface pack (`assistant.ts:18`, `benchmark.ts:24`, `task-runner.ts:24`, `pr-agent.ts:39` all spread
`CORE_RULES`; `renderPackByMode` maps all 6 AgentModes to them):

```
[R-ENV] Do NOT attempt to install dependencies or modify the environment. ...your patch is the deliverable, not a working env.
[R-STOP-ENV] ...Repeating the same install or env command will not unblock you...
[R-NO-SHIM] ...If verification fails because a dependency/binary is missing... declare the environment unavailable and stop.
```

The Terminal brain inherits these: `brain-mode.ts:155` `pickPersona:()=>"default"`, `env:{}` ⇒ bootstrap takes the
`buildSystemPrompt(cwd,{persona:"default"})` branch (`bootstrap-session.ts:195`) ⇒ full `CORE_RULES` incl R-ENV.
Live proof (box `13.124.146.106`, `kv-store-grpc`, reward=0, 4 turns): the agent bailed —
*"the higher-priority environment rules for this session forbid installing dependencies (pip, npm, apt)"* —
obeying R-ENV. But TB's `kv-store-grpc` REQUIRES installing grpc (`test_grpc_tools_installation`).

## Failure landscape (full-89 run, ~48/89 solved, ~42 failures reviewed by reading each final message)

R-ENV is a **confirmed but non-dominant** lever. Honest classification (signature = the agent's own final message,
cross-checked against TB2 top-tier solve-rates; caveat: this is a heuristic on message text + solve-rate, NOT proof
of mechanism — a couple are misfiled, e.g. `nginx-request-logging` reads as R-ENV but a loose regex filed it under
claimed-done; `merge-diff-arc-agi` is model-reasoning, not verify):

- **R-ENV install-refusal: ~8-10 (~20-25%)** — agent explicitly *"not allowed to install / owned by the harness"*
  then bailed: kv-store-grpc, sqlite-with-gcov, nginx-request-logging, install-windows-3.11, torch-pipeline-parallelism,
  caffe-cifar-10, compile-compcert, configure-git-webserver, build-cython-ext. **← THIS RFC.** (Earlier loose regex
  over-counted this to 19; reading the finals corrects it to ~8-10.)
- **CLAIMED-DONE-but-failed: ~30 (~70%) — the DOMINANT mode.** Agent declared *implemented/verified/green*, verifier
  disagreed. This RFC does NOT address it. Splits into: (a) a *verify-before-submit / real-oracle* lever — the agent
  had or could build a local check and skipped it (e.g. path-tracing-reverse claimed green but never diffed its output
  against `/app/mystery`); (b) genuine model/reasoning ceiling. Solve-rate proxy: only ~3 are reliably solved by
  top-tier (pytorch-model-recovery 66%, mcmc-sampling-stan 56%, merge-diff 35%); the rest are 2-17% = hard-with-rare-
  wins. **This is a SEPARATE lever family** — see `docs/analysis/terminal-bench-analysis/FAILURE-RCA.md` A2/A3 and the
  sticky-verify / oracle-loop work. Out of scope here; flagged so this RFC is not mistaken for the whole fix.
- **Hard ceiling (top-tier ≈0): ~7-12** — gpt2-codegolf, protein-assembly, mteb-leaderboard, make-doom-for-mips,
  regex-chess, sam-cell-seg, extract-moves-from-video, … No scaffold lever.
- **Budget/other: ~5** — ran out of turns mid-build (build-pmars, make-mips-interpreter), or uncategorized.

**Impact of THIS RFC:** the ~8-10 install-gated tasks (SYSADMIN/build/install-heavy), a clean confirmed lever ≈10% of
the bench. It is lever **#1 of ≥2**; the larger #2 (verify-before-submit) is deliberately not scoped here.

## Why ours is like this + how competitors differ (`.extracted_source/` corpus)

- **Ours:** primary bench is SWE-bench, where R-ENV is correct (frozen pre-built container; the patch is the
  deliverable). It got baked into `CORE_RULES` (always-on, deliberately non-externalized per core.ts:12-16) and
  leaks to all surfaces.
- **Codex (GPT-5.2):** no "don't install" prompt rule. Install/network is a **runtime sandbox config** (modes
  read-only / workspace-write / danger-full-access × `networkAccess`) + escalation; the prompt *describes* the
  sandbox, it doesn't forbid.
- **Claude Code:** package managers are normal tools; no prohibition.
- **TB scaffolds (Terminus2/orchestrator/harbor):** agent owns the container; the container IS the isolation
  boundary, so install/build/config inside it is free.

**Correction from v1 (audit finding 9):** Codex making prompt-guidance track the runtime sandbox is a *description*
relationship, not a coupling that weakens enforcement. quanta must keep the two SEPARATE: the fix changes only
**what the model is told**, never the actual `SandboxPolicy`/`os-sandbox` enforcement. Coupling posture to host
enforcement would make the CLI wiring (Phase 4) a host-escape surface. **EnvironmentPosture selects PROMPT TEXT ONLY.**

## Design: EnvironmentPosture = a prompt-rule-group selector (text only)

`EnvironmentPosture = "frozen" | "owned"`. (No `escalating` tier — audit finding 2: escalation is the
bash-tool host seam `sandbox-escalation-wire.ts`, fired only for sandboxed host `bash`; the brain has no host bash,
only `container_exec`/`pty_*` over the duplex, so escalation is inert for TB. Escalation stays orthogonal machinery
for bash-bearing surfaces and is out of scope here.)

- `frozen` → today's env rules verbatim (SWE-bench, and the DEFAULT for every existing caller).
- `owned` → inverted env rules: install/configure/build freely; a working environment IS the deliverable.

Posture is **set explicitly per surface**, NOT derived from `SandboxMode` (audit finding 3: the brain has no
`SandboxMode`; `brain-mode.ts:183` sets a `permissionMode`, not a sandbox mode). Any future CLI derivation
(Phase 4) is a separate, prompt-only mapping.

## Plan (phased, hellgate protocol)

### Phase 0 — Hellgate RED (feasible via existing FakeLlm)
- `brain-mode.test.ts` already captures `llm.seen[0].system` via `FakeLlm`. Add: assert the brain's system prompt
  **currently contains** `[R-ENV]` (RED baseline; also closes the "brain doesn't record its prompt" gap).
- Assert (RED, will pass after Phase 1-3) that an `owned` brain prompt MUST NOT contain `[R-ENV]`/`[R-STOP-ENV]`
  and MUST contain the install-permitted rule.

### Phase 1 — Add a parallel `OWNED_RULES` list; leave `CORE_RULES` UNTOUCHED (revised for byte-identity)
> Revised from "split CORE_RULES": splitting reorders/reword R-ENV/R-STOP-ENV/R-NO-SHIM and would break both
> cache-prefix byte-identity AND the existing `packs.test.ts` equality pin (`CORE_RULES.map(id)===[7 ids in order]`).
> Cleaner: DON'T touch `CORE_RULES` at all — it stays the `frozen` posture, byte-identical *by construction*, and
> the existing tests stay green. Add a SEPARATE `OWNED_RULES` list used only by the `owned` posture.
- `CORE_RULES` — **unchanged** (all 7 rules, same order/text). This IS `frozen`. Every existing pack keeps spreading
  it verbatim ⇒ zero byte drift, `packs.test.ts` + `prompt-rules-snapshot.test.ts` stay green untouched.
- `OWNED_RULES` (NEW parallel list): the 4 universal rules (R-SEARCH-FIRST, R-READ-FAILURE, R-NO-THRASH,
  R-FAILURE-MODE) + a diff-integrity-only shim rule (R-NO-SHIM's core, WITHOUT the "missing dep ⇒ declare env
  unavailable and stop" tail) + two new owned rules:
  - `[R-ENV-OWNED]` "You own this environment. Install dependencies, configure services, and build tooling as needed
    (pip/apt/npm/cargo/…). A working environment IS part of the deliverable, not an obstacle. Prefer non-interactive
    flags; re-probe after installing; a clean exit code on the verifying command is the proof."
  - `[R-INSTALL-THRASH]` "If an install or build fails, read the error and diagnose (wrong package name, missing
    index, missing build dep, permissions) before retrying — do not re-run the same install command unchanged."
    (audit finding 5: universal R-NO-THRASH is edit-scoped, doesn't cover install-thrash.)
  Folds `TERMINAL_OPERATOR_GUIDE`'s install-on-demand guidance UP from the user turn (L8) to system priority.
- **Tests:** existing pins stay green (CORE_RULES untouched). Add a NEW test file for `OWNED_RULES` (asserts it
  OMITS R-ENV/R-STOP-ENV, CONTAINS R-ENV-OWNED/R-INSTALL-THRASH, and keeps the 4 universal IDs).

### Phase 2 — Thread posture into the prompt (two seams, both prompt-only)
- **General mechanism:** add `envPosture?: EnvironmentPosture` to `buildSystemPrompt` opts (and forward through
  `buildSystemPromptForMode` — audit note: its `mode` is the task-posture `ModeVariantKey`, a separate axis, so
  `envPosture` is a genuinely new param on both). Default `"frozen"` ⇒ all ~18 existing call sites
  (enumerated by the objective audit: bootstrap ×3, agent-arg-builder ×2, driver.ts SWE-bench, mode-presets ×5,
  web-daemon, eval ×2, persona knob, cache path) stay **byte-identical**.
- **Brain seam (CORRECTED — review P2):** the brain does NOT have an `input.system` channel. `input.system`
  (`prompt.ts:616`) is the prompt *builder's* caller-supplied base-prompt arg; the brain never calls the builder
  directly — it goes through `bootstrapSession`, whose runtime session config has NO `system` field
  (`src/host/runtime/types.ts:4`). Bootstrap builds the system prompt internally (`buildSessionStatePorts` →
  `buildSystemPrompt(cwd,{persona})`, `bootstrap-session.ts:195`) and exposes it as `boot.system` +
  a mutable `boot.systemSource` (`src/host/bootstrap/types.ts:483,489`); the turn/assemble path reads
  `systemSource.get()` (`src/runner/assemble/config.ts:345`). So the real seam is one of:
  (a) thread `envPosture` through the bootstrap prompt build (`SessionBootstrapDeps`/runtime → `buildSessionStatePorts`
  → `buildSystemPrompt`), or (b) after bootstrap, rebuild the prompt with `owned` posture and set it via
  `boot.systemSource` (the same mechanism `refreshSystemPrompt` uses for identity-mode swaps). Path (a) is cleaner
  (single source of truth); path (b) is lower-churn. Decide in Phase 3; NOT a `input.system` one-liner.

### Phase 3 — Terminal brain → `owned` (prompt-only, constant)
- `brain-mode.ts` sets posture=`owned` as a constant and injects it via the `systemSource`/bootstrap seam above
  (NOT `input.system`). Today the brain layers the operator guide as the first *user* turn (`brain-mode.ts:258`,
  pinned by `brain-mode.test.ts:172`); the owned env-rules must instead land in the *system* prompt (so they carry
  L1-L5 authority and are not overridden by anything), which is exactly why the `systemSource` seam — not the
  user-turn layering — is the correct injection point.
- **Safety invariant (audit finding 9):** this changes ONLY prompt text. It does NOT set `SandboxMode`, does NOT
  touch `SandboxPolicy`/`os-sandbox`, does NOT loosen host enforcement. The brain's tools remain `container_exec`/
  `pty_*` over the duplex; the container is the isolation boundary (safe by construction — no host bash exists on
  this surface, confirmed brain-mode.test.ts:187-188).

### Phase 4 — (optional, later) interactive CLI posture — STRICTLY prompt-only
- Map the user's chosen sandbox to prompt posture: read-only→frozen; workspace/danger→owned. **Reconcile the two
  sandbox semantics first** (objective omission 4): `status-pills.SandboxMode` (read-only/workspace/danger/default)
  vs the enforcing `QUANTA_SANDBOX` knob in `config/knob-inventory/daemon.ts` (off/workspace-write). Pick one SSOT.
  **`default`/unset → frozen** (objective omission 3: the majority path has no `QUANTA_SANDBOX` set).
- MUST remain prompt-only; MUST NOT be the same code path that configures host enforcement.
- If a new env var is introduced here, register it in `config/knob-inventory/*` + `shared/runtime-config*` or the
  drift guard fails (objective omission 5). Deferred until measured need.

### Phase 5 — Adversarial audit ≥3R + structural TDD
- No-leak: `owned` drops ONLY R-ENV/R-STOP-ENV + R-NO-SHIM's stop-tail. Honesty rails (R-READ-FAILURE,
  verify-before-claim) and the shim-ban core stay. Install-thrash guard replaces the dropped R-STOP-ENV.
- Cache-prefix byte test: SWE-bench + interactive prompts byte-identical pre/post (frozen default).
- Snapshot matrix: {frozen, owned} × the two seams (buildSystemPrompt param + brain `systemSource` override).
- Respects core.ts's original intent: R-ENV is NOT made a runtime env-var kill-switch; it's selected at a
  compile-time, test-pinned surface (changing a surface's posture still requires code + snapshot edits).

### Phase 6 — Measure-first A/B (audit finding 6 — do NOT pre-claim)
- TB `owned` vs current on install-gated failures (kv-store-grpc + SYSADMIN set). **Classify grader-error vs
  real-solve** per the leaderboard-throttle-miss protocol before claiming any delta; TB2 corpus solve-rates are a
  ceiling for external scaffolds under mixed-quality/grader-error confounds, NOT a quanta prediction.
- SWE-bench Verified: confirm unchanged (frozen byte-identical) — measurement integrity guard.

## Surface census (objective omission 6) — posture decision per buildSystemPrompt caller
- SWE-bench batch driver (`driver.ts:2930`): **frozen** (assert; keeps R-ENV, correct + measured).
- Terminal brain: **owned** (this RFC).
- interactive / agent-arg-builder / mode-presets / persona knob / cache path: **frozen** (default, byte-identical).
- web-daemon, daemon, ide, eval replay/synthetic: **frozen for now** — arguably container-owned like the brain, but
  measure-first before flipping (out of scope; noted so the census is complete, not silently dropped).

## Non-goals / guards
- NOT a runtime kill-switch for R-ENV. NOT coupled to `SandboxPolicy`/`os-sandbox` enforcement (prompt-text only).
- No new sandbox enforcement mechanism. No heuristics — posture is an explicit per-surface constant, not inferred.
- No new env knob unless Phase 4 lands (then it must be inventory-registered).
