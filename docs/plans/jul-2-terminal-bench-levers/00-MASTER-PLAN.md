# Terminal-Bench harness levers — MASTER PLAN (final, 2026-07-02)

Single source of truth for the TB lever effort. Consolidates the landscape, every lever's status, the
implementation sequence, and the measurement discipline. Per-lever detail in the numbered RFCs.

---

## 0. Executive summary

- **Current: 63/89 = 71%** (projection — mixed-config sum, not one clean run).
- **Validated on the box:** env-posture (+5), turn-budget (+3). **Broken:** verify-gate v1 (rubber-stamp, ~0).
- **Planned:** verify-gate v2 (honesty), best-of-N (f2p), brain observability (prereq).
- **Realistic reach with all levers: ~66-68/89 (74-76%).**
- **Ceilings (hard facts):** 13 tasks solved by NOBODY ⇒ physical max **76/89 = 85%**. The **84% "frontier" is a
  UNION** of 68 mixed scaffolds' bests ⇒ **unreachable by a single system** (best single full-run ~63%). We are
  already ABOVE typical single-system; the remaining gap is mostly shared hard-ceiling, not a scaffold deficit.

---

## 1. Failure landscape (full-89 baseline, read every final message)

~41 failures at the 48/89 knob-OFF baseline, in 4 mechanisms:

| type | n | mechanism | lever | status |
|---|---|---|---|---|
| R-ENV install-refusal | ~9 | agent obeyed SWE "never install" core rule, bailed on tasks needing install/build | env-posture | **5 recovered** |
| fake-green (CLAIMED-DONE) | ~30 | ran it, self-declared green, output actually wrong / unchecked | verify-gate v2 + best-of-N | v1 broken; v2/N planned |
| hard-ceiling | ~7-12 | beyond gpt-5.5 (top-tier ≈0 too) | none (model) | skip (no Opus) |
| budget/other | ~5 | ran out of the 30-turn cap mid-build | turn-budget | **3 recovered** |

---

## 2. Lever registry

| # | lever | knob | RFC | status | measured / expected |
|---|---|---|---|---|---|
| 0 | brain observability (prompt+verdict+trajectory log) | `QUANTA_TB_BRAIN_TRACE` | [05](05-brain-observability.md) | **planned — PREREQ** | makes all A/B verifiable (0 f2p) |
| 1 | env-posture (owned rules replace R-ENV) | `QUANTA_TB_ENV_OWNED` | [01](01-env-posture-rfc.md) | **built + validated** | +5 (kv-store, nginx, sqlite, configure-git, build-cython) |
| — | turn-budget (reuse shared knob) | `QUANTA_MAX_TURNS` | [03-rca](03-verify-gate-rca-and-redesign.md) | **built + validated** | +3 (path-tracing 48 turns, mcmc, adaptive-rejection) |
| 2 | verify-gate v1 | `QUANTA_TB_VERIFY_GATE` | [02](02-verify-before-finalize-rfc.md) | **built but BROKEN** | ~0 (rubber-stamped 3/7 FAILED tasks) |
| 2.5 | verify-gate v2 (compare-to-reference; L1 ladder) | `QUANTA_TB_VERIFY_GATE` (fix ON⇒L1) | [03-v2](03-verify-gate-v2-compare-to-reference.md) | **planned (2R audit, final)** | measurement HONESTY + f2p +1-2 (fragile) |
| 3 | best-of-N (fair self-selection) | `QUANTA_TB_BEST_OF_N` | [04](04-best-of-n-fair-selection.md) | **planned** | f2p +2-3 (variance capture) |

Companion RCA: [03-verify-gate-rca-and-redesign.md](03-verify-gate-rca-and-redesign.md) (why v1 rubber-stamps).

---

## 3. Implementation sequence (dependency-ordered)

1. **#0 observability FIRST.** Without a logged system prompt + verdict, every box A/B is faith-based (the jul-02
   audit could not even confirm env-posture applied on the box). Cheap, default-OFF, zero behavior change.
2. **#2.5 verify-gate v2.** Fix the SAME `QUANTA_TB_VERIFY_GATE` (ON ⇒ L1-gated; retire the broken v1 rubber-stamp,
   no second knob). Kills the false `verified-pass` so downstream A/B numbers are trustworthy; also serves as
   best-of-N's per-candidate selector.
3. **#3 best-of-N.** The real f2p lever (variance capture). Reuses v2's L1 check + the existing
   `acceptance-selector`/`llm-candidate-select` SSOT + the `BESTK_PASSK` measurement rail.
- **#1 env-posture + turn-budget are DONE + validated** — no more work; keep enabled in the winning config.

---

## 4. Measurement discipline (non-negotiable)

- **Default-OFF byte-identical** for every knob (hard invariant; guard-enforced).
- **measure-first:** land the lever OFF, A/B it, keep ONLY on a measured f2p gain; else delete the knob.
- **Isolate each lever** in its own A/B arm — v1's "+7" was unattributable because bundled with env-posture.
- **SERIAL grading** (concurrent grading = false-neg); classify grader-error vs real-miss before claiming a delta.
- **No answer-key / no hidden-test peek** — the cardinal red line. Fair signals only (task-provided reference,
  self-consistency); Pass@K (which touches the grader) is an OFFLINE ceiling metric, never a reported score.
