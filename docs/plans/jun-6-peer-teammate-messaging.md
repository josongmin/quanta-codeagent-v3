# RFC — Peer teammate messaging: auto-delivered inbox + team-scoped bus

> **Status: ✅ IMPLEMENTED (jun-06)** — all 3 deltas landed default-OFF byte-identical. See §10 (as-built).
> Date: 2026-06-06
> Slice: EXTEND `src/agent/subagent-mailbox/` + `src/subagent/` (turn-gate/wake) + NEW team-scope seam; loop turn-boundary wire
> Default posture: OFF (byte-identical when the knob is unset)
> Feature axis: multi-agent coordination (peer ↔ peer) — sits alongside the EXISTING `QUANTA_TEAM_{DAG,BROKER,IDLE}` leader↔worker capabilities
> Candidate: Claude Code CLI 2.1.150 — "Agent Teammate Communication" (`SendMessageTool`, `TeamCreate`/`TeamDelete`, auto-delivered inbox, "sending a message to an idle teammate WAKES THEM UP", `Teammate` plan-mode execution type)

---

## 1. 요약 — what's already built vs the genuine delta

**HONEST re-audit first.** quanta already has MORE peer-messaging substrate than the candidate's surface suggests. The candidate is teammate↔teammate (peer) messaging with an **auto-delivered** inbox + a **team lifecycle** + **wake-idle-by-message**. Grep-verified state:

| Capability | quanta today | Evidence | Verdict |
|---|---|---|---|
| Peer-addressable mailbox (sibling↔sibling, not just leader↔worker) | **EXISTS** | `src/agent/subagent-mailbox/{types,store}.ts` (`MailboxPort.send({from,to,…})`, `to` = any agent id / `"*"` broadcast / `"parent"`). Per-recipient `directDelivered` so a sibling consuming its own mail can never hide another's (audit-H fix, `store.ts:53-68,239`). | Reuse as-is |
| `send_message` LLM tool | **EXISTS** | `subagent_send_message` (`src/tool/subagent-mailbox/index.ts:132`), `subagent_read_messages` (:218). One shared port. Codex `multi_agents_v2.send_message` parity. | Reuse |
| Bounded inbox (no unbounded growth) | **EXISTS** | `maxRetained` (1024) + `retentionMs` (3.6e6) LRU, delivered-before-undelivered eviction, **per-sender undelivered quota** `maxUndeliveredPerSender` (`store.ts:165-193`, audit-H R2/R3). Input caps `to≤128`/`body≤8000`/`limit≤256` (`tool/.../index.ts:69-71`). | Reuse |
| Wake an **idle** teammate by message | **EXISTS** | `SubagentTurnGate` (`src/subagent/turn-gate.ts`) + `TurnWakeRegistry` (`src/subagent/turn-wake.ts`); the runner registers a per-child waker (`subagent-runner.ts:586`, `registerChildWaker`). `followup_task` (`src/subagent/introspect-tools.ts:198`) delivers via mailbox THEN `wake(agentId, "followup"|"interrupt")` → `"woke"` (idle) / `"queued"` (busy) / `"interrupt"` aborts the in-flight turn. | Reuse — already does wake-idle |
| Peer can't self-grant / escalate via message | **EXISTS (load-bearing)** | Broker (`src/subagent/coordination/broker.ts:15-22`, `applyDecisionResponse`) honors a permission widen ONLY from a leader-authored `response` matching the worker's outstanding `correlationId`. A worker-forged `request`/`broadcast`/self-`response` is rejected. `QUANTA_TEAM_BROKER`. | Preserve — invariant must NOT regress |
| **Auto-delivered** inbox (no manual poll — "you do NOT need to check your inbox") | **MISSING** | The loop's turn-top `syncQueuedTurnInputs` (`src/agent/loop/turn-iteration.ts:37-52`) drains ONLY the user `FollowUpQueue` (`pollFollowUpQueue`, `control-poll.ts:15`). It NEVER reads the subagent mailbox. The agent must MANUALLY call `subagent_read_messages`. A wake just runs a turn; the message surfaces only if the model chooses to poll. | **DELTA #1** |
| **Team lifecycle** `TeamCreate`/`TeamDelete` + per-team bus isolation + cross-team deny | **MISSING** | `grep -rn 'createTeam\|deleteTeam\|TeamCreate\|TeamDelete\|reap.*bus'` → **no matches**. There is ONE global per-session `MailboxPort`; addressing is by label only, no team partition, no membership set, no teardown that reaps a bus. A teammate can address ANY label in the session. | **DELTA #2** |
| Redaction of untrusted peer body | **MISSING (partial)** | The READ side only does `escapeBodyForLine` (anti line-injection, `tool/.../index.ts:200`). No content redaction (secrets/PII) on a peer-authored body before it enters the recipient's context. | **DELTA #3** |

