# Ticket 07 — wire the dead `summarize` conversation-action verb

**Date:** 2026-06-07
**Status:** 📐 Design (no impl).
**Gap:** §11.5 follow-up — the mid-turn control subsystem (ADR-0071) has a `summarize` verb that is **decided but never executed**. Sibling of the now-fixed `resume` verb (ticket-less, landed this session via `interrupted-turn.ts`).
**Slice:** `@/agent` (control-poll) + `@/agent/compaction` (the existing summarizer). Surface already has `/summarize-now`.
**Candidate ADR:** next free (≥ 0510).
**ROI:** cost 저, impact 중 — the verb + slash + decide-path already exist; only the executor is missing. Low-risk continuity win.

## 1. Problem
`decideAction` (`src/agent/conversation-action.ts`) returns `accepted_control` for `{kind:"summarize"}`, and `/summarize-now` (`registry-session.ts`) pushes it. But `control-poll.ts`'s `accepted_control` switch handles only `cancel` + `cancel_subagent`; **`summarize` falls through to `conversation_action_noop`** (a recovery event) and nothing happens. Verified jun-07: `grep "summarize" src/agent/loop/control-poll.ts` → 0.

So a user typing `/summarize-now` mid-turn gets "queued" ack but the conversation is never summarized.

## 2. Current state (src-verified)
- `control-poll.ts` `accepted_control`: `cancel`→finish_aborted, `cancel_subagent`→cancel child, else→noop.
- A compaction/summarization engine EXISTS: `src/agent/compaction.ts` (+ `loop/compaction-wire.ts`, `microcompactToolResults`). The loop already compacts on the auto-window; there is a real summarizer to call.
- `resume` (the sibling) was just wired (control-poll → buffer→injection) — same shape: a new poll-outcome that the loop consumes.

## 3. Design
- Add a `summarize` branch in `control-poll.ts` `accepted_control`: return a new outcome `{kind:"summarize"}` (or reuse a recovery+flag) that `syncQueuedTurnInputs` / the turn loop turns into a **mid-turn compaction pass** over the working memory.
- The actual summarization = call the SAME compaction path the auto-window uses (inject a `summary` message / replace history per `compaction.ts`'s contract), gated so absent compaction config ⇒ clean no-op (byte-identical).
- Default-OFF: when no compaction port wired ⇒ `summarize` stays a no-op (with an honest recovery detail `summarize:no_compactor`), never a crash.

## 4. Files to touch
- `src/agent/loop/control-poll.ts` — `summarize` branch + a `ConversationActionPollOutcome` arm (or reuse `injection` with a summary message).
- `src/agent/loop/turn-iteration.ts` — consume the summarize outcome → run the compaction pass over `wm`.
- (maybe) `src/agent/compaction.ts` — expose a one-shot `summarizeNow(wm, ...)` if not already callable mid-turn.

## 5. TDD / hellgate plan (red-first)
- control-poll: `summarize` accepted_control + compactor wired → returns the summarize outcome (not `conversation_action_noop`). RED first (today it's noop).
- control-poll: `summarize` + NO compactor → honest no-op (`summarize:no_compactor`), no crash (default-OFF byte-identical).
- turn-iteration e2e: push `summarize` → wm is compacted (history replaced/summary appended) per the compaction contract; subsequent turn sees the summary.
- regression: the existing `cancel`/`cancel_subagent`/`resume` branches unchanged.

## 6. Risk
- Mid-turn compaction must not corrupt in-flight working memory (same risk the auto-window already manages — reuse, don't reinvent). Run the existing compaction hellgates as regression.

## 7. Open questions
- Does `compaction.ts` support an on-demand pass mid-turn, or only the window-triggered path? (Read before designing the call.) If only window-triggered, the ticket grows to expose a one-shot seam.
