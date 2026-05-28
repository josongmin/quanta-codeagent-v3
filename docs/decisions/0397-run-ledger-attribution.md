# ADR-0397 — Run Ledger attribution via hook bus

**Status:** Accepted (2026-05-28)
**Slice:** `src/agent/run-ledger-attribution/` (new: `types.ts` + `matchers.ts` +
`subscriber.ts` + `index.ts`) + hellgate
**Default-OFF:** Yes — pure new slice imported by nobody. The composition root
must explicitly subscribe the handler to a `HookBus` for the ledger to receive
any data; until then the byte-for-byte legacy path is preserved.

## Context

[ADR-0395](./0395-run-ledger.md) shipped `@/agent/run-ledger` as a **pure store**
that models long-running work in one shape (`RunKind = shell | subagent |
mcp_task | exec`, `RunStatus = running | waiting | completed | failed |
stopped`). The wave-1 contract is closed; what was missing is the *reporting*
seam — nothing in the agent reports INTO the ledger today, so a UI that wires
the wave-1 store sees only the empty set.

Three slices produce the events the ledger needs to render:

1. **`@/tool/bash`** — `timeout_behavior:"background"` emits a
   `[bash background] shellId=<id> status=running ...` banner; `bash_await`
   emits `[bash_await exit N] shellId=<id> ...`; `bash_kill` emits
   `[bash_kill killed] shellId=<id> ...`.
2. **`@/subagent`** — `agent({background:true})` emits
   `Subagent launched in background. task_id: <id> ...`; `task_output`
   renders `task_id:` / `status: <name>` lines for a settled task;
   `task_stop` emits `Stopped task <id>.`.
3. **`@/tool/mcp_tasks`** — `get_mcp_task` emits
   `<id> [<state>]\n(completed|failed|cancelled): <payload>`;
   `cancel_mcp_task` emits `cancelled: <id>`.

Wiring any of those slices to call the ledger directly is a slice-fence
violation (the wave-1 ADR specifically forbids `run-ledger/` from importing
peer slices, and adding an import in the opposite direction would couple bash
/ subagent / mcp to ledger internals). What we need is an OBSERVATION seam.

## Decision

Introduce a separate slice `src/agent/run-ledger-attribution/` that subscribes
to the **in-process `HookBus`** `post_tool_use` event (declared in
`src/agent/hooks.ts`) and translates observed tool outputs into ledger calls.

### Closed contracts

- **`LedgerAction`** — three arms (`start` / `touch` / `settle`) mirroring the
  three `RunLedgerPort` verbs. `start` carries `id`, `runKind`, `owner`,
  `title`, optional `resumeAction`. `settle` carries `id`, terminal `status`,
  optional `error`.
- **`LedgerMatcher.match(event)`** — pure function. Input: the four
  load-bearing fields of a `post_tool_use` event (`name`, `input`, `output`,
  `ok`). Output: a `LedgerAction` or `null`. **NO-THROW** under any malformed
  input; **no side effects**.
- **`createRunLedgerHookSubscriber({ledger, matcher?, owner?})`** — returns a
  hook handler `(event) ⇒ void`. Validates the event shape, runs the matcher,
  applies the resulting action to the ledger best-effort. Swallows any
  ledger throw (defense in depth).

### Default matcher

Composes eight per-tool leaves, each anchored on a literal output banner:

| Tool              | Banner / signal                              | Action                            |
| ----------------- | -------------------------------------------- | --------------------------------- |
| `bash`            | `[bash background] shellId=<id> status=running` | `start kind:"shell"` (resumeAction=`bash_await <id>`) |
| `bash_await`      | `[bash_await exit 0] shellId=<id>`           | `settle status:"completed"`       |
| `bash_await`      | `[bash_await exit N>0]` or `ok:false`        | `settle status:"failed"`          |
| `bash_await`      | `await_timeout` (shell still running)        | `null` (do not settle on poll)    |
| `bash_kill`       | `[bash_kill ...]` + `ok:true`                | `settle status:"stopped"`         |
| `agent`           | `input.background===true` + `Subagent launched in background.` banner + `task_id: <id>` | `start kind:"subagent"` (resumeAction=`task_output <id>`) |
| `task_output`     | `status: completed` (and `task_id` on input) | `settle status:"completed"`       |
| `task_output`     | `status: failed`                             | `settle status:"failed"`          |
| `task_output`     | `status: stopped`                            | `settle status:"stopped"`         |
| `task_output`     | `status: running` / block-timeout            | `null`                            |
| `task_stop`       | `Stopped task <id>.` + `ok:true`             | `settle status:"stopped"`         |
| `get_mcp_task`    | `completed: <payload>`                       | `settle status:"completed"`       |
| `get_mcp_task`    | `failed: <payload>`                          | `settle status:"failed"`          |
| `get_mcp_task`    | bare `cancelled` line                        | `settle status:"stopped"`         |
| `get_mcp_task`    | `not-ready:` / `not-found:`                  | `null`                            |
| `cancel_mcp_task` | `cancelled: <id>` + `ok:true`                | `settle status:"stopped"`         |
| anything else     | —                                            | `null`                            |

