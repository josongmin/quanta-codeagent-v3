# Absorption Efficacy Measurement — design (jul-03)

The 11 competitor-UX features (branch history → main, all default-OFF) need a keep/kill basis.
Before running anything: **what metric is valid for each?** Getting this wrong = a wasted bench box
+ a confound.

## The load-bearing reframe: bench pass-rate is the WRONG metric for ~all 11

These were absorbed through the **UX/product** lens (the user explicitly pushed off the bench lens).
Turning them ON does not change SWE-bench / terminal-bench pass rate — so a pass-rate A/B would show
**null for ~10 of 11**, which is NOT evidence they're worthless; it's evidence the metric is wrong.
Running a bench A/B to "measure" them would confound (jun-20 throttle-miss confound class) and burn
the box for a null.

Efficacy for a UX feature has two honest levels:
1. **Delivers-its-function** (deterministic, local, cheap): gate ON produces the effect; OFF is
   byte-identical. This is ALREADY MEASURED — the wiring + hell-audit round landed mutation-proven
   tests for exactly this (gate-ON→effect red-on-injection; gate-OFF→byte-identical). See each
   feature's `*-hellgate`/`*-wire` tests. So "does it work when on" = green.
2. **Improves-the-human-UX** (the real efficacy): needs real usage telemetry or human eval, NOT a
   synthetic bench. The correct measure-first path is: instrument → collect real ON-cohort usage →
   decide keep/kill on actual signal.

## Per-feature valid metric

| # | Feature (gate) | Moves a bench score? | Valid efficacy metric | Status |
|---|---|---|---|---|
| S1 | browser network capture (`QUANTA_BROWSER_NETWORK`) | No (UX) | Does the agent USE captured network to fix a web task? → task-success on a web-interaction eval + tool-call telemetry | function-proven; usage TBD |
| S2 | unified item-stream (`QUANTA_ITEM_STREAM`) | No (UX/observability) | Human: "do you understand what the agent's doing?" — user comprehension / support-ticket rate | function-proven; needs human/usage |
| S3 | reasoning-token gauge | No (UX) | Does the gauge get looked at / does it change user pacing? usage telemetry | function-proven; needs usage |
| A1 | HITL control-request (`QUANTA_CONTROL_REQUEST`) | No (interactive, not batch) | Steer-uptake rate + mid-turn redirect success on interactive sessions | function-proven; needs usage |
| A2 | artifacts (`QUANTA_ARTIFACT_STORE`) | No (UX) | Artifact-render engagement (open/download rate); only meaningful once the .tsx viewers land | function-proven (channel); renderer deferred |
| A3 | projects-KB (`QUANTA_PROJECTS_KB`) | **Maybe** — IF used as retrieval grounding on a task where the answer is in an uploaded doc | grounded-task success ON vs OFF **with docs uploaded** (NOT standard bench — standard picks have no KB) | function-proven; grounded-eval TBD |
| B1 | product-onboard skill | No (activation) | New-user activation / time-to-first-task | function-proven; needs cohort |
| B2 | durable cron/rrule (`QUANTA_AUTOMATION_STORE`) | No (infra) | Scheduled-task reliability across restart (does a durable task survive + fire) — deterministic | function-proven (disk test); reliability eval local |
| B3 | memory rate-limit write-guard (`QUANTA_MEMORY_WRITE_GUARD_PCT`) | **Weakly** — blocks bad memory writes under provider throttle | memory-write quality under a throttle-heavy long-run (high noise, rare on standard picks) | function-proven; bench-A/B weak/noisy |
| B4 | mcp read-dir + blob (`QUANTA_MCP_RESOURCES`) | No (MCP UX) | Resource-read success + blob-offload correctness (deterministic) | function-proven; local |
| B5 | presence-push (`QUANTA_NOTIFY_PRESENCE`) | No (notifications) | Missed-completion rate for away users (getPushStats: pushSent vs suppressed) | function-proven; usage-instrumented |

**Bench-A/B-defensible subset: ~0–1** (B3 only, weakly/noisily; A3 only with a bespoke grounded-doc
eval, not standard bench). The other 9 are UX — measure by usage telemetry / human eval, not bench.

## What to actually do (measure-first, no confounded bench burn)

1. **Do NOT fire a standard SWE/terminal-bench A/B for the 11.** ~10 return null (confound), 1 (B3)
   is noise on standard picks. That's box time for no signal.
2. **Consolidate the delivers-function proof** into an explicit per-feature efficacy readout — most
   already have observability hooks from the wiring round (A3 `knowledge{}` accounting, B5
   `getPushStats`, B3 `onArm` arm-telemetry, S2 subagent-activity item stream, S3 reasoning gauge,
   B2 disk-store test). These are the ON-cohort signal sources.
3. **Instrument the UX ones for real-usage efficacy** (the honest A/B): each ON session emits its
   effect signal (tool-use, engagement, suppression, uptake). Collect over real use → keep/kill on
   actual signal, not a synthetic bench. This is a small telemetry-readout layer over hooks that
   mostly exist.
4. **For the ~1 genuinely bench-touchable (B3):** a defensible A/B config exists — ON vs OFF preset,
   same picks, on a **throttle-heavy** long-run (the only regime where the guard fires), with the
   jun-20 throttle/empty-patch confound classifier applied. But expect a small/noisy delta; only run
   it if the box is idle (preflight per feedback-preflight-before-launch). Low priority.
5. **A3 grounded-eval (optional, higher-value than bench):** a bespoke eval where the answer lives in
   an uploaded doc — projects-KB ON should beat OFF on grounded-task success. This is the one place a
   real A/B *number* is both valid and meaningful. Worth building if projects-KB is a keep candidate.

## Bottom line
The 11 are UX/product features; their efficacy is not a bench number. "Does it work" is already
green (wiring tests). "Does it help the human" needs usage instrumentation, not a bench box. The
disciplined path is instrument-then-collect, not fire-a-confounded-A/B. Bench-A/B is defensible for
0–1 of them (B3, weakly), and a bespoke grounded-doc eval for A3 is the one place a valid A/B number
lives.
