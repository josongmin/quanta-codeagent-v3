# USAGE — the wire SDK door (`connect()` + `SessionHandle`)

> Ticket 01 (S7) DX guide. The in-process embed door (`createAnalysisAgent`) is
> documented in [jul-4 USAGE](../jul-4-sdk-embed-dx/USAGE.md); THIS page is the
> **wire** door: session.v1 over WebSocket / stdio. Design SSOT:
> [00-MASTER-PLAN.md](00-MASTER-PLAN.md) §3, ticket [01](01-connect-session-handle.md).

```ts
import { connect, transports } from "quanta-codeagent/sdk"
```

## 1. Three transports

### ① Remote WS (a running `quanta` web daemon — same door `quanta attach` uses)

```ts
const session = await connect({
  transport: transports.ws({
    url: "ws://127.0.0.1:4096/",
    authToken: process.env.QUANTA_DAEMON_TOKEN, // sent as ?token=…
    // webSocketCtor: MyWebSocket,              // non-Bun runtimes / tests
  }),
  onApproval: async (approval) => "approve",    // ApprovalDecisionResult SSOT (§4)
  onConnectionState: (s) => {
    if (s.status === "closed") console.error(`connection lost: ${s.reason}`)
  },
})

await session.input.append("refactor the parser")
await session.turn.run()                        // → { commandId, submitted: true }
const end = await session.awaitTurnEnd()        // turn.completed | turn.failed | turn.aborted
console.log(end.type)
await session.close()
```

### ② Codex-style sidecar (spawn-owned stdio child)

```ts
const session = await connect({
  transport: transports.stdio({
    command: ["quanta", "serve", "--stdio"],
    env: { QUANTA_SERVE_STDIO: "1" }, // ⚠ passed VERBATIM as the ENTIRE child env —
    cwd: repoDir,                     //   nothing is auto-injected; enabling the
  }),                                 //   ticket-02 maturity gate is YOUR explicit act.
})
```

The transport OWNS the child lifecycle: `close()` = stdin EOF + SIGTERM →
bounded SIGKILL; any child exit surfaces as
`onConnectionState({status:"closed", reason:"child_exit code=… stderr_tail: …"})`
— a gate-OFF server that exits immediately fails FAST with its last words, not
a silent hang. (`quanta serve --stdio` itself is ticket 02 — until it lands,
point `command` at your own session.v1 stdio server or pass a pre-built
transport via `transports.stdio({ transport })`.)

### ③ In-process — deliberately NOT here

External in-process embedding = `createAnalysisAgent` (the jul-4 door). There
is NO public loopback transport and no public session factory (MASTER §3.3) —
the internal `toSessionHandle` adapter exists only as the transport-conformance
oracle. If you control the process, you don't need a wire.

## 2. First-frame contract (what a NORMAL handshake looks like)

`connect()` performs the same discovery handshake `quanta attach` does. On the
wire you will see — and must not be alarmed by — this sequence:

```
→ connect  {sessionId: "ui-session"}                 # discovery SENTINEL (id unknown yet)
← rejected {target:"connect", reason:"session_id_mismatch", sessionId:"<canonical>"}
                                                     # NOT an error — the reject CARRIES the id
→ connect  {sessionId: "<canonical>"}                # re-handshake, adopted id
← snapshot {…}                                       # state carrier; handshake is now READY
← event    …                                         # live tail
```

The `rejected(canonical)` leg is the id-adoption mechanism, not a failure. The
SNAPSHOT is the authoritative state/capabilities carrier (there is no
`session.created` frame on the wire). `connect()` resolves after the snapshot;
`session.sessionId`, `session.snapshot()` and `session.lastSeq()` are seeded
atomically from the handshake (the cursor never lags the handshake window),
and tail events the handshake itself consumed (a stdio chunk can carry
snapshot+tail in one dispatch) are RE-DELIVERED to any subscriber attached
before the first live frame — nothing from the handshake window is dropped.

