# ADR-0416 — Managed-subagent mailbox (`subagent_send_message` between agents)

**Status:** Accepted (2026-05-28)
**Absorption source:** Codex `multi_agents_v2.send_message(agent_id, msg)` —
parent↔child + sibling↔sibling message exchange WITHOUT teardown.
**Slice:** `src/agent/subagent-mailbox/` (new closed substrate slice — 3 files:
`types.ts` / `store.ts` / `index.ts`) + `src/tool/subagent-mailbox/index.ts`
(new tool slice, 1 file) + `src/agent/tier1/subagent-mailbox.ts` (new
composition-root builder) + 3 surgical wire edits (`features.ts` import + push,
`tier1/index.ts` re-export, `types.ts` slot + Pick + type import).
**Default-OFF:** Yes — `config.subagentMailbox` absent ⇒ builder returns `[]`,
the `subagent_send_message` tool is NOT registered, the ToolRegistry stays
byte-identical.

## Context

quanta subagents are FORK-AND-FORGET. The `agent` tool (ADR-0011) spawns a child
that owns its own conversation envelope; the parent only learns the result when
the child settles (foreground summary, or background `task_output` poll). There
is no channel for a running parent to message a running child, for a child to
message its parent mid-flight, or for siblings to coordinate — short of tearing
down and re-spawning.

Codex's `multi_agents_v2` exposes `send_message(agent_id, msg)` precisely for
this: a persistent mailbox where any agent in a run can post a message addressed
to another agent (or broadcast to all) and the recipient consumes it on its next
inbox poll. This closes the "managed multi-agent" gap — agents stay alive and
coordinate.

## Decision

Add a CLOSED in-memory mailbox substrate + ONE LLM-facing SEND tool, wired
through the same default-OFF Tier-1 seam as `objective` (ADR-0402) and the
background subagent trio (ADR-0140).

1. **New substrate slice `src/agent/subagent-mailbox/`** (slice-fence clean —
   pure leaf; the store depends only on `node:crypto`; types reference nothing
   outside the slice). NEVER `@/agent` core.

   - `types.ts` — the closed `MailboxPort` + `MailboxMessage` /
     `MailboxMessageKind` (`request` | `response` | `broadcast`) /
     `MailboxSnapshot`.
   - `store.ts` — `createSubagentMailbox(opts?)` in-memory reference store.
   - `index.ts` — the barrel.

   `MailboxPort` methods (ALL NO-THROW):
   - `send(init)` — enqueue; ALWAYS returns a message (even on hostile input).
   - `read(agentId, opts?)` — undelivered messages for `agentId`, MARKS them
     delivered (idempotent re-read).
   - `peek(agentId, opts?)` — same selection WITHOUT marking.
   - `ack(messageId)` — mark a specific message delivered; returns it or `null`.
   - `list(filter?)` — all retained messages, optionally filtered by
     `from`/`to`/`kind`.
   - `pendingFor(agentId)` — count of undelivered messages for `agentId`.
   - `toSnapshot()` / `fromSnapshot(snap)` — REPLACE-not-merge persistence.

2. **New tool slice `src/tool/subagent-mailbox/`** (slice-fence clean — imports
   `@/agent/subagent-mailbox` types only, `../types` for Tool / ToolContext /
   ToolEvent / ToolResult, `@/shared` for `errMessage`, and `zod`).

   - `subagent_send_message` — ONE tool. `to`: a target agent id, `"*"`
     broadcast, or `"parent"`. `kind`: request / response / broadcast.
     `body` (1–8000 chars). `correlation_id?`.
   - **HITL tier**: `pre-approval-ok` (information-class — the only effect is an
     in-memory enqueue; no FS / shell / network).
   - **NO-THROW**: zod `safeParse` catches malformed input at the boundary; the
     port call is wrapped in try/catch so a hostile throwing port surfaces as
     `{ ok: false, output: "send failed: <message>" }`.
   - **Sender id**: derived from `ctx.depth` (root = `"root"`, child =
     `"agent@depth-N"`). `ToolContext` carries no session id today, so depth is
     the only stable agent-identity signal the dispatch seam threads in. `"parent"`
     is rewritten to the parent's derived label (depth N → N-1) so a child can
     address its parent without knowing the id.

