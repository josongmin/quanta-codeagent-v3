# RFC — Peer/Side-Agent Message Surfacing to the User (Codex "Sent from another task" parity)

- **Status**: PROPOSED (jul-15)
- **Scope**: fix the three defects found in the jul-15 peer-messaging hellaudit (F1 dead-letter,
  F2 quota split-brain, F3 dishonest deny), then surface agent-to-agent mail to the USER as a
  first-class, attributed transcript item — following the Codex UI/UX pattern verbatim.
- **North star**: agent-state observability (what is the agent doing / why / what's next) —
  a subagent/side-agent that reports back must be VISIBLE to the operator, not only to the model.
- **Protocol**: hellgate 5-stage per workstream (RED e2e setup → TDD → adversarial audit ≥3R →
  self-audit → structural TDD backfill). Static-first; leaf unit tests only until landing.

---

## 1. Evidence — the Codex pattern (corpus-verified, jul-15)

All refs are into `.extracted_source/codex/` (webview bundle + `_codex-bin-symbols.txt`).

### 1.1 Data model: provenance-stamped user message, NOT a new bubble kind

The receiving thread's transcript carries the injected prompt as a **normal `userMessage`
item** with an optional provenance variant. The renderer branches on the variant:

```js
// webview/assets/app-initial~app-main~onboarding-page-zcfEkMl-.js (beautified)
if (n.heartbeatTrigger != null) { … }                     // "Sent by scheduled task"
if (n.codexDelegation != null) {
  return jsx(zDe, { sourceThreadId: n.codexDelegation.sourceThreadId,
                    message: n.message, sentAtMs: n.sentAtMs, cwd, hostId, compactActions })
}
```

- `userMessage.codexDelegation: { sourceThreadId }` → cross-task message.
- `userMessage.heartbeatTrigger: { automationId }` → automation-sourced prompt
  (i18n `heartbeatUserMessage.automation` = "Sent by scheduled task").

### 1.2 Rendering: standard user bubble + muted clickable attribution label above

```js
// zDe → WV: right-aligned column; label row (icon + text, onClick → navigate
// to `/local/${sourceThreadId}`), then the ordinary user-message bubble
// (collapsedLineCount = 2 → long bodies collapse).
label = [icon] + i18n("localConversation.codexDelegationUserMessage.codex",
                      "Sent by Codex from another task")
```

Key properties to copy:
1. The message renders **as if the user sent it** (same bubble), so the transcript reads naturally.
2. Attribution is a **small dim label above the bubble**, not inline noise in the body.
3. The label is **clickable → jumps to the sender task's thread** (web surface only).
4. Long bodies **collapse** (2-line preview, expandable).
5. Variants (delegation vs automation) share ONE labeled-bubble component; only the label differs.

### 1.3 Delivery semantics (core, from `_codex-bin-symbols.txt`)

> `send_message` — "Send a message to an existing agent. The message will be **delivered
> promptly**. **Does not trigger a new turn**." (queued input submission)
> `followup_task` — "Send a follow-up task … and **trigger a turn**".

I.e. Codex separates **display promptness** (immediate) from **model delivery** (queued; no
forced turn). Our design mirrors this split (§4, WS1).

### 1.4 Transcript item types for agent activity

Conversation items include `collabAgentToolCall` (`tool: spawnAgent|sendMessage|wait…`,
`receiverThreadIds: […]`) and `subAgentActivity` — agent-to-agent traffic is first-class
transcript data, which is what makes the attribution/navigation UX possible.

---

## 2. Current state (jul-15 hellaudit findings — all file:line verified)

Substrate is sound (store per-reader delivery cursor, no-throw, anti-injection escaping,
redaction seam, team gate fail-closed, child label propagation; hellgates 43/43 green).
The defects are all in the wiring/surface layer:

| ID | Severity | Finding |
|----|----------|---------|
| F1 | P1 | Side-agent finding push channel is a **dead letter** for the root session: publisher addresses `cfg.mailboxAgentId ?? "main"` (`agent-config-assembler.ts:643` → `side-agent/registry.ts:157-159`), but every root read path uses `"root"` (`loop/control-poll.ts:101` drain; tool `senderId` depth fallback). Nothing in `src/` ever reads `"main"`. |
| F2 | P1 | Mailbox factory duplicated with divergent DoS posture: `optional-ports.ts:564-567` bakes `maxUndeliveredPerSender`; `agent-config-assembler.ts:413` + `:642` mint **quota-less** mailboxes. |
| F3 | MED | Team-scoped deny is dishonest at the tool surface: `team-scoped.ts:112` returns a stand-in message; `subagent_send_message` renders `ok:true "sent message msg_cross-team-denied"`. With `QUANTA_TEAM_PEER_MSG=1` and no team, child→parent silently no-ops. Tool description never mentions the team prerequisite. |
| F4 | LOW | `SideAgentSinkPort` ("render-only stream signal", `side-agent/types.ts:95-98`) is not a field of `SideAgentWireDeps` — the would-be UI hook is unwireable dead code. Superseded by WS1 (delete or wire; see §4). |
| F5 | GAP | Peer mail is injected into working memory only (`turn-iteration.ts:113-114` → `wm.append`); **no stream event for the MAILBOX channel** on any surface. The user learns about peer mail only if the model mentions it. |

**Baseline correction (jul-15 dedup re-audit).** Subagent visibility is NOT zero today: a
child shares the parent's stream port verbatim (`subagent-runner.ts:627 stream: parent.stream`,
no wrapper — grepped `isSubagentEvent|fromSubagent|childEvent` = 0 hits), and the stdout
adapter renders every `assistant_text` / `tool_call` / `turn_start` with no depth/agent
filter (`stdout.ts:114`). So a spawned child's raw output ALREADY interleaves into the
user's terminal, **unattributed** (concurrent bg children interleave mid-parent-output).
The real gaps are therefore: (a) the mailbox channel emits nothing, (b) no attribution
anywhere, (c) no idle-session delivery. This RFC targets exactly (a)+(b)+(c); taming the
raw-interleave noise is out of scope (§8).

