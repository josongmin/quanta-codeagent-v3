# Ticket — Peer/Side-Agent Mail: audit fixes + user-visible surfacing (Codex parity)

- **Date:** 2026-07-15
- **Status:** OPEN (nothing landed; RFC accepted)
- **RFC (SSOT for design + file-level plan):** `docs/plans/jul-15-peer-message-user-surfacing-rfc.md`
  — §2 audit findings, §2.6 duplication audit, §4 workstreams, §9 commit-sliced implementation plan.
- **Provenance:** jul-15 hellaudit of the subagent-mailbox / peer-messaging / side-agent stack
  (adversarial + objective, all findings file:line-verified by direct read; hellgates 43/43 green
  on the substrate) + Codex corpus dig (`.extracted_source/codex/`, webview + bin symbols).
- **Goal:** (1) fix the three wiring defects the audit found; (2) make agent-to-agent mail
  VISIBLE to the user as an attributed transcript item — Codex "Sent by Codex from another
  task" UX, terminal dialect first.
- **Protocol:** hellgate 5-stage per item; RED-first; static checks + leaf unit tests until
  landing gates; 3R adversarial audit before each land.

> Coordination hazard: a concurrent session is actively landing multi-agent-panel work in
> `stream/types.ts` / `stdout.ts` (it added `subagent_spawn`/`subagent_status`, union now 39).
> Rebase onto fresh `origin/main` immediately before Wave 2; keep union edits minimal appends.
> Re-check `HEAD` before every commit; no ref rewrites; file-scoped biome only.

---

## ALREADY DONE — do NOT rebuild (dedup, grep-verified jul-15; RFC §2.6)

- Mailbox substrate is SOUND: per-reader delivery cursor, NO-THROW, LRU + retention +
  snapshot quota sweep, anti-injection escaping, redaction seam, team gate fail-closed
  (`src/agent/subagent-mailbox/*`). Do not touch store semantics.
- Auto-delivery to the MODEL exists and works: `pollPeerInbox` → `wm.append` at turn-top
  (`loop/control-poll.ts:97-106`, `loop/turn-iteration.ts:113-114`), delivered-once, capped 32.
- `communicate_update` → `progress_update` → stdout render: LANDED but child-dead
  (`progressSink` not in `buildChildConfig` keep-list). Different verb; see PARKED-1.
- Raw child stream ALREADY interleaves into the terminal unattributed
  (`subagent-runner.ts:627` + no filter in `stdout.ts`) — visibility gap is attribution +
  mailbox channel, not "nothing shows".
- NOT duplicates: side-conversation (ADR-0049, never spliced into main thread), OSC completion
  notify (ADR-0444), operator-notice bus (stderr degrade), item-stream `subagent` member
  (lifecycle only), jul-13 goal chip. `AGENT_EVENT_TYPES` has no mailbox-shaped member.

---

## Wave 1 — audit fixes (branch `feat/peer-mailbox-audit-fixes`; small, land first)

### W1-a — [P1] Side-agent finding dead-letter: recipient SSOT `"root"`
- **What/why:** daemon findings publish to `cfg.mailboxAgentId ?? "main"`
  (`agent-config-assembler.ts:643`) but every root read path uses `"root"`
  (`control-poll.ts:101`, tool depth-fallback). Nothing reads `"main"` ⇒ the advertised
  mailbox push channel is dead in ALL root-session configs.
- **Fix:** `ROOT_MAILBOX_AGENT_ID = "root"` const in `subagent-mailbox/types.ts`; both
  consumers use it. RED-first hellgate: publish → `read("root")` non-empty, `read("main")`
  empty control. Grep-sweep `?? "main"` to 0.
- **ROI:** one-line class of fix revives a landed feature's output channel; prerequisite for
  Wave 2 (side-agent findings ride the surfacing rail).

