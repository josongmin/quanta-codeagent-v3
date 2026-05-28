# ADR-0419 — Subagent read-inbox tool (`subagent_read_messages`)

**Status:** Accepted (2026-05-29)
**Closes:** the ADR-0416 read deferral ("No read tool this wave").
**Absorption source:** Codex `multi_agents_v2` — an agent polls its own inbox to
consume messages other agents posted to it.
**Slice:** `src/tool/subagent-mailbox/index.ts` (the existing ADR-0416 tool
slice — the read tool is a SIBLING export in the same file) +
`src/agent/tier1/subagent-mailbox.ts` (the existing builder now returns BOTH
tools). NO new substrate, NO new shared-file wire.
**Default-OFF:** Yes — unchanged from ADR-0416. `config.subagentMailbox` absent
⇒ `buildSubagentMailboxBlock` returns `[]`, neither tool is registered, the
ToolRegistry stays byte-identical.

## Context

ADR-0416 shipped the closed `MailboxPort` substrate + the `subagent_send_message`
LLM tool, but DEFERRED the read half: incoming messages were only surfaceable
out-of-band (the `task_output` summary for background children, or a child-seed
injection for newly-spawned children). An agent that wanted to consume mail
mid-flight — without teardown — had no LLM-facing channel.

The `MailboxPort` already defines `read(agentId, opts)` (marks delivered,
idempotent re-read), `peek(agentId, opts)` (no mark), and `pendingFor(agentId)`
(undelivered count). The only missing piece was an LLM tool that derives the
caller's agent id and calls those methods. This ADR adds exactly that — no
substrate change, no shared-file wire change.

## Decision

Add `subagent_read_messages` as a SIBLING export in the existing
`src/tool/subagent-mailbox/index.ts`, and extend `subagentMailboxTools(port)`
(and therefore the Tier-1 builder) to return BOTH tools when the port is wired.

### Tool: `subagent_read_messages`

```typescript
z.object({
  mode: z.enum(["read", "peek"]).optional()
    .describe('"read" marks delivered (default); "peek" leaves undelivered.'),
  limit: z.number().int().positive().optional()
    .describe("Max messages to return (oldest-first)."),
})
```

- **Reader id**: derived from `ctx.depth` via the SAME `senderId` helper the send
  tool uses (root = `"root"`, child = `"agent@depth-N"`). An agent that sent
  under a depth-derived label reads its own inbox under that identical label.
- **mode** (default `"read"`): `read` calls `port.read(agentId, {limit})` —
  returns undelivered mail addressed to the caller and MARKS it delivered (a
  re-read is idempotent and renders `(no messages)`). `peek` calls
  `port.peek(agentId, {limit})` — same selection WITHOUT marking, so the mail
  stays pending.
- **limit**: positive integer cap on the oldest-first result; passed straight to
  the port's `opts.limit`. Omitting it returns all undelivered mail.
- **Render**: each message becomes one line `from→to [kind] body (id,
  correlationId?)` oldest-first (the port already returns them sorted by
  `sentAt`), followed by a trailing `pending: <pendingFor(agentId)>` line that
  reports how many messages remain undelivered to the caller AFTER this call. An
  empty inbox renders the literal `(no messages)` plus the `pending: 0` line.
- **HITL tier**: `pre-approval-ok` (information-class — the only effect is the
  in-memory delivery cursor advancing). `isReadOnly: () => true` (a poll mutates
  no observable state the loop snapshots — strictly an inbox drain).
- **NO-THROW**: zod `safeParse` rejects malformed input at the boundary
  (`⇒ { ok: false, output: "invalid input: ..." }`); the port calls are wrapped
  in try/catch so a hostile throwing port surfaces as
  `{ ok: false, output: "read failed: <message>" }` instead of bubbling past the
  loop.

### Builder

`buildSubagentMailboxBlock(config)` is unchanged in shape — it still returns `[]`
when `config.subagentMailbox` is absent and `subagentMailboxTools(port)` when
wired. `subagentMailboxTools(port)` now returns `[send, read]` (2 tools) instead
of `[send]`, both bound to the SAME port instance and the SAME id-derivation.

## Slice fence