### 2.6 Duplication audit (jul-15 — grep-verified before any build)

| Adjacent existing channel | Where | Verdict vs this RFC |
|---|---|---|
| `communicate_update` → `progress_update` event → stdout render | tool gated `QUANTA_PROGRESS_UPDATE` (`gated-tools.ts:407-413`); producer `createProgressStreamSink` (`host/runtime/progress-sink-wire.ts`); renderer `stdout.ts:258,460` | NOT a duplicate (self-progress reporting, model-initiated). **Child-dead today**: `progressSink` is absent from the `buildChildConfig` keep-list, so a subagent's `communicate_update` early-returns. See §5.5 quick-win. |
| Raw child stream interleave | `subagent-runner.ts:627` + `stdout.ts` (no filter) | Partial overlap on "visibility" only; zero attribution, and mailbox mail never rides it. Baseline note above. |
| Side-conversation (ADR-0049) | `agent/side-conversation/run.ts` — "answer is returned to the CALLER, never spliced into the main thread" | NOT a duplicate by design. |
| OSC completion notify (ADR-0444, `QUANTA_NOTIFY`) | `apps/cli/notify` + `repl/factories/notify-and-warning.ts` | NOT a duplicate (desktop notify on turn completion). Future composition: `peer_message` → notify when idle. Deferred §8. |
| Operator-notice bus (WS-G jul-10) | `shared/operator-notice.ts` | NOT a duplicate (stderr degrade signals). Already excluded in §WS3. |
| Item-stream `subagent` member + activity spine + fleet panel + lifecycle pills | `item-stream.ts:55`, `activity/render.ts`, `apps/cli/agents-fleet-panel.ts`, `lifecycle-pills.ts` | Lifecycle visibility only — no message CONTENT, no from/to. §5.6 records why we do not overload `subagent.progress`. |
| jul-13 goal-pursuit surface store / 🎯 chip | scheduler/automation + pursuit-prompt | Different concern (status chip/ticker, not transcript). |
| `AGENT_EVENT_TYPES` (39 members, `stream/types.ts:124-162`) | — | No mailbox/peer-shaped member exists. `peer_message` is genuinely new. |
| Knob namespace | knob-inventory grep | No `QUANTA_PEER*`/`*_SURFACE` collision. |

---

## 3. Design overview — Codex → quanta mapping

