# RFC — per-tool `interruptBehavior` (cancel | block)

**Date:** 2026-06-06
**Status:** Design (NOT implementation). This doc proposes a seam; it ships no code.
**Slice:** `@/tool` (the `Tool` / `ToolCore` contract in `src/tool/types.ts`) + the
abort routing in `@/agent` (`streaming-dispatch.ts` / `dispatch.ts`) + a StatusBar/event
signal. No new slice — one optional method on the tool contract + a read site in dispatch.
**Default posture:** OFF, byte-identical. A tool that does not implement
`interruptBehavior()` is treated EXACTLY as today (uniform turn-level cancel) — no method,
no behavior change, no event emitted.

> Scope note: SOTA++ design grounded in (a) quanta's existing **uniform** abort model
> (`AbortSignal` gated between phases, threaded into `ctx.signal`) and (b) the gap that an
> atomic mutating tool (`write`/`edit`) has no way to say "do not tear me down mid-apply"
> — an ESC that lands inside the FS-write window today can leave a half-written file.

---

## 1. 요약 (Summary)

Interrupts in quanta are **uniform and turn-level**: one `AbortSignal` gates the loop
between streaming phases and is threaded into every tool's `ctx.signal`. There is **no
per-tool policy** — a cancellable `read`/`grep` and an atomic `write`/`edit` are aborted
the same way. For a read this is correct (drop it, no harm). For an atomic apply this is a
**half-applied-file hazard**: an ESC that arrives after the temp buffer is opened but
before the rename/flush completes can leave a truncated or partial file on disk.

This RFC adds an **optional, default-absent** method to the `Tool` contract:

```ts
interruptBehavior?(): "cancel" | "block"
```

- **`"cancel"`** (the implied default for every tool today) — the abort propagates into
  `ctx.signal` immediately; the tool is expected to bail. Byte-identical to current behavior.
- **`"block"`** — the dispatch layer **withholds** the abort from `ctx.signal` while the
  tool is in its **critical section** (the FS-mutating window), letting the atomic op
  finish, THEN honors the abort at the next phase boundary. A `write` that is 2ms from
  `rename()` finishes the rename; the turn still aborts immediately after.

The signal is surfaced to the operator: when an ESC is **deferred** because a `block` tool
is mid-apply, a StatusBar/event line ("finishing atomic write before interrupting…") makes
the brief pause legible instead of looking like a hung ESC.

What it deliberately is NOT: a way for a tool to **veto** an interrupt forever, a long-running
hold, or a new control op. `block` defers the abort across a **bounded** critical section
only (a watchdog cap, §4.3); it can never swallow a cancel.

---

## 2. 경쟁사 레퍼런스 (Competitor reference)

- **Claude Code / Codex** both model interrupts as a single ESC → cancel-current-turn; the
  novelty here is **per-tool granularity**, which neither exposes as a tool-level declaration.
  The closest analogue is the OS-level distinction between an interruptible syscall and one
  that runs to a safe point — the design borrows that "critical section" framing, not a
  competitor field.
- **The relevant prior art is internal**: quanta already distinguishes
  `isReadOnly()` / `isConcurrencySafe(input)` as per-tool **predicates** on the same
  `ToolCore` contract (`src/tool/types.ts:984-989`). `interruptBehavior()` is a third
  predicate of the same family — a tool self-describing a property the scheduler consumes.
  It rides the exact same "optional method on `Tool`, read by dispatch" seam.

So this is **honest SOTA++ from first principles + quanta's own predicate pattern**, not a
copy of a competitor RPC.

---

## 3. 현재 quanta 상태 (grep-verified, cite file:line)

### 3.1 The abort model is uniform and phase-gated (no per-tool policy)

- `streamingTurn` checks `isAborted(signal)` at **every phase boundary**
  (`src/agent/streaming-dispatch.ts:559,564,584,597,601`) but the file header states the
  contract verbatim: it "does NOT pass `signal` into the injected `dispatch(call)`. The
  caller … is responsible for threading `config.signal` into `ctx.signal` … tools that may
  run long (`bash` / `test_runner`) listen on it themselves" (`streaming-dispatch.ts:531-540`).
- So **the abort reaches a tool already executing via its `ctx.signal`** — directly, with
  no per-tool gate (`streaming-dispatch.ts:537-539`). There is exactly one policy for all
  tools.