## 3. Receipts, rejection, and `awaitTurnEnd()`

- Every verb resolves `{ commandId, submitted: true }` — **transport-send
  truth only**. session.v1 has no success-ack frame, and the server dispatch
  queue is serial (ticket 01 §3.1): awaiting completion inside a verb is the
  deadlock class; correlation happens on events instead.
- Server-side refusals arrive asynchronously on
  `session.onCommandRejected(cb)` as `{message, error}` with a TYPED error
  (§6 catalog).
- `awaitTurnEnd()` resolves the CURRENT turn chain's terminal event —
  `turn.completed | turn.failed | turn.aborted` — correlated by
  `causedByCommandId`, **including across an approval suspension** (§3.2
  succession: the post-approval `turn.run` re-issue, client- or daemon-owned,
  is followed automatically). Every correlation LOSS is a typed
  `SessionTurnCorrelationLostError` — never a silent hang:

  | `reason` | meaning |
  |---|---|
  | `no_turn_run` | you never issued `turn.run` through this handle |
  | `approval_denied` | the turn's approval was denied — the kernel clears the draft and emits NO turn terminal (wire fact) |
  | `approval_voided` | the session left `awaiting_approval` without the approval ever resolving — e.g. `turn.cancel` on a parked approval: the kernel discards it silently (no `approval.resolved`, no turn terminal) |
  | `continuation_failed` | the post-approval re-issue could not be submitted — or the `approval.respond` itself never left the client (send failure) |
  | `connection_closed` | transport died mid-wait |
  | `handle_closed` | you closed the handle mid-wait |
  | `superseded` | you issued a NEW explicit `turn.run` (or reused a commandId) while this chain's post-approval adoption window was open — the new turn claims the session's single draft |

## 4. Approvals (`onApproval`)

The decision type is the existing `ApprovalDecisionResult` SSOT — bare
`"approve"` / `"deny"` or the rich form
`{decision:"approve", scope?:"once"|"session"|"session_prefix"}` /
`{decision:"deny", steer?:string}`. Under the hood the hoisted attach flow
sends `approval.respond` and — unless the daemon declared the
`serverAutoContinues` capability (ADR-0540 W1-B) — re-issues the continuation
`turn.run`, reporting it into `awaitTurnEnd()`'s chain.

- a THROWING / garbage `onApproval` fail-safes to **deny** (never approve,
  never hang);
- `onApproval` ABSENT + an approval arriving ⇒ the turn **parks** (no timeout)
  until another peer (web UI, attach CLI) answers — see §5 for unattended runs.

## 5. Unattended operation (3 lines — ticket 01 §3.4)

CI / bots should not park on approvals: run
`await session.permission.set("bypass")` (or `"acceptEdits"`) right after
connect. `onApproval` is for HITL surfaces (each approval is a
park→respond→re-issue round-trip). No `onApproval` + no permission change +
an approval-raising tool = the turn parks forever by design.

## 6. Error catalog (typed, all `instanceof SessionProtocolError`)

| class | wire source | when |
|---|---|---|
| `SessionDuplicateCommandError` | `rejected: duplicate_command` | commandId replay (dedup window) |
| `SessionRevisionConflictError` | `rejected: revision_conflict` | your `expectedRevision` is stale (carries expected/actual) |
| `SessionProtocolValidationError` | `rejected: session_id_mismatch` / `protocol_validation` + kernel issue (e.g. `empty_turn_input`) | malformed / inapplicable command |
| `SessionDispatchFailedError` | `rejected: protocol_validation` + issue `dispatch_failed` | the command was ADMITTED but the dispatch threw (S5a promotion — previously a silent hang) |
| `SessionProtocolVersionError` | `rejected: protocol_validation` + issue `bad_version` | version skew — the peer refused OUR protocol version. Only peers carrying the S5b lenient reject can say this; a peer shipped BEFORE it stays silent (both directions), so treat an unexplained handshake hang against an old daemon as possible skew |
| `SessionHandleClosedError` | (client-side) | verb/connect on a dead connection — carries the transport's close `reason` (`socket_close…`, `child_exit…`, `local_close`) |
| `SessionTurnCorrelationLostError` | (client-side) | `awaitTurnEnd()` hang-guard — §3 table |