3. **New Tier-1 builder `src/agent/tier1/subagent-mailbox.ts`** —
   `buildSubagentMailboxBlock(config) ⇒ Tool[]`. Returns `[]` when
   `config.subagentMailbox` is `undefined`, otherwise returns the tool from
   `subagentMailboxTools(port)`. Mirrors `buildObjectiveBlock` /
   `buildSubagentBgBlock`.

4. **Wire (3 shared-file diffs)**:

   - `src/agent/types.ts`: new `import type { MailboxPort } from "./subagent-mailbox"`,
     new `readonly subagentMailbox?: MailboxPort` on `AgentConfig` (helper-only
     port slot), new `"subagentMailbox"` entry in the `FeaturesConfig` Pick.
   - `src/agent/features.ts`: `buildSubagentMailboxBlock` added to the tier1
     named-import block + one push line in `buildSessionFeatures` after
     `buildSubagentBgBlock`.
   - `src/agent/tier1/index.ts`: one new export.

## Port contract (verbatim)

```typescript
export type MailboxMessageKind = "request" | "response" | "broadcast"
export interface MailboxMessage {
  readonly id: string
  readonly from: string
  readonly to: string            // agent id or "*" broadcast
  readonly kind: MailboxMessageKind
  readonly body: string
  readonly correlationId?: string
  readonly sentAt: number
  readonly deliveredAt?: number
}
export interface MailboxSnapshot { readonly messages: readonly MailboxMessage[] }
export interface MailboxPort {
  send(init: { from: string; to: string; kind: MailboxMessageKind; body: string; correlationId?: string }): MailboxMessage
  read(agentId: string, opts?: { limit?: number; since?: number }): readonly MailboxMessage[]
  peek(agentId: string, opts?: { limit?: number; since?: number }): readonly MailboxMessage[]
  ack(messageId: string): MailboxMessage | null
  list(filter?: { from?: string; to?: string; kind?: MailboxMessageKind }): readonly MailboxMessage[]
  pendingFor(agentId: string): number
  toSnapshot(): MailboxSnapshot
  fromSnapshot(snap: MailboxSnapshot): void
}
export const createSubagentMailbox: (opts?: { now?: () => number; retentionMs?: number; maxRetained?: number }) => MailboxPort
```

## Delivery semantics (substrate invariants)

- **Direct** (`to === agentId`): a per-message `deliveredAt` stamp. `read` marks
  undelivered → delivered; a re-read is idempotent (the message does not
  reappear). `peek` selects the same set without marking.
- **Broadcast** (`to === "*"`): per-AGENT `lastReadAt` cursor. A broadcast is
  delivered ONCE PER AGENT — each distinct reader has its own cursor, so the
  message appears exactly once to each reader and NEVER to its own sender.
- **Self**: a message is never delivered to its own sender (direct or broadcast).
- `send(to: unknown)` SUCCEEDS — an unknown / not-yet-spawned target id sits
  unread until that agent reads (or until eviction reclaims it).
- `pendingFor(unknown)` is `0`.
- `since` / `limit` narrow a `read`/`peek`: only messages with `sentAt > since`,
  capped to `limit`.

## Retention / LRU

At most `maxRetained` messages are kept (default **1024**); messages older than
`retentionMs` (default **3_600_000ms** = 1h) are reclaimed on the next `send`.
Size-based eviction prefers **DELIVERED before UNDELIVERED** (an unread message
is more valuable), oldest-`sentAt` first within a class. A fully-consumed
broadcast (at least one non-sender cursor past it) ranks as delivered for
eviction.

## NO-THROW contract

Every public method wraps its body in try/catch and degrades to a safe value:
`send` ⇒ a best-effort message; `read`/`peek`/`list` ⇒ `[]`; `ack` ⇒ `null`;
`pendingFor` ⇒ `0`; `fromSnapshot` ⇒ leaves whatever survived. Hostile input
(non-string ids, bad kind, null snapshot, `{messages: [null, 42]}`) is absorbed.
Returned messages + snapshots are `Object.freeze`d (no post-return mutation leak).

## No read tool this wave (deliberate deferral)

The SEND surface lands first because it is the strictly-additive half. There is
NO `subagent_read_inbox` LLM tool yet. A recipient surfaces incoming messages
through the existing channels — `task_output` summary for background children,
or a child-seed injection for newly-spawned children. A future ADR will add the
read tool (and the dispatch-seam wiring that drains `pendingFor` into the
per-turn reminder). Until then a recipient that never polls simply leaves the
message unread; the store retains/evicts it. This keeps the tool slice
slice-fence-clean (it imports the substrate types only — no `@/agent` core).

