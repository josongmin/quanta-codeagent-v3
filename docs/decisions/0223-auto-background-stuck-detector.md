# ADR-0223: Auto-background after 2 s — stuck-detector + propose-handler

- **Status**: Accepted
- **Date**: 2026-05-25
- **Renumbered**: from initially-drafted ADR-0221 (3-way collision: the
  parallel `0221-git-directive-emit-protocol.md` slice + `0222-otel-emit-
  new-slices.md` appeared after stash-pop revealed cherry-pick-in-progress
  parallel work). Per ADR-collision policy (memory
  `adr-collision-policy-2026-05-25`): user/parallel keep originals; ours
  bumps to next-free (0223).
- **Related ADRs**: ADR-0130 (background subagent fork/poll/await — the
  EXECUTOR this slice's prompt feeds into), ADR-0140 (background-subagent
  caller wire — sibling pattern: helper lands first, wire seam closes
  later), ADR-0166 (conversation-seed replay — separate background concern)
- **References**: `src/agent/auto-background/**`,
  `tests/unit/auto-background-stuck-detector-hellgate.test.ts`,
  `src/agent/dispatch.ts` (two-line tick wire)

## Research grounding

Per `docs/analysis/경쟁사리뷰/`: Claude Code's UX surfaces a one-shot
"move to background?" prompt when a long-running tool exec sits >2 s with
no progress. One keystroke (Esc/Enter) flips the call into the detached
path. The underlying detached run uses a fork/poll/await scheduler — quanta
already ships that scheduler (ADR-0130 `BackgroundSubagentScheduler`
+ ADR-0140 caller wire) but requires an EXPLICIT user `/bg` invocation.

The gap is the AUTOMATIC observer: a tiny stateful primitive that

  1. tracks each tool call's start time,
  2. on a poll-based probe answers "is this past the threshold?",
  3. surfaces a proposal AT MOST ONCE per call (dismiss is sticky), and
  4. is plane-clean enough to slot into `dispatch.ts` with two surgical
     lines and zero default-OFF behaviour delta.

## Context

Four constraints shape the slice:

1. **Default-OFF byte-identical** (RFC §1.2): existing dispatch must stay
   byte-identical when `config.autoBackground?.detector` is absent. The
   wire is two optional-chain calls bracketing `execute()`; when the chain
   short-circuits there is zero allocation, zero new branch, zero
   behaviour delta.
2. **Closed-port DI**: every clock/threshold is injected. Tests drive every
   threshold boundary (`<2s` / `=2s` / `>2s`) under a controlled clock; no
   `setTimeout` / `Date.now` snuck in.
3. **Once-per-id proposal**: a user who said "no" once should not be asked
   again for the same call. Idempotency is the proposer's invariant —
   independent of how often the detector or host polls.
4. **Plane-clean**: the slice imports ZERO `@/*` modules. Its only outward
   edge is the slot type on `AgentConfig.autoBackground?`. Dispatch is the
   ONLY consumer and reads it via `config.autoBackground?.detector?.…`.

## Decision

Add a leaf-level slice at `src/agent/auto-background/`:

| File | Purpose |
|---|---|
| `port.ts` | `StuckDetectorPort` + `ProposeHandlerPort` + `AutoBackgroundConfig` + `DEFAULT_STUCK_THRESHOLD_MS` |
| `stuck-detector.ts` | Pure-functional kernel — `computeStuckProbe` / `normalizeThreshold` / `stuckProbeAbsent` |
| `default-tracker.ts` | `defaultStuckDetector` — `Map<toolCallId, startTimeMs>` impl composing the pure kernel |
| `propose-handler.ts` | `defaultProposeHandler` — once-per-id state machine wrapping the detector |
| `index.ts` | Barrel re-export |

### Port shape (locked)

```ts
interface StuckDetectorPort {
  tickToolStart(input: { toolCallId: string; toolName?: string }): void
  tickToolEnd(input: { toolCallId: string }): void
  isStuck(input: { toolCallId: string; now: number }): StuckProbeResult
  list(): readonly ToolTrackingEntry[]
}

interface StuckProbeResult {
  readonly stuck: boolean
  readonly elapsedMs: number
  readonly threshold: number
}

interface ProposeHandlerPort {
  shouldPropose(input: { toolCallId: string; now: number }): boolean
  accept(input: { toolCallId: string }): void
  dismiss(input: { toolCallId: string }): void
  hasProposed(toolCallId: string): boolean
}
```

### Threshold semantics (locked)

- `stuck = elapsedMs >= threshold` (INCLUSIVE at the boundary — matches the
  UX phrasing "after 2 s"). Pinned by HELL-AB-02.
- Default threshold `2 000` ms (`DEFAULT_STUCK_THRESHOLD_MS`). Knob via
  `AutoBackgroundConfig.thresholdMs`.
- Non-finite / non-positive thresholds coerce to the default
  (`normalizeThreshold`). Closed-port no-throw posture — a host's bad knob
  becomes a safe default, not an exception (HELL-AB-15).

### State machine (proposer)

Three terminal states + the implicit absent fourth:

```
absent → proposed   (shouldPropose returns true exactly once)
absent → accepted   (host called accept directly; tolerated)
proposed → accepted (user said "yes" — move to background)
proposed → dismissed (user said "no" — never re-propose)
```

Every terminal state is absorbing for `shouldPropose` — it returns false
forever after. Pinned by HELL-AB-04 / HELL-AB-05 / HELL-AB-16.

### Dispatch wire (2 lines)

