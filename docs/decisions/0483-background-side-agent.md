# ADR-0483: Background side-agent daemon — a resident, self-waking monitor that pushes findings without blocking the main loop

- **상태**: Accepted
- **날짜**: 2026-06-06
- **관련**:
  - ADR-0130 (background subagent — the one-shot `fork`/`SubagentRunner` this daemon REUSES as its per-wake substrate; N1 is a NEW axis, not an extension)
  - ADR-0416 (subagent mailbox — the per-recipient inbox findings are PUSHED onto)
  - ADR-0161 (scheduled agent — the cron substrate that drives the MAIN loop; a side-agent is the opposite axis, a resident runner on its OWN thread)
- **참조**:
  - `src/side-agent/types.ts` — the pure-leaf model: `SideAgentSpec` (`task` / `trigger` interval|event / `maxWakes` / `maxTurnsPerWake` / `idleReapMs?`), `SideAgentStatus` (`running`|`stopped`|`failed`|`idle-reaped`), `SideAgentFinding`, the injected ports (`SideAgentRunnerPort` / `SideAgentMailboxPort` / `SideAgentSinkPort` / `SideAgentEventSourcePort`), `SideAgentError` (`cap-exceeded`|`invalid-spec`), and the duck-typed `SideAgentIdleBarrierPort`.
  - `src/side-agent/registry.ts` — `createSideAgentDaemonRegistry(opts) → SideAgentDaemonRegistry`: the supervise loop (`spawn`/`findings`/`list`/`stop`/`stopAll`), the runaway guards (`maxConcurrent`/`maxWakes`/`idleReapMs`/`maxFindings`/`maxRetained`), `validateSpec`, the per-wake `wake()` (drop-overlapping + bounded), `pruneTerminal`.
  - `src/tool/side-agent/index.ts` — the model-facing `side_agent_spawn`/`_list`/`_stop`/`_findings` tools over the duck-typed `SideAgentDaemonPort` (NO-THROW surface).
  - `src/agent/tier1/side-agent.ts` — `buildSideAgentBlock(config)`: the four tools iff `config.sideAgentDaemons` wired, `[]` otherwise.
  - `src/agent/side-agent-runner.ts` — the Phase-2 bridge: `subagentRunnerToSidePass` (read-biased bounded pass, `finalText`→finding, `SUMMARY_MAX`/`DETAIL_MAX` caps), `mailboxToSideAgentMailbox` (finding→broadcast), `wireSideAgentDaemons`, `SIDE_AGENT_READONLY_TOOLS`.
  - `src/host/runtime/agent-config-assembler.ts` — `maybeWireSideAgent` (the `QUANTA_SIDE_AGENT=1` composition-root bind).
  - `src/tool/surface/manifest.ts` — the `QUANTA_SIDE_AGENT` surface entry (opt-in everywhere).
  - Tests: `tests/unit/side-agent-hellgate.test.ts` (registry FSM + runaway guards + no-block-main), `tests/unit/side-agent-tools-hellgate.test.ts` (tool surface NO-THROW), `tests/unit/side-agent-runner-hellgate.test.ts` (bridge: read-bias + detail cap + surrogate-safety), `tests/unit/side-agent-block-e2e-hellgate.test.ts` (default-OFF + duck-typed seam).
  - RFC: `docs/plans/jun-4-background-side-agent.md` (§3 the "not a subagent-bg duplicate" verdict; §4 the supervise loop; §4.6 read-bias).
  - Feature catalog: `tools/feature-catalog/features/09-integration/n1-background-side-agent.yaml`.

## 맥락

quanta already had three ways to run work off the foreground turn, and a **persistent monitor** is none of them:

- **One-shot background subagent (ADR-0130)** runs a single `fork` pass and is done. A monitor that should keep watching the build / disk / test suite across many main-loop turns cannot be expressed as a one-shot — you would re-`fork` every turn, with no resident identity, no cadence, no accumulated idle-state.
- **The scheduler (ADR-0161)** fires cron automations onto the **MAIN** `AgentLoopPort` — it drives the *main* loop on a time-gate. A side-agent is the opposite axis: it runs on its OWN thread and must NEVER take the main turn.
- **bash-bg** is a raw shell process, not an agent that reasons over a charter prompt and reports findings.

Claude Code 2.1.150's `tengu_bg_agent_action` (the highest-signal background symbol on disk, audited in the RFC) is a fourth axis: a **resident daemon** that wakes on its own cadence, runs ONE bounded agent pass per wake, and surfaces findings back asynchronously. N1 absorbs exactly that axis. The RFC's §3 verdict is load-bearing: N1 is a NEW axis (persistent side-runner), but it **REUSES** ADR-0130's `SubagentRunner` + lifecycle/abort posture as the per-wake substrate rather than reinventing a child-agent harness.