| Codex | quanta (this RFC) |
|---|---|
| `userMessage.codexDelegation.sourceThreadId` | new `AgentEvent` `peer_message` `{ from, to, kind, body, correlationId?, sentAt, provenance }` (§WS1) |
| `userMessage.heartbeatTrigger` (automation variant) | same event, `provenance: { source: "side-agent", daemonId }` (side-agent findings ride the same mailbox after F1) |
| "delivered promptly / does not trigger a new turn" | display event emitted at **enqueue time** (prompt); model delivery stays at turn-top drain (unchanged — no forced turn) |
| conversation item (`collabAgentToolCall`) | item-stream append-only member `peerMessage` (§WS2) — both wire planes carry `itemType` verbatim, zero transport edits |
| label-above-bubble UI (`WV`/`zDe`) | CLI: dim attribution line + collapsed body block (§WS3); web: item row w/ from-badge, label+bubble polish deferred (§WS4) |
| label click → `/local/${sourceThreadId}` | deferred (web thread nav dependency), noted in §8 |

**Trust posture is unchanged**: the event body is the SAME redacted + line-escaped text the
model sees (`peer-inbox.ts` redact→escape order); display is INFORMATION-only, never a grant.
Model-facing injection format (`[teammate <from> — untrusted] …`) stays byte-identical.

---

## 4. Workstreams

### WS0 — audit fixes (prerequisite; small, main-direct wave)

**WS0-a (F1) recipient SSOT.**
- Add `export const ROOT_MAILBOX_AGENT_ID = "root"` to `src/agent/subagent-mailbox/types.ts`
  (owner-local; both consumers already import this slice).
- `loop/control-poll.ts:101` → `cfg.mailboxAgentId ?? ROOT_MAILBOX_AGENT_ID`.
- `agent-config-assembler.ts:643` → `cfg.mailboxAgentId ?? ROOT_MAILBOX_AGENT_ID` (kills `"main"`).
- Hellgate (RED first): real registry `publish` → `mailbox.read("root")` returns the finding;
  paired control: `read("main")` empty. Today this is RED (finding lands under `"main"`).
- Grep-sweep for other `?? "main"` homonyms on mailbox ids (none known; prove it).

**WS0-b (F2) mailbox factory SSOT.**
- Move the quota-baking factory into the owner slice:
  `createDefaultSubagentMailbox()` in `src/agent/subagent-mailbox/index.ts`
  (wraps `createSubagentMailbox({ maxUndeliveredPerSender: DEFAULT_… })`).
- `optional-ports.ts:564-567`, `agent-config-assembler.ts:413`, `:642` all call it.
- Hellgate: assembler-minted mailbox enforces the per-sender cap (flood N+1 undelivered from
  one sender → oldest evicted, sibling mail untouched). RED today on the assembler path.

**WS0-c (F3) honest deny.**
- Additive optional field `denied?: "cross-team"` on `MailboxMessage` (store NEVER sets it;
  only `team-scoped.ts` `droppedMessage`/`fanOutBroadcast` empty-roster stand-in set it).
- `subagent_send_message` renders `ok:false, output: "send denied: cross-team — create/join a
  team (team_create) or message a same-team agent"` when `denied` present.
- Tool description += one sentence: delivery requires same-team membership when team messaging
  is enabled.
- Hellgate: knob-on un-teamed send → `ok:false` + reason; teamed send → `ok:true` (paired
  control); knob-off plain mailbox send → unchanged `ok:true` (byte-identity control).
- Keep `sameTeam=false for un-teamed` semantics — that's converged design; we fix HONESTY only.

### WS1 — display spine: `peer_message` AgentEvent at enqueue time

**Pattern precedent (dedup §2.6): clone the landed "duck-typed mirror → host adapter →
existing AgentEvent stream" shape** — `createProgressStreamSink`
(`host/runtime/progress-sink-wire.ts`, itself a byte-for-byte clone of
`createPassiveVcsStreamSink`, `agent-config-assembler.ts:473-503`). Do NOT invent a third
shape: the slice-side decorator takes a duck-typed `PeerMessageSink` (never imports
`@/stream`); the host builds `createPeerMessageStreamSink(stream)` and injects it.

