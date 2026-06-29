# Measure-first: does the EXISTING best-of-N move resolve-rate? (jun-29)

## Why this, not more code

The competitor-study ([../../analysis/competitor-study](../../analysis/competitor-study/README.md))
+ the Pro/Live failure RCA converge: our genuine misses are **synthesis** (right files, wrong
edit) — competitors converge the same files via **best-of-N + oracle-select + shell-iterate**,
NOT via a harness-side per-language repro parser. Scaffold comparison confirms: every
interactive agent (mini-swe / SWE-agent / OpenHands / Claude Code / Codex / Cursor) lets the
**model self-verify over a shell** (language-agnostic, free); only agentless (which we copied)
uses a structured Python repro-rail — the source of our self-inflicted "polyglot" problem.

**The lever already EXISTS in-tree, wired + live, default-OFF, efficacy NEVER measured:**
- `QUANTA_BENCH_BRANCH_SEARCH=K` (int 2–8) → `agent/branch-search-runner.ts` (K forked
  candidates, worktree isolation, voter quorum ADR-0433). NOT inert (verified statically).
- `QUANTA_BENCH_REPAIR_BREADTH=B` → repair loop forks B candidates, continues from the
  validator-green one (oracle-as-selector).
- acceptance-select rail + cross-vendor lanes (G1) — also default-OFF.
- The model already runs tests itself over bash (observed in Pro/Live trajectories).

So the structurally-correct next step is **measurement**, not building (building = duplicate
dev). The polyglot repro-adapter (Phase 1+2a, landed byte-identical) is SHELVED — wrong
direction vs the field; left in place because it's behavior-neutral.

## The A/B (run when a box is free)

Fixed instance set, on-demand box (no spot reclaim), SERIAL grade (concurrent-grade =
false-neg), one OAuth account at a time (concurrent = throttle). Same model (gpt-5.5), same
preset, ONLY the knob differs.

| arm | env | 
|---|---|
| **A (baseline)** | (best-of-N OFF — default) |
| **B (best-of-N)** | `QUANTA_BENCH_BRANCH_SEARCH=4` |
| **C (repair-breadth)** | `QUANTA_BENCH_REPAIR_BREADTH=4` |

- Instance set: a fixed ~20–30 of SWE-bench **Verified** (Python — the rail works TODAY, no
  polyglot needed; isolates the best-of-N effect from the language confound). Re-use the
  smoke/regression picks so results compare to history.
- Metric: `resolved / measurable` (exclude grader_invalid + harness/LSP holes — the
  `goldResolved`/verdict taxonomy already separates these). Report per-arm + the delta + cost
  multiplier (B/C are ~K× patch-gen cost).
- Decision: if B/C beat A beyond noise → best-of-N is the validated lever → make it a preset
  default + then (only then) consider polyglot to extend it to Pro non-Python. If NOT → the
  synthesis gap needs a different lever (iterate-loop prompt / cross-vendor diversity), and the
  K× cost is unjustified.

## Guards (from memory — don't re-learn the hard way)
- on-demand box (`QUANTA_FULL_REMOTE_ONDEMAND=1`) — spot reclaim churned the Pro run.
- SERIAL grading only; never grade concurrently (false-neg).
- one account; don't run beside a live campaign (429 kills both).
- pre-flight (`tools/bench-preflight.sh`) before launch.
- classify measurement-holes OUT of the denominator (the platform already does this).

## What is NOT needed (avoid duplicate dev)
best-of-N, repair-breadth, oracle-select, cross-vendor lanes, acceptance rerank — all BUILT.
The shell self-verify — the model already does it. Do NOT rebuild any of these. The only gap is
**evidence**, obtained by the A/B above.