- **Confirm SWE-bench Verified unchanged** as the cross-bench integrity guard (terminal levers are surface-scoped).

---

## 5. Winning config (SSOT so far)

`QUANTA_TB_ENV_OWNED=1` + `QUANTA_MAX_TURNS=60`, model gpt-5.5 (oauth), dataset `terminal-bench`.
Code: commits `e90ec2fcd` (env-posture) · `2f720e5a7` (verify-gate scaffold) · `796465949` (maxTurns) on
`feat/swe-bench-multi-dataset`. verify-gate must be left OFF until v2 lands (v1 rubber-stamps).

---

## 6. Open operational items

- **Branch consolidation:** RFCs are split — `01/02/README` committed on `feat/swe-bench-multi-dataset`;
  `00/03/03-v2/04/05` untracked on `main`. Consolidate onto one branch + commit.
- **quanta_agent.py:** repo copy reverted to a `NotImplementedError` stub by concurrent commits; the working
  implementation (with the `--agent-env` merge fix) lives only on the box + in feat history. Restore before any
  deploy-from-repo.
- **Box auth:** the brain reads oauth from `~/.quanta/auth/chatgpt.json`; it is per-box + expires — re-scp the
  fresh local token before each campaign (a missing token ⇒ 25s brain crash, not a lever failure).
- **Box sizing:** run campaigns on a small SPOT instance from AMI `ami-0d4f2f0da1774a446` (deps+code baked);
  root volume is stuck at 300GB (base-AMI lineage) — the real cost lever is the instance TYPE (r7i.xlarge),
  not the AMI. Back up results periodically (spot can be reclaimed mid-run).

---

## 7. Honest bottom line

The scaffold levers that CAN move the number are largely spent: env-posture + turn-budget already banked the
install-refusal + turn-capped wins; verify-gate v2 mainly buys measurement honesty; best-of-N buys a few
variance tasks. Realistic single-system reach is **~74-76%**, against a **physical ceiling of 85%** and an
unreachable 84% union. The remaining ~13-15 failures are shared hard-ceiling / never-solved — model-bound, not
scaffold-bound, and gpt-5.5 is the model ceiling here.

---

## X. Surface-adaptive prompt composition (SOTA++ — no hardcoding, not query-derived)

**Question raised:** should the prompt template change per problem? Is the surface hardcoded?

**Answer — 3 cleanly-separated layers (the universal SOTA shape; Codex/Claude/Terminus all do this):**

| layer | who sets it | when | cacheable |
|---|---|---|---|
| **L1 base** ("how to work") | fixed in code | build | ✅ yes (prefix cache) |
| **L-surface** (capability posture: terminal-owner / repo-frozen / ci-bot) | **the ENTRY POINT declares it** (launch context) | once, at launch | ✅ yes (per-surface prefix) |
| **task turn** (the problem) | the `instruction.md` / user query | per turn | n/a (varies by design) |

- **Surface ≠ query-derived.** The surface is a *deployment fact* — "am I the harbor terminal adapter? a CLI repl?
  a CI bot?" — known by WHICH entry point launched, NOT inferred from the question. Inferring surface from the query
  would add a "classify the task type" failure mode + break prompt caching. Codex parity: base fixed + sandbox/
  approval *config-declared* (not query-read) + AGENTS.md repo-context. All launch-context.
- **Not core-hardcoded either.** The bad form is `if (terminal) {...}` in the assembler. The SOTA form: the core
  exposes a **surface-profile registry**; each entry point SELECTS/DECLARES its own profile. The core only composes.
- **Per-problem adaptation already works** — it lives in the task turn (the full `instruction.md`), which the model
  reads and adapts to. No need (and it's anti-SOTA) to swing the system prompt per problem.

**The actual bug (this is the lever):** the terminal brain entry point does NOT declare its surface — `brain-mode.ts`
calls the builder with `persona:"default"` and NO `promptPack` → falls to the interactive-assistant default (wrong
surface). And there is no terminal/task surface profile to select even if it tried.

**Fix (composition, not hardcoding) — folds env-posture + terminal-pack into ONE surface-profile seam:**
1. Define a `SurfaceProfile` = `{ envPosture, operatorGuide, rulePack }` (the terminal profile = owned-env +
   terminal-operator guide + task-runner rules). This is a *declared* module, not an `if` in the core.
2. `brain-mode.ts` (the entry) DECLARES the terminal profile at launch — exactly the seam env-posture already used
   (`systemSource`/`buildSystemPrompt` opts). Other entries (CLI, bench, web-daemon) declare theirs; the core stays
   a pure composer with a fixed, cacheable base.
3. Net: env-posture (lever #1) stops being an ad-hoc inline `owned` injection and becomes the terminal
   `SurfaceProfile.envPosture` — one clean seam instead of two. No per-surface `if` in core, no per-problem swing.

**Scope note:** this is an *architecture cleanup that generalizes the env-posture lever* — it makes the fix correct
for a MULTI-SURFACE agent (terminal + CLI + bench + future) rather than a terminal-only hack. Ship env-posture via
this seam from the start; do NOT hardcode a terminal branch in the prompt core.