**Verdict: PARTIALLY BUILT.** The hard parts — a peer-addressable bounded mailbox, the wake-idle gate, the no-self-grant invariant — are DONE and live (behind `QUANTA_TEAM_*`). This RFC scopes ONLY the three genuine deltas: **(1) auto-delivery at the turn boundary**, **(2) team-scoped bus + `TeamCreate`/`TeamDelete` + cross-team deny**, **(3) redaction of untrusted peer body.** It does NOT rebuild the mailbox, the wake registry, or the tools.

---

## 2. 경쟁사 레퍼런스 (verified evidence)

### 2.1 Claude Code CLI 2.1.150 — "Agent Teammate Communication" (round-3 verified)

- `# Agent Teammate Communication` system-prompt section + `SendMessageTool` — a teammate-to-teammate send.
- `TeamCreate` / `TeamDelete` — a **team** is the unit of membership; create mints a shared comms space, delete reaps it.
- Prose, verbatim shape: *"Messages from teammates are automatically delivered to you... You do NOT need to manually check your inbox"* — i.e. delivery is **push at the turn boundary**, not a pull tool. This is the single biggest behavioral difference from quanta's `subagent_read_messages` poll.
- *"Sending a message to an idle teammate WAKES THEM UP"* — quanta already has this (the turn-gate `wake`), so this is the one place we REUSE rather than build.
- `Teammate` as a plan-mode execution type: *"agent with true parallelism and inter-agent communication"* — distinguished from a fire-and-forget subagent by (a) it persists/idles rather than fork-and-forget, (b) it shares a bus with siblings, (c) messages auto-arrive.

### 2.2 Codex `multi_agents_v2` (already absorbed)

quanta's `subagent_send_message` + `followup_task` are the Codex `send_message` / `followup_task` absorption (ADR-0416/0419/0437). Codex's model is still **leader-orchestrated** (the parent drives `followup_task`); the auto-delivered, team-scoped peer bus is the Claude-CLI delta over Codex.

**What the candidate adds over quanta's current state:** (a) the recipient does not poll — mail is injected into its loop automatically; (b) a first-class team boundary so a teammate can only message its own team (no global label-addressing); (c) `TeamCreate`/`TeamDelete` as the lifecycle that mints + reaps the bus.

---

## 3. 현재 quanta 상태 (grep-verified, detailed)

### 3.1 The mailbox is already peer (NOT leader↔worker-only)

`MailboxPort.send` (`src/agent/subagent-mailbox/store.ts:353`) takes an arbitrary `from`/`to`. `isUndeliveredFor` (`store.ts:320-328`) delivers a DIRECT cell to `to === agentId` OR a broadcast to any non-sender — there is no hierarchy in the data model. The runner threads a DETERMINISTIC stable label per child (`mailboxIds.agentId = parentLabel/seq`, `subagent-runner.ts:562-564`) and propagates the SAME port instance into every child (`subagent-runner.ts:467`), so sibling A (`root/1`) can already `send({to:"root/2"})` and sibling B reads it. **Peer transport exists.** What's missing is push-delivery + a team boundary.

### 3.2 Wake-idle already works

`followup_task` (`introspect-tools.ts:198-235`): delivers over the mailbox, then `wake(agentId, "followup")`. The gate (`turn-gate.ts`) parks an idle child at its completion point; a wake while parked resolves `"woke"` and the loop runs another turn (whose top-of-loop would surface the mail IF we wire §4.1). `wake("interrupt")` aborts an in-flight turn. The runner registers the waker (`subagent-runner.ts:586`). **We reuse this verbatim for "message wakes an idle teammate" — no new wake code.**

### 3.3 The auto-delivery gap (the core delta)

`src/agent/loop/turn-iteration.ts:43` — `syncQueuedTurnInputs` calls `pollFollowUpQueue(cfg, sessionId)` (the USER follow-up queue, `control-poll.ts:15`) and appends the result to working memory at the TOP of every turn. This is EXACTLY the seam the candidate's auto-delivery needs — but it only drains the user queue, never the subagent mailbox. A waked teammate runs a turn but the peer message is invisible unless the model spends a tool call on `subagent_read_messages`. **DELTA #1 = drain the recipient's mailbox at this same seam and inject it as a system/user message, mirroring `pollFollowUpQueue`.**

