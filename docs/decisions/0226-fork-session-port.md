# ADR-0226: Fork session — ForkSessionPort (branch-name + signal + shadow-tag)

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0118 (`shadow_rewind`), ADR-0124
  (`ConversationCheckpointStore`), ADR-0201 (base `SessionForker`),
  ADR-0108 (`ShadowOdb`), ADR-0184 (`ConversationCheckpointStore` LRU
  swap), ADR-0166 (subagent conversation seed replay).
- Collision: requested ADR number was **0220**; that slot is held by
  `0220-git-directive-emit.md`. The fallback **0221** was also taken
  in-flight by `0221-git-directive-emit-protocol.md`; 0222/0223 by
  user tracks (`otel-emit-new-slices` / `auto-background-stuck-detector`);
  0224 by W2-5 (`cli-slash-web-paste`); 0225 by W2-5 sibling
  (`cli-slash-mid-edit`). Per the user-deference renumber policy
  (memory: `adr-collision-policy-2026-05-25`), this slice takes the
  next-free number **0226**.

## Context

ADR-0201 shipped the BASE `SessionForker` port — a synchronous
`Result`-returning surface over `ConversationCheckpointStore` with
UUID-v4 session-id minting. That is enough for the `fork_session` agent
tool, but Claude `/fork` + Cursor session-fork expose a RICHER UX surface
the base port can't cover:

1. **Human branch labels** — `--name=feature-x` so a branch tree is
   navigable by the user, not by UUID.
2. **`AbortSignal` cancellation** — long-running fork chains (e.g. when
   a sibling Shadow-ODB tag write blocks on disk) must honour caller
   cancellation, with the guarantee that NO state is observable
   post-abort.
3. **Shadow ODB fork-tag** — record a workspace snapshot at fork time
   so a future "restore branch point" UX can navigate by branch id.
4. **Parent-link metadata + branch enumeration** — `listBranches` and
   `resolveParent` so a `/fork` slash command can paint a branch tree
   without grepping the snapshot store.

Adding these to the BASE port would break every existing
`SessionForker` consumer (the agent tool, ADR-0166 subagent replay).
Instead this ADR introduces a NEW port — `ForkSessionPort` — that
COMPOSES the existing base. Existing consumers see byte-identical
behavior; new surfaces (the `/fork-checkpoint` slash command + the
future fork-tree UI) consume the richer port.

Negative invariants we are NOT violating:

- **Byte-identical default-OFF.** `ForkSessionPort` is constructed by
  the composition root; when nothing wires it, no slash command is
  registered (the `/fork-checkpoint` body refuses with "not wired in
  this surface" when `SlashContext.forkSession` is absent — exit 0,
  no error, no extra tools).
- **Snapshot immutability** (inherited from ADR-0201).
- **No loop coupling.** This slice imports `@/shared` +
  `@/agent/conversation-checkpoint` only. The shadow ODB is consumed
  through a structural `ShadowOdbLike` interface so this slice does
  NOT import `@/storage/shadow-odb` directly.
- **`exactOptionalPropertyTypes: true`** — `branchName` is OMITTED on
  every payload (`ForkResult`, `ParentLink`) when absent, never
  `undefined`-set.
- **No-throw on the public port surface.** Every error is a typed
  `ForkError` arm (8 arms total — 4 from ADR-0201 + 4 new in 0221).
- **No new external dependencies.** The user spec suggested `nanoid`;
  installs are blocked in this repo. We ship `branch-id.ts` — a
  ~50-LOC URL-safe minter built on `node:crypto.randomBytes`,
  entropy-equivalent to nanoid default (~126 bits at length 21).

## Decision

### New files in `src/agent/fork-session/`

```
branch-id.ts          BRANCH_ID_ALPHABET + defaultBranchIdMinter + isWellFormedBranchId
parent-link.ts        ParentLink + ParentLinkStore + defaultParentLinkStore (LRU, cap=500)
port.ts               (extended) — ForkSessionPort + ForkInput + ForkResult + BranchInfo
default-forker.ts     (extended) — defaultForker + ShadowOdbLike
types.ts              (extended) — 4 new ForkError arms (fork-not-configured /
                                   aborted / invalid-branch-name / shadow-odb-failed)
index.ts              (extended) — barrel re-exports
```

