# ADR-0496: control-request runtime surface

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - `src/agent/control-request/` (types + planner + port + barrel)
  - Tests: `tests/unit/control-request-hellgate.test.ts`
  - Consolidates: `src/agent/submission.ts` (`SubmissionOp`) + `src/agent/conversation-action.ts`
  - Absorbs: Claude Code 2.1.167 control-request protocol (docs/plans/jun-7-draft-ide-integration-spec-claude.md §2)

## Context

Claude Code drives a live session through a unified control-request channel (~30 subtypes:
set_model / set_permission_mode / set_max_thinking_tokens / get_context_usage / interrupt / rewind / …).
quanta had the interrupt / cancel_subagent / set_mode / set_brief members scattered across `SubmissionOp`
and `ConversationAction`, but NO unified surface for the model / permission-mode / thinking / usage
controls — "조각조각 있지만 하나의 일관된 채널로 안 묶여있음".

## Decision

A single closed union `ControlRequest` (set_model / set_permission_mode / set_thinking / get_context_usage)
+ an exhaustive `ALL_CONTROL_REQUEST_KINDS` array + a PURE `planControlRequest(req, ctx)` that maps each
request to a typed `ControlEffect`. The planner invents NO vocabulary: model ids, permission modes, and
thinking levels are validated against caller-supplied allowlists (the composition root passes the real
sets), so the slice carries zero coupling. Fail-closed: an off-allowlist / malformed request ⇒ a typed
`rejected` effect; a null/garbage request never throws. A `ControlRequestPort { next() }` is the
host-injection shape (mirrors `conversationActionPort`).

Scope note: this round adds the NET-NEW controls; folding interrupt / cancel / set_mode / set_brief
(already in `SubmissionOp`) under this umbrella is the documented consolidation follow-up.

## Default posture

OFF. `isControlRequestEnabled(env)` = `gateOn(QUANTA_CONTROL_REQUEST)`. Unset ⇒ a host wires no port and
the loop never polls — byte-identical. The planner is pure (always callable in tests); the live-loop poll
site (turn-iteration chokepoint, like `pollConversationAction`) is the documented follow-up wire — the
same posture as `SubmissionOp.set_mode` ships in today.

## Correctness invariants (hellgate-proven)

1. Each kind maps to its effect on the happy path.
2. Fail-closed: off-allowlist model / mode / level, empty model, and missing usage snapshot all ⇒
   `rejected` (never applied).
3. An absent allowlist means the host opted out of gating that axis (value accepted as-is).
4. NO-THROW on malformed / null / undefined request.
5. Exhaustive kind coverage; default-OFF gate via the @/shared SSOT.

## ROI / tradeoff

Gives quanta one typed, validated, fail-closed control vocabulary for live-session steering — the missing
"host drives a live agent" surface for the `ide` preset. Pure + ported now; live-loop application is the
low-risk follow-up wire done one subtype at a time with regression checks (per hot-path discipline).

## CLI wiring note (2026-06-07) — deliberately NOT wired on CLI (redundant, not deferred)

This surface is for a HOST (ide/web) to steer the loop over a wire. On the **CLI the user IS the
controller** and the same effects ALREADY exist as first-class slash commands: `set_model` ⇔ `/model`
(ADR-0462 sticky model) + `/retry-with` (ADR-0065/0066 model swap); `get_context_usage` ⇔ `/context` +
`/cost` + `/usage`; effort ⇔ the effort slash. Adding a `controlRequestPort` poll to the turn loop on CLI
would (a) duplicate those slash commands and (b) be hot-path surgery on every turn for a consumer that
isn't the CLI. So control-request stays the verified host-wire vocabulary; its live consumer is the
out-of-repo ide/web adapter (like the rest of §6/§10 in the IDE spec). This is an architectural decision,
not an unfinished wire — `set_model`/`get_context_usage` are genuinely usable on CLI today via slash.
