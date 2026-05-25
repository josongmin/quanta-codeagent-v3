# ADR-0250: Inline-trigger wiring — Aider-style source-comment dispatch primitive

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0203 (playbook frontmatter — defines `trigger.comment-marker`
  but the watcher wired by ADR-0203 is per-playbook-spec; THIS slice ships the
  generic primitive ANY host can reuse), ADR-0240 (playbook auto-dispatch + inline-trigger
  dispatch completion — consumes the sibling watcher, not this slice yet),
  Aider `// fix this AI!` source-comment dispatch pattern.
- **References**:
  `src/skill/playbook/trigger/port.ts` (closed `InlineTriggerWatcher` port +
  `Subscription { unsubscribe }` handle + `WatchResult` typed-failure shape),
  `src/skill/playbook/trigger/types.ts` (`TriggerEvent { file, marker, line }`,
  `TriggerError` discriminated union, `DEFAULT_DEBOUNCE_MS`),
  `src/skill/playbook/trigger/comment-scanner.ts` (pure `scanFile` + 1-based
  `findMarkerLine`),
  `src/skill/playbook/trigger/debouncer.ts` (pure per-key debouncer with
  `cancelAll` for the no-leak invariant),
  `src/skill/playbook/trigger/fs-watch-adapter.ts` (Node `fs.watch` adapter —
  chokidar deliberately rejected because the install is blocked in this
  environment, see `verify-workflow` memory),
  `src/skill/playbook/trigger/headless-stub.ts` (deterministic in-memory
  adapter for tests + headless CI rigs),
  `src/skill/playbook/trigger/index.ts` (barrel — re-exports the closed port,
  both adapters, the pure helpers, and the public types).
  Hellgate: `tests/unit/skill/playbook/inline-trigger-hellgate.test.ts`
  (15 cases).

## Context

ADR-0203 introduced the playbook frontmatter slot `trigger.comment-marker`
(plus `trigger.watch-glob`). The accompanying watcher
(`src/skill/playbook/inline-trigger-watcher.ts`) implemented the per-playbook
binding: one root, one glob, one marker, callback bound at start time. It is
the right shape for `auto-dispatch` (ADR-0240) — the playbook-watcher fans out
one watcher per registered playbook with its own glob.

What we did NOT have was the **primitive**: a single watcher that takes a list
of roots and a list of markers and emits a typed event per (file, marker)
hit. Hosts beyond `auto-dispatch` want this primitive directly:

  - status flash that wants to surface `// TODO!` lines for the LLM,
  - the REPL session-loop that wants to react to `// QUANTA!` saves,
  - the side-conversation runner that wants to honor `// CLAUDE!` while a
    background turn is in flight,

without each of them re-inventing fs.watch + debounce + UTF-8 binary skip +
typed-failure handling. The sibling ADR-0203 watcher cannot be re-purposed for
this because its lifetime / glob semantics are bound to a playbook spec
(playbook id, frontmatter trigger config, per-playbook callback).

This ADR ships the slice primitive (closed port + production adapter +
debouncer + scanner + deterministic test stub + 15-case hellgate). Wiring
into a tool / status-flash / REPL / side-conv host is **deliberately
deferred** — the catalog entry records the hold under the helper-only
deferred-wire idiom the project uses for primitives that land before any
consumer is ready.

## Decision

### Slice layout

```
src/skill/playbook/trigger/
  port.ts              — InlineTriggerWatcher + Subscription + WatchResult
  types.ts             — TriggerEvent, TriggerError, DEFAULT_DEBOUNCE_MS
  comment-scanner.ts   — pure scanFile(file, content, markers): TriggerEvent[]
  debouncer.ts         — pure per-key debouncer with cancelAll()
  fs-watch-adapter.ts  — node:fs.watch adapter (production)
  headless-stub.ts     — deterministic in-memory adapter (tests)
  index.ts             — barrel
```

### Port (`port.ts`)

```ts
export interface InlineTriggerWatcher {
  readonly watch: (
    roots: readonly string[],
    markers: readonly string[],
    callback: TriggerCallback,
    debounceMs?: number,
  ) => WatchResult
}

export type WatchResult =
  | { readonly ok: true; readonly subscription: Subscription }
  | { readonly ok: false; readonly error: TriggerError }

export interface Subscription {
  readonly unsubscribe: () => void
}
```

The port has ONE method. Keeping it minimal is intentional — every additional
method is one more thing test rigs must mock. Both adapters implement this
shape and nothing more.

### Types (`types.ts`)

```ts
export interface TriggerEvent {
  readonly file: string   // absolute path
  readonly marker: string // literal substring that matched
  readonly line: number   // 1-based line number
}

export type TriggerError =
  | { kind: "root-missing"; root: string }
  | { kind: "watch-failed"; root: string; detail: string }
  | { kind: "unsupported-encoding"; file: string }

export const DEFAULT_DEBOUNCE_MS = 100
```

`unsupported-encoding` is part of the typed surface for forward-compatibility
but the current fs adapter drops binary files silently in the hot-path
(HELL-IT-11) rather than surfacing them — emitting one event per binary save
would be too noisy. A future host that wants the signal can wrap the callback.

### Production adapter (`fs-watch-adapter.ts`)