The distinguishing invariant — the headline this ADR exists to protect — is **no-block-main**: `spawn` returns a daemon id synchronously even when the very first pass hangs forever, and `list()`/`findings()` never await. A daemon wakes, runs ONE bounded pass on its own thread, PUSHES a finding via the mailbox, and goes back to sleep; the main loop only ever *drains* findings at its own pace.

## 결정

A new **pure-leaf** slice `@/side-agent` (`src/side-agent/`) plus a Phase-2 host bridge (`@/agent/side-agent-runner`), surfaced as four model tools under a strict opt-in.

### The resident registry + the daemon model

`createSideAgentDaemonRegistry(opts) → SideAgentDaemonRegistry` is **pure orchestration over injected ports** — it imports nothing concrete and carries no `Date.now()` / `setInterval` / randomness of its own (the host injects `now` / `setInterval` / `clearInterval` at composition, so the supervise loop is fully testable over fakes). A daemon is a `SideAgentSpec`:

- `task` — the charter prompt re-run each wake;
- `trigger` — a **closed union** `{ interval; everyMs }` | `{ event; topic }` (no free-form scheduling);
- `maxWakes` — a HARD ceiling on total wakes (runaway guard);
- `maxTurnsPerWake` — the per-wake model-turn budget (each pass is bounded exactly like an ADR-0130 fork);
- `idleReapMs?` — auto-stop after this much wall-idle with no finding (omitted ⇒ never).

`spawn` mints an id, arms the trigger (`setInterval` for interval, `events.subscribe` for event), and returns **immediately** — the supervise loop runs detached. The lifecycle FSM is `running → {stopped | failed | idle-reaped}`; `finish` is idempotent and tears down the timer/subscription + aborts the daemon's `AbortController`.

### Bounded-pass-per-wake + mailbox-push

`wake(id)` runs ONE bounded pass: it guards against an over-run (`wakesDone >= maxWakes` ⇒ auto-stop), **drops overlapping wakes** (`inFlight` coalescing — a tick that lands while a pass is in flight is dropped, never double-fires), invokes `opts.runner.run({ task, wake, maxTurns, signal })`, and on a non-null result calls `publish`. `publish` writes the finding to the in-memory ring-buffer log AND **pushes it via `opts.mailbox.send`** to `mainRecipient` (the main session) AND optionally emits to a render-only `sink`. A `null` pass = "the wake found nothing" → no finding, no mailbox message, idle accumulates. After each completed pass `applyPostPassBounds` applies the wake ceiling then the idle reaper. The runner port is allowed to throw — a thrown pass is caught and transitions the daemon to `failed`, never propagating to the caller.

### The four model tools + the duck-typed port fence

`@/tool` may **NOT** import `@/side-agent` (slice fence). So `src/tool/side-agent/index.ts` declares a **duck-typed `SideAgentDaemonPort`** — a structural mirror of the registry's `SideAgentDaemonRegistry` (the model-facing subset: `spawn`/`findings`/`list`/`stop`, omitting host-only `stopAll`). The composition root passes the REAL registry, which matches structurally (proven in `side-agent-block-e2e-hellgate`). The tools — `side_agent_spawn` / `side_agent_list` / `side_agent_stop` / `side_agent_findings` — are a **NO-THROW surface**: every path yields a typed `ok:false` on failure, including the registry's single `cap-exceeded` throw (caught and mapped to `reason: "cap_exceeded"`), bad input (`bad_input`), abort (`aborted`), an unknown id on stop (`not_found`), and a misbehaving registry (`mode: "error"`). The model never sees a rejected iterator.

### The Phase-2 bridge (read-biased, bounded, capped)

`src/agent/side-agent-runner.ts` is the SOLE place coupling the pure slice to the real substrate (mirroring how `subagent-runner.ts` is the sole bridge for ADR-0130):

- `subagentRunnerToSidePass` adapts the ADR-0130 `SubagentRunner` into one bounded **read-biased** pass: a daemon defaults to `SIDE_AGENT_READONLY_TOOLS` (read/grep/glob/file_tree_summary/parse_test_failure/diagnostics/bash_await/test_runner) — a monitor *observes*; it does NOT get mutating tools by default. The toolFilter is an **allowlist (narrowing only)**, and any write still re-enters the parent permission / HARD_DENY gate, so a side-agent cannot self-grant. The child's `finalText` becomes the finding: `summary` = first line capped at `SUMMARY_MAX` (200); `detail` = the full text capped at `DETAIL_MAX` (8000) with a surrogate-safe truncation marker.
- `mailboxToSideAgentMailbox` adapts the ADR-0416 `MailboxPort`: a finding → a `broadcast` (push, no reply).
- `wireSideAgentDaemons` assembles the registry from the two adapters + injected timers/clock; the returned registry structurally satisfies `SideAgentDaemonPort`.

### Default-OFF (`QUANTA_SIDE_AGENT`)