### 3.4 No team boundary

There is ONE `MailboxPort` per session (the root mints it; `subagent-runner.ts:467` propagates the same instance to all descendants). Addressing is by free-form label. Nothing scopes "team membership" or denies cross-team. `grep -rn 'createTeam\|deleteTeam\|TeamCreate\|TeamDelete' src/` → no matches. **DELTA #2 = a team registry (membership set + per-team bus view) + create/delete + a delivery-time membership check.**

### 3.5 No body redaction

The read renderer escapes newlines (`escapeBodyForLine`, `tool/subagent-mailbox/index.ts:200`) to stop a peer forging a second inbox line — a real anti-spoof control — but does NOT redact secrets/PII in the body. quanta has a redaction chokepoint elsewhere (untrusted-envelope / source-tag work, memory `jun-04-h-feature-wave1`). **DELTA #3 = run the peer body through the existing redaction seam before it enters the recipient's context** (a peer body is untrusted-peer content).

---

## 4. 설계 (delta only — reuse the substrate)

### 4.1 Auto-delivery at the turn boundary (DELTA #1)

Add a SECOND drain in `syncQueuedTurnInputs`, right after `pollFollowUpQueue`, gated on a new optional config slot `cfg.peerInbox` (a tiny duck-typed port — NOT a direct `@/agent/subagent-mailbox` import from the loop; the loop already takes the mailbox via assembly):

```ts
// src/agent/loop/control-poll.ts — sibling of pollFollowUpQueue
export interface PeerInboxDrain {
  /** Drain THIS agent's undelivered peer mail and render it as ONE injected
   *  message, or null when empty. MARKS delivered (read, not peek) so the same
   *  mail never re-injects across turns. Bounded by the mailbox's own caps. */
  drainFor(agentId: string): Message | null
}
export const pollPeerInbox = (cfg: AgentConfig): Message | null =>
  cfg.peerInbox?.drainFor(cfg.agentLabel ?? "root") ?? null
```

```ts
// turn-iteration.ts syncQueuedTurnInputs — after the followUpResult append:
const peerMail = pollPeerInbox(args.cfg)
if (peerMail !== null) args.wm.append(peerMail)
```

