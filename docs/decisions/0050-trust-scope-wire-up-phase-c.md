# ADR-0050 — Trust-Scope Registry Wire-Up (Phase C)

## Status

Accepted — 2026-05-21

## Context

`src/permission/` already houses a full HITL stack (4-tier policy, 3-tier
reviewer, 8-state outcome enum, classifier port). What it lacked was a
**persistent grant memory** so that a user who has already approved a
structurally-equivalent action does not get re-prompted on every repeat in
the same scope.

Phase A defined the `TrustScope` enum (`always_allow | project | workspace |
session | once_only | deny`) and Phase B sketched the registry shape, but
there was no caller — the admissibility-gate never consulted any registry.
Phase C closes that gap with **one** wire-up site.

## Decision

1. Land the registry impl under `@/permission`
   (`src/permission/trust-scope.ts`) with an in-memory implementation
   (`createInMemoryTrustScopeRegistry()`). The interface exposes three
   methods — `hasGrant`, `consume`, `grant`. Only `hasGrant` is called by
   the gate; `once_only` consumption happens inside `hasGrant` itself
   (positive-and-consume) so the gate stays one `if` deep.

2. Add `AgentConfig.trustScope?: { registry; projectKey }`. Absent is the
   DEFAULT — `runAdmissibilityGate` then runs byte-identical to the
   pre-Phase-C path. Opt-in callers (CLI flag, web surface) wire the
   registry per-session.

3. Wire-up site: `runModePolicy` in `src/agent/admissibility-gate.ts`,
   inside the `decision.kind === "ask"` branch, BEFORE `config.onConfirm`
   is invoked. When `config.trustScope` is set and
   `registry.hasGrant(projectKey, { tool })` returns true, the gate
   returns `null` (admissible) and the prompt is skipped.

4. `deny`-scoped grants are NOT treated as ask-skip by the wire-up. The
   registry's `POSITIVE_SCOPES` set deliberately excludes `deny`; an
   explicit deny path can be added later without touching this seam.

## Consequences

**Positive**

- The legacy onConfirm path is preserved exactly when `trustScope` is
  unset — every existing admissibility-gate test passes byte-identical.
- One-line semantics: the gate consults a registry; the registry owns
  scope-resolution and once_only consumption. The gate never branches on
  scope literals.
- Slice isolation holds: `@/permission` ships the registry; `@/agent`
  type-imports the interface only. No new cross-slice deps.

**Trade-offs**

- The wire-up is intentionally minimal: it only handles the `ask` branch
  inside mode-policy. It does NOT short-circuit the HITL `always-confirm`
  tier — that tier's whole point is to bypass batch-approval. If a future
  caller wants trust-scope to cover always-confirm too, that's a separate
  ADR.

## Negative invariants

- A `deny`-scoped grant MUST NOT silently allow the action — verified by
  unit test `(e)` in `tests/unit/permission/trust-scope-wire.test.ts`.
- A `once_only` grant MUST be consumed on first positive answer — verified
  end-to-end in `tests/integration/trust-scope-e2e.test.ts`.
- `config.trustScope` UNSET MUST behave byte-identically to the
  pre-Phase-C path — verified by the trustScope-UNSET control case in
  both unit and e2e suites.

## Files touched

- `src/permission/trust-scope.ts`     — NEW: enum + registry interface + impl.
- `src/permission/index.ts`           — exports the new symbols.
- `src/agent/types.ts`                — `AgentConfig.trustScope?` field.
- `src/agent/admissibility-gate.ts`   — one `if` in `runModePolicy`.
- `tests/unit/permission/trust-scope-wire.test.ts`     — NEW (5 cases).
- `tests/integration/trust-scope-e2e.test.ts`          — NEW (2 cases).
