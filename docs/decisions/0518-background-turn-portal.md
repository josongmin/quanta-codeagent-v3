# ADR-0518: background-turn portal — Ctrl+B detach + `/background` (ticket-18 V1)

- **상태**: Proposed
- **날짜**: 2026-06-09
- **관련**:
  - `src/apps/cli/repl/background-turn-portal.ts` (pure state store + bounded HEAD+TAIL buffer + read-only `view()`)
  - `src/apps/cli/background-cmd.ts` (`/background [list|reattach <id>|cancel <id>]` render)
  - Wiring: `src/apps/cli/repl/surface-compose.ts` (gate-build + `ctx.background` thread), `src/apps/cli/repl/session-loop.ts` (`shouldWireBackground` WEAVE guard + Ctrl+B detach sink), `src/apps/cli/slash/registry-surface.ts` (BUILTINS append)
  - Gate: `QUANTA_BG_TURN` (`src/config/knob-inventory.ts`, default-OFF)
  - Tests: `src/apps/cli/__tests__/background-turn-portal.hellgate.test.ts`, `src/apps/cli/__tests__/background-ctrlb-turn-runner.hellgate.test.ts`, `tests/unit/apps/cli/repl/background-turn-portal-buffer.test.ts`

## Context

A running interactive turn was all-or-nothing: the operator either waited it out or Esc-Esc
cancelled it (losing the work). Competitors (Claude Code background tasks, Codex async runs) let a
long turn be detached and observed later. This is the **highest-risk surgery** of the ticket batch
because it touches three fragile invariants at once: (1) **turn atomicity** — the body promise must
keep running after detach without orphaning; (2) **signal cleanup** — the turn's own
`AbortController` is shared, so a backgrounded body that rejects must NOT surface as an unhandled
rejection and a later cancel must unwind cleanly; (3) **WEAVE conflict** — WEAVE mode blends a
mid-turn line into the CURRENT turn, so backgrounding mid-weave would orphan the live blend (and an
in-flight INTERRUPT is mid-resume of a partial turn). Naive "just hand the promise off" breaks all
three.

## Decision

A **pure passive-observer** portal (`createBackgroundTurnPortal`) that imports NOTHING from
`@/agent` — it never re-enters the loop. On Ctrl+B, the loop hands the SAME live body `promise` plus
the turn's `AbortController` to `detach()`, which registers a `running` entry and attaches a
**NO-THROW** `.then/.catch` that swallows the outcome into a terminal state
(`done`/`failed`/`cancelled`) — the original promise keeps running, owned by the portal, and a
rejection never escapes. An `AbortError` is mapped to `cancelled` (user backgrounded then cancelled),
distinct from a genuine `failed`. Streamed output is captured in a **bounded HEAD+TAIL window**
(`makeBoundedBuffer`, 50 MiB cap, UTF-8-byte-accurate so a multibyte char split at the cut decodes to
U+FFFD rather than a lone surrogate) with a `… +N KB elided …` middle marker — head is never dropped
(it explains what the turn was doing). `view()` exposes a **read-only** projection
(`BackgroundPortalView`: list/get/reattach/cancel) threaded onto `SlashContext.background`; the full
write-capable portal stays surface-private. `/background` is **observe-only in V1**: `reattach` is
print-only (buffer + result/error, "still streaming" if running) and the SDK session remains the SSOT
for the merged transcript — V1 does NOT fold the result back into surface history. The WEAVE conflict
is closed by `shouldWireBackground`: the Ctrl+B sink is wired ONLY when a portal exists AND inbound
mode ≠ `weave` AND no interrupted turn is active; otherwise the keypress is a silent no-op (the turn
runs exactly as if the key were unbound). Whole thing is gated `QUANTA_BG_TURN` (default-OFF): absent
slot ⇒ `/background` prints "not wired" + exit 0, byte-identical to every other presence-gated panel.

## Consequences

Operators can detach a long turn and reattach/cancel it from `/background`, without the surgery
risking unhandled rejections, orphaned weave blends, or surrogate-corrupted buffers. The cost is a
deliberately thin V1: persistence across restart (V2) and live re-entry reattach that re-awaits the
body (V3) are out of scope — `reattach` is print-only and the SDK session owns the merged transcript.
Alternatives rejected: (a) re-awaiting the body inside the slash (would re-enter the loop from a
read-only surface — breaks the passive-observer invariant); (b) newest-only output buffering (loses
the head that explains the turn); (c) wiring Ctrl+B unconditionally (orphans the WEAVE live blend).
