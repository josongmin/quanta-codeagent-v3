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

## Web-daemon live wire (2026-07-03, jul-03 A1 producer)

The jul-03 A1 round (7fd701f2b) activated the previously-inert loop drain
(`pollControlRequests`) — but with NO producer feeding the port the protocol was still
inert. This round wires the MISSING PRODUCER on the **web-daemon host surface** (the
in-repo IDE/web adapter):

- `src/apps/web-daemon/control-request-frame.ts` — `peekControlRequest(raw)`: decodes an
  out-of-band `{kind:"controlRequest", request:<ControlRequest>}` WS frame (mirror of
  `peekPlanInputAnswer` / `peekFollowerVerb`). Consumed at the connection layer BEFORE the
  session bridge — NOT a `SessionCommand`, never touches the kernel reducer.
- `src/apps/web-daemon/web-control-request-port.ts` — `createWebControlRequestPort({permission,…})`:
  the `ControlRequestPort` (bounded latest-wins queue) + the `ControlEffectApplier` + the live
  `ControlRequestContext`. The **load-bearing** effect: `set_permission_mode` mutates the daemon's
  LIVE mutable `permission.mode` cell (the exact getter/setter `runtime-factory` builds), which the
  per-turn permission gate reads FRESH — so the mode ACTUALLY flips mid-session. Permission is
  fail-closed at the planner (an explicit allowlist is REQUIRED — the closed `ALL_PERMISSION_MODES`
  SSOT).
- `runtime-factory.ts` mints the port under `QUANTA_CONTROL_REQUEST`, wires the `controlRequest`
  AgentConfig slot, and exposes it on the facade; `index.ts`/`server.ts`/`ws-handlers.ts` thread the
  port bundle so a peeked frame is `enqueue`d. Gate OFF ⇒ no slot ⇒ the loop never drains and a stray
  frame falls through to the bridge (byte-identical).

HONEST SCOPE: `set_model` / `set_thinking` / `get_context_usage` have no live daemon CELL to land on
today (there is no per-session model/thinking swap cell exposed the way permission is, and no live
usage source is wired). Their applier callbacks SURFACE the planned effect through an optional
`observe` sink (not silently dropped) rather than mutating runtime state — this is the honest
remaining gap, not a faked applier. `set_permission_mode` is the one axis with a real end-to-end
observable effect; the others become live the moment the daemon exposes those cells (a sticky-model
store set + a live usage supplier).