**Emission point.** A `surfaceNotifyMailbox(inner, { sink, recipientId, redact })` decorator
in `src/agent/subagent-mailbox/` (pure). It wraps the **raw store**
(so the team decorator sits OUTSIDE it and denied sends never reach it — display shows only
actually-enqueued mail). On `send` whose `to === recipientId` (the session owner label,
`ROOT_MAILBOX_AGENT_ID` for root), the host-injected sink emits:

```ts
{
  type: "peer_message",
  from,
  to,
  kind,
  body: escape(redact(body)),
  correlationId?,
  sentAt,
  provenance:
    | { source: "peer" }
    | { source: "side-agent"; daemonId: string }
}
```

- **Promptness parity**: user sees the message the moment it's enqueued — root idle or
  mid-turn — while the MODEL still receives it at the next turn-top drain (unchanged;
  no forced turn — exactly Codex `send_message` semantics).
- Single emission point ⇒ no drain-time double-display. `pollPeerInbox` untouched.
- NO-THROW: emit failures swallowed (comms display must never break `send`).
- **Provenance is load-bearing**: `from` alone is NOT enough because ordinary peer mail and
  side-agent findings both arrive over the same mailbox rail. The side-agent bridge MUST retain
  finding provenance when adapting onto the mailbox seam (e.g. daemon publish path tags
  `provenance.source = "side-agent"`); otherwise WS3 cannot distinguish "peer mail" from
  "side agent finding".
- Wire in the composition roots that mint/decorate the mailbox (assembler + optional-ports,
  post-WS0-b these share one factory seam), gated by **`QUANTA_PEER_MSG_SURFACE`** (gateOn
  vocab, default-OFF). Knob unset ⇒ decorator not installed ⇒ byte-identical event stream.
- **Ordering is load-bearing**: do NOT rely on mutating `cfg.subagentMailbox` AFTER
  `wireSideAgentDaemons(...)` has already captured a mailbox instance. The decorated/raw-sinked
  mailbox must be the SAME instance handed to both the peer/team path and the side-agent registry
  (either hoist the decoration before daemon wiring or pass the decorated mailbox directly into
  `wireSideAgentDaemons`).
- **Knob hygiene is part of DoD**: `QUANTA_PEER_MSG_SURFACE` requires the normal SSOT path
  (`runtime-config` field + knob inventory/docs + no-dead-knob/default-OFF rails). No direct
  `process.env` reads at feature sites.
- F4 closure: delete `SideAgentSinkPort` (dead seam superseded by this rail) — side-agent
  findings arrive as `peer_message` via the same mailbox after WS0-a.

**Event-type cascade checklist** (append `"peer_message"` to `AGENT_EVENT_TYPES`,
`src/stream/types.ts:124` — every exhaustive surface must be visited in the SAME commit):
1. `AgentEvent` union member + `AGENT_EVENT_TYPES` array (`satisfies` pins both ways).
2. `src/stream/adapters/stdout.ts` exhaustive switch (§WS3 render).
3. `src/protocol/agent-state/projection.ts` mappers (project or explicitly ignore).
4. `src/stream/item-stream-projector.ts` (§WS2).
5. `grep -rn "Record<AgentEventType" src/` + run the event-type drift-guard tests — any
   closed `Record<Union, …>` map over event types must gain the key (compile-fails first).
6. `src/stream/adapters/jsonl-recorder.ts` (`KIND_MAP` + `dataOf`) — recorder is NOT
   shape-agnostic; add the new arm explicitly and replay-smoke it.
7. CLI secondary consumers: `apps/cli/timeline-panel.ts`, `apps/cli/debug-tracer.ts`,
   and any explicit event-type subset arrays (`turn-summary` may intentionally ignore, but that
   omission must be explicit, not accidental fallback).
8. Trajectory/cassette replay smoke; recorder hash / cassette fold must stay honest after the
   explicit recorder-arm addition above.

### WS2 — item-stream member `peerMessage` (append-only)

- `src/shared/item-stream.ts`: `ItemStreamItemType` += `"peerMessage"`;
  `ItemStreamDeltaKind` += `"peerMessage.text"`; `ITEM_DELTA_KIND_BY_ITEM_TYPE` entry
  (compile-enforced by the `satisfies Record<…>`).
