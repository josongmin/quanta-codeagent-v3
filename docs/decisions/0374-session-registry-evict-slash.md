# ADR-0374 — `/session-registry evict <id>` slash sub-command

- Status: **Accepted**
- Date: 2026-05-28
- Slice: `src/apps/cli/session-registry-cmd.ts` (MUTATE — add dispatcher + `renderEvict` handler), `tests/unit/session-registry-slash.test.ts` (MUTATE — +12 hellgate cases)
- Related: ADR-0345 (closed-port `evict` contract) · ADR-0370 (inspector + stats slash) · ADR-0376 (help discovery, sibling)

## Context

ADR-0370 shipped `/session-registry stats` for **read-only** operator visibility. It deliberately omitted write sub-commands (`evict`, `clear`, `vacuum`) and pointed at "a separate mutation-policy ADR" for the per-id case.

Operator-side need keeps recurring: a stuck / hot session pins a registry slot, jsonl growth blocks ADR-0369 auto-sweep budgets, or a sqlite GC straggler needs an out-of-band kick. Without a slash the operator either restarts the process (drops every session, not just the hot one) or runs `sqlite3 ~/.codex/logs_2.sqlite 'DELETE FROM sessions WHERE id=…'` directly — bypassing the closed-port `evict` and missing the in-memory sibling state. Codex operators do exactly the latter; we want the same outcome surfaced **in-band** through the slash.

The closed port (ADR-0345) already exposes the right primitive: `evict(sessionId: string): void` is **idempotent** + **NO-THROW**. The slash wires that primitive — it is not a new mutation surface, just a CLI verb on top of an existing one.

## Decision

Extend `/session-registry` with one mutation sub-command:

```text
/session-registry evict <sessionId>
```

### 1. Dispatcher restructure in `session-registry-cmd.ts`

Before this ADR the file's `run()` was a 2-way switch (`help` vs `stats-default`). Replace with a 3-way sub-command dispatcher that fans out to `renderStats` / `renderHelp` / `renderEvict`. The default sub-command stays `stats` — `run([])` is **byte-identical** to ADR-0370's pre-mutation behavior (regression-tested in case [3]).

### 2. `renderEvict(args, ctx)` semantics

| Input                                | Stdout                | Stderr                                                                    | Exit |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------- | ---- |
| `evict` (no id)                      | —                     | `/session-registry: usage: /session-registry evict <sessionId>`           | 1    |
| `evict <id>` — id known to registry  | `evicted <id>`        | —                                                                         | 0    |
| `evict <id>` — id unknown            | `evicted <id>`        | —                                                                         | 0    |
| `evict <id>` — `registry.evict` throws | —                   | `/session-registry: evict failed: <message>`                              | 1    |
| `evict <id> <extra> <junk>`          | `evicted <id>`        | —                                                                         | 0    |

The unknown-id success row mirrors **ADR-0345 §"Idempotent — unknown id ⇒ no-op"**. Reporting failure on unknown id would either (a) require the slash to peek the registry first (race against parallel evictors / TTL sweepers) or (b) widen the closed port with a "did-evict" boolean — both worse than honest idempotence.

The throw-row exists for **defence-in-depth**: the closed port mandates NO-THROW, but hostile mocks in tests + future adapter regressions can still throw. The slash itself MUST NOT crash the REPL, so we wrap `evict` in try/catch and surface the error message — operator sees what went wrong without losing the prompt.

Extra args after `<id>` are ignored. A future `evict <id1> <id2> …` bulk form would invert exit-code semantics (partial failure handling); the ADR pins the single-id contract and defers bulk to a separate ADR if/when needed.

### 3. No confirm gesture (deliberate)

ADR-0370 cited "operator typo dropping a hot session" as the foot-gun argument against write sub-commands. For per-id `evict` we accept that risk because:

