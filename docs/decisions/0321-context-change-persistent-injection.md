# ADR-0321 — Context-change detector + persistent typed-event injection

- Status: Accepted (slice landed, default-OFF; wire-up deferred to W-A merge)
- Date: 2026-05-27
- Renumbered 0301 → 0319 → 0321 across two collisions:
  `0301-playbook-trigger-flag-echo.md` (user) blocked 0301;
  `0319-system-prompt-vision-priority.md` (user) blocked 0319.
  User-deference renumber policy (memory `adr-collision-policy-2026-05-25`)
  → final slot 0321.
- Related: ADR-0320 (typed history store port — parallel W-A slice),
  ADR-0080 (ContextProvider trust-ladder), ADR-0133 (hook prompt injects —
  sibling channel that ALSO splices into per-turn messages but represents a
  different concern — hook output, not state diff),
  src/agent/prompt.ts (ephemeral system-reminder tail — the channel this slice
  is NOT replacing).
- Codex absorption: `codex-rs/core/src/session/turn.rs:161` —
  `record_context_updates_and_set_reference_context_item`.

## Context

quanta's per-turn prompt assembly today re-renders the CURRENT state every
turn via `buildDynamicContext` in `src/agent/prompt.ts:358-439` and wraps it
in a trailing `<system-reminder>` user message:

```
<system-reminder>
Today's date is YYYY-MM-DD.
Working directory: /path/to/cwd
...current mode notice...
...active repo rules body...
...active skills catalogue...
</system-reminder>
```

The reminder is ephemeral and STATELESS: it shows the model "what is now",
not "what changed". When cwd changes from `/a` to `/b`, the tail simply
re-renders with `/b`; the model has no signal that a transition occurred,
no record of the prior value, and no way to correlate the change with the
user instruction that triggered it. The same holds for mode transitions,
repo-rule additions, and skill activations.

Codex's `record_context_updates_and_set_reference_context_item` solves the
SAME problem differently: at turn boundaries it diffs the previous and
current state and writes typed events into the conversation history
stream. The diff envelope (`<context_update field="cwd" prev="A" next="B">`)
is persistent, replayable, and survives compaction — the model reads "what
changed" as a first-class signal.

## Decision

Land a `src/agent/context-change/` slice that adds a 3-stage pipeline
parallel to (NOT replacing) the existing ephemeral reminder tail:

**Stage 1 — capture**: `captureSnapshot(input)` produces an ephemeral
`TurnStateSnapshot` (5 fields: cwd / mode / model / repoRulesPaths /
activeSkills). No I/O, no clock read; the snapshot is value-only.

**Stage 2 — detect**: `detectContextChanges(prev, current, at, meta)` is a
pure diff. It emits `ContextEvent[]` per the 5-pass algorithm in
`detector.ts`. Equality is reference-identity short-circuit followed by
field-wise `===` (strings) or order-sensitive array equality (string
arrays). NO-THROW; bad input produces an empty array.

**Stage 3 — inject**: `buildPersistentInjectionMessages(events)` is a pure
event-list → `Message[]` builder. Each event becomes ONE user-role message
wrapped in a purpose-specific tag (`<context-update>`, `<mode-change>`,
`<repo-rules-change>`, `<skill-activation>`, `<reasoning-echo>`) via
`embedUntrusted` so a forged inner closer cannot terminate the wrapper.

The 5 ContextEvent variants are frozen by this ADR. They match the W-A
`TypedHistoryEventStorePort` port (declared locally in `types.ts` as a
mock — see "Wiring" below).

### Algorithm specifics

- **Reference identity short-circuit**: `Object.is(prev, current)` ⇒ `[]`.
  Same-snapshot two turns in a row is the hot path.
- **Mode change emits ONE event**: `mode_change` (rich form with optional
  `reason`), NOT also `context_update{field:"mode"}`. Otherwise a single
  mode transition double-injects. Consumer registers one handler.
- **Active skills emit one `skill_activation` per ADDED id**. Removal is
  intentionally out of scope for this ADR (no `skill_deactivation` variant);
  removed-only diffs produce zero events.
- **Repo rules emit at-most-one `repo_rules_change`** with added/removed
  path sets. Path-set diff (not body diff) keeps the envelope cheap.