- Projector: `peer_message` → atomic `started`+`completed` pair
  (`item-peer-${hash}`, mirrors the `subagent_cancel` precedent at
  `item-stream-projector.ts:217-222`), `text` = `"<from>→<to> [kind] <body>"`.
- Both wire planes (session.v1 `item.*`, web agent-state `item.*`) carry `itemType`
  verbatim (documented invariant, `item-stream.ts:44-47`) ⇒ **zero transport edits**;
  `apps/web-frontend` ItemStreamSection renders the new row generically for free.
- Guarded by the same `QUANTA_ITEM_STREAM` gate as every other member (no new knob here).

### WS3 — CLI render (Codex label-above-bubble, terminal dialect)

`src/stream/adapters/stdout.ts` — render `peer_message` as a two-part block mirroring
Codex's muted-label + bubble:

```
✉ sent by root/1 — from another task [request]        ← DIM label line
  <body, ≤4 lines, then "… (+N lines — subagent_read_messages to view)">
```

- Body collapse mirrors Codex `collapsedLineCount` (theirs 2; terminal gets 4).
- Side-agent findings read `✉ sent by <daemon-id> — side agent finding` based on
  `provenance.source === "side-agent"` (NOT inferred heuristically from `from`).
- Redaction already applied at emission (WS1); the adapter renders verbatim, passes the
  existing `redactStr` belt-and-suspenders like `error` does (`stdout.ts:163`).
- NOT an operator-notice: this is transcript content, not a degrade signal — it rides the
  stream adapter like `assistant_text`, not the stderr notice bus.

### WS4 — web polish (optional, after WS1-3)

- MVP ships free via WS2 (generic item row + `peerMessage` badge).
- Polish (separate ticket): dedicated component with Codex's exact contract —
  muted label row ("Sent by \<agent\> from another task", icon) above a user-style bubble,
  collapse-at-2-lines; label click → agent drilldown (blocked on web thread-nav; deferred §8).

### WS5 — feature catalog + docs

- `tools/feature-catalog/features/09-integration/peer-message-surfacing.yaml` (new, L2→L3
  with hellgates; owner-local hellgate per the jul-13 meta-ratchet).
- Refine `peer-teammate-messaging.yaml` (F3 honesty note) + `side-agent` entry (F1 fix).
- `subagent_send_message` tool description update (WS0-c) is model-facing docs — keep the
  one-line diff, byte-pin the rest.

---

## 5. Decisions & alternatives considered

1. **Enqueue-time display vs drain-time display.** Drain-time (emit inside `pollPeerInbox`)
   is 5 lines simpler but loses promptness: an idle root session displays nothing until the
   user types. Codex explicitly promises "delivered promptly" for display while NOT forcing a
   turn — enqueue-time emission is the only shape that reproduces both. **Chosen: enqueue-time.**
2. **Provenance field on `Message` (Codex `codexDelegation`) vs separate event.** Stamping
   provenance onto the injected `Message` would thread a new optional field through working
   memory, persistence, replay, and compaction — high blast radius, and our transcript
   persistence is turn-granular `Message[]` (no per-item metadata surface today). The
   event+item-stream spine reaches every surface with append-only edits. **Chosen: event.**
   Revisit the Message-stamp only if/when web transcript persistence needs offline replay of
   attribution.
