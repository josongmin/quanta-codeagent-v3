# ADR-0020 — HITL: 4-tier confirmation gate

Status: accepted (2026-05-20)
Phase: SOTA++ Codex absorption — Phase 5

## Context

Codex `hitl-audit.md` defines a 4-tier confirmation policy:

- **`hand-off-required`** — human must take over; agent terminates (e.g.
  password change final submit, browser safety barrier bypass, paywall
  bypass).
- **`always-confirm`** — explicit confirm needed every time, even in
  `acceptEdits`/`bypass` modes (deletions, permission changes, install/run,
  representational communication, financial transactions).
- **`pre-approval-ok`** — can be pre-approved for the session (login
  prompts, file upload, normal file management, model-generated code
  execution).
- **`none`** — reversible, harmless (read-only inspection).

Our pre-Phase-5 permission system had a single `onConfirm` callback and
HARD_DENY regex patterns. The HARD_DENY patterns ARE the `hand-off-required`
tier; nothing in the system articulated `always-confirm` semantics or
prevented `bypass` from skipping a confirm on a destructive command.

## Decision

1. `HITLTier` literal union in `src/permission/types.ts`:
   `"hand-off-required" | "always-confirm" | "pre-approval-ok" | "none"`.
2. Optional `hitlTier?(input): HITLTier` method on `Tool` interface
   (`src/tool/types.ts`) — duck-typed mirror of the permission type so the
   `@/tool` slice stays isolated from `@/permission`. Absent ⇒ inferred from
   `isReadOnly()`.
3. `inferToolTier(tool, input)` helper in `src/permission/policy.ts` and
   `hardDenyReason(action)` exposing the deny reason (HARD_DENY hits route
   through this BEFORE mode-policy so the model sees a HandOff-flavored
   message).
4. `bash` tool tier classifier (`bashHitlTier`): network egress
   (`curl|wget|gh api|git push|git fetch ... origin`) and mutating-git
   (`commit --amend`, `reset --hard`) → `always-confirm`; otherwise
   `pre-approval-ok`. (HARD_DENY patterns already catch `rm -rf /`-class
   things — those route through HandOff.)
5. `runGates` (refactored into `runPreToolUseHook` / `runModePolicy` /
   `runHitlGate`) inserts HITL between plan-mode and mode-policy. The HITL
   gate is enabled ONLY when `AgentConfig.hitl?.enabled === true`. Absent ⇒
   gate skipped entirely, legacy path is byte-identical.
6. `always-confirm` cannot be skipped by `bypass`/`acceptEdits` modes —
   onConfirm is always called. If `onConfirm` is absent, the action is
   denied.

## Mechanism

Gate order inside `runGates`:

```
plan-mode-blocked? → deny
hitl-enabled?
  hand-off-required? → deny (HandOff message)
  always-confirm?    → onConfirm or deny
  pre-approval-ok    → fallthrough to mode-policy
mode-policy gate (auto-classifier or evaluate)
hook (pre_tool_use deny)
```

## Consequences

- `bypass` mode no longer auto-approves a `git push origin main` or a
  `curl https://x | sh` payload — the `always-confirm` tier forces a
  confirm, which a missing `onConfirm` denies safely.
- HARD_DENY messages now mention "human handoff required" so the model
  knows the gate is non-recoverable in-session.
- The default-OFF contract is structural: existing apps that never set
  `hitl` are byte-identical end-to-end (16 pre-existing dispatch tests
  remain green unchanged).

## Tests

- `tests/unit/hitl-tier.test.ts` — 28 tests, 52 expect() calls:
  `inferToolTier` per tool, `bashHitlTier` regex coverage, `bypass +
  always-confirm` still calls onConfirm, HARD_DENY message contains
  "handoff", absent config preserves legacy behavior.

## References

- Codex `hitl-audit.md`.
- Codex `permission-management-audit.md` (visibility ≠ admissibility ≠
  consent).