- `ToolContext` exposes `signal` as the mandatory half of the contract pair
  (`src/tool/types.ts:103`, "The mandatory pair (`cwd`, `signal`)"), and the per-request
  abort signal "chained from the tool's `ctx.signal`" (`src/tool/types.ts:663`).

### 3.2 `ToolCore` already has per-tool predicates — the seam this rides

`src/tool/types.ts:982-991`:

```ts
export interface ToolCore<I = unknown> {
  name: string
  description: string
  inputSchema: z.ZodType<I>
  isReadOnly(): boolean
  isConcurrencySafe(input: I): boolean       // ← per-tool scheduler predicate
  execute(input: I, ctx: ToolContext): AsyncIterable<ToolEvent>
}
```

`isConcurrencySafe` is the precedent: a per-tool method the **scheduler** reads to decide
overlap. `interruptBehavior()` is the per-tool method the **abort router** reads to decide
withhold-vs-propagate. (`Tool = ToolCore & Partial<ToolSecurityHooks> & …`,
`src/tool/types.ts:972-975` — optional methods are the established extension shape.)

### 3.3 The half-apply hazard is real

`write`/`edit` are atomic-intent tools (`src/tool/write/index.ts`, `src/tool/edit/index.ts`)
that already opt into `hitlTier: () => "pre-approval-ok"` because they mutate
(`src/tool/types.ts:1010-1018`). But **nothing protects their FS-mutating window from an
abort** — the uniform `ctx.signal` can fire mid-`execute`. There is no `interruptBehavior`,
`criticalSection`, or "block ESC" anywhere: `grep -rn "interruptBehavior\|criticalSection"
src/tool` → 0 hits. This RFC closes that gap.

---

## 4. 설계 (Design — closed-port DI)

### 4.1 The contract addition (one optional method)

```ts
// src/tool/types.ts — on ToolCore (or as a 4th Partial arm, see §4.4)
/** How an in-flight interrupt is handled while THIS tool's `execute` runs.
 *  Absent ⇒ "cancel" (legacy uniform behavior, byte-identical).
 *  "block" ⇒ the abort is withheld from `ctx.signal` ONLY while the tool is
 *  inside a declared critical section (see `ctx.beginCriticalSection`). */
interruptBehavior?(): "cancel" | "block"
```

Default absence ⇒ `"cancel"`. `read`/`grep`/`glob`/`ls`/`bash` keep returning nothing
(or `"cancel"`); only `write`/`edit` (and future atomic appliers) return `"block"`.

### 4.2 Critical-section gating (injected, not ambient)

`"block"` must NOT mean "ignore abort for the whole `execute`" — a tool that streams for 30s
then writes at the end would freeze ESC the whole time. So the **scope** is an explicit,
bounded critical section, marked by the tool via a new **injected** duck-typed seam on
`ToolContext` (closed-port DI — `@/tool` declares the shape, `@/agent` provides the impl):

```ts
// ToolContext — new optional seam (mirror type; @/tool imports nothing from @/agent)
readonly criticalSection?: {
  /** Enter: the abort router withholds the signal from THIS tool until exit.
   *  Returns a disposable; `using` / try-finally guarantees exit. */
  begin(): { end(): void }
}
```

A `block` `write` wraps **only** its rename/flush window:

```ts
const cs = ctx.criticalSection?.begin()
try { await fs.rename(tmp, target) } finally { cs?.end() }
```