- **`at` is caller-supplied** so the detector is pure (no `Date.now`); the
  caller sources it from the same clock that produces the per-turn timestamp
  (same pattern as `src/agent/admissibility-gate.ts`).

### Inject message format (one variant shown)

```
<context-update>
field: cwd
prev: /old/path
next: /new/path
at: 1700000000000 turnId="turn-7"
</context-update>
```

Each line is `key: value`; the closing tag is the genuine literal closer.
Any inner forged closer in `prev`/`next` (e.g. an `AGENTS.md` body or a
user-supplied path) is defanged to `<\/context-update>` by `embedUntrusted`.

## Non-goals

- **Cross-turn persistence is NOT in this slice**. Persistence is W-A's
  `TypedHistoryEventStorePort.append` responsibility; this slice provides
  the producer (detector) and one consumer shape (inject builder).
- **Working memory (wm) is NOT touched**. The detector reads ephemeral
  snapshots, not `WorkingState`. The injection messages are user-role
  prompts, not wm entries.
- **The ephemeral `<system-reminder>` tail is NOT removed**. Both channels
  coexist: the reminder shows "what is now" (cheap, every turn); the
  injection envelopes show "what changed" (cheap when nothing changed,
  one message per diff otherwise). They serve different model needs.
- **`reasoning_echo` is producer-shaped but the detector does NOT emit it**.
  Reasoning echo comes from the LLM stream, not the snapshot diff. The
  variant is declared in `types.ts` so the injector handles it uniformly
  when an upstream producer (future slice) appends it to the store.
- **`skill_deactivation` is out of scope**. Activation-only by design;
  future ADR may extend.

## Wiring (deferred — main-integration step)

This slice is DEFAULT-OFF: no production path imports from
`src/agent/context-change/`. The wire-up that does the actual injection
lives in a follow-up step, NOT in this slice.

**Injection point in `src/agent/prompt.ts`** (read-only verified — not
mutated by this slice):

- `buildTurnContext` (line 397) — assembles the per-turn `messages[]`.
- Line 425: `const messages: Message[] = [...input.baseMessages]` — clone.
- Line 426: `appendHookContextMessage(messages, input.hookPromptInjects)` —
  ADR-0133 hook channel.
- Lines 435-438: `messages.push({ role:"user", content:[...
  embedUntrusted("system-reminder", dynamic) ...] })` — ephemeral tail.

The persistent-injection messages should be spliced BETWEEN line 425 and
line 435 — AFTER `baseMessages` but BEFORE the trailing reminder. That
positions the diff envelope as a chronological pre-turn signal so the
model reads "what changed since last turn" before "what is now this turn".

A new `TurnContextInput` field (e.g. `contextChangeEvents?:
readonly ContextEvent[]`) threads the per-turn windowed event list from
the host (which has access to the W-A port's `since(lastTurnAt)`). The
field is OPTIONAL ⇒ absent / empty ⇒ no splice ⇒ byte-identical to today.

**ADR-0320 port import**: at main-integration the local
`TypedHistoryEventStorePort` import in `types.ts` swaps to the W-A export
(or W-A re-exports under our name) once W-A lands. The shapes were
designed to match; if W-A's actual port ships with a different shape, the
adapter lives in the integration step, not in this slice.

## Consequences

- **Pro**: the model gains a first-class signal for state transitions; long
  sessions become more debuggable because the typed history stream is a
  replayable narrative.
- **Pro**: the slice is pure / observability-grade infra; no risk to the
  agent loop while it stays default-OFF.
- **Pro**: shape-aligned with W-A's port so the integration step is a
  one-line import swap.
- **Con**: doubles the per-turn message count when many fields change in
  one turn (e.g. fresh-session capture). Mitigated by the typed-history
  windowing (only emit events since previous turn).
- **Con**: forward-compat risk if W-A's actual port ships with a different
  shape. Mitigated by a local mock surface — the integration step adapts.

## Test coverage

- `__tests__/detector.hellgate.test.ts` — 10 cases (A-E groups in source).
- `__tests__/inject.hellgate.test.ts` — 9 cases (A-E groups in source).
- Total: 19 tests / 70 expects / 0 fail at landing.
- tsc: 0 errors against this slice.
- biome: 0 errors / 0 warnings against this slice.