## Default-OFF / byte-identical

`config.subagentMailbox` absent ⇒ `buildSubagentMailboxBlock` returns `[]` ⇒ the
tool is NOT registered ⇒ the ToolRegistry the loop builds is structurally
identical to the pre-ADR registry (RFC §1.2). Importing
`@/agent/subagent-mailbox` allocates nothing at module load.

## Tests

`tests/unit/subagent-mailbox-hellgate.test.ts` — 40 cases / 93 expects:

- **A. PORT delivery** (11): direct send→read marks delivered; idempotent
  re-read; peek does not mark; pendingFor counts + drops to 0; pendingFor
  unknown = 0; send(to:unknown) sits unread; broadcast once-per-agent; broadcast
  never to sender; direct never to self; `since` watermark; `limit`.
- **A2. ack / list / isolation** (5): ack marks specific; ack unknown = null;
  list filters by from/to/kind; multi-agent isolation; correlationId round-trip.
- **A3. LRU / retention / snapshot / NO-THROW** (6): LRU evicts
  delivered-before-undelivered past maxRetained; retentionMs reclaim; snapshot
  round-trip; fromSnapshot REPLACES; NO-THROW on hostile snapshot/inputs; frozen
  returns.
- **B. WIRE** (7): tier1 barrel re-exports the builder; `AgentConfig` accepts the
  slot; `FeaturesConfig` Pick includes `"subagentMailbox"`; slot absent ⇒ tool
  not in extraTools; builder returns `[]` when absent; slot wired ⇒ tool lands;
  builder binds to the SAME port instance.
- **C. TOOL execute** (11): send round-trips through the bound port; sender id
  derives from depth; `"parent"` resolves to parent label; `"*"` broadcast
  passes through; correlation_id threads; schema rejection (missing/empty body,
  bad kind, body > 8000); NO-THROW on throwing fake port; HITL tier surface.

## Wire matrix

| File                                                | Change                                                                       |
|-----------------------------------------------------|------------------------------------------------------------------------------|
| `src/agent/subagent-mailbox/types.ts`               | NEW — closed `MailboxPort` + data model                                      |
| `src/agent/subagent-mailbox/store.ts`               | NEW — `createSubagentMailbox(opts?)` in-memory store                         |
| `src/agent/subagent-mailbox/index.ts`               | NEW — barrel                                                                 |
| `src/tool/subagent-mailbox/index.ts`                | NEW — `subagent_send_message` tool + `subagentMailboxTools(port)` builder    |
| `src/agent/tier1/subagent-mailbox.ts`               | NEW — `buildSubagentMailboxBlock(config)` ⇒ `Tool[]`                         |
| `src/agent/tier1/index.ts`                          | +1 line — `export { buildSubagentMailboxBlock } from "./subagent-mailbox"`   |
| `src/agent/features.ts`                             | +1 import entry + 2 lines (push + comment in `buildSessionFeatures`)         |
| `src/agent/types.ts`                                | +1 import + 1 field on `AgentConfig` + 1 entry in `FeaturesConfig` Pick      |
| `tests/unit/subagent-mailbox-hellgate.test.ts`      | NEW — 40 hellgate cases / 93 expects                                         |
| `tools/feature-catalog/features/09-integration/subagent-mailbox.yaml` | NEW — fc catalog row                                       |

## Consequences

**Positive:**
- quanta subagents can now coordinate WITHOUT teardown — parent↔child,
  sibling↔sibling, broadcast. Codex managed-multi-agent parity.
- Slice fence preserved: substrate is a pure leaf; the tool slice imports only
  the substrate types; neither reaches `@/agent` core.
- Default-OFF byte-identical for every legacy caller.

**Deferred:**
- `subagent_read_inbox` LLM tool + dispatch-seam drain of `pendingFor` into the
  per-turn reminder (next ADR).
- Session-id-based sender ids: `ToolContext` carries no session id today, so the
  sender label is depth-derived. A future ADR may thread a per-agent id through
  the dispatch seam for precise sibling addressing.
- Snapshot persistence wiring at session boundaries (mirrors the follow-up-queue
  snapshot-store pattern).

**Negative:**
- Depth-derived sender ids collapse all siblings at the same depth into one
  label (`agent@depth-1`). Precise sibling↔sibling addressing needs the
  per-agent-id follow-up above. Acceptable for the SEND-first wave.
- One more tool in the registry when the port is wired (only when the host
  explicitly opts in).