Unchanged from ADR-0416. The read tool lives in the same tool slice and imports
ONLY `@/agent/subagent-mailbox` types (`MailboxPort` / `MailboxMessage`),
`../types` (Tool / ToolContext / ToolEvent / ToolResult), `@/shared`
(`errMessage`), and `zod`. NEVER `@/agent` core. The sealed
`src/agent/subagent-mailbox/*` substrate is UNMODIFIED.

## Default-OFF / byte-identical

Unchanged from ADR-0416. `config.subagentMailbox` absent ⇒ builder returns `[]` ⇒
neither tool is registered ⇒ the ToolRegistry stays structurally identical to the
pre-ADR-0416 registry (RFC §1.2).

## Tests

`tests/unit/subagent-mailbox-read-hellgate.test.ts` — 26 cases:

- **A. READ semantics** (12): read marks delivered + idempotent re-read ⇒
  `(no messages)`; peek does NOT mark (re-peek still sees it; a later read
  consumes); default mode `"read"` marks; `limit` caps oldest-first and does not
  consume the rest; empty inbox renders `(no messages)`; trailing `pending: <n>`
  reflects `pendingFor` AFTER the call; empty inbox still emits `pending: 0`;
  render shape `from→to [kind] body (id)`; correlationId rendered when present;
  multiple messages oldest-first; broadcast read by a non-sender.
- **A2. id-derivation parity** (3): reader id derives from `ctx.depth` (root reads
  root's mail; a depth-2 child reads `agent@depth-2` mail and a depth-1 reader
  sees nothing); missing/invalid depth derives to root (matches send default).
- **B. builder wiring** (4): slot WIRED ⇒ builder registers BOTH tools, same
  port; slot ABSENT ⇒ `[]`; read tool bound to the SAME port instance;
  send→read round-trip through the builder-bound pair.
- **C. NO-THROW / schema / HITL** (7): schema rejection (bad mode / non-positive
  limit / non-integer limit) ⇒ `ok:false`; NO-THROW on a throwing `read`/`peek`
  ⇒ `ok:false "read failed"`; NO-THROW on a throwing `pendingFor`; HITL tier
  `pre-approval-ok` + `isReadOnly` true; the existing send tool is unaffected.

The existing `tests/unit/subagent-mailbox-hellgate.test.ts` (ADR-0416) is
unchanged except for case (29), whose `tools.length === 1` count assertion was
updated to `tools.some(t => t.name === "subagent_send_message")` — the builder
now returns 2 tools; the test's intent (same-port binding of the send tool) is
preserved.

## Wire matrix

| File                                              | Change                                                                |
|---------------------------------------------------|-----------------------------------------------------------------------|
| `src/tool/subagent-mailbox/index.ts`              | +`subagent_read_messages` sibling tool + `subagentMailboxTools` 2-tool |
| `src/agent/tier1/subagent-mailbox.ts`             | doc only — builder now returns BOTH tools via `subagentMailboxTools`   |
| `tests/unit/subagent-mailbox-read-hellgate.test.ts` | NEW — 26 hellgate cases                                             |
| `tests/unit/subagent-mailbox-hellgate.test.ts`    | case (29) count assertion updated (builder now 2 tools)               |
| `tools/feature-catalog/features/09-integration/subagent-read-inbox.yaml` | NEW — fc catalog row                           |

## Consequences

**Positive:**
- Closes the ADR-0416 read deferral — an agent can now POLL its inbox mid-flight
  and consume parent / sibling / broadcast mail without teardown.
- No new substrate, no new shared-file wire: the read tool is a sibling export in
  the existing tool slice; the builder change is the array growing by one entry.
- Slice fence + default-OFF + NO-THROW preserved verbatim from ADR-0416.

**Deferred (still open from ADR-0416):**
- Dispatch-seam auto-drain of `pendingFor` into the per-turn reminder (this ADR
  is the PULL surface; an automatic PUSH into the prompt remains a future ADR).
- Session-id-based reader ids: `ToolContext` carries no session id, so the reader
  label stays depth-derived. Siblings at the same depth still collapse into one
  label (`agent@depth-N`) — a known ADR-0416 limitation, unchanged here.

**Negative:**
- One more tool in the registry when the port is wired (only when the host opts
  in). The send tool's old description still says "no read tool this wave"; the
  read tool's own description supersedes that for the read flow.
