# Ticket 08 — steering UX residual: weave-race hardening + mid-turn input visibility

**Date:** 2026-06-07
**Status:** 📐 Design (no impl).
**Gap:** §11.5 follow-up — two residuals from the landed inbound 3-mode + interrupt-restore work.
**Slice:** `@/agent` (weave race) + `@/apps/cli` (TTY visibility).
**Candidate ADR:** next free (≥ 0510).
**ROI:** **08a weave-race** cost 저, impact 저 (rare edge, already fails-safe). **08b mid-turn visibility** cost 고 (TTY hot-path), impact 중 (UX). Split — 08a is a quick hardening; 08b is the genuinely-hard one (deliberately deferred at first build).

## 08a — weave same-turn race (preserve, don't drop)

### Problem
`weave` routes a mid-turn line through `conversation-action.pushUserMessage` → the loop's `decideAction` re-runs `steer()` at poll time. If the turn ENDS in the window between the user's keypress and the next poll, the captured `expectedTurnId` mismatches → `decideAction` rejects (`expected_turn_mismatch`). This correctly prevents mis-injecting into the WRONG turn, but the message is then **consumed-from-the-port and dropped** (not re-queued). Rare, but a silent loss.

### Current state (src-verified)
- `control-poll.ts` `pollConversationAction`: a `rejected` outcome emits an error event + `{kind:"continue"}` — the action is gone (port.next() already shifted it). No re-queue.
- The inbound router's no-active-turn / non-steerable cases ARE preserved (queue_fallback) — only this tight turn-end race is uncovered.

### Design
- On `decideAction` `rejected` for a `user_message` with reason `expected_turn_mismatch`/`no_active_turn`/`interrupted` (i.e. "couldn't weave"), **re-enqueue the text onto the follow-up/external queue** instead of dropping it — same "never lose a non-empty message" invariant the router already enforces.
- Needs a queue handle reachable from `control-poll` (or surface it back to `syncQueuedTurnInputs`, which has the loop's queues). Cleanest: control-poll returns a new outcome `{kind:"requeue", text}` that the loop pushes to the follow-up queue.

### TDD (red-first)
- decideAction rejects a `user_message` (turn ended) → control-poll returns `requeue` (RED: today it's continue+drop) → loop enqueues the text → it runs next turn.
- non-`user_message` rejects (malformed control) → still error+continue (unchanged).

## 08b — mid-turn input visibility (TTY redraw lane)

### Problem
With `QUANTA_MIDTURN_CAPTURE=on`, the in-turn reader captures keystrokes WHILE the turn streams, but the user **sees nothing** — no echoed input line, no cursor. They type blind. (The capture/route works; only the render is missing — explicitly deferred at the inbound build as a hot-path TTY concern.)

### Current state (src-verified)
- `in-turn-reader.ts` reads raw stdin during the turn (raw-mode save/restore done) and fires `onLine`. No echo, no bottom-anchored input lane.
- The streaming output writes to stdout unmanaged; an echoed input line would collide with streamed tokens (the contention the original code called out as out-of-scope).

### Design (the hard part — calibrate, no magic)
- A bottom-anchored **input lane**: reserve the last terminal row for the live mid-turn buffer; stream agent output ABOVE it (cursor save/restore + line-clear per redraw). Echo keystrokes into the lane; on Enter, route via the existing `routeMidTurnLine` and clear the lane + print the ack.
- Must coexist with: existing raw-mode lifecycle, Ctrl-C/Esc-Esc arbitration, paste-burst, and the streaming renderer. This is the genuine cost.
- Default-OFF: only when `QUANTA_MIDTURN_CAPTURE=on` AND a TTY; non-TTY/pipe ⇒ byte-identical (no lane).

### TDD (what's testable)
- The lane STATE machine (buffer edits, enter→flush, backspace, clear) is pure → hellgate it.
- The raw render (ANSI cursor moves) is hard to unit-test; pin the emitted control-sequence STRINGS for given buffer transitions (snapshot of the escape bytes), not live TTY.
- Regression: non-TTY path unchanged; raw-mode restored on every exit (existing in-turn-reader invariant).

## Risk
- 08b touches the REPL render hot-path — highest-risk item in the steering area. Land 08a first (cheap, pure); gate 08b behind its own knob if needed and verify live before default.