Absent seam (test doubles, surfaces that didn't wire it) ⇒ `begin?.()` is undefined ⇒
behaves as `"cancel"` ⇒ byte-identical.

### 4.3 Abort-path routing (where the withhold happens)

The composition root (the agent loop's `dispatch` binding that today threads
`config.signal` into `ctx.signal`, `streaming-dispatch.ts:533-536`) wraps the propagation:

1. When the loop builds `ctx.signal` for a tool whose `interruptBehavior?.() === "block"`,
   it threads a **derived** signal that is *suppressible*: an inner `AbortController` that
   normally mirrors `config.signal`, but pauses mirroring while a critical section is open.
2. `criticalSection.begin()` flips a per-call "withholding" flag; `end()` clears it and, if
   `config.signal` aborted while withheld, **immediately** aborts the derived signal (so the
   tool's very next `signal.aborted` check post-rename sees the abort).
3. **Watchdog cap (safety):** a critical section auto-expires after a bounded
   `CRITICAL_SECTION_MAX_MS` (injected via runtime-config knob, default e.g. one rename
   budget); on expiry the withheld abort is force-delivered. `block` can defer a cancel for
   at most one bounded window — it can NEVER swallow it. The clock is **injected**
   (`ctx`/runtime-config), no `Date.now()` in the tool slice.

The phase-boundary checks in `streamingTurn` (§3.1) are unchanged: between phases the loop
still sees `config.signal`; only the *intra-tool* delivery for `block` tools is gated.

### 4.4 Where the method lives — `ToolCore` vs a 4th Partial arm

Two equally clean options; the RFC recommends a **new `Partial` arm**
(`ToolInterruptPolicy`) joined into the `Tool` union (`src/tool/types.ts:972-975`) rather
than a required `ToolCore` member — that keeps `ToolCore` (the "every tool implements,
no `?.`" surface, `:982-991`) untouched and makes the method **optional by construction**,
exactly like `ToolSecurityHooks`. Dispatch reads it as `tool.interruptBehavior?.() ??
"cancel"`.

---

## 5. 통합 (Integration)

- **Knob (default-OFF):** `QUANTA_TOOL_INTERRUPT_BLOCK` (boolean, default unset ⇒ feature
  inert: dispatch ignores `interruptBehavior()` and threads the raw `config.signal` as
  today — byte-identical). Registered in the knob registry + `help-render.ts`. A second
  numeric knob `QUANTA_CRITICAL_SECTION_MAX_MS` feeds the §4.3 watchdog via runtime-config
  (no literal in the tool slice).
- **Tool wiring:** `write`/`edit` gain `interruptBehavior: () => "block"` and wrap their
  rename/flush in `ctx.criticalSection?.begin()`. Every other tool is untouched
  (absent ⇒ `"cancel"`).
- **Manifest/hook:** no new tool, no manifest row, no new hook event — this is a *property*
  of existing tools, not a new surface. (Contrast `pty-attach`, which needed a manifest row.)
- **StatusBar / event:** a new `ToolEvent` variant (or a `stream.emit` status line) —
  `{ kind: "interrupt_deferred", tool, reason }` — emitted when an ESC is withheld because a
  `block` tool is mid-section, and a paired `interrupt_honored` on `end()`. The CLI
  StatusBar (`src/apps/cli/status-bar.ts` / `status-pills.ts`) renders a one-line
  "finishing atomic write before interrupting…" so the operator sees WHY ESC paused. Absent
  subscriber ⇒ no-op.
- **fc:** one feature-catalog node `tool-interrupt-behavior` on the tool-contract axis;
  wire reachability so the predicate → dispatch read → event path is seen by the
  reachability lint.
- **Fence:** `@/tool` declares the `criticalSection` mirror type but imports **nothing** from
  `@/agent` (duck-typed seam, same rule as every `ToolContext` field, `src/tool/types.ts:9-21`).
  The real `criticalSection` impl is built at the composition root in `@/agent`.

---

## 6. 테스트 계획 (Hellgate + e2e)

New `tests/unit/tool-interrupt-behavior-hellgate.test.ts`:

1. **Default absent ⇒ cancel, byte-identical.** A tool with no `interruptBehavior` gets the
   raw `config.signal`; aborting mid-execute aborts it now. Assert identical to a baseline
   run with the feature knob unset.
2. **`block` defers across the section ONLY.** A fake `write` enters a critical section,
   abort fires *during* it; assert `ctx.signal.aborted === false` inside the section and
   `=== true` immediately after `end()`. The rename completes; the file is whole.
3. **`block` outside the section is still cancellable.** Abort BEFORE `begin()` or AFTER
   `end()` is honored immediately (no withhold) — `block` is not a turn-wide hold.
4. **Watchdog cap (can't swallow).** A pathological tool opens a section and never ends it;
   assert the withheld abort is force-delivered after `CRITICAL_SECTION_MAX_MS` (injected
   fake clock, deterministic) — a `block` tool can never permanently swallow a cancel.
5. **Half-apply prevention (the headline).** Fault-inject an abort 1 tick before
   `fs.rename` in a `block` write; assert the on-disk file is either fully old or fully new,
   never truncated. Repeat for a `cancel` write and assert (documenting) that the uniform
   path *can* tear mid-write — proving the feature's value.
6. **Event signal.** `block` mid-section abort emits exactly one `interrupt_deferred` then
   one `interrupt_honored`; a `cancel` tool emits neither. Absent subscriber ⇒ no throw.
7. **Phase-boundary unchanged.** `streamingTurn`'s between-phase `isAborted(signal)` checks
   see `config.signal` regardless of any tool's section state (the gate is intra-tool only).

e2e: a real `write` of a large file with an ESC scripted into the rename window
(`QUANTA_TOOL_INTERRUPT_BLOCK=1`) → file intact + turn aborted; same with the knob unset →
documents the legacy tear.

---

## 7. 단계 (Phases)

- **Phase 1 (core):** the `ToolInterruptPolicy` Partial arm + `ctx.criticalSection` mirror
  seam + dispatch withhold routing + watchdog + `QUANTA_TOOL_INTERRUPT_BLOCK` knob. Hellgate
  1–4,7. Default-OFF.
- **Phase 2 (apply tools + signal):** `write`/`edit` declare `"block"` + wrap their
  rename/flush; the `interrupt_deferred`/`interrupt_honored` events + StatusBar line; fc
  entry. Hellgate 5–6.
- **Phase 3 (optional):** extend to `apply_patch` / `scripted_replace` / any future
  multi-file atomic applier; consider a `mode:"all-or-none"` group section spanning a
  multi-file patch. Backlog.

---

## 8. 리스크 / 대안 (Risks & alternatives)

- **R1 — `block` becomes a hang.** A buggy tool that never exits its section would freeze
  ESC. *Mitigation:* the §4.3 watchdog force-delivers after a bounded, injected cap; the
  section scope is the rename/flush window only (not the whole `execute`). Hellgate 4 locks
  this. `block` defers, never vetoes.
- **R2 — byte-identity.** The whole feature is inert when the knob is unset OR the tool omits
  `interruptBehavior` OR the `criticalSection` seam is unwired — three independent OFF gates.
  The default path threads the raw `config.signal` exactly as `streaming-dispatch.ts:533-536`
  does today.
- **R3 — race between `end()` and a between-phase abort.** The withhold is per-call and
  per-section; `end()` synchronously re-checks `config.signal` and aborts the derived signal
  before returning, so no abort is lost. Phase-boundary checks read `config.signal` directly
  (§3.1) and are never gated.
- **Alternative — make it ambient (a global "atomic region" stack).** Rejected: ambient
  state across concurrent dispatches (`isConcurrencySafe` overlap) would let one tool's
  section gate another's abort. The per-call derived-signal model keeps each dispatch's abort
  routing independent (mirrors the "independent admissibility-gate state" invariant,
  `dispatch.ts` concurrency note).
- **Alternative — do nothing (rely on FS atomicity).** quanta's writers may already
  temp-file + rename, but the *abort* can still fire between buffer-open and rename, and
  `edit`'s in-place strategies are not all rename-atomic. The seam makes the intent explicit
  and testable rather than relying on every writer's incidental atomicity.

---

## 9. 코드 위치 요약 (Code-location summary)

**Audited (read, grounds the design):**
- `src/tool/types.ts:103,663` — `ToolContext` mandatory `(cwd, signal)` pair + chained abort.
- `src/tool/types.ts:982-991` — `ToolCore` predicates (`isReadOnly`/`isConcurrencySafe`) — the
  per-tool-method precedent.
- `src/tool/types.ts:972-975` — `Tool = ToolCore & Partial<…>` union (the optional-arm shape).
- `src/agent/streaming-dispatch.ts:531-540` — the verbatim abort contract (signal not passed
  into `dispatch`; threaded into `ctx.signal`; reaches in-flight tools directly).
- `src/agent/streaming-dispatch.ts:559,564,584,597,601` — phase-boundary `isAborted` checks
  (unchanged by this RFC).
- `src/tool/write/index.ts`, `src/tool/edit/index.ts` — the atomic-apply tools that opt into
  `"block"`.

**To add (implementation, NOT in this RFC):**
- `src/tool/types.ts` — `ToolInterruptPolicy` Partial arm + `ctx.criticalSection` mirror seam.
- `src/agent/streaming-dispatch.ts` / the loop's `dispatch` binding — withhold routing +
  watchdog (clock injected).
- `src/tool/write`, `src/tool/edit` — `interruptBehavior: () => "block"` + section wrap.
- `src/apps/cli/status-bar.ts` / `status-pills.ts` — the deferred/honored status line.
- `src/runner/knobs/…` + `help-render.ts` — `QUANTA_TOOL_INTERRUPT_BLOCK` +
  `QUANTA_CRITICAL_SECTION_MAX_MS`.
- `tools/feature-catalog/…` — `tool-interrupt-behavior` node.
- `tests/unit/tool-interrupt-behavior-hellgate.test.ts` — the §6 battery.
