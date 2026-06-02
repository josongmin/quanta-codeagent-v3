# ADR-0444 — turn-completion terminal notification (OSC title + BEL)

**Status:** Accepted (2026-06-02)
**Type:** UX/DX slice — RFC-09 (`docs/plans/jun-2-misc/09-completion-notify-and-context-warning.md`), feature A.
**Scope:** new leaf `src/apps/cli/notify/` (`port.ts` / `osc-adapter.ts` /
`notify-enabled.ts` / `index.ts`) + wiring through `prompt-pipeline.ts`,
`session-loop.ts`, and the composition root `repl.ts`. Default-OFF behind
`QUANTA_NOTIFY` (opt-in).

## Context

During a long turn (build / large grep / sub-agent) the user switches to another
window. quanta had ZERO OSC title / bell usage (`grep` of `src/apps` returned 0
hits) so there was no passive "come back, I'm done" signal. Claude Code ships a
`notifChannel` enum (`terminal_bell` / `iterm2_with_bell` / `notifications_disabled`)
with two trigger toggles (`inputNeededNotifEnabled` vs `agentPushNotifEnabled`);
Codex ships a configurable `[tui].terminal_title` + a `turn/completed`
notification. We absorb the fixed-format subset.

## Decision

A closed-port `NotificationPort` exposes only SEMANTIC events —
`onTurnComplete` / `onIdleAwaitingInput` / `markActive` / `dispose` — and knows
NOTHING about escape sequences (DIP; liftable to a Tauri/Web toast). The default
`createOscNotificationPort` adapter is the only place that knows OSC/BEL: it
emits `ESC ] 0 ; <title> BEL` (Claude OSC form `:190796`, BEL `:13717`) with the
title run through a `sanitizeTitle` char-code filter (strips C0 + DEL — the
title-injection guard).

Reused signals (NO new measurement):
- "slow turn only" gate reuses the runner-measured `RunOneTurnResult.durationMs`
  (`turn-runner.ts:138`). Fast turns are silent (anti-spam). Default 10s.
- idle path reuses the existing `idle-monitor` gate inside the prompt pipeline;
  notify fires ONCE per idle entry (latch), reset by `markActive` on the next
  accepted prompt.

The two triggers map 1:1 onto Claude's split (`onTurnComplete` = agent-push,
`onIdleAwaitingInput` = input-needed).

## Gate (default-OFF, opt-in)

`resolveNotifyChannel(env, isTTY)` clones the `isStatusBarSupported` idiom:
non-TTY ⇒ `"off"` (NEVER write an OSC byte to a pipe), `TERM=dumb` ⇒ `"off"`,
`QUANTA_NOTIFY` unset ⇒ `"off"`. `bell` ⇒ title+BEL, `title`/`title_only` ⇒
title only, truthy ⇒ `bell`, unknown ⇒ fail-closed `"off"`. Unlike the spinner
(default-ON), the title is a visible side effect on the user's tab, so opt-in is
required.

## Wire points (end-to-end, live)

- `repl.ts` `buildNotificationPort()` — builds the port from `QUANTA_NOTIFY` +
  `process.stdout.isTTY`, binds `write` to `process.stdout.write`; passed to
  `runSessionLoop` only when present.
- `session-loop.ts` — `notifyTurnComplete(notify, out, cwdBasename)` after each
  finished turn (one-shot + interactive branches); `registerNotifyDispose`
  pushes title-restore onto the LIFO close stack; notify + cwd threaded into
  `composePromptPipeline`.
- `prompt-pipeline.ts` — idle gate fires `onIdleAwaitingInput` (latched) and
  `markActive` on accepted prompt.

## Consequences

Default-OFF byte-identical: `QUANTA_NOTIFY` unset ⇒ no port ⇒ all `notify?.`
calls are no-ops, no close-stack entry, OSC 0 bytes. Title restored on teardown
(neutral cwd title, not empty, for multiplexer safety). Idempotent dispose.

## Non-goals (deferred)

- iTerm2 native OSC 9 / 1337 push notifications (Claude's "iTerm2" half) — port
  extends by adding an adapter.
- Codex full `[tui].terminal_title` config DSL — v1 is a fixed format.
- Per-emulator detection table — v1 uses the conservative TTY + `TERM != dumb`
  gate (worst case: a pane title changes, never raw-escape leakage).
- OS-level desktop notifications (external binaries).
- tmux/screen DCS passthrough wrapping — plain OSC 0 only (the multiplexer
  handles it; worst case a pane title changes).

## Adversarial-review notes (2026-06-02)

- **Title persists "✓ done" until the next prompt (interactive).** Intentional —
  NOT fixed by calling `dispose()` per turn, because `dispose` is idempotent and
  latches `disposed=true`, so a per-turn call would kill notifications for the
  rest of the session. The title naturally transitions to "… waiting" on the
  next `onIdleAwaitingInput`, and is restored at session teardown via the LIFO
  close-stack. Acceptable: a brief post-turn "done" title is the desired signal.
- **snooze + idle latch:** `markActive()` is deliberately NOT called while
  `idle.isSnoozed()` (the input is declined), so the idle latch correctly stays
  set during snooze — re-notify only resumes after a real `markActive()` on an
  accepted prompt. Confirmed correct; a dedicated snooze×notify test is the one
  remaining coverage gap (behavior verified by reading, not yet pinned).
- **sanitizeTitle hardened** beyond C0+DEL to also strip C1 controls (0x80-0x9f,
  incl. NEL 0x85) and U+2028/U+2029 line/para separators — all can break or
  hijack the OSC frame. Covered by an osc-adapter hellgate case.
