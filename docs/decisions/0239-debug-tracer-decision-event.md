# ADR-0239: Debug tracer + `decision` event (developer mode for gate observability)

> **Renumbered from 0237 (user-deference): 0237 + 0238 claimed by concurrent
> in-flight slices for llm-error-16-kind + shell-snapshot-production-spawner.
> 0239 is the next free slot.**

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0032 (OTel canonical attribute vocabulary — this
  ADR is the *live, in-process* counterpart to the OTel collector path;
  same vocabulary, no external infra), ADR-0046 (permission stack — one
  of the emit sites in Phase 2), ADR-0055 (AWF PreToolUse hook — the
  hook emit site), ADR-0031 (prefix-rule allowlist — the rule emit
  site), ADR-0034 (session JSONL envelope — where `decision` events are
  persisted), ADR-0054 (context-usage metrics + status line — the *post*
  surface this ADR complements with a *pre-dispatch* surface)
- **References**:
  `src/stream/types.ts` (`AgentEvent` union + `DecisionEvent` variant),
  `src/session/envelope.ts`, `src/session/envelope-encoder.ts`
  (JSONL mapping),
  `src/apps/cli/debug-tracer.ts` (pretty consumer + `parseDebugEnv`),
  `src/apps/cli/debug-cmd.ts`, `src/apps/cli/repl/session-setup.ts`
  (runtime toggle + boot-time auto-enable),
  `tests/unit/decision-event-hellgate.test.ts`,
  `tests/unit/debug-tracer-hellgate.test.ts`,
  `tests/unit/debug-cmd-hellgate.test.ts`

## Research grounding

The pre-dispatch gate stack (permission / rule / hook / cap / jail /
budget) is the largest **non-observable** decision surface in the loop.
Every other major decision class already has a live surface:

- LLM cost / tokens → `workMetrics` (ADR-0065) + status line (ADR-0054)
- Turn diff → `turn_diff_updated` event (ADR-0102)
- Stop reason → `StopCategory` matrix (ADR-0073) surfaced in turn summary
- Tool failures → typed `ToolFailure` (ADR-0069) surfaced in tool panel

The pre-dispatch gates are different — they emit *nothing*, even though
they decide whether a tool call ever leaves the loop. The OTel
vocabulary in ADR-0032 already names these dimensions (`quanta.tool.call.status`,
`quanta.permission.*`, `quanta.rule.*`, `quanta.hook.*`), but those
attributes only exist when an external OTel collector is wired. For an
operator running `quanta` interactively from a terminal, *there is no
way to see why a tool call was allowed, denied, or asked-about* without
restarting the process under a debugger or pointing it at a collector.

Three independent vendors expose a similar live-trace surface:

- **Cursor** ships a "debug panel" that pretty-prints the gate decisions
  in the chat surface itself (collapsible per-tool-call).
- **Claude Desktop** has a developer toggle that streams structured
  decision logs to stderr.
- **Codex** emits OTel spans for every gate by default; the operator
  reads them via `codex --trace` (still requires a collector).

This is strong-signal (3-vendor convergence on the same surface shape),
so we absorb the *live in-process* form: an `AgentEvent` variant the
gates emit, plus a CLI consumer that pretty-prints it to stderr.

## Context

The CLI currently surfaces only *aggregated, post-hoc* information:

- `turn-summary` — what happened *after* the turn finished
- `cost-panel` — cumulative token/cost numbers
- `status-bar` — context %, mode, model

A developer (or a sufficiently motivated end-user) debugging "why did
that tool call get denied?" or "why did the model retry without me
seeing a permission prompt?" has nothing to look at. The `AgentEvent`
stream already carries 20+ variants, but no surface tees the stream to
the operator live — it goes to the session JSONL recorder and the
turn-summary aggregator and nowhere else.

The gap has two halves:

1. **No `decision` event.** Even if a surface *did* tee `AgentEvent`s
   live, the gates today emit nothing — they short-circuit silently
   inside `dispatchTool` / `checkDispatchAllowed` / the hook bus.
2. **No consumer.** Even adding the event without a surface to render
   it leaves the trace invisible.

This ADR closes both halves with one slice (split across three tracks
A/C/D for parallel implementation), keeping wiring at the emit sites
(permission / rule / hook) **out of scope** as an explicit Phase 2
follow-up — those are the per-subsystem ADRs that already exist
(0046 / 0031 / 0055), and this ADR fixes the *contract* they should emit.

## Decision

Three coordinated changes, default-OFF and byte-identical when disabled:

1. **`AgentEvent` gains a `decision` variant** (Track A).
   Closed-union shape:

   ```ts
   export type DecisionEvent = {
     readonly type: "decision"
     readonly turn: number
     readonly kind: "permission" | "rule" | "hook" | "cap" | "jail" | "budget"
     readonly outcome: "allow" | "deny" | "ask"
     readonly reason: string
     readonly toolCallId?: string
     readonly ruleId?: string
     readonly hookName?: string
     readonly metadata?: Readonly<Record<string, unknown>>
   }
   ```

   The session JSONL envelope (ADR-0034) maps this to a new top-level
   `decision` record so post-hoc replay tools see it. EXACT-OPTIONAL
   discipline — absent fields are *omitted*, never `undefined`-set.