1. The operator typed the id explicitly — there is no globbing / wildcard / `--all` variant. A typo evicts the wrong session, not "every session".
2. `evict` is **idempotent + recoverable**: the next `getOrCreate(id)` mints fresh resources. The cost of an accidental evict is a cold cache + a lost typed-history-event tail (durable mirrors recover the rest). The cost of a confirm gesture is operator friction every time, including the legitimate "kill the hot session" path.
3. The 3-way restore primitives (ADR-0210) already cover the "I evicted by mistake" case at a finer granularity than confirm-then-evict.

A `--yes` flag for future destructive sub-commands (`clear`, `vacuum`) remains the right shape; this ADR does **not** preempt it.

### 4. ADR-0370 BUILTINS table unchanged

`/session-registry` already lives in `APP_SLASH_COMMANDS` (ADR-0370). This ADR adds a sub-command, not a new top-level slash. The `BUILTINS` sweep test (`tests/unit/slash-commands.test.ts`) asserts the exact 47-entry name array; that array is **byte-identical** pre / post this ADR.

## Non-goals

- **Bulk evict** (`evict --all`, `evict --pattern …`) — out of scope. The single-id form keeps exit-code semantics simple; a bulk form needs a separate ADR.
- **`clear` sub-command** — out of scope. The closed port has `clear()` for test reset / shutdown; exposing it via slash without a confirm gesture **is** the ADR-0370 foot-gun.
- **TTL override** — operators cannot extend a session's TTL through this slash. ADR-0369 owns the sweep policy; a TTL knob is a separate ADR.
- **Audit trail** — the slash does not emit a telemetry event on evict. ADR-0358 / 0360 cover registry op counters; if the `evict` count needs to be observable separately from the slash that is a follow-up wire (NOT a closed-port change).
- **Read-after-evict assertion** — the slash does **not** verify `peek(id) === null` after `evict`. The closed port already guarantees idempotent eviction; double-checking would race against concurrent `getOrCreate` re-mints.

## Wiring

- The slash is already registered (ADR-0370). No changes to `src/apps/cli/slash/registry-app.ts`.
- `session-registry-cmd.ts` imports `getGlobalSessionResourceRegistry` from `@/agent/session-resource-registry/global` (already an existing exported symbol — no port change).
- No mutation of `loop.ts`, `prompt.ts`, `assemble.ts`, or any composition-root file.

## NO-THROW invariants

- `renderEvict` wraps `registry.evict(id)` in try/catch — a throwing implementation surfaces as stderr + exit 1, not a process crash.
- Missing id → usage line + exit 1 (no exception).
- Unknown id → success path (idempotent per ADR-0345).
- Extra args → ignored (no exception).

## Slice fence

- `src/apps/cli/session-registry-cmd.ts` — mutated (dispatcher + handler + import).
- `tests/unit/session-registry-slash.test.ts` — mutated (+12 hellgate cases).
- No mutation of `src/agent/session-resource-registry/*` (port + adapters untouched).
- No new cross-slice imports beyond what ADR-0370 already established.

## Test coverage

`tests/unit/session-registry-slash.test.ts` adds 7 cases for this ADR (numbered [6]–[12] alongside ADR-0370's [1]–[5] and ADR-0376's [13]–[17]):

| Case | Subject                                              |
| ---- | ---------------------------------------------------- |
| [6]  | `evict` (no id) → usage on stderr + exit 1           |
| [7]  | `evict <id>` → "evicted <id>" on stdout + exit 0     |
| [8]  | `evict <id>` → calls `registry.evict(id)` exactly once |
| [9]  | `evict <unknown>` → idempotent success (ADR-0345)    |
| [10] | evict then stats → sessions count reflects removal   |
| [11] | hostile `evict` throws → stderr + exit 1 (NO-THROW slash) |
| [12] | extra args after id → only first id evicted          |

The pre-existing [1]–[5] continue to pin ADR-0370 invariants. The new dispatcher does not regress them (cases [1]–[5] all green after the mutation).
