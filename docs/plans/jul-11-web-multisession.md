# P1 — Web daemon: make ANY thread live (swap model)

**Status:** plan re-derived jul-11 after an adversarial audit killed the first
draft (below). The LAST jul-9 bugbash backlog item.

## What the audit killed (first draft was 짜친/over-engineered)

The original 4-phase plan (add `RuntimeSessionConfig.history` → daemon N-session
factory → WS routing → frontend) was WRONG on two counts, both code-verified:

1. **Phase A's premise was false.** `session.transcript.replace`
   (`sdk/runtime/session.ts:91`, kernel `reducer.ts:162`) ALREADY seeds a live
   session's transcript. The CLI's `/fork` + `--resume` already do "make ANY
   thread live" this way (`session-loop.ts:511,534`; `session-switch.ts:73`
   `performSessionSwitch` = load thread messages → `transcript.replace` → in-place
   persist-id repoint). No new `RuntimeSessionConfig.history` field is needed.
2. **N-concurrent-session hosting is unnecessary AND buggy.** One human operator
   opening a thread in the web UI needs ONE live session that swaps, not N. And
   the daemon's config-level ports are explicitly SHARED across connections
   (`ws-handlers.ts:280` userInputPorts, controlRequestPorts, followerCoControl,
   observability/canvas/agentState) — replicating N sessions with one shared
   input/control port is a cross-talk bug the 4-phase plan never accounted for.
   The swap model keeps ONE session ⇒ those ports stay correctly singleton.

## The one keystone the audit itself under-weighted

The swap needs a **lossless `Message[]` source** for `transcript.replace`, and
the daemon does not have one:

- `session-registry.ts:42` keys by WS object, `entry.session` is shared — no
  per-thread session (confirmed: no phase pre-built).
- The daemon persists **`SessionEvent[]`** to sqlite (`server/persistence.ts`,
  `persistence-sqlite.ts`), NOT `Message[]`.
