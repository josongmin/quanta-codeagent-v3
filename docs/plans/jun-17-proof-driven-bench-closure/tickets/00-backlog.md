# jun-17 Proof-Driven Bench Closure — Ticket Backlog (SSOT)

9 tickets extracted from the jun-17 proof-driven closure bundle. Status: `OPEN` unless noted.
Sizes: S (<= 1/2d), M (~1d), L (multi-day). Posture is the shipped default of the behavior introduced by the ticket.
Before Wave 0, run one non-ticketed preflight to reconcile preset namespace and historical report truth (`agentless-v2` vs `agentless-v2-safe` / published rows).

## Recommended execution order

**Wave -1:** preset namespace + historical report-truth cleanup  
**Wave 0:** T-101  
**Wave 1:** T-201 -> T-202  
**Wave 2:** T-301 -> T-302 || T-401  
**Wave 3:** T-501 -> T-601  
**Wave 4:** T-701

## House constraints

- No runtime hidden-oracle reads: `FAIL_TO_PASS`, `PASS_TO_PASS`, `test_patch`, official grader report are forbidden routing inputs.
- No runtime routing from oracle-only analysis notes, gold patches, or extracted oracle fixtures.
- `agentless-v1` must remain byte-identical; all new behavior lives behind new knobs and later a new preset.
- Use `FaultEvidencePacket` as the name; do not collide with the existing `EvidencePacket` in `src/tool/evidence/`.
- `primaryRail` is a first-class field, not an inference from "last verify command".
- Required verification is external-only: execution / structure / exact diff facts. Same-model self-critique is advisory only.
- A required verification step must include an explicit success condition, not just a command.
- Synthesized repro must prove RED on the unpatched base before it can become a required rail.
- The gate is bidirectional: high-confidence trivial cases may commit early; high-stakes ambiguous cases must verify.
- Default to telemetry or advisory posture before deny/block unless the rule is exact.
- Benchmark claims require official x86 harness artifacts plus the diagnostic sidecar.
- [jun-17-strategy-failure-fix-plan.md](../jun-17-strategy-failure-fix-plan.md) is an analysis note for ticket calibration, not this backlog's competing SSOT.

## Ticket table

| ID | Title | What closes | Pri | Size | Deps | Posture |
|---|---|---|---|---|---|---|
| T-101 ✅DONE | closure diagnostic rail + report sidecar | owner/proof metrics absent | P0 | M | — | offline |
| T-201 🟡CORE | `FaultEvidencePacket` builder | no typed owner-context artifact | P1 | L | T-101 | OFF (`fault-evidence`) |
| T-202 🟡PARTIAL | owner admission + first-edit telemetry | file-localized but owner-unpinned edits | P1 | M | T-201 | telemetry-half DONE; owner-admission builder NOT built |
| T-301 🟡CORE | `VerificationPlan` builder | no typed proof plan | P1 | L | T-101, T-202 | OFF (`verification-plan`) |
| T-302 🟡CORE | primary-rail enforcement + gate decision + repair admission | repair uses generic verify noise / no explicit commit-vs-verify gate | P0 | L | T-301 | OFF (`primary-rail`) |
| T-401 🟡CORE | patch hygiene gate + stray-file report | over-wide / polluted diffs | P0 | M | T-202 | OFF (`patch-hygiene`) |
| T-501 🟡CORE | post-localization commit rail + no-patch exhausted verdict | `#9296`-class over-exploration / missing commit-fast inverse rail | P1 | M | T-202 | OFF (`no-patch-breaker`) |
| T-601 🟡CORE | multi-owner escalation decision | multi-site widening is ad hoc | P1 | M | T-202, T-301, T-401 | OFF (`repair-escalation`) |
| T-701 | freeze `agentless-v2` preset + leaderboard/report integration | no measured preset contract for the bundle / preset namespace truth unresolved | P1 | M | T-302, T-401, T-501, T-601 | preset |

> Legend: ✅DONE = core + wiring + tests landed · 🟡CORE = pure typed-artifact
> core + unit teeth landed (default-OFF, no driver wiring yet) · blank = open.
> **Integration wave (remaining):** wire 🟡CORE modules into the live driver
> behind their knobs (gather inputs, gate repair/verify-guard, emit to report),
> ~~+ T-202 first-edit stream tap~~ (DONE), + knob-inventory registration, + T-701 preset
> freeze. One coherent driver pass (avoids 6-ticket seam collisions).
>
> **2026-06-17 progress:**
> - 🟡 T-202 **telemetry half** LANDED (owner-admission builder still OPEN):
>   `BenchStreamTap` SSOT (`runner/batch/eval/stream-tap.ts`) —
>   firstEditFile + editCount + turnsToFirstEdit, observe-gated (byte-identical
>   OFF), wired into BOTH drivers (runner core + apps LIVE prod), dedups the
>   prior drifting `LastVerifyCmdTap` copies. + F6 closure-diag metrics
>   (edit_count_per_run / turns_to_first_edit / repro_red_but_unresolved_rate,
>   raw — no thresholds). 28 new teeth.
> - 📊 **Measurement (the point of the bundle):** baseline-failed 6 re-solved
>   with agentless-v1 → **3/6 resolved** (baseline 0/6). Residual 3 = exactly
>   the audit's localize-miss (#10914) / multi-site (#14315) / repro-symptom
>   (#16667) classes → execution feedback fixes fix-precision, NOT localization.
> - 🟢 LSP nav cwd (the .claude plan's "Phase A bug") = **stale/non-bug**: core
>   nav (definition/references/hover) already roots at `ctx.cwd`=sandbox via
>   `buildConfig`. Only rename/codeAction/format/signatureHelp hardcode
>   `process.cwd()` (non-grounding aux tools). No fix shipped (verified, not guessed).
> - ⏸️ **Deferred w/ reason:** T-701 `agentless-v2` preset — the name is
>   in-flight in a concurrent session (contention); behavioral gate driver-loop
>   wiring (T-302/T-501/T-601) held under measure-first (no prod-path behavior
>   change before its own EC2 A/B). Cores + teeth already landed (default-OFF).

## Conditional, not ticketed yet

- Bench closeout-critic wiring for over-engineering review. Open only if T-302/T-401 telemetry shows residual false-green or over-wide patch cases that exact gates cannot explain.
- Prompt-only steer experiments such as `spec-fidelity-steer`. Open only after the typed artifact rails exist and only as isolated OFF-by-default measurements.
- If the preflight proves `agentless-v2` is already bound to a different published posture, rename the final frozen bundle instead of silently reusing the label.