### W1-b — [P1] Mailbox factory SSOT (per-sender DoS cap)
- **What/why:** `optional-ports.ts:564-567` bakes `maxUndeliveredPerSender`;
  `agent-config-assembler.ts:413`/`:642` mint quota-less ⇒ assembler-only surfaces get an
  uncapped mailbox (AGT-035's exact fear, half-realized).
- **Fix:** `createDefaultSubagentMailbox()` in the owner slice; all three call sites use it.
  RED-first flood test on the assembler path.
- **ROI:** 3-line convergence closes a DoS-posture drift class permanently.

### W1-c — [MED] Honest cross-team deny at the tool surface
- **What/why:** denied send renders `ok:true "sent message msg_cross-team-denied"`
  (`team-scoped.ts:112` + tool render) — model believes delivery succeeded; with
  `QUANTA_TEAM_PEER_MSG=1` and no team, child→parent silently no-ops.
- **Fix:** additive `denied?: "cross-team"` on the stand-in message (store never sets);
  tool renders `ok:false` + team_create guidance; description += team prerequisite sentence.
  Keep un-teamed⇒deny semantics (converged design) — honesty only.
- **ROI:** removes a knob-on behavioral trap; model can react (create team / report) instead
  of false-believing.

**Wave-1 land gate:** targeted `bun test` + typecheck + file-scoped biome + 3R adversarial
audit on the diffs.

---

## Wave 2 — user-visible surfacing (branch `feat/peer-message-surfacing`; after Wave 1)

Full file-level plan: RFC §9 Wave 2 (4 commits). Summary:

### W2-1 — `peer_message` AgentEvent at enqueue time
- New union member (mirrors `subagent_spawn` conventions) + `surfaceNotifyMailbox` decorator
  wrapping the RAW store at the mint seam (BEFORE side-agent `:486` and team `:939` wiring —
  ordering invariant), host sink = clone of `progress-sink-wire.ts` shape.
- Provenance on send-init only (`{source:"peer"} | {source:"side-agent", daemonId}`);
  body = same redact+escape the model sees. Knob `QUANTA_PEER_MSG_SURFACE` default-OFF with
  full runtime-config SSOT burden.
- Recorder: RECORD with explicit `KIND_MAP`/`dataOf` arm (durable copy is conditional on
  drain — differs from `subagent_spawn`'s skip rationale).
- Cascade checklist RFC §WS1 (stdout / projection / projector / recorder / timeline / tracer /
  `Record<AgentEventType` grep) — same commit, full typecheck gate.
- **ROI:** the actual feature — Codex-parity promptness (display at enqueue, no forced turn),
  covers BOTH teammate mail and side-agent findings on one rail.

### W2-2 — item-stream member `peerMessage` (append-only)
- `item-stream.ts` unions + map entry; projector atomic started+completed; zero transport
  edits (planes carry itemType verbatim); web ItemStreamSection renders generically for free.
- **ROI:** web/agent-state surfaces get the message for one enum append.

### W2-3 — CLI render (label-above-bubble, terminal dialect)
- `stdout.ts`: `✉ sent by <from> — from another task [kind]` DIM label + body ≤4 lines +
  collapse marker; side-agent label variant via `provenance.source`.
- **ROI:** the visible deliverable of the whole ticket (user's original ask).

### W2-4 — feature catalog + docs
- New `peer-message-surfacing.yaml` (owner-local hellgate), refine peer-teammate-messaging +
  side-agent entries, RFC status flip.

**Wave-2 land gate:** full typecheck + drift-guard suites (default-OFF sweep, knob parity,
event vocab) + replay smoke (recorder arm) + 3R hellaudit (adversarial lenses: emission on
denied send, redaction bypass, wiring order, double-display).

---

## PARKED (decision needed, not code)

- **PARKED-1 — `progressSink` child propagation quick-win.** One spread line in
  `buildChildConfig` + optional `from?` on `progress_update` would let subagents explicitly
  report progress to the user TODAY via the landed `communicate_update` rail. Different verb
  (self-progress; no mailbox/side-agent coverage; no idle delivery) — neither replaces nor
  blocks Wave 2. **Why parked:** the keep-list omission may be deliberate (child spam of the
  parent indicator). Decide intent, then it's a ~1-hour item.
- **PARKED-2 — WS4 web label+bubble polish + click-to-navigate.** Blocked on web thread-nav;
  measure engagement of the W2-2 generic row first.
- **PARKED-3 — surface enablement (seed `QUANTA_PEER_MSG_SURFACE` in CLI gates).**
  Measure-first: flip after a live engagement smoke, same discipline that opt-in'd the
  mailbox itself (`gated-tools.ts:139`).
