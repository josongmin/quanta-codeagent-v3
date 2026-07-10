# P1 — Web daemon multi-session (thread-addressed live sessions)

**Status:** planned (code-boundary confirmed jul-11). The last remaining item from
the jul-9 UI/UX bugbash verified backlog. NOT a "nut" — a genuine 2-slice
architecture change, proven below.

## Problem

Today the web daemon is **multi-client, single-session**: `server.ts:182` mints
ONE `sharedSession = runtime.createSession(config.sessionConfig)`; every WS
client attaches to that same live transcript (`session-registry.ts` tracks
per-WS *transport* pairs, but `entry.session` is shared — closing a WS never
closes the session). A deeplink `?thread=<id>` to a DIFFERENT thread therefore
renders **read-only history** (`lib/thread-resume.ts`, honest `boundary:
"read-only-history"`), because the live session cannot be switched to an
arbitrary thread. When the requested id *equals* the live session id it is
already effective live-attach (App renders "(live)" + the WS-connected composer
is active) — so the FLOOR is done; only "make ANY thread live" is open.

## Why it is architecture, not a nut (code-confirmed jul-11)

1. **`RuntimeSessionConfig` carries no seed** (`src/host/runtime/types.ts:4`):
   `{ cwd?, model?, permissionMode?, identityMode?, toolProfile? }` — no
   `history` / `messages`. `createSession` (`src/sdk/runtime/runtime.ts:9`) makes
   an EMPTY session; `createSessionHost(config)` has no hydrate path. So the SDK
   literally cannot spawn a session seeded from a persisted transcript today.
2. **The daemon's per-session wiring assumes ONE session**: three collaborators
   bind to `sharedSession` inline (`server.ts:190` setupThreadPersistence,
   `:205` setupFollowerApproval, `:216` attachCostAggregator). Multi-session
   needs each replicated per hosted session.

Both must change; A gates B (no daemon hydrate without SDK seed). That is the
"session-registry architecture" the earlier notes referenced — now pinned to
exact lines.

## Plan (4 phases, each an independent tsc-green commit; A → B → C → D)

### Phase A — SDK/host: seed a session from prior history
- Add `history?: readonly Message[]` to `RuntimeSessionConfig`
  (`src/host/runtime/types.ts`). Absent ⇒ empty session (byte-identical).
- Thread it through `createSessionHost` → the session-host factory so the new
  session's initial working-memory/transcript is that history. Reuse the
  existing Codex-R2 history-block / "re-assemble REUSES prior typed-history"
  logic in `agent-config-assembler.ts` (~772, ~934) rather than a new path.
- SDK `createSession` returns the seeded session; capability manifest unchanged.
- **Hellgate:** `createSession({ history: [...] })` → the session's first
  `turn.run` sees that history (a follow-up references a prior user message);
  `history` absent ⇒ empty (paired control).
- Risk: touches the shared session-creation pipeline (every surface). Keep the
  field optional + default-absent so CLI/headless/bench are byte-identical;
  pin that with a paired control.

### Phase B — daemon: session factory + threadId-keyed registry
- Replace the single `sharedSession` mint with
  `getOrCreateSession(threadId?): Promise<RegisteredSession>` in `server.ts`.
  `threadId` absent ⇒ the default session (current behavior, byte-identical).
- Move the three per-session collaborators (persist/follower/cost) INTO the
  factory so each hosted session gets its own; `session-registry` keys by
  `threadId` (or a synthetic default key) instead of the WS object, and
  `closeAll()` closes each hosted runtime session exactly once.
- **Hellgate:** two distinct threadIds ⇒ two distinct sessions in the registry;
  same threadId twice ⇒ one session (get, not create); default (no id) unchanged.

### Phase C — daemon: WS routing + hydrate-on-first-attach
- WS upgrade reads `?thread=<id>`; `getOrCreateSession(id)` — on a cache miss,
  `threadStore.loadEvents(id)` → `Message[]` → `createSession({ history })`
  (Phase A). Unknown id ⇒ a fresh empty session under that id (honest, not a
  crash).
- Generalize the `fetch-handler.ts:182` single-shared-session boundary: any
  hosted thread is now `live-attach`; only never-persisted ids stay read-only.
- **Hellgate:** attach to a non-live thread ⇒ a live session hydrated from its
  persisted events (composer active, `turn.run` reachable) — RED today.

### Phase D — frontend: live join instead of read-only replay
- `lib/thread-resume.ts` + `App.tsx`: when opening a thread, (re)connect the WS
  with the thread param → join the live session; drop the read-only replay for
  hydrated threads. Keep read-only only for genuinely absent ids.
- **Hellgate:** picking a thread yields an INTERACTIVE session (composer
  enabled) — the pin `lib/thread-resume` currently fails.

## Sequencing / safety
- A is the keystone (B/C need the seed). Each phase lands green; the OFF/default
  path (no threadId, no history) stays byte-identical so CLI + existing web
  single-session behavior never regress — pin that paired control in every
  phase.
- Adversarial axes per phase: two tabs on one hosted thread (fan-out — the
  transport already broadcasts, verify), attach to a closing session, garbage
  threadId (clean empty, never 500), snapshot-first join (CLI handshake
  parity), cost/follower isolation between sessions (no cross-talk).

## Alternative considered — runtime-per-thread (avoids Phase A)

`createRuntimeFromAgentConfigBase({ history, … })` ALREADY accepts a `history`
seed at *runtime* construction (`runtime-factory.ts` passes
`history: [...base.messages]`). So a daemon could host one RUNTIME per thread
(each built with that thread's persisted messages) instead of extending
`RuntimeSessionConfig` with a per-session seed. Rejected as the primary path:
a runtime re-runs the WHOLE composition (MCP load, tool registry, observability
wiring) per thread — heavy and duplicative. The session-per-thread path (Phase
A seed, runtime shared) is lighter and is the plan of record. Keep runtime-
per-thread as the fallback if Phase A's kernel-transcript seeding proves too
invasive.

## Scope reality (jul-11)

Phase A is the keystone AND the deepest cut: `RuntimeSessionConfig.history`
must thread `createSessionHost(config)` → the surface factory → the
`@/kernel/session` `SessionHost` initial transcript. That is the shared
session-creation pipeline every surface (CLI/headless/bench/web) rides, so it
needs a paired-control byte-identity pin for the default-absent path before any
daemon work. This is a dedicated-session change; do NOT half-land it (a broken
seed path breaks every session). Start here next session.

## Out of scope (documented)
- Multi-TENANT auth (per-thread ACL): `fetch-handler.ts:194` — the bearer token
  IS the ownership boundary on a single-tenant daemon; a future multi-user
  daemon gates `threadId` against caller identity at that seam. Not this work.
