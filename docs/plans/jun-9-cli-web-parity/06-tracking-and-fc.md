# Ticket 06 — parity tracking via `fc surface_integration` + ratchet

**Phase**: 0/1 (cross-cutting) · **Risk**: low

## Goal
Institutionalize CLI→web parity so it is measured, flips green per phase, and cannot silently rot.

## Authoritative gap (measured — `bun tools/feature-catalog/cli.ts surface`)
```
surface_integration coverage — 958/958 audited
  cli: { full:834, partial:6,  missing:87,  na:31 }
  web: { full:107, partial:59, missing:213, na:579 }
```
- **213 features `web: missing`** + **59 `partial`** = the real parity backlog (the jun-09 audit's "~182" was an estimate; this is the live count).
- **579 `web: na`** — genuinely not-applicable to web (internal/CLI-only). That is *fine*; parity ≠ porting the na set.
- The `fc surface` **schema blocker is already resolved** (no invalid `wired` enum remains; the command runs). The 00-index R4 risk is stale — drop it.

## Valid enums (don't reinvent)
[tools/feature-catalog/schema.ts:42](../../../tools/feature-catalog/schema.ts#L42) — `SurfaceStatus = full | partial | missing | na | unknown`. Evidence text is **required** when status ∈ {full, partial, missing} ([schema.ts:41 note](../../../tools/feature-catalog/schema.ts#L41)). So flipping a feature to `web: full` forces a one-line evidence string (file:line of the wiring) — self-documenting.

## Per-phase flips
- **Phase 0 (keystone)**: the feature(s) covering the slash-run transport flip `web: missing→full` with evidence = the `slash.run`/`slash.result` wire (tickets 02-04). This does **not** flip the individual command features — they each need their slot (Phase 1).
- **Phase 1**: each of the 12 read-only command features ([ticket 05](05-phase1-readonly-commands.md)) flips `web: missing→full` (or `partial` if slot-deferred) as its route lands, evidence = the `get_*` control-request case or the `local`-route slot binding (file:line). `/state` first.

## Ratchet (regression guard)
- The jun-09 `surface_integration` ratchet already exists (per memory `jun-09-cli-web-integration-audit-and-surface-tracking`: "fc에 surface_integration축+ratchet"). Confirm it asserts a **monotonic floor** on `web: full` (count cannot decrease) and run it in the gate. If the ratchet is count-based, bump the floor as each phase lands so a later regression turns it red.
- The `surface-populate.workflow.js` ([tools/feature-catalog/surface-populate.workflow.js](../../../tools/feature-catalog/surface-populate.workflow.js)) re-derives the matrix — run it after each phase so the catalog reflects reality, not intent.

## Definition of Done
- `bun tools/feature-catalog/cli.ts surface` runs clean (already true) and shows `web: full` increased by exactly the features landed this phase (no accidental flips).
- The ratchet floor is raised per phase; a synthetic revert (un-wire one command) turns it red (red-on-injection).
- Each flipped feature carries a file:line evidence string for its web wiring.

## Why this ticket exists
Parity work without a tracked denominator drifts back to "web is a thin subset" within weeks (the exact failure mode this plan is fixing). The `fc surface` matrix is the denominator; the ratchet is the floor. Memory `jun-09-integration-audit-3round`: "병렬레인 slice-test green ≠ tree green" — the surface ratchet is the tree-level check that a slice-green command is actually wired end-to-end.
