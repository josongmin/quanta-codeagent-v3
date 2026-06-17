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
- `agentless-v1` must remain byte-identical; all new behavior lives behind new knobs and later a new preset.
- Use `FaultEvidencePacket` as the name; do not collide with the existing `EvidencePacket` in `src/tool/evidence/`.
- `primaryRail` is a first-class field, not an inference from "last verify command".
- Required verification is external-only: execution / structure / exact diff facts. Same-model self-critique is advisory only.
- Synthesized repro must prove RED on the unpatched base before it can become a required rail.
- The gate is bidirectional: high-confidence trivial cases may commit early; high-stakes ambiguous cases must verify.
- Default to telemetry or advisory posture before deny/block unless the rule is exact.
- Benchmark claims require official x86 harness artifacts plus the diagnostic sidecar.

## Ticket table

| ID | Title | What closes | Pri | Size | Deps | Posture |
|---|---|---|---|---|---|---|
| T-101 ✅DONE | closure diagnostic rail + report sidecar | owner/proof metrics absent | P0 | M | — | offline |
| T-201 🟡CORE | `FaultEvidencePacket` builder | no typed owner-context artifact | P1 | L | T-101 | OFF (`fault-evidence`) |
| T-202 | owner admission + first-edit telemetry | file-localized but owner-unpinned edits | P1 | M | T-201 | rides W1 gate |
| T-301 🟡CORE | `VerificationPlan` builder | no typed proof plan | P1 | L | T-101, T-202 | OFF (`verification-plan`) |
| T-302 🟡CORE | primary-rail enforcement + gate decision + repair admission | repair uses generic verify noise / no explicit commit-vs-verify gate | P0 | L | T-301 | OFF (`primary-rail`) |
| T-401 🟡CORE | patch hygiene gate + stray-file report | over-wide / polluted diffs | P0 | M | T-202 | OFF (`patch-hygiene`) |
| T-501 🟡CORE | post-localization commit rail + no-patch exhausted verdict | `#9296`-class over-exploration / missing commit-fast inverse rail | P1 | M | T-202 | OFF (`no-patch-breaker`) |
| T-601 🟡CORE | multi-owner escalation decision | multi-site widening is ad hoc | P1 | M | T-202, T-301, T-401 | OFF (`repair-escalation`) |

> Legend: ✅DONE = core + wiring + tests landed · 🟡CORE = pure typed-artifact
> core + unit teeth landed (default-OFF, no driver wiring yet) · blank = open.
> **Integration wave (remaining):** wire 🟡CORE modules into the live driver
> behind their knobs (gather inputs, gate repair/verify-guard, emit to report),
> + T-202 first-edit stream tap, + knob-inventory registration, + T-701 preset
> freeze. One coherent driver pass (avoids 6-ticket seam collisions).
| T-701 | freeze `agentless-v2` preset + leaderboard/report integration | no measured preset contract for the bundle / preset namespace truth unresolved | P1 | M | T-302, T-401, T-501, T-601 | preset |

## Conditional, not ticketed yet

- Bench closeout-critic wiring for over-engineering review. Open only if T-302/T-401 telemetry shows residual false-green or over-wide patch cases that exact gates cannot explain.
- If the preflight proves `agentless-v2` is already bound to a different published posture, rename the final frozen bundle instead of silently reusing the label.