2. **`debug-tracer` consumer** (Track C). New file
   `src/apps/cli/debug-tracer.ts`. Subscribes to `AgentEvent` (via the
   existing tee fan-out) and writes one human-readable line per event
   to stderr, ANSI-coloured by category. `parseDebugEnv()` reads
   `QUANTA_DEBUG=<categories>` (comma-separated, `all` shorthand) and
   returns the filter set. Pure stringifier — no I/O, no formatting
   beyond `chalk` already used elsewhere in CLI.

3. **`/debug` slash command + `QUANTA_DEBUG` env** (Track D). New
   file `src/apps/cli/debug-cmd.ts`. The slash command toggles a
   runtime flag that attaches/detaches the tracer consumer to the
   tee. The env var auto-enables at REPL boot by adding the consumer
   in `session-setup.ts` before the loop starts.

### The contract this ADR fixes (for Phase 2 emit wiring)

The six gates listed in `kind` MUST, when their respective subsystem
opts in (post-this-ADR), emit a `decision` event before short-circuiting:

| `kind`       | Site                                      | `outcome`s emitted          | Phase 2 ADR thread |
|--------------|-------------------------------------------|-----------------------------|--------------------|
| `permission` | `src/permission/*` admissibility-gate     | allow / deny / ask          | ADR-0046, 0050     |
| `rule`       | `src/rules/*` prefix-rule matcher         | allow / deny / ask          | ADR-0031           |
| `hook`       | `src/agent/hooks.ts` `pre_tool_use` bus   | allow / deny (via `updatedInput`) | ADR-0055, 0113 |
| `cap`        | `src/agent/dispatch-seam-guard.ts`        | deny only (cap = block)     | ADR-0036           |
| `jail`       | `src/runtime/fs-jail.ts`                  | deny only                   | ADR-0091, 0100     |
| `budget`     | `src/observability/token-budget.ts`       | deny only (`BudgetBreach`)  | ADR-0138           |