- `node:fs.watch(root, { recursive: true })` per root.
- Pre-validates every root via `existsSync` + `statSync`. Any failure yields
  `{ ok: false, error: { kind: "root-missing", root } }` BEFORE any watcher is
  installed — guarantees no leaked file handles on partial-failure.
- `fs.watch` throw becomes `{ kind: "watch-failed", root, detail }`. Detail
  carries the OS-level error message.
- Per-event flow: `change`/`rename` → resolve to absolute path → debounce
  on absPath → read UTF-8 → NUL-byte binary check → `scanFile` → callback
  per event. All stopped-checks interleave around awaits.
- `unsubscribe()` closes every `FSWatcher`, cancels every pending debounce
  timer. Idempotent.

### Headless stub (`headless-stub.ts`)

- Same port shape.
- `fire(file, content)` simulates a saved file; per active sub, runs the
  same scanner + debouncer pipeline.
- Roots prefixed with `/missing/` are rejected as `root-missing` — that lets
  tests assert the parity branch without `existsSync` calls.
- `activeCount()` + `pendingCount()` exposed for test introspection / leak
  checks. Default-OFF: zero side effects on construction (HELL-IT-12).

### Pure helpers

- `scanFile(file, content, markers)` — returns one event per marker hit, in
  the order markers appear in the input list (stable priority for downstream
  routing). Empty markers and duplicates are skipped. The 1-based `line` is
  the line where the marker FIRST appears.
- `createDebouncer(ms)` — per-key debouncer. `schedule(key, action)`
  supersedes any prior pending action for the same key. `cancelAll()`
  clears every pending timer (required for `unsubscribe` no-leak).
  `pendingCount()` for test introspection.

### Hellgate — 15 cases

```
HELL-IT-01..04  scan AIDER!/CLAUDE!/QUANTA!/TODO! markers
HELL-IT-05      no marker / empty marker / duplicate markers
HELL-IT-06      multi-line scan: 1-based line, not byte offset
HELL-IT-07      debounce: two same-key schedules within window ⇒ 1 fire
HELL-IT-08      unsubscribe before debounce flush ⇒ NO callback
HELL-IT-09      fs.watch failure ⇒ typed ok:false (root-missing OR watch-failed)
HELL-IT-10      missing root ⇒ ok:false / root-missing
HELL-IT-11      binary file (NUL byte) ⇒ silently dropped
HELL-IT-12      default-OFF byte-identical (construct ≠ side effect)
HELL-IT-13      headless stub is deterministic + parity-equivalent
HELL-IT-14      1000-file scan < 1s (pure scanner sanity)
HELL-IT-15      unsubscribe clears the debouncer (no timer leak)
```

## Consequences

**Positive**

- The smallest reusable primitive for inline-trigger lands as a closed port
  with one production and one deterministic adapter — same shape every
  other quanta runtime slice uses (`src/runtime/shell-snapshot/`,
  `src/runtime/node-repl/`), which keeps the audit reflex transferable.
- Hosts beyond `auto-dispatch` can now adopt the inline-trigger pattern
  without re-implementing fs.watch + debounce + UTF-8 + typed-failure
  handling.
- The fs.watch → chokidar swap remains a one-file body change — port
  surface unchanged. If installs unblock and chokidar lands, only
  `fs-watch-adapter.ts` is touched.

**Negative / accepted trade-offs**

- The slice is shipped **default-OFF**. No tool / status-flash / REPL / side-conv
  host consumes it yet — the catalog entry records the deliberate hold.
  This is intentional per RFC §1.2 — byte-identical landing first,
  feature wiring later. A future ADR will wire the primitive into the
  status flash and the REPL (the two highest-ROI hosts identified during
  the .extracted_source audit).
- The sibling `inline-trigger-watcher.ts` (ADR-0203) is NOT migrated to
  consume this primitive. The reason: the ADR-0203 watcher's per-spec
  callback shape + per-spec debounce window do not map cleanly onto the
  list-of-roots / list-of-markers / single-callback port here. A future
  ADR may unify them; for now they coexist as sibling slices behind the
  same barrel (`src/skill/playbook/index.ts` re-exports both — see
  ADR-0203 for the sibling, ADR-0250 for the primitive).
- The fs adapter uses a single shared debouncer per `watch()` call —
  meaning fires across DIFFERENT files debounce independently (correct)
  but fires from DIFFERENT call sites on the SAME file (rare in
  practice) do not coalesce across `watch()` calls. Documented; the
  next ADR can swap to a module-global debouncer if a host needs it.

## Rejected alternatives

- **Use `chokidar` instead of `node:fs.watch`.** Strictly better semantics
  (debounced rename storms, glob handling, stable cross-OS events), but
  the install is blocked in this environment. The port shape is
  unchanged so the swap is a one-file diff if the constraint lifts.
- **Make the sibling ADR-0203 watcher the only entry point.** Its
  per-spec API does not generalize to the "any root × any marker"
  primitive hosts beyond `auto-dispatch` need. Forcing them to
  fabricate a synthetic playbook spec just to subscribe is the wrong
  trade-off.
- **Default-ON wiring into a tool / status-flash this round.** Violates
  RFC §1.2 byte-identical landing. The primitive ships first; a
  follow-up ADR adds the host wiring once the ROI story is concrete.