`buildSideAgentBlock(config)` returns the four tools iff `config.sideAgentDaemons` is wired, `[]` otherwise. The host's `maybeWireSideAgent` mints the live registry ONLY when `QUANTA_SIDE_AGENT === "1"` (and never clobbers a caller-supplied slot). Absent gate ⇒ slot unset ⇒ tools unregistered ⇒ **byte-identical** for every caller that did not opt in. The surface manifest marks it opt-in EVERYWHERE (spawns do real work, so it never auto-seeds). An optional `QUANTA_TEAM_IDLE` additionally composes a duck-typed idle barrier so a leader can `await teamIdle()` over the resident daemons instead of polling — absent ⇒ legacy registry (byte-identical).

## 결과

- A persistent monitor/cleanup/periodic-check axis exists that is structurally distinct from one-shot subagent-bg and the main-loop-driving scheduler, while REUSING the ADR-0130 runner + ADR-0416 mailbox rather than reinventing them.
- The headline `no-block-main` invariant is enforced and pinned: `spawn` returns synchronously even under a never-resolving runner; `list()`/`findings()` are synchronous.
- The pure-leaf design (every effect an injected port) makes the entire supervise loop — every runaway guard, the overlap-coalescing, the idle reaper — deterministically testable over fake timers/clock, with no `Date.now()`/`setInterval`/RNG in the slice.
- The `@/tool → @/side-agent` fence holds via a duck-typed port whose structural compatibility with the real registry is proven end-to-end.
- Default-OFF + caller-override-safe wiring keeps every non-opting caller byte-identical.

## Trade-offs / Negative invariants

- **Cap enforcement = a SINGLE throw.** `spawn` past `maxConcurrent` (default 2, deliberately below subagent-bg's 3) is the ONLY runtime throw the registry emits — `SideAgentError("cap-exceeded")`. A stopped daemon frees a slot (pinned in hellgate). The tool surface catches this and maps it to `ok:false` / `reason: "cap_exceeded"`; the model never crashes on a cap hit.
- **`invalid-spec` is a programming-error throw, distinct from the runtime cap.** `validateSpec` rejects three real footguns BEFORE a daemon is spawned, occupying NO concurrency slot: an `interval` with `everyMs <= 0` (CPU spin), an `event` trigger with NO injected event source (a permanently-asleep zombie holding a slot forever), and a non-positive `maxWakes`/`maxTurnsPerWake`/empty-`task`/`idleReapMs<=0`. These are the only two throws in the slice; everything else is NO-THROW.
- **NO-THROW tool surface.** Every tool path yields a typed `ToolResult` — a misbehaving registry surfaces `mode: "error"`, never rejecting the iterator (Tool contract §2). Pinned across spawn/list/stop/findings.
- **A thrown pass fails the daemon, silently.** `runner.run` MAY throw; the supervise loop catches it, transitions the daemon to `failed`, clears its timer, and does NOT propagate. The runaway is contained at the daemon, not the session.
- **Overlapping wakes are dropped, not queued.** An interval/event that fires while a pass is `inFlight` is coalesced (no double-fire). A slow pass therefore *skips* ticks rather than backing up — intentional (a monitor wants freshness, not a backlog), but it means effective cadence under load is bounded by pass duration.
- **Bounded memory by construction.** The findings log is a ring-buffer capped at `maxFindings` (default 1000, oldest evicted); terminal daemons are pruned past `maxRetained` (default 100) while running daemons are NEVER pruned. The per-finding `detail` is capped at `DETAIL_MAX` (8000) with **surrogate-safe** truncation — a naive UTF-16 slice could emit a lone surrogate (→ U+FFFD) into the ring-buffer / mailbox body, so the cut snaps off a surrogate-pair boundary (pinned with a straddling-emoji hellgate). This mirrors C2's per-field-cap DoS discipline: a chatty child cannot balloon the findings log or the mailbox broadcast body.
- **Privilege is narrowing-only.** The read-biased default toolFilter is an ALLOWLIST; a wider filter must be supplied explicitly, and even then every write re-enters the parent permission/HARD_DENY gate — a side-agent cannot self-grant capabilities.
- **The fence is structural, not nominal.** `@/tool` mirrors the registry shape via a duck-typed `SideAgentDaemonPort` rather than importing `@/side-agent`. If the registry's model-facing signature drifts from the mirror, the seam silently breaks at composition — guarded by the e2e hellgate that plugs the REAL registry into the tools.
- **Phase-1 non-goals (deferred).** No OS-level process supervision (launchctl/systemd), no worktree-isolated checkouts, no cross-process IPC. The host currently mints a DEDICATED subagent runner for daemon passes; sharing the foreground subagent block's single budget is a follow-up (the dedicated runner still honors per-pass `maxTurns` + the registry `maxConcurrent` guard).
