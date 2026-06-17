# jun-17 Proof-Driven Bench Closure — Ticket Bundle (INDEX / status board SSOT)

**Date:** 2026-06-17  
**Scope:** turn the easy-django tail RCA into implementable, anti-heuristic bench work items.  
**Status:** `DRAFT` -> tickets in [tickets/00-backlog.md](tickets/00-backlog.md)

## Root-cause snapshot

- easy django 84 is now **78 resolved / 5 unresolved / 1 no-patch** on the authoritative EC2 x86 run.
- The 5 unresolved model misses are **right neighborhood, wrong exact fix**:
  - `#10914`, `#15987` -> over-engineering / wrong exact edit
  - `#16642`, `#16667` -> wrong repair / wrong fallback value
  - `#14315` -> multi-site omission
- `#9296` is **not** a model-miss. It is a no-patch / over-exploration harness failure.
- Therefore the tail gap is not gross localization. It is **closure discipline**:
  - what is the owner?
  - what is the primary proof rail?
  - when is the patch too wide?
  - when must we stop exploring and commit a best edit?

The full-corpus architecture still cannot jump straight to "repair loop first". The structural order remains:

```text
Evidence -> Owner -> Plan -> Gate -> Repair -> Escalate
```

## North star

Replace prompt-only nudges with typed artifacts and explicit gates:

1. `FaultEvidencePacket` answers **what to touch**.
2. `OwnerAdmission` answers **whether the owner is clear enough to edit**.
3. `VerificationPlan` answers **what proof is required before done**.
4. `GateDecision` answers **whether to `commit-now` or `verify` and which external signals count**.
5. `PatchHygieneReport` answers **whether the diff is too noisy / polluted**.
6. `PrimaryRail` answers **whether repair is allowed to iterate**.
7. `EscalationDecision` answers **when the case is genuinely multi-owner**.

`agentless-v2` is the **last** step, not the first. The preset is frozen only after the component metrics move in the right direction.

## Structural invariants

- `agentless-v1` is frozen. No in-place mutation. New behavior lands behind new bench knobs and eventually a new preset.
- Runtime paths introduced by this bundle must **not** read `FAIL_TO_PASS`, `PASS_TO_PASS`, `test_patch`, or official grader reports as routing authority.
- The new bench artifact is named **`FaultEvidencePacket`**, not `EvidencePacket`, to avoid colliding with the existing multilang debugging packet in `src/tool/evidence/types.ts`.
- Required verification must be grounded in external/public signals only:
  - execution results
  - symbol / owner resolution
  - exact diff facts
  - same-model self-critique is advisory only and never clears a gate
- `primaryRail` means an explicit reproduction command chosen by the planner:
  - selected repro script when present
  - otherwise the first required verification step
  - never "whatever verify-like command happened to run last"
- A synthesized repro can become `primaryRail` only after it proves RED on the unpatched base (`red-on-injection`).
- `repair` remains default-OFF until a selected `primaryRail` exists and is red.
- Ground-before-act loops are hard-capped:
  - green external signal stops immediately
  - no evidence-free rewrite rounds
- Gate entry uses cheap structural signals (`stakes`, `uncertainty`, `signal availability`, `empty-patch pressure`), not free-form "verify vibe".
- Broad score claims require official x86 harness artifacts (`report.json`, `predictions.jsonl`) plus the diagnostic sidecar; local arm64 smoke is not headline evidence.

## Workstream map

| Workstream | Problem it closes | Ticket set | Priority |
|---|---|---|---|
| Diagnostic rail | measure owner/proof quality before score claims | T-101 | P0 |
| Fault evidence | replace raw-source hint blobs with a bounded typed packet | T-201, T-202 | P1 |
| Proof planning | separate primary rail from generic verify noise | T-301, T-302 | P0/P1 |
| Patch hygiene | catch stray files / out-of-scope diffs structurally | T-401 | P0 |
| No-patch control | stop `#9296`-style exploration collapse | T-501 | P1 |
| Escalation | widen only on explicit multi-owner evidence | T-601 | P1 |
| Preset + reporting | freeze the winning bundle as `agentless-v2` | T-701 | P1 |

## Measurement register

The first success criterion is **not** `resolved` alone.

Required diagnostic outputs:

- `owner_recall@1`
- `owner_recall@3`
- `first_edit_owner_match`
- `required_verification_coverage`
- `primary_rail_present_rate`
- `primary_false_green_rate`
- `gate_enter_rate`
- `gate_bypass_rate`
- `verify_rounds_per_run`
- `synth_repro_base_red_rate`
- `stray_file_rate`
- `out_of_scope_file_rate`
- `no_patch_exhausted_rate`

Only after these stabilize do we compare official `resolved`.

## Recommended landing order

**Wave -1:** preset namespace + historical report-truth cleanup (non-ticketed preflight)  
**Wave 0:** T-101  
**Wave 1:** T-201 -> T-202  
**Wave 2:** T-301 -> T-302 || T-401  
**Wave 3:** T-501 -> T-601  
**Wave 4:** T-701

## House constraints

- New gates go through the bench knob registry, not ad-hoc `process.env` branching.
- The bundle must degrade cleanly to today's behavior when its knobs are absent.
- Deterministic signals beat heuristic critics. Any LLM critic is conditional work only after the artifact rails exist.
- The gate is bidirectional:
  - high-stakes / ambiguous cases must verify
  - exact low-risk / high-confidence single-owner cases may commit early
- "Too wide" is only a deny when the rule is exact:
  - stray file not on the allowlist
  - primary rail missing
  - primary rail red
  - cross-owner evidence unresolved
- Everything else is telemetry first.

## Conditional, not ticketed yet

- Bench closeout-critic wiring for over-engineering review.
- Additional regression-rail critics beyond the first `VerificationPlan`.
- Historical `agentless-v2` / `agentless-v2-safe` namespace cleanup if T-701 preflight finds the label already overloaded in published artifacts.
- Broader full-Verified rollout changes beyond easy-django and the existing smoke packs.