Phase 2 (Track B in this slice's planning) wires the emit calls; this
ADR is the contract those wires honour.

### Invariants

1. **Default-OFF byte-identical.** With no env var and no `/debug`
   toggle, the tee never has a tracer attached, no stderr bytes are
   written, no `decision` event is emitted (Phase 2 emit sites are
   themselves opt-in per their own ADRs).
2. **NO-THROW** in the tracer. Tracer errors (broken pipe, format
   crash, etc.) MUST be caught by the tee's existing error isolation
   — a debug surface MUST NOT take down the agent loop.
3. **TTY-only auto-enable.** When stdout/stderr is not a TTY
   (pipe / redirect / `< /dev/null`), `parseDebugEnv` returns the
   empty filter regardless of `QUANTA_DEBUG` value, so scripted runs
   are never polluted.
4. **Metadata is caller-sanitized.** The tracer truncates each
   `metadata` value to 100 characters in the pretty line. The
   *caller* (permission / rule / hook emit site) is responsible for
   not putting raw secrets / PII in `metadata` — secret redaction
   (ADR-0078) applies at the content plane before this ADR's surface
   sees the event.
5. **No full tool input/output in the tracer line.** Only summary
   (length, kind, top-level key set). Full input/output is already in
   the JSONL envelope (ADR-0034) for post-hoc analysis.
6. **EXACT-OPTIONAL** on `DecisionEvent` fields per the union-shape
   convention used throughout `src/stream/types.ts`.

## Default-OFF posture

The tee never constructs a `debug-tracer` consumer unless one of these
two paths fires:

- `QUANTA_DEBUG=<filter>` set at process start → boot wiring in
  `repl/session-setup.ts` calls `parseDebugEnv` and attaches if
  non-empty + TTY.
- `/debug` slash command invoked at runtime → toggles the attach
  state on the live tee.

Absent both, the tee fan-out is *exactly* as it is before this ADR,
including event count, JSONL bytes, and stderr bytes.

## Alternatives considered

- **External OTel collector only** (status-quo expansion). Rejected:
  forces every operator who wants gate trace to set up an OTel
  collector. Most CLI users won't. The OTel path remains — this ADR
  is *additive*.
- **`QUANTA_LOG_LEVEL=debug` only.** Rejected: unstructured, no
  category filter, no clean integration with the existing
  `AgentEvent` plane. Would also re-emit non-decision events at debug
  level, blowing up signal-to-noise.
- **Separate `debug.jsonl` sidecar file.** Rejected: post-hoc only.
  Operators debugging a live session need stderr feedback in real
  time. The session JSONL envelope (ADR-0034) already records
  `decision` for post-hoc.
- **Render in chat surface instead of stderr.** Rejected: the chat
  surface is for the *model's* output. Mixing operator-side debug
  trace there violates the separation between model-visible and
  operator-visible channels (and would corrupt session replay).
- **A per-gate `debug` callback hook on each subsystem port.**
  Rejected: six callbacks instead of one event. The `AgentEvent`
  plane is the SSOT for cross-subsystem observability.

## Negative invariants

These are things this slice deliberately does NOT do, and which
follow-up work MUST also NOT do without a fresh ADR:

- **No Phase 2 emit wiring** in this slice. Permission / rule / hook
  emit calls land in their own follow-up ADRs that reference this
  ADR's contract. (Listed in the table above.)
- **No `/inspect <toolCallId>` slash command** — the tracer is a
  live tail, not a query interface. `/inspect` is a separate slice
  (post-hoc query over the JSONL envelope).
- **No `/replay` time-travel.** Replay is the JSONL envelope's job
  (ADR-0034) plus the seed-replay infra (ADR-0166).
- **No split-screen timeline panel.** The tracer is stderr-only.
  Visual timeline rendering is a TUI-surface concern handled by a
  separate slice if it lands.
- **No `metadata` deep-clone.** The event ships caller's frozen
  reference; the tracer reads but never mutates. (Caller owns the
  freeze.)
- **No automatic stderr write on non-TTY.** Even if `QUANTA_DEBUG=all`
  is set, a non-TTY context disables. Scripted CI runs that want
  debug must explicitly request a TTY (`script -q`, `unbuffer`, etc.).

## Wiring map

This slice (3 parallel tracks A/C/D, shipping together):

- `src/stream/types.ts` — Track A — add `DecisionEvent` to the
  closed `AgentEvent` union.
- `src/session/envelope.ts` + `envelope-encoder.ts` — Track A —
  map the new variant onto a JSONL `decision` record.
- `src/apps/cli/debug-tracer.ts` — Track C — pretty consumer +
  `parseDebugEnv` helper.
- `src/apps/cli/debug-cmd.ts` + `repl/session-setup.ts` + slash
  dispatcher — Track D — `/debug` toggle + `QUANTA_DEBUG` boot
  auto-enable.

Out-of-scope, tracked as Phase 2 follow-ups:

- `src/permission/*` — emit `decision { kind:"permission" }` at
  allow / deny / ask sites (ADR-0046, 0050 thread).
- `src/rules/*` — emit `decision { kind:"rule" }` at the prefix-rule
  match site (ADR-0031 thread).
- `src/agent/hooks.ts` — emit `decision { kind:"hook" }` at
  `pre_tool_use` deny / `updatedInput` rewrite sites (ADR-0055,
  0113 thread).
- `src/agent/dispatch-seam-guard.ts` — emit `decision { kind:"cap" }`
  at every cap deny (ADR-0036 thread).
- `src/runtime/fs-jail.ts` — emit `decision { kind:"jail" }` at
  every jail escape detection (ADR-0091, 0100 thread).
- `src/observability/token-budget.ts` — emit
  `decision { kind:"budget" }` on every `BudgetBreach` (ADR-0138
  thread).

## Validation

- **Hellgate**: `tests/unit/decision-event-hellgate.test.ts` (union
  exhaustiveness + EXACT-OPTIONAL + JSONL round-trip),
  `tests/unit/debug-tracer-hellgate.test.ts` (TTY gate + crash
  isolation + metadata truncate + ANSI strip when piped),
  `tests/unit/debug-cmd-hellgate.test.ts` (toggle idempotence +
  parseDebugEnv hostile-input + boot-time attach).
- **TSC**: 0 errors introduced by this slice.
- **Biome**: 0 errors introduced by this slice.
- **Byte-identical fence**: with `QUANTA_DEBUG` unset and `/debug`
  never invoked, the existing turn-summary / cost-panel / status-bar
  / JSONL byte stream is identical to the pre-ADR baseline. The
  existing closeout battery doubles as the byte-identical guard.

## Limits + follow-ups

- **No emit wiring yet** — Phase 2. This ADR fixes the contract; the
  six emit-site ADRs (0031 / 0046 / 0050 / 0055 / 0091 / 0100 / 0113 /
  0138) consume it.
- **No `/inspect` post-hoc query** over the JSONL `decision` records
  — separate slice.
- **No persistent ring buffer** in the tracer — purely streamed. For
  `decision` events that fire before `/debug` is invoked, the
  operator must restart with `QUANTA_DEBUG=…` (this is the same
  posture Codex and Cursor's debug surfaces take).
- **No multi-session aggregation** — the tracer is per-process. A
  cluster-wide gate-decision dashboard would consume the JSONL
  records (already persisted in ADR-0034) via the OTel collector
  path (ADR-0032), not via this surface.