3. **New knob vs riding `QUANTA_TEAM_PEER_MSG`.** Display is useful with the PLAIN mailbox
   (no teams) too — e.g. side-agent findings after F1. Separate `QUANTA_PEER_MSG_SURFACE`,
   default-OFF, byte-identical when unset. Measure-first: flip surfaces on after engagement
   smoke (same discipline that opt-in'd the mailbox itself, `gated-tools.ts:139`). This knob
   inherits the full runtime-config SSOT burden; a parser-only/env-only seam is not acceptable.
4. **`wake-on-message` (trigger a turn on peer mail).** Explicitly out — Codex `send_message`
   does not trigger turns either; `followup_task` (we already have it under
   `QUANTA_SUBAGENT_FOLLOWUP`) is the turn-triggering verb. No new lever without measurement.
5. **Quick-win alternative: propagate `progressSink` to children.** `communicate_update` +
   `progress_update` + stdout render are all LANDED (§2.6) but child-dead (keep-list omission).
   One spread line in `buildChildConfig` + an additive optional `from?: string` on the
   `progress_update` event would let a subagent explicitly report to the user TODAY. This is
   REAL but a different verb (self-progress, model-initiated, no mailbox/side-agent coverage,
   no idle-delivery). Recorded as an independent 1-line ticket — it neither replaces nor
   blocks WS1. Decide propagation intent explicitly (the omission may have been deliberate:
   a child's progress spamming the parent indicator).
6. **Reuse item-stream `subagent` member instead of a new `peerMessage` member.** Rejected:
   `subagent.progress` deltas are lifecycle drilldown lines keyed by subagent id; peer mail
   needs from/to/kind attribution, and side-agent daemons are not registry subagents — the
   join would be lossy. Append-only member addition is the cheaper, documented path
   (`item-stream.ts:44-47`).

---

## 6. Test plan (hellgate-first)

RED e2e first, then TDD units, then ≥3R adversarial audit:

1. **WS0-a RED**: composition-level — assembler-built cfg + real registry publish →
   `read("root")` non-empty (fails today), `read("main")` empty control.
2. **WS0-b RED**: assembler-minted mailbox flood → cap enforced (fails today).
3. **WS0-c**: knob-on un-teamed `subagent_send_message` → `ok:false` (fails today);
   knob-off byte-identity paired control.
4. **WS1 capture-exporter**: fake stream port captures `peer_message` on `send`; assert
   NOT emitted when (a) knob off, (b) `to !== recipientId`, (c) send denied by team gate
   (red-on-injection: temporarily emit on denied send in-tree → test must go red).
   Assert provenance too: ordinary peer send ⇒ `source:"peer"`; side-agent publish ⇒
   `source:"side-agent"` + daemon id retained.
5. **WS1 redaction**: planted secret in body → captured event body scrubbed + newline-escaped
   (mirror `peer-messaging-hellgate.test.ts:280-305`).
6. **WS1 ordering regression**: assembler path with side-agent daemons wired ON must still
   surface daemon findings after the mailbox decoration is installed. Control: a post-hoc slot
   mutation that leaves the daemon holding the raw mailbox must fail.
7. **WS2**: projector maps `peer_message` → `peerMessage` started+completed; drift guard —
   `ITEM_DELTA_KIND_BY_ITEM_TYPE` keys == union (compile) + runtime keys check.
8. **WS3**: stdout adapter snapshot for the two-line render incl. collapse marker; exhaustive
   switch stays exhaustive (`never` default).
9. **Recorder/timeline cascade**: `jsonl-recorder`, timeline panel, and debug tracer each get
   one targeted assertion so `peer_message` is never "added to the union but dropped by a side
   consumer".
10. **Byte-identity sweep**: all knobs unset ⇒ event stream, tool menu, transcript identical
   (existing default-OFF guard suites + one new entry).
11. **Live smoke (post-landing, box)**: side-agent daemon finding → visible CLI line — the
   original jul-15 user scenario end-to-end.

---

## 7. Landing order & sizing

| Wave | Content | Size | Mode |
|------|---------|------|------|
| 1 | WS0-a/b/c + hellgates | ~6 files, small | main-direct (<30 tool uses), single branch |
| 2 | WS1 + WS2 + WS3 + cascade checklist + hellgates | ~10 files | one branch; the event-type cascade makes this the risky wave — run the full typecheck + drift-guard suite, not just leaf tests |
| 3 | WS5 catalog/docs | tiny | rides wave 2 |
| 4 | WS4 web polish | separate ticket | deferred until measured engagement |

Concurrent-session discipline: re-check `HEAD` before each commit; no ref rewrites; file-scoped
`biome check --write <paths>` only.

## 8. Out of scope / deferred (with why + ROI)

- **Label click → navigate to sender thread (web)** — needs web thread-nav infra; ROI low until
  the web surface has a task switcher. Revisit with WS4.
- **`send_input` / `interrupt_agent` Codex verbs** — different capability (steering, not
  surfacing); our conversation-action + followup_task cover the near-term need.
- **Message-level transcript persistence of attribution** — see §5.2; blast radius > value today.
- **Wake-on-idle delivery** — §5.4; measure demand first.

---

## 9. Implementation plan (jul-15 — file-level, commit-sliced)

**Convention anchor (jul-15 re-check).** The union is now 39 members: a concurrent session
landed `subagent_spawn`/`subagent_status` ("Multi-agent-panel SUBSTRATE", `stream/types.ts:390-421`).
Those two are the freshest precedent for adding an event and `peer_message` mirrors their
conventions exactly: (a) doc block stating emission gate + render-only/no-control-authority +
"bounded & scrubbed at the emit boundary"; (b) DIM one-liner stdout arms
(`stdout.ts:349-368`); (c) an EXPLICIT recorder posture comment. **Coordination hazard:** that
session is actively editing `stream/types.ts` / `stdout.ts` / projections — rebase onto fresh
`origin/main` immediately before Wave 2 and keep the union edit a minimal append.

### Wave 1 — `feat/peer-mailbox-audit-fixes` (WS0; ~6 files + 3 test files)

**Commit 1 — WS0-a recipient SSOT (RED-first).**
| File | Edit |
|---|---|
| `src/agent/subagent-mailbox/types.ts` | + `export const ROOT_MAILBOX_AGENT_ID = "root"` (value const beside the port types; re-export via `index.ts`) |
| `src/agent/loop/control-poll.ts:101` | `?? ROOT_MAILBOX_AGENT_ID`; amend the "no direct mailbox import" fence comment — the fence bars PORT/instance imports, a shared id CONST is the SSOT fix |
| `src/host/runtime/agent-config-assembler.ts:643` | `?? ROOT_MAILBOX_AGENT_ID` (kills `"main"`) |
| `tests/unit/side-agent-root-recipient-hellgate.test.ts` (new) | RED first: assembler-shaped wire (mailboxAgentId unset) → registry `publish` → `read("root")` non-empty + `createPeerInboxDrain(mailbox).drainFor("root")` non-null; paired control `read("main")` empty |
Plus: `grep -rn '?? "main"' src/` sweep recorded in the commit message (expected: 0 remaining).

**Commit 2 — WS0-b factory SSOT.**
| File | Edit |
|---|---|
| `src/agent/subagent-mailbox/index.ts` | + `createDefaultSubagentMailbox()`; MOVE `DEFAULT_SUBAGENT_MAILBOX_MAX_UNDELIVERED_PER_SENDER` here (owner-local) |
| `src/agent/optional-ports.ts:562-567` | `defaultSubagentMailbox` → thin alias of the moved factory (or inline-replace call sites) |
| `agent-config-assembler.ts:413`, `:642` | → `createDefaultSubagentMailbox()` |
| `tests/unit/subagent-mailbox-quota-ssot-hellgate.test.ts` (new) | RED first on the assembler path: flood cap+1 undelivered from one sender → oldest evicted, sibling untouched |

**Commit 3 — WS0-c honest deny.**
| File | Edit |
|---|---|
| `src/agent/subagent-mailbox/types.ts` | `MailboxMessage` += `denied?: "cross-team"` (additive optional; store NEVER sets it) |
| `src/agent/subagent-mailbox/team-scoped.ts` | `droppedMessage` + empty-roster broadcast stand-in set `denied: "cross-team"` |
| `src/tool/subagent-mailbox/index.ts` | send tool: `m.denied` ⇒ `ok:false` + guidance ("create/join a team via team_create…"); description += one team-prerequisite sentence |
| extend `tests/unit/peer-messaging-hellgate.test.ts` + tool-level test | knob-on un-teamed ⇒ `ok:false`; teamed ⇒ `ok:true` (paired); knob-off plain ⇒ `ok:true` (byte-identity) |

Wave-1 gate: targeted `bun test` files + repo typecheck + file-scoped biome; 3R adversarial
audit on the three diffs; land main-direct (re-check `HEAD` per commit — concurrent sessions).

### Wave 2 — `feat/peer-message-surfacing` (WS1+WS2+WS3+WS5; after Wave 1 lands)

**Commit 1 — event spine (`peer_message`).**
| File | Edit |
|---|---|
| `src/stream/types.ts` | append `"peer_message"` to `AGENT_EVENT_TYPES` + union member `{ type, from, to, kind, body, correlationId?, sentAt, provenance: {source:"peer"} \| {source:"side-agent"; daemonId} }`; doc block mirrors `subagent_spawn` (gate, render-only, pre-scrubbed body, recorder posture) |
| `src/agent/subagent-mailbox/surface-notify.ts` (new) | duck-typed `PeerMessageSink` + `surfaceNotifyMailbox(inner, {sink, recipientId, redact})` — wraps the RAW store; emits on `send` iff `to === recipientId`; provenance read from the send-init (see next row); NO-THROW |
| `src/agent/subagent-mailbox/types.ts` | send-init += optional `provenance` (consumed by the decorator only; NOT stored on `MailboxMessage` — keeps store/snapshot untouched) |
| `src/agent/side-agent-runner.ts` `mailboxToSideAgentMailbox` | send-init += `provenance: {source:"side-agent", daemonId: from}` |
| `src/host/runtime/peer-message-sink-wire.ts` (new) | `createPeerMessageStreamSink(stream)` — byte-for-byte clone shape of `progress-sink-wire.ts`; `maybeWirePeerMsgSurface(cfg, env)` |
| wiring order | install the notify decoration **at the mint seam** in BOTH factories' call sites — assembler right after `maybeWireMailbox` (`:477`) and in `wireOptionalAgentPorts` — i.e. BEFORE `maybeWireSideAgent` (`:486`) and BEFORE `maybeWirePeerTeamMessaging` (`:939`), so daemon registry AND team decorator both capture the notified instance (RFC ordering invariant) |
| runtime-config SSOT | `types.ts` field `peerMsgSurface` + `runtime-config.ts` `gateOn(env, "QUANTA_PEER_MSG_SURFACE")` (+ checked-in `.js` mirror if the repo pattern requires it — follow `teamPeerMsg` precedent exactly) + knob-inventory entry + default-OFF guard suite entry |
| `src/stream/adapters/jsonl-recorder.ts` | **RECORD, explicit arm** (`KIND_MAP` + `dataOf`). Rationale: unlike `subagent_spawn` (durable copy guaranteed via ADR-0133 hooks), peer mail's durable copy is CONDITIONAL — the drain-injected wm message only exists if the recipient later drains; content-bearing + low-frequency ⇒ record, `decision`-family posture |
| `src/protocol/agent-state/projection.ts` | explicit-ignore with comment (web rides the WS2 item-stream leg; revisit if agent-state consumers need raw events) |
| `apps/cli/timeline-panel.ts`, `debug-tracer.ts` | verify generic-passthrough (tracer pads `event.type`) or add explicit ignore-with-comment — no silent fallthrough |
| tests | capture-exporter matrix (emit iff knob∧to==recipient∧enqueued; NOT on team-deny — red-on-injection); provenance peer vs side-agent; redaction (planted secret); ordering regression (daemon wired ON still surfaces after decoration); recorder line assert; byte-identity knob-off |

**Commit 2 — item-stream leg.**
`src/shared/item-stream.ts` (+`peerMessage`, +`peerMessage.text`, map entry) →
`src/stream/item-stream-projector.ts` atomic started+completed arm (mirror `:217-222`) →
tests: projector mapping + runtime keys==union drift guard. Zero transport edits (verify:
web `ItemStreamSection` renders the row generically).

**Commit 3 — CLI render.**
`src/stream/adapters/stdout.ts`: `renderPeerMessage` — DIM label line
(`✉ sent by <from> — from another task [kind]` / `— side agent finding` on
`provenance.source==="side-agent"`), body ≤4 lines + `… (+N lines — subagent_read_messages to
view)`; `redactStr` belt-and-suspenders. Snapshot tests incl. collapse marker + exhaustive
`never` intact.

**Commit 4 — WS5 catalog/docs.**
`tools/feature-catalog/features/09-integration/peer-message-surfacing.yaml` (new, owner-local
hellgate pointer) + refine `peer-teammate-messaging.yaml` / side-agent entry; RFC status flip.

Wave-2 gate: full typecheck (NOT just leaf tests — event-type cascade), drift-guard suites
(default-OFF sweep, knob parity, event vocab), replay smoke (recorder arm), then 3R hellaudit
(adversarial lens on: emission-on-denied-send, redaction bypass, ordering, double-display).

### Explicitly parked (needs a decision, not code)
- §5.5 `progressSink` child propagation quick-win — 1-line ticket, decide intent first.
- WS4 web label+bubble polish — after engagement measurement.