- `drainFor` wraps `mailbox.read(agentId, {limit})` (mark-delivered, idempotent) and renders the messages as a single `role:"user"` message with a clear provenance header (`[teammate <from>]: …`, one line each, body already newline-escaped + redacted per §4.3). Rendering reuses `renderMessage`/`renderInbox` from the tool slice (or a shared helper) so the model sees the IDENTICAL format whether it polls or receives a push.
- **Idempotency:** `read` advances the per-recipient delivered cursor, so a message injected at turn N never re-injects at N+1. This is the SAME cursor the manual `subagent_read_messages` uses — push and pull share one delivery cursor, so a message is delivered exactly once regardless of path. (The model MAY still call `subagent_read_messages` manually; it will just find an empty inbox after a push.)
- **`limit` per turn** caps how much mail is injected per turn (e.g. 32) so a flooded inbox does not blow the context window in one turn — the rest stays pending and drains over subsequent turns (bounded, FIFO oldest-first, exactly the mailbox's existing order).
- **Wake → push convergence:** when `followup_task`/`send_message` wakes an idle teammate (§3.2), the resulting turn now AUTO-injects the mail via this seam. That is the candidate's "sending a message to an idle teammate wakes them up AND the message is automatically delivered" — assembled entirely from existing parts + this one drain.

### 4.2 Team-scoped bus + `TeamCreate`/`TeamDelete` (DELTA #2)

A team is a **membership set** sharing one bus. Today the bus is global; we add a thin team layer WITHOUT forking the mailbox storage:

```ts
// src/subagent/team/registry.ts  (new leaf under src/subagent — fence: imports only @/shared)
export interface TeamRegistryPort {
  create(teamId: string, members: readonly string[]): void  // mint a team
  delete(teamId: string): readonly string[]                 // reap; returns reaped member ids
  addMember(teamId: string, agentId: string): void          // a spawned teammate joins
  removeMember(teamId: string, agentId: string): void
  teamOf(agentId: string): string | undefined               // membership lookup
  sameTeam(a: string, b: string): boolean                   // delivery-time gate
  members(teamId: string): readonly string[]
}
```

- **Delivery-time membership check (the cross-team deny).** Wrap the shared `MailboxPort` in a `TeamScopedMailbox` decorator that, on `send({from,to})`, consults `registry.sameTeam(from,to)` (and allows a broadcast `"*"` ONLY to the sender's own team members — expanding `"*"` to the team roster, never the whole session). A cross-team `send` is dropped with a typed `{ok:false, output:"cross-team message denied"}` — it NEVER reaches the other team's delivery cursor. `read`/`peek` are unchanged (a recipient only ever sees mail addressed to it, and cross-team mail was never enqueued for it). This is a pure decorator; the underlying store + caps + quota are untouched.
- **`TeamCreate`** mints a team id + seeds members (the spawning agent + the agents it spawns into the team). In quanta-idiomatic terms this is the side-agent/spawn path: a `team_create` tool (or a `spawn_batch({team})` option) registers the membership. The bus is the SAME per-session `MailboxPort` instance — `TeamCreate` does NOT mint a new store, it mints a membership SCOPE over the existing one (cheaper, and the LRU/quota caps stay global so total memory is bounded regardless of team count).
- **`TeamDelete`** reaps the team: `registry.delete(teamId)` returns the member ids; the host (a) tears down each member's runner (reusing the existing subagent disposer, `subagent-runner.ts:619`) and (b) the membership scope drops — any in-flight cross-references to reaped ids `send` into an unread void that the global `retentionMs` reclaims. No new teardown machinery; it composes the existing runner disposal + the registry drop.
- **Why a decorator, not a new store:** the mailbox's per-recipient delivery, LRU, per-sender quota, and snapshot are load-bearing (audit-H). Re-implementing them per-team would re-introduce the DoS surfaces those fixes closed. A membership decorator over ONE bounded store keeps total memory capped by the existing global `maxRetained` no matter how many teams exist.

### 4.3 Redaction of untrusted peer body (DELTA #3)

A peer-authored `body` is untrusted-peer content (a compromised/confused teammate could carry a leaked secret or a prompt-injection string). On BOTH the push path (§4.1 `drainFor`) and the pull path (`subagent_read_messages`), run the body through the existing redaction seam before it enters the recipient's context:

- Reuse the established redaction chokepoint (untrusted-envelope / source-tag, memory `jun-04-h-feature-wave1` / `jun-03-audit-r3`) as an INJECTED `redact?: (s:string)=>string` on the inbox/tool — default identity when unwired (byte-identical), the host wires the real redactor under the same knob.
- Keep `escapeBodyForLine` (anti line-injection) UNCHANGED and apply it AFTER redaction — the two compose (redact secrets, then guarantee one-line-per-message so a redacted body still can't forge a sibling line).
- The push injection carries an explicit `[teammate <from> — untrusted]` provenance header so the recipient model treats the content as data from a peer, not as a trusted instruction (mirrors the untrusted-rule → base-section posture, memory `jun-04-h2-h12`).

### 4.4 Preserve the no-self-grant invariant (security, load-bearing)

The broker's grant invariant (`broker.ts:15-22`) MUST NOT regress. The peer bus carries `request`/`response`/`broadcast` kinds; a permission WIDEN is honored ONLY by `applyDecisionResponse` when the message is a leader-authored `response` matching an outstanding `correlationId`. Auto-delivery (§4.1) injects peer mail as INFORMATION into the model's context — it does NOT call the permission decider. A teammate cannot escalate by sending a message: the message becomes context text, and the recipient's tool calls still go through its OWN admissibility gate / the leader broker. Cross-team deny (§4.2) is enforced at `send` (before enqueue) so a cross-team peer can't even place a forged `response` into a victim's correlationId stream. **The peer layer is a comms channel, never a grant channel.**

---

## 5. 통합

### 5.1 Config knob (default-OFF, byte-identical)

- Add `teamPeerMsg: boolean` to `RuntimeConfig`, parsed `env["QUANTA_TEAM_PEER_MSG"] === "1"` (strict opt-in, mirroring `teamDag`/`teamBroker`/`teamIdle` at `runtime-config.ts:890-896`). Default `false`.
- **OFF ⇒** the loop wires no `peerInbox` drain (`cfg.peerInbox === undefined` ⇒ `pollPeerInbox` returns `null` ⇒ the turn loop is byte-identical); no `TeamScopedMailbox` decorator (the raw global mailbox, today's behavior); no team registry; `team_create`/`team_delete` tools NOT registered. The `subagent_send_message`/`_read_messages` tools behave exactly as today (manual poll). Proven by the existing tool-surface drift guard + a "turn loop byte-identical when off" hellgate.
- Reuse, don't multiply knobs: peer-msg builds ON `QUANTA_TEAM_*`. Sensible composition — `QUANTA_TEAM_PEER_MSG` implies the mailbox is present; if `QUANTA_TEAM_IDLE`/wake plumbing is also on, idle teammates wake on message. Document the matrix in the catalog entry.

### 5.2 Tools + tool-surface manifest

- `team_create` / `team_delete` — GATED on `{kind:"config-slot", slot:"teamRegistry", env:"QUANTA_TEAM_PEER_MSG"}`, `risk:"mutating"` (they spawn/reap teammates). `team_create(members?, label?)` mints a team and returns the team id; `team_delete(teamId)` reaps. (A host may instead fold team-create into `spawn_batch({team:…})` — decided in §8.)
- `subagent_send_message` is REUSED as the peer `SendMessageTool` (already exists, already peer). No new send tool — the candidate's `SendMessageTool` maps onto it. Optionally add a `team_send` alias that defaults `to` to broadcast-within-team; low value, likely skip (§8).
- `subagent_read_messages` stays (manual poll remains available even with auto-delivery on — useful for `peek`/`limit` introspection), but with auto-delivery on it usually returns empty because the push already drained.

### 5.3 Feature-catalog entry

Add `tools/feature-catalog/features/05-coordination/peer-teammate-messaging.yaml` (schema per the existing team-capability entries): `subsystem: Peer teammate messaging`, `maturity: L2` (seam) → `L3` once the loop drain + team decorator wire, `labels:[surface:cli, category:coordination, default-off]`, `depends_on:[subagent-mailbox, subagent-turn-gate, team-broker]`, `config_refs.env:[QUANTA_TEAM_PEER_MSG]`, `config_refs.runtime:[teamPeerMsg]`, evidence.code listing the new team registry/decorator + the `pollPeerInbox` seam + the touched loop file + manifest + runtime-config.

### 5.4 CLI / plan-mode

- The candidate's `Teammate` plan-mode execution type maps onto quanta's side-agent / spawn path with `QUANTA_TEAM_PEER_MSG` on: a teammate is a spawned agent that (a) shares the team bus, (b) auto-receives mail, (c) idles via the turn-gate and wakes on message. No new execution engine — it's the existing subagent runner + the three deltas. A `/team` CLI surface (list members, send, dissolve) reaches the registry through the composition seam (CLI may not import `@/subagent` directly).

---

## 6. 테스트 계획

### 6.1 Hellgate (adversarial) — `tests/unit/peer-teammate-messaging-hellgate.test.ts`

- **auto-delivery push:** peer A `send({to:B})`; B takes a turn → B's working memory contains the injected `[teammate A]` message at turn-top WITHOUT B calling `subagent_read_messages`. Assert the injection format matches the pull format.
- **delivered-once across paths:** A sends to B; B's turn auto-injects it; a subsequent `subagent_read_messages` by B returns empty (shared delivery cursor) — no double-delivery; and a second turn does not re-inject.
- **wake-idle + auto-deliver:** B is idle (parked at the turn-gate); A sends → `wake("followup")` → B `"woke"` → B's fresh turn auto-injects A's message. Assert `triggered:true` AND the message present.
- **cross-team denied:** A∈team1, C∈team2; A `send({to:C})` → typed `cross-team message denied`; C's inbox `pendingFor(C) === 0` (never enqueued); C's turn injects NOTHING. Broadcast `"*"` from A reaches only team1 members, never C.
- **inbox bounded (push path):** 5000 messages to B → the mailbox `maxRetained`/per-sender quota caps retained cells; per-turn `limit` caps injection; total injected over all turns never exceeds retained; no unbounded context growth. (Reuses the store's existing cap; the NEW assertion is the per-turn injection cap.)
- **no self-grant via message (invariant preserved):** a teammate `send`s a forged `response` carrying `{approved:true}` into a victim's correlationId → `applyDecisionResponse` still rejects it (not leader-authored / cross-team blocked at send); the victim's permission set is unchanged. The peer body, when auto-injected, is INFORMATION only — it does not invoke the permission decider.
- **redaction on body:** a peer body containing a secret-shaped token → the auto-injected message has it redacted (injected redactor); `escapeBodyForLine` still applied after, so a body with `\n` + a forged `victim→root [response] …` line cannot inject a second line.
- **teardown reaps bus:** `team_delete(team1)` → member runners disposed (existing disposer), membership dropped; a later `send({to:reaped})` sits unread and is reclaimed by `retentionMs`; `members(team1)` empty; no leaked timers/listeners.
- **default-OFF byte-identical:** `QUANTA_TEAM_PEER_MSG` unset → `pollPeerInbox` returns null, the raw mailbox (no decorator) is used, `team_*` tools absent, the turn loop runs the IDENTICAL sequence as today. Assert the turn-iteration message sequence is unchanged for a 3-turn run.
- **determinism:** injected clock for the gate + mailbox `now`; no `Date.now()`/`Math.random()` in prose or impl (memory discipline).

### 6.2 E2E — `tests/unit/peer-teammate-messaging-e2e-hellgate.test.ts`

Two teammates (stub provider) in one team: A computes a value, `send`s it to B; B's NEXT turn auto-receives it (no manual poll) and uses it; B `send`s a result back to A; A auto-receives. Assert the full round-trip happens with ZERO `subagent_read_messages` calls. Then `team_delete` reaps both. OFF variant: same script with the knob unset reproduces today's behavior (B must manually poll, no team teardown tool).

---

## 7. 단계

- **Phase 1 — auto-delivery seam (DELTA #1, default-OFF).** `pollPeerInbox` + `PeerInboxDrain` port in `control-poll.ts`; the one-line append in `syncQueuedTurnInputs`; `cfg.peerInbox` config slot; `teamPeerMsg` runtime knob; hellgate auto-delivery + delivered-once + OFF-byte-identical cases. NO team boundary yet — the drain reads the existing global mailbox for the agent's own label. This alone delivers the candidate's headline "no manual inbox check" behavior + reuses wake-idle. Smallest shippable slice.
- **Phase 2 — team boundary + lifecycle (DELTA #2).** `src/subagent/team/registry.ts` (`TeamRegistryPort`) + `TeamScopedMailbox` decorator (cross-team deny at `send`, broadcast-scoped-to-team); `team_create`/`team_delete` tools (gated, mutating); wire `TeamDelete` to the existing runner disposer; hellgate cross-team + teardown cases.
- **Phase 3 — redaction (DELTA #3).** Inject the redactor into the inbox drain + the read tool; `[teammate <from> — untrusted]` provenance header; redaction hellgate case. Independent of Phase 2; can land alongside Phase 1.

---

## 8. 리스크 / 대안 / 비결정

- **Don't rebuild the mailbox (the whole point).** The temptation is a fresh per-team `Bus`. Rejected — the existing store's per-recipient delivery cursor, LRU, per-sender quota, and snapshot are audit-H-hardened; re-implementing per-team re-opens those DoS surfaces and unbounds total memory by team count. The decorator-over-one-store keeps the proven caps. **Revisit only if** teams need isolated retention policies (unlikely — the global cap is the resource backstop).
- **Auto-delivery vs context blowup.** Pushing all pending mail every turn could flood context. Mitigated by the per-turn `limit` (FIFO oldest-first, rest stays pending) — bounded injection, drains over turns. The cap is a knob, not a tuned heuristic (no-heuristics memory). Risk: a teammate that ONLY receives mail and never acts could lag; acceptable (it still drains, just over more turns).
- **`team_create` tool vs `spawn_batch({team})` option.** Two idiomatic spots: a standalone `team_create` tool (matches the candidate's `TeamCreate` 1:1) or folding membership into the existing `spawn_batch`/side-agent spawn. **Undecided:** lean standalone tool for Phase 2 (explicit, testable, maps to the candidate verbatim) but the membership registry is the same either way — the tool is a thin front. Revisit if spawn-time team assignment proves more ergonomic.
- **Delivered-once across push+pull.** Both paths share ONE delivery cursor (`read` marks per-recipient), so a message is delivered exactly once regardless of path — this is a correctness REQUIREMENT, locked by the "delivered-once across paths" hellgate. The only subtlety: `peek` (manual) must NOT advance the cursor, so a model that `peek`s still gets the push later. Already the store's contract (`peek` doesn't mark).
- **`Teammate` plan-mode type.** The candidate exposes "Teammate" as a distinct plan execution type. quanta reaches the same behavior by composing existing parts under the knob; a dedicated plan-mode type is presentation/UX, not new mechanism — deferred (the mechanism, not the label, is the SOTA part). Revisit when plan-mode UX is the focus.
- **Redactor source.** Reuse the established untrusted-content redactor rather than rolling a new one; if none is cleanly injectable from the loop without a fence break, fall back to an injected `redact?` seam (default identity) wired by the host — never a hard import from the loop into a redaction slice.

---

## 9. 코드 위치 요약

**Create:**
- `src/subagent/team/registry.ts` — `TeamRegistryPort` (membership set, `sameTeam`, create/delete/add/remove). Fence: imports only `@/shared`.
- `src/agent/subagent-mailbox/team-scoped.ts` (or a decorator in the tool/inbox slice) — `TeamScopedMailbox` (cross-team deny at `send`, broadcast-scoped-to-team) over the existing `MailboxPort`.
- `src/tool/team/index.ts` — `team_create` / `team_delete` tools (gated, port-injected).
- `tools/feature-catalog/features/05-coordination/peer-teammate-messaging.yaml`.
- `tests/unit/peer-teammate-messaging-hellgate.test.ts`, `tests/unit/peer-teammate-messaging-e2e-hellgate.test.ts`.

**Touch:**
- `src/agent/loop/control-poll.ts` — add `PeerInboxDrain` + `pollPeerInbox` (sibling of `pollFollowUpQueue`).
- `src/agent/loop/turn-iteration.ts` — one `pollPeerInbox` drain + append in `syncQueuedTurnInputs` (after the follow-up append).
- `src/agent/types.ts` — add `peerInbox?: PeerInboxDrain` (+ optional `agentLabel` already threaded) to `AgentConfig`.
- `src/shared/runtime-config.ts` — add `teamPeerMsg` (+ `QUANTA_TEAM_PEER_MSG` parse), alongside `teamDag`/`teamBroker`/`teamIdle`.
- `src/tool/subagent-mailbox/index.ts` — inject optional `redact?` into the read render (DELTA #3); shared `renderMessage` so push + pull formats match.
- `src/agent/subagent-runner.ts` — register spawned children into the team registry when `teamPeerMsg` is on; wire `team_delete` to the existing child disposer.
- `src/tool/surface/manifest.ts` — `team_create`/`team_delete` GATED entries + drift-guard test update.

**Reused unchanged (NOT rebuilt):** `src/agent/subagent-mailbox/{types,store}.ts` (the bounded peer bus), `src/subagent/turn-gate.ts` + `turn-wake.ts` (wake-idle), `src/subagent/introspect-tools.ts` `followup_task` (send+wake), `src/subagent/coordination/broker.ts` (no-self-grant invariant), `src/tool/subagent-mailbox/index.ts` send tool.

---

## 10. As-built (jun-06) — what actually landed

**✅ host-wired LIVE (jun-06).** All three deltas were built as SEAMS; the composition root now INJECTS them. `src/host/runtime/peer-team-wire.ts` (`maybeWirePeerTeamMessaging`, called from `agent-config-assembler.ts` right after `maybeWireMailbox`) — when `QUANTA_TEAM_PEER_MSG` is on: (1) mints ONE per-session `createTeamRegistry()` → `cfg.teamRegistry` (the tier1 `buildTeamBlock`, `src/agent/tier1/team.ts`, registers `team_create`/`team_delete` over it); (2) wraps `cfg.subagentMailbox` with `teamScopedMailbox` (a duck-typed `TeamMembershipGate` adapter over the registry — `sameTeam` + `membersOf` = `members(teamOf(id))`); (3) sets `cfg.peerInbox = createPeerInboxDrain(scoped, { redact: redactSecrets@tool_result })`. The REAL `createSubagentRunner` (`src/agent/subagent-runner.ts`) propagates `peerInbox` + `teamRegistry` onto each child config AND registers the spawned child (`root/0`, …) into the parent's team (`maybeRegisterChildTeam`). So a sibling's `send` AUTO-delivers into the child's next turn via the loop's `pollPeerInbox` seam — no manual `subagent_read_messages`. Proven e2e through the REAL composition root + runner in `tests/unit/peer-messaging-host-wire-hellgate.test.ts` (child inherits + joins team → sibling message auto-delivers / cross-team denied / knob-OFF byte-identical / redaction). Knob-OFF ⇒ no `peerInbox`, raw mailbox, no registry, `team_*` unregistered, child inherits none (byte-identical).

All three deltas shipped behind `QUANTA_TEAM_PEER_MSG` (strict `=== "1"` opt-in, default-OFF byte-identical). The hard parts the re-audit flagged as ALREADY built were reused UNCHANGED (peer mailbox + bounded inbox caps + wake-idle gate + broker no-self-grant). 21 hellgate cases (`tests/unit/peer-messaging-hellgate.test.ts`) + the host-wire e2e (`tests/unit/peer-messaging-host-wire-hellgate.test.ts`), all green; no regression across the subagent-mailbox / coordination / turn-loop suites.

**DELTA #1 — auto-delivery (DONE).** `PeerInboxDrain` port + `pollPeerInbox(cfg)` in `src/agent/loop/control-poll.ts` (sibling of `pollFollowUpQueue`, duck-typed — no `@/agent/subagent-mailbox` import from the loop). ONE append in `syncQueuedTurnInputs` (`src/agent/loop/turn-iteration.ts`), right after the follow-up append. `cfg.peerInbox?` slot on `AgentConfig`; the drain reads `cfg.mailboxAgentId ?? "root"`. The drain adapter (`src/agent/subagent-mailbox/peer-inbox.ts`, `createPeerInboxDrain`) wraps `mailbox.read` (mark-delivered ⇒ shares the manual-poll cursor ⇒ delivered exactly once across push+pull; per-turn `limit` default 32, rest drains FIFO) and renders ONE `role:"user"` message. A throwing drain degrades to null (emits an error event, never bubbles).

**DELTA #2 — team boundary + lifecycle (DONE).** `TeamRegistryPort` + `createTeamRegistry` (`src/subagent/team/registry.ts`, pure leaf — imports nothing; an agent belongs to exactly one team, re-home on re-create). `TeamScopedMailbox` DECORATOR (`src/agent/subagent-mailbox/team-scoped.ts`, `teamScopedMailbox`) over the EXISTING store — NOT a new store, so the audit-H caps stay global. Cross-team `send` DENIED before enqueue (never reaches the victim's cursor; the dropped message is returned undelivered for the port contract); broadcast `"*"` fanned out to the sender's own team roster only; a throwing membership gate fails CLOSED. `team_create`/`team_delete` tools (`src/tool/team/index.ts`, gated + mutating; `team_create` auto-adds the caller; `team_delete` returns reaped member ids for the host to dispose via the existing subagent disposer). The membership gate + redactor are duck-typed ports so the mailbox slice never imports `@/subagent` or `@/security`.

**DELTA #3 — body redaction (DONE).** The drain adapter takes an injected `redact?: (s)=>string` (default identity ⇒ byte-identical when unwired); the host wires `@/security/redaction#redactSecrets` under the knob. Redaction runs BEFORE `escapeBodyForLine` (the two compose — scrub secrets, then one line). Provenance header `[teammate <from> — untrusted]` so the recipient model treats the body as peer DATA, not a trusted instruction.

**Security invariants preserved.** (1) Auto-delivered mail is INFORMATION — the drain has no permission port and never invokes the permission decider; a forged `approved=true` body enters context as a tagged-untrusted user message only. (2) Cross-team deny at `send` (before enqueue) — a cross-team peer can't place a forged `response` into a victim's correlationId stream. (3) `broker.ts` UNTOUCHED (read-only) — the leader-authored-response-only widen (no-self-grant) is intact. (4) Inbox stays bounded under a 5000-msg flood (the decorator did not replace the store).

**Default-OFF byte-identity.** `QUANTA_TEAM_PEER_MSG` unset ⇒ no `peerInbox` wired ⇒ `pollPeerInbox` returns null ⇒ the turn loop appends nothing (one extra null-returning call, no behavioral change); no `TeamScopedMailbox` decorator (raw global mailbox); `team_*` tools not registered. Verified by the OFF-byte-identity hellgate cases + the existing `session-knobs-default-off-byte-identity` suite (green).

**Verification.** `bun test` peer-messaging (21/0) + subagent-mailbox/coordination suites (226/0) green. biome clean on all new/touched files. `bun run typecheck` — no errors from this slice (2 pre-existing in-flight errors in `compaction-wire.ts` / `error-routing` are unrelated). `fc validate` (892 features, all evidence resolved) + `fc lint` + `fc gates` (no violations). fc entry: `tools/feature-catalog/features/09-integration/peer-teammate-messaging.yaml` (L3).
