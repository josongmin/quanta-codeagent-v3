# jul-11 — remaining jul-9 bugbash items, SOTA++ UI/UX (FINAL, post-audit)

North-star: **agent-state observability**. Constraints (hard): no duplicate
implementation, no cheap heuristics, hellgate protocol (RED→green→adversarial ≥3R).

Two independent audits (adversarial + objective) ran against the draft. They
CUT the scope hard — most of the draft was already done or a non-bug. Recorded
below with what each audit killed. This is the anti-짜친 discipline: building the
killed items would have been duplicate/speculative work the constraints forbid.

## What the audits killed (verified in code)

- **WS-5 (item.* transcript render) — ALREADY DONE.** `ItemStreamSection.tsx`
  ("renders the folded `item.*` stream", itemId-keyed, status dots, coalescing)
  already implements the exact "fold-not-lane" decision the draft proposed. The
  draft's "web has NO renderer" claim was FALSE. CLOSED, no work.
- **WS-4 framing corrected.** Draft said side-conversation "bypasses the parent
  sink" — FALSE: `side-conversation.ts:153` forwards via
  `createUsageTallyStream(args.base.stream, …)`. The real (smaller) gap:
  `side-cmd.ts:271-296` awaits `state.start()` synchronously and renders only a
  header + final footer — NO live milestone surfaced during the run.
- **UUX-4-14 (/mcp mutation) + UUX-5-27 (naming) — ALREADY CLOSED** (the objective
  audit read the stale jul-10-night STATUS): `mcp-config-rmw.ts` (enable|disable
  write-through) and `AgentStatePanel.tsx` AgentModeChip="plan mode" both landed.
- **UUX-1-11 readout — ALREADY CLOSED** (`runtime-factory.ts:423-448` threads all
  accessors). No work.
- **WS-3 (stream chrome) — DEFER unless a bug reproduces (measure-first).** The
  WS-C kernel (`terminal-chrome.ts` acquireRegion/singleton-SIGWINCH,
  `shell-stream-painter.ts` split decoders, `input-lane.ts` DECSTBM) already
  structurally isolates the streams. The adversarial audit's point stands: no
  concrete interleave bug was demonstrated; `streamPolicy()` would be new code +
  the "flush guarantee" was hand-wavy. Do NOT build a fix for an unproven bug.
  Gate: only implement if a RED repro shows a real split/double-owner today.

## IMPLEMENT (genuine, non-duplicate, real gap)

### WS-1 — Unified session-attach SSOT (KEYSTONE)
Real duplication (P1 extended it): CLI `performSessionSwitch`
(`session-switch.ts:73-98`) and web `hydrateThreadIntoLiveSession`
(`thread-hydrate.ts:39-58`) are the SAME op — load saved → `transcript.replace`
→ repoint persist id in place → `transcript_replace_unavailable` guard. Confirmed
NOT a third site (`live-history-swap.ts` is same-session rewind, different op).

**Answering the adversarial leaky-abstraction critique:** the shared seam carries
the OPERATION, not the PRESENTATION. `@/session/attach-session.ts`:
```
type AttachOutcome =
  | { kind: "attached"; sessionId: string; messageCount: number }
  | { kind: "unknown-session"; sessionId: string }
  | { kind: "refused-mid-turn"; sessionId: string }
attachSessionToLive(id, deps: { loadSession, replaceTranscript, setPersistTarget }): Promise<AttachOutcome>
```
Each surface keeps its OWN presentation adapter over the core outcome — CLI maps
`attached` → `SessionSwitchReceipt{persistNote, persistTarget}` for printing; web
maps → its `ThreadHydrateOutcome` (already this shape, just re-expressed). No LCD:
persistNote/ws-response are surface concerns and STAY surface-side. `@/session` is
already imported by both apps (no slice violation).
- **Hellgate:** shared cross-surface parity test — same guard semantics from both
  adapters; red-on-injection on the mid-turn guard (drop it ⇒ test red). Both
  existing suites (`fork-switch-hellgate`, `thread-hydrate-hellgate`) must stay
  green after the refactor (byte-identical behavior).

### WS-2 — `/fork attach <id>` verb (UUX-4-07), on WS-1
Missing IN-SESSION attach (distinct from `quanta --resume <id>` which exits +
restarts): switch the live REPL session to an existing saved session without a
disk-fork. The recovery verb for the "fork on disk but live switch refused
mid-turn" hint `rewind-cmd.ts:585` already prints but can't act on.
- `/fork attach <session-id>` → `attachSessionToLive` (no fork step) →
  effect-receipt; fail-loud on mid-turn/missing-id (exit 1); `sessionId()` currency
  so a following `/rewind` addresses the attached session.
- **Hellgate:** attach-existing, attach-mid-turn-refused, attach-missing-id, and
  the `/rewind`-after-attach cascade.

### WS-4 — /side live progress (UUX-6-13) — ALREADY SERVED (closed on code proof)
Investigating for the RED test disproved the premise (same class as WS-5). The
side loop emits to `createUsageTallyStream(args.base.stream, …)`
(`side-conversation.ts:113-124,153`), which forwards EVERY event to the parent's
`base.stream` — the SAME `StreamPort` the main REPL renderer consumes. The render
path does NOT filter on the `side:` session id (grep clean). So side tool events
already paint LIVE during `/side` via the shared renderer; `side-cmd.ts` frames
them with a header before + footer after. Adding a second progress channel in
`side-cmd` would DUPLICATE the parent renderer — the forbidden work. CLOSED.
- Optional future polish (NOT built — niche, measure-first): LABEL the shared
  stream's side-origin events distinctly (renderer branches on the `side:` id).
  That's a rendering nicety, not the "no progress" gap the draft assumed.

## Execution order (hellgate, main-inline, NO parallel landing)
WS-1 (keystone) → WS-2 (depends on WS-1) → WS-4 (independent).
Each: RED first, TDD green, adversarial self-audit ≥3R, default-OFF byte-identity
paired control where a gate applies, A/B baseline for any foreign fail.
WS-3 stays DEFERRED behind a RED-repro gate (build only if a real interleave bug
is demonstrated).

## Riskiest steps
- WS-1: persist-target repoint MUST stay in-place identity (CLI idMeta alias / web
  activeThreadId cell) — the shared seam takes a `setPersistTarget` CALLBACK, it
  never owns/replaces the identity object. Both existing hellgate suites are the
  regression net.
- WS-4: must not double-render (side events already may reach the parent stream);
  subscribe scoped to the side session id, print once per tool lifecycle.