Connection death always ALSO fires `onConnectionState({status:"closed",
reason})` exactly once. v1 does NOT auto-reconnect and takes NO resume
cursor: reconnect = a fresh `connect()` (the handshake snapshot re-seeds the
full state view). Resume of any kind is **ticket 05** — see §10 for why the
option was removed rather than deferred.

## 7. Streaming render recipe

The snapshot carries any mid-stream text; deltas append from there:

```ts
let text = (await session.snapshot())?.snapshot.state.streamingAssistantText ?? ""
session.subscribe((event) => {
  if (event.type === "turn.output.delta") {
    text += event.delta
    render(text)
  }
  if (event.type === "turn.completed") {
    text = event.assistantText ?? text // authoritative final text
    render(text)
  }
})
```

`session.snapshot()` is a **cache of the last received snapshot frame** (with
`receivedAtMs` + `lastSeenSeq` freshness), NOT a server round-trip — there is
no snapshot-request verb in session.v1.

## 8. Keepalive

| transport | client | server |
|---|---|---|
| ws | the web daemon's peers send app-level `heartbeat` pings; SDK v1 does **not** auto-ping (add your own timer if you sit behind an idle-killing proxy: `transport` keepalive is ticket-02/03 territory) | daemon answers `pong` |
| stdio | none by default (parent↔child pipes don't idle out) | answers `pong` if you send `ping` |

## 9. Types without `.d.ts` (honest current state)

`package.json` exports `"./sdk"` with a `types` condition pointing at the
SOURCE (`./src/sdk/index.ts`) until jul-4 P8 produces `.d.ts`. A consumer
typechecking against it today needs (proven working — see ticket 01
acceptance):

```jsonc
// consumer tsconfig.json
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["bun-types"],                    // the graph uses Bun ambients
    "typeRoots": ["./node_modules"],           // relative to the consumer project
    "paths": { "@/*": ["./node_modules/quanta-codeagent/src/*"] } // internal alias shim
  },
  "files": [
    "main.ts",
    "node_modules/quanta-codeagent/src/agent/sticky-model/write-file-atomic.d.ts",
    "node_modules/quanta-codeagent/src/tool/web/turndown.d.ts"
  ]
}
```

The alias shim + ambient-file loading disappear when P8 ships `.d.ts` (that
ticket owns the artifact; this door only pulled its ordering forward).

## 10. Resume — NOT in this door (descoped, jul-16 audit)

`connect()` deliberately has **no `resumeFromSeq`**. The reason is structural,
not scheduling: the handshake only becomes ready on a SNAPSHOT frame, but the
daemon answers a servable resume cursor with an **events-only** replay — and
with **zero frames** when the cursor is already at tip (`planSessionReplay`),
which is exactly the reconnect-right-after-a-drop base case. session.v1
carries no ack frame that could signal "caught up", so a resume-carrying
`connect()` is a guaranteed forever-pending promise (an earlier draft shipped
it and claimed "you always converge" here — that was false; both audit
attackers reproduced the hang).

What you DO have today:

- `lastSeq()` — pure observation: the highest seq this handle has seen (useful
  for logging/diffing how far a view had advanced before a drop);
- reconnect = a fresh `connect()` — the handshake snapshot re-seeds the full
  state view (you lose the event-granular gap, not the state).

Door-level resume is **ticket 05**: it rides the raw client's
`connect({resumeFromSeq})` resume watcher (already landed on main —
arm→send + resume-outcome surfacing), plus the on-disk event log
(ADR-0540 W4-b) for durability across daemon restarts.