```ts
// Before execute():
config.autoBackground?.detector?.tickToolStart({
  toolCallId: effectiveCall.id, toolName: effectiveCall.name,
})
// After execute() — in a finally so a thrown execute still drops the entry:
config.autoBackground?.detector?.tickToolEnd({ toolCallId: effectiveCall.id })
```

The `tickToolEnd` runs from a `finally` so a throw from `execute()` (which
the outer dispatch catch normalizes to a deny-style result) still drops
the entry — no detector memory leak across thrown tool calls.

### Default-OFF wire

- `AgentConfig.autoBackground?: AutoBackgroundConfig` slot added; absent
  ⇒ both `tickToolStart` and `tickToolEnd` short-circuit at the optional
  chain (zero allocation). Pinned by HELL-AB-07.
- No CLI flag wired in this slice — a follow-up host slice (TUI / Web) is
  responsible for choosing when to show the prompt and how to bind
  `accept`/`dismiss` to a keystroke.

## Hellgate (17 cases)

`tests/unit/auto-background-stuck-detector-hellgate.test.ts` pins:

- **HELL-AB-01** — `<2 s` elapsed ⇒ `stuck:false` (default threshold).
- **HELL-AB-02** — exactly `2 000` ms ⇒ `stuck:true` (boundary inclusive).
- **HELL-AB-03** — `>2 s` elapsed ⇒ `stuck:true`.
- **HELL-AB-04** — dismissed `toolCallId` blocks all future
  `shouldPropose` (even when `isStuck` still true).
- **HELL-AB-05** — `shouldPropose` returns true AT MOST once per id.
- **HELL-AB-06** — distinct `toolCallId`s propose independently.
- **HELL-AB-07** — `undefined` slot ⇒ optional chain no-op (default-OFF).
- **HELL-AB-08** — injected clock drives every decision (`Date.now` not
  consulted).
- **HELL-AB-09** — `tickToolEnd` drops the entry; subsequent `isStuck`
  returns absent zero.
- **HELL-AB-10** — `thresholdMs` knob honored (500 ms tested).
- **HELL-AB-11** — parallel tracking — N tools tracked independently.
- **HELL-AB-12** — 1 000 start→end cycles leave `list()` empty (no leak).
- **HELL-AB-13** — double `tickToolStart` keeps the ORIGINAL `startTimeMs`
  (idempotent; re-arm masked).
- **HELL-AB-14** — `isStuck` on unknown id returns absent zero; double-
  end is a no-op (no throw).
- **HELL-AB-15** — pure helpers: NaN propagates, `normalizeThreshold`
  coerces non-finite / non-positive, `stuckProbeAbsent` shape-stable.
- **HELL-AB-16** — `accept` transitions to terminal — no re-propose after.
- **HELL-AB-17** — proposer survives a throwing detector (defense-in-depth).

## Default-OFF byte-identical

- Verified by HELL-AB-07 — when the slot is absent every dispatch path
  behaves byte-identically to the pre-ADR baseline (optional chain short-
  circuits at the first nullish hop).
- The `try { execute } finally { tickEnd }` reshape preserves the previous
  `const out = await execute(...)` semantics because `let out:
  DispatchResult` is assigned exactly once before the `finally` body runs.
  When the detector is absent, the only behaviour delta is the
  `let`-vs-`const` declaration (no runtime effect; tsc strict-mode safe).

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **`setTimeout` arm-and-disarm timer per call** | Forces every dispatch into the macrotask queue; cancellation requires `clearTimeout` bookkeeping; tests need fake timers (brittle across Bun/Jest variants). The pull-based `isStuck` probe lets the host integrate at its own idle cadence (e.g. existing stream-event tick) with zero new timer infrastructure. |
| **Merge detector + proposer into one port** | Conflates the "math" and the "policy". A host wanting a status-bar nudge (instead of a modal) would have to fork the policy out of the detector. Split lets a host wire only the detector (pay nothing for the proposer's Map). |
| **Re-arm on second `tickToolStart`** | Would mask a long-running tool: a retry wrapper that calls `tickToolStart` twice would reset the clock. Original-time-wins preserves the user-visible "this has been running for N seconds" intuition (HELL-AB-13). |
| **Throw on bad threshold** | Violates the no-throw contract. Coerce to the default and let the host observe via the probe's `threshold` field (HELL-AB-15). |
| **Auto-flip to background without prompting** | Surprising UX — Claude Code's value is the consent moment. A user might prefer to wait. The proposer is the "ask" layer; the actual flip is the host's job using `BackgroundSubagentScheduler.fork()` (ADR-0130). |

## Consequences

- **Default-OFF byte-identical**: dispatch and every existing call path
  unchanged. HELL-AB-07 + manual review of the `try/finally` reshape.
- **Closed-port**: detector + proposer + clock are all injected; tests
  drive every boundary deterministically.
- **No-throw discipline**: every public method on every port is total.
  HELL-AB-14 (unknown id) + HELL-AB-17 (throwing detector defense-in-depth).
- **Slice isolation**: `src/agent/auto-background/` imports ZERO `@/*`
  modules. The single outward edge is the slot type on
  `AgentConfig.autoBackground?`.
- **Follow-up**: a host-side wire (TUI prompt + key binding for accept /
  dismiss; bridge from `accept` ⇒ `BackgroundSubagentScheduler.fork`) is
  out of scope for this slice — the observer lands first; the executor
  bridge closes in a sibling commit. Pattern matches ADR-0140's deferred
  wire (helper lands plane-clean, caller wire closes follow-up).