### Slice fence

The slice imports ONLY `@/agent/run-ledger` (type imports for the port) and
`@/shared` (today the slice consumes nothing from shared, so the rule is
forward-compatible). It NEVER imports `@/tool/bash`, `@/subagent`, `@/mcp`,
or any other peer slice — and notably NOT `@/agent/hooks` either: the
subscriber takes an opaque shape `{name, input, output?, ok}` (validated
defensively) so the slice cannot drift with hook-bus internals.

The MATCHER owns the **literal-banner contract** with each producing tool.
If a tool author changes a banner, the matcher's hellgate fails — the seam
is enforced by tests rather than by reaching across the fence.

### Pinned invariants

- **NO-THROW** at the matcher boundary: every malformed event (null,
  missing fields, wrong types) ⇒ `null` without throwing.
- **NO-THROW** at the subscriber boundary: a misbehaving ledger (test stub
  that throws, future remote-IPC store) cannot crash the hook bus.
- **No mid-state mis-settlement**: `await_timeout` (poll timeout, shell
  still running) and `running`-status `task_output` polls do NOT settle.
  The only paths to terminal `failed`/`completed`/`stopped` are explicit
  signals from the producing tool.
- **Owner stamping is fixed at `start`**: a custom `owner()` closure is
  invoked when starting a new ledger entry. `touch`/`settle` do not
  re-stamp owner (the wave-1 ledger keeps the original).
- **Idempotent re-observation**: applying the same `post_tool_use` event
  twice does not break ledger state (a re-`start` overwrites; a duplicate
  `settle` on an already-settled entry is a no-op per the wave-1 contract).

## Consequences

- **+** The wave-1 ledger now has a defined wiring path: a composition root
  that has both a `HookBus` and a `RunLedgerPort` can subscribe the handler
  in ONE line and bash/subagent/mcp begin reporting transparently.
- **+** Zero churn in peer slices: `bash`, `subagent`, `mcp` slices are
  untouched. The observation seam is the existing hook bus.
- **+** Default-OFF & byte-identical: importing the barrel touches no
  process state. Composition wiring is a follow-up; this ADR ships only
  the subscriber factory + matcher.
- **+** Banner-contract owned by tests: a tool author who changes an
  output banner sees a CI fail in this slice (the matcher's hellgate
  pins every literal), not a silent regression in some UI weeks later.
- **−** The matcher leans on output STRINGS (not structured ToolEvent
  values). This is forced by the `HookBus` event shape (`output: string`)
  — it is the preview the host already sees. A future
  `post_tool_use_structured` hook variant could supplant this; until then
  the matcher's banner contract is the bridge.

## Alternatives considered

- **Have each slice (`bash` / `subagent` / `mcp`) call the ledger
  directly.** Rejected: violates the wave-1 slice fence (`run-ledger/`
  forbids peer imports) and the inverse coupling (peer slices importing
  ledger) would entangle three independent slices on a single observability
  seam.
- **Use a `post_tool_use_structured` event variant.** Rejected (not now):
  the hook bus shape would need a new variant + every emitter migrated,
  with no behaviour win over banner-string parsing. Forward-compatible:
  the matcher abstraction is shaped so a future structured variant is a
  drop-in.
- **Subscribe at dispatch (not via `HookBus`).** Rejected: dispatch is
  the most sensitive seam in the loop; adding a ledger call there
  re-introduces the very coupling this ADR avoids. The hook bus is the
  existing in-process observability point.