- Those events are a **UI archive, lossy**: `turn.started.prompt` and
  `turn.completed.assistantText` are whole, but `tool.invoked.argsPreview` /
  `tool.completed.resultPreview` are **~256-char truncated** ("full args live in
  the artifact / session log" — `events.ts:108-131`). Reconstructing `Message[]`
  from events would feed the resumed model a transcript with truncated tool
  calls — a DISHONEST resume.
- No `SessionEvent[] → Message[]` reconstructor exists; the kernel reducer does
  NOT replay events into `state.messages` (it takes `command.messages` directly,
  `reducer.ts:166`); the frontend renders events for display only.

**Conclusion:** the honest swap needs the daemon to persist a lossless
`Message[]` transcript, exactly like the CLI's `@/session` SavedSession store
(`loadSessionById` → `SavedSession.messages`), which the CLI's own
`performSessionSwitch` consumes. events-reconstruction is rejected (lossy).

## Plan of record — swap model, lossless

### Phase 0 — a lossless `Message[]` READ seam (sub-keystone, verified jul-11)
The session facade's `transcript` is **write-only** (`replace`, `session.ts:91`);
`box.state.messages` is internal (only `side.start` reads it, `:103`). There is
NO public messages getter — so the daemon cannot even READ the live transcript
to persist it. RESOLVED (jul-11): option (a) — capture
`SessionDispatchResult.turn.messages` at the daemon — is REJECTED: `ws-handlers`
is a transport bridge (it `subscribe`s to event sources and relays frames), so
the daemon SERVER never receives the `turn.run` return value; it crosses the
transport to the client. So use option (b): add a `session.transcript.messages`
READ getter (`sdk/runtime/session.ts:91` + `types.ts:110`) returning
`[...box.state.messages]` — the clean symmetric read to the existing write-only
`replace`. The daemon reads it when it observes `turn.completed`.
- **Hellgate:** `session.transcript.messages` returns the exact live `Message[]`
  (tool calls intact, no 256-char preview truncation); byte-identical read.

### Phase 1 — daemon persists a lossless transcript (the real keystone)
- Persist that `Message[]` to the `@/session` SavedSession store (the CLI's
  store) via `saveSessionById(meta, {reason, turns, messages})`, keyed by the
  daemon's session/thread id, driven off the turn seam Phase 0 taps. Keep the
  sqlite `SessionEvent[]` UI archive as-is (it serves read-only history + the
  transcript UI). Gate-symmetric with `QUANTA_WEB_DB`.
- **Hellgate:** a completed daemon turn writes a SavedSession whose
  `loadSessionById(id).messages` round-trips the live transcript (no tool-call
  truncation). Gate OFF ⇒ byte-identical.

### Phase 2 — swap-on-attach
- WS upgrade / `fetch-handler.ts:206` reads `?thread=<id>`. On attach:
  `loadSessionById(id)` → `sharedSession.transcript.replace(saved.messages)`
  (reuse the existing `transcript_replace_unavailable` mid-turn guard) → repoint
  the append id so future persist writes under the swapped thread (the same
  in-place `SessionMeta` repoint `performSessionSwitch` does — the daemon's
  `setupThreadPersistence` currently hard-binds `sharedSession.sessionId`
  (`persistence.ts:24`); make its append id follow a mutable active-thread cell).
- Unknown / never-persisted id ⇒ clean empty (no crash), stays read-only.
- **Hellgate:** attach with a persisted thread id ⇒ live session hydrated from
  that thread's SavedSession, composer active; parent thread on disk untouched.

### Phase 3 — frontend live-join — LANDED (jul-11)
- **3a (client seam, `ws/client.ts`):** `#withThreadQuery` (symmetric to
  `#withAuthQuery`) rides `ConnectOptions.resumeThreadId` onto the WS URL as
  `?thread=<id>`, so the daemon's Phase-2 swap-on-attach fires. Absent ⇒
  byte-identical connect. Corrected the stale `resumeThreadId` doc.
- **3b (`App.tsx` resume effect):** opening a persisted thread now RE-DIALS the
  WS with `resumeThreadId` (`buildResumeConnectOptions`, a pure tested seam) so
  the daemon swaps its one live session onto the thread — model continuity (the
  NEXT turn continues the thread's kernel transcript) + a real live-attach
  boundary. The existing REST hydration still RENDERS the thread, because
  `transcript.replace` emits only a `session.state.updated` summary, NOT the
  per-message events the UI draws (verified `reducer.ts:162-194`).
- Boundary flows from the server-computed REST outcome, so pre-Phase-1 threads
  (no SavedSession ⇒ swap can't hydrate) honestly stay `read-only-history`.
- **Hellgate:** `buildResumeConnectOptions` carries the thread id + rides auth
  only with a token (paired byte-identity control); client seam pins
  `?thread` append + encode + compose-with-`?token`.

### Scoped follow-up (NOT this backlog item — the multi-tenant piece)
The daemon's client-facing `SessionEvent[]` archive
(`persistence-sqlite.ts` + the bridge's `attachSessionTransport` replay) is NOT
repointed on swap. So the re-dial's reconnect snapshot still replays the
*original* live session's turn/tool events; when the daemon had prior in-process
activity, those can surface alongside the swapped thread's REST-rendered
transcript. A fully-clean cross-session RENDER needs a daemon-side archive
repoint-on-swap — which is the true N-concurrent / multi-tenant surface the plan
scoped out (§Semantics). What the swap model delivers here is the load-bearing
capability: any persisted thread can BECOME the one live session (model
continuity) with an honest boundary.

## Semantics (honest)
One human, one live session that swaps — like the CLI's `/fork`. All tabs share
the one session, so a swap is daemon-wide (opening thread B moves everyone to B).
That is the correct model for a single-operator daemon and sidesteps the
shared-port cross-talk N-session would hit. True N-concurrent live threads is a
multi-TENANT feature (per-thread ACL at `fetch-handler.ts:194`) — out of scope.

## Riskiest step
Phase 2's persist-id repoint without clobbering the parent thread — but
`performSessionSwitch`'s in-place `SessionMeta` repoint already solves exactly
this; port its pattern (the CLI file is apps/cli-sliced, so re-implement the
tiny in-place mutation daemon-side, don't import it).