### New file in `src/apps/cli/`

```
fork-checkpoint-cmd.ts   /fork-checkpoint slash command
slash-commands.ts        (1-line append) — register forkCheckpointCmd in BUILTINS
```

### New file in `tests/unit/agent/`

```
fork-session-port-hellgate.test.ts   17 invariants (FP-01 .. FP-17)
```

### Public shape

```ts
interface ForkSessionPort {
  fork(input: ForkInput): Promise<Result<ForkResult, ForkError>>
  listBranches(input: { sessionId: string }): ReadonlyArray<BranchInfo>
  resolveParent(input: { sessionId: string }): string | null
}

interface ForkInput {
  readonly fromCheckpointRef: string
  readonly branchName?: string
  readonly signal?: AbortSignal
}

interface ForkResult {
  readonly newSessionId: string
  readonly parentSessionId: string
  readonly branchPoint: string
  readonly branchId: string
  readonly branchName?: string
  readonly forkedAt: number
  readonly messages: ReadonlyArray<unknown>
}
```

### Composition

The CLI surface wires the port like this (composition root only — the
slash command does NOT construct):

```ts
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { defaultForker, defaultSessionForker } from "@/agent/fork-session"
import { defaultShadowOdb } from "@/storage/shadow-odb"

const store = defaultConversationCheckpointStore()
const base = defaultSessionForker(store)
const shadowOdb = defaultShadowOdb()
const port = defaultForker({ base, shadowOdb, workspaceRoot: cwd })

// Wire into slash-context:
ctx.forkSession = { port, activeSessionId }
```

### CLI surface

```
/fork-checkpoint                              → list branches off active session
/fork-checkpoint --session=SID                → list branches off SID
/fork-checkpoint <ref> [--name=BRANCH]        → fork; print new sid + branch id
```

Distinct from existing `/fork` (session-level message-id fork in
`rewind-cmd.ts`, ADR session-level). The new command operates on
`ConversationCheckpointStore` keys, not message ids.

## Consequences

- 5 new files (4 in slice + 1 slash command + 1 hellgate).
- 4 new `ForkError` arms (closed-union — every consumer's
  exhaustive-switch fails to compile when an arm is missed).
- `+17` hellgate tests / `+0` regressions. The original ADR-0201
  hellgate (`fork-session-hellgate.test.ts`, 13 tests) still passes.
- `defaultParentLinkStore` cap = 500 (10× the conversation-checkpoint
  cap — branch labels cost less than message arrays).
- Shadow ODB tag is BEST EFFORT. A tag-write failure returns
  `Err("shadow-odb-failed")` but the link + session are kept (the new
  session is usable; only the recovery anchor is missing).
- Default-OFF — when nothing wires `ctx.forkSession`, the slash
  command prints "not wired" and exits 0 (no error, no panic).

## Alternatives considered

1. **Extend `SessionForker` in-place** (add `branchName` / `signal` /
   `listBranches`) — REJECTED. Breaking every existing consumer
   (`fork_session` tool, ADR-0166 replay) for a UX-only enrichment is
   the wrong trade.
2. **Pull in `nanoid`** — REJECTED. Installs are blocked in this repo
   (verify-workflow memory). The in-house `branch-id.ts` is
   entropy-equivalent and zero-dep.
3. **Bake shadow-ODB into the base** — REJECTED. The base port has no
   workspace concept; the shadow ODB is workspace-anchored. Keeping
   them separate at the port boundary is the SRP cut.
4. **Reuse `/fork` slash name** — REJECTED. `/fork` already exists in
   `rewind-cmd.ts` for session-level message-id forking. The new
   command addresses a different ID space (checkpoint refs); naming
   it `/fork-checkpoint` makes the distinction obvious in `/help`.
