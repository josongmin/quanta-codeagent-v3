# RFC — N1: Background Side-Agent (Daemon)

**Date:** 2026-06-04
**Status:** Design (NOT implementation). This doc proposes a seam; it ships no code.
**Slice:** new `@/side-agent` library slice (proposed) + thin host wiring.
**Default posture:** OFF, byte-identical. A constructed-but-not-started daemon performs zero work.

> Scope note: this is a SOTA++ design doc grounded in (a) the Claude Code 2.1.150
> `tengu_bg_agent_action` daemon model audited on disk, and (b) quanta's existing
> background substrate (subagent-bg ADR-0130, scheduler ADR-0161, bash-bg
> ADR-0296). The single largest design risk — N1 being a duplicate of
> subagent-bg — is addressed head-on in §3. **Verdict up front: N1 is a NEW
> axis (persistent side-runner), NOT an extension of subagent-bg, but it
> REUSES subagent-bg's runner + lifecycle FSM as an internal substrate.**

---

## 1. 요약 (Summary)

N1 is a **long-lived background agent (daemon)** that runs *side tasks* —
monitoring, cleanup, tee/observe, periodic checks — **without blocking the main
agent loop**. Unlike the existing one-shot background subagent (ADR-0130), an N1
daemon is *persistent*: it stays resident across many main-loop turns, runs on
its own cadence (event-driven and/or periodic), and **surfaces findings back to
the main session asynchronously** via the existing mailbox + stream-event seams.
It is the closed-port equivalent of Claude Code's `claude daemon` / `--bg` /
`/background` "on-demand daemon" + supervisor model.

The design:

- A `SideAgentDaemon` port: `spawn(spec) → handle`, `list()`, `stop(handle)`,
  `stopAll()`, plus a `findings()` drain. NO-THROW surface (mirrors ADR-0130).
- Each daemon is a **supervisor loop** over an injected `SubagentRunner` (the
  exact runner ADR-0130 already injects). It wakes on a tick (reuse the
  scheduler's `setInterval` cadence pattern) and/or on a subscribed event,
  runs one bounded subagent pass, writes its findings to a **mailbox**
  (ADR-0416), and goes back to sleep.
- Findings reach the main session through the **`SubagentMailboxPort`** (an
  existing per-recipient inbox) drained at turn boundaries, and/or a
  **stream event** on the existing `@/stream` bus — never by blocking.
- Hard resource bounds: max concurrent daemons, per-daemon max-wakes,
  per-wake turn budget, an idle/age reaper, and a first-class
  `AbortController` per daemon (reuse ADR-0130's cancel posture).
- **Default-OFF**: gated behind a `QUANTA_SIDE_AGENT` env flag in the same
  shape as `QUANTA_SCHEDULER`; absent ⇒ the daemon registry is never
  constructed and the tool surface stays byte-identical.

N1 deliberately does **not** introduce OS-level process supervision
(launchctl/systemd), worktree-isolated checkouts, or cross-process IPC in
Phase 1 — those are Claude's persistent-service extensions and are listed as
explicit non-goals / Phase-3 backlog.

---

## 2. 경쟁사 레퍼런스 (verified on disk)

### 2.1 Claude Code 2.1.150 — `tengu_bg_agent_action` (primary signal)

`tengu_bg_agent_action` appears **21×** in
`.extracted_source/claude-code-cli/_cli-symbols.txt` (highest-signal background
marker). Cross-referencing the surrounding symbols reveals a **full daemon /
supervisor architecture**, not a one-shot task:

**Lifecycle surface (CLI verbs):**
- `claude --bg` / `/background` — fork the *current* session into a background
  session. Confirm prompt: `"Background this session?"` / `"Background anyway
  (tasks will be abandoned)"`. Telemetry: `tengu_background_fork`,
  `tengu_background_declined`, `tengu_background_spawn_failed`.
- `claude agents` / agent view — *list* background sessions
  (`tengu_agent_list_attach`). Message: `"still running. Run \`claude agents\`
  to see your background sessions."`
- `claude stop <id>` (`cli_bg_stop`) — *"Stop a background session. Its
  conversation is kept; resume it later with \`claude attach <id>\`."*
- `claude attach <id>` — *reattach* to a backgrounded session (resume its
  conversation).
- `claude rm <id>` (`cli_bg_rm`) — *"Delete a background session and its
  worktree. Unlike \`stop\`, works on already-exited sessions."*

**Supervisor / daemon process:**
- `claude daemon [run|status|logs|uninstall|stop]` — a **supervisor** process.
  `run` = run supervisor foreground; `stop` = *"Shut down the supervisor and
  terminate background sessions"*; `uninstall` = remove the launchctl/systemd
  service.
- Config: `~/.claude/daemon.json`, `daemon.log`, `daemon.lock`,
  `com.anthropic.claude-daemon` (launchctl label), named pipe
  `\\.\pipe\cc-daemon-*` (Windows), `supervisorPid`, `supervisorProcStart`.
- Modes: `"transient"` (spawn one for this login session) vs install
  persistently (`"ask"`). On-demand: *"the on-demand daemon"* —
  `daemonColdStart`, `daemon-worker`.
- Respawn/self-heal: `tengu_bg_respawn_unconfirmed_bail`,
  `job_respawn_kill_unconfirmed`, `respawnIfIdleStale`, `respawnHandler`,
  `crashed_during_spawn`, `tengu_bg_killjob_ctrl_fallback`.
- Scheduling link: `daemon.scheduled.status.json`, `daemon_scheduled_add`,
  `daemon_scheduled_remove` — the daemon also hosts scheduled (cron-like) runs.

**Isolation:** background sessions run in **git worktrees** by default
(`"isolation": "worktree"` blocks `Edit`/`Write` in the main checkout until
`EnterWorktree`; `"none"` lets bg jobs edit the working copy directly). Worktree
auto-cleaned if the agent made no changes. Symlink dirs (`node_modules`, etc.)
configurable to avoid disk bloat.

**What actions a bg agent performs / how it reports back:**
- Actions: run a self-contained task to completion in the background; the
  `/batch` flow shows the canonical workload — *"Multi-agent bug sweep of the
  current branch. Self-respawning finder pool … streams into 5-vote adversarial
  verification …"* — i.e. monitor/sweep/verify on a branch, autonomously.
- Reports back: the conversation is **kept** (not discarded). User reattaches
  (`claude attach`) to read it, or the agent view lists status. Persistent
  service streams to a log; transient bg streams when reattached.

> **Takeaway:** Claude's bg agent is *exactly* the N1 axis — a **persistent,
> resumable, supervised side-runner** distinct from a single inline subagent.
> Its full form (OS service + worktree isolation + cross-process supervisor)
> is heavier than N1 Phase 1 needs; we absorb the *model* (spawn/list/stop/
> conversation-kept/findings-surfaced/idle-reaper/respawn-on-stale) and defer
> the OS-process + worktree layers.

### 2.2 Codex 0.135 — automation / heartbeat

Codex's analog is the **`heartbeat`** automation (already absorbed into quanta's
scheduler as `AutomationKind = "cron" | "heartbeat"`, ADR-0161 H8): a repeating
agent attached to one thread that keeps working it under a fixed posture. Codex
also carries `multi_agents_v2.send_message(agent_id, msg)` (absorbed as the
ADR-0416 mailbox) — the sibling↔sibling channel a daemon needs to report back
without teardown. Codex's pattern is *periodic-prompt-onto-a-thread*, weaker
than Claude's resident-supervisor; N1 sits between them.

### 2.3 Cursor 3.x — `ForceBackgroundSubagent`

`agent.v1.ForceBackgroundSubagent{Args,Result,Status}` +
`shellStreamExecutor.forceBackgroundByToolCallId(toolCallId)` +
`backgroundSubagentAction` (`cursor-agent-exec/dist/main.js`). This is the
substrate quanta's ADR-0130 (`force_background_subagent` + `subagent_await`)
already absorbed: a *detached, one-shot* subagent forked from a tool call —
**not** a persistent daemon. Confirms the gap: nobody but Claude ships a
resident side-runner; Cursor/Codex/v0 stop at one-shot or periodic.

---

## 3. 현재 quanta 상태 + axis 구분표

### 3.1 What already exists (cited)

| Substrate | File:line | What it is |
|---|---|---|
| **subagent-bg** (ADR-0130) | `src/agent/subagent-background.ts:99` (`BackgroundSubagentScheduler`) | **One-shot** fork/await: `fork(spec)→handleId` runs the injected `SubagentRunner` **once**, `await`/`poll`/`cancel`/`list`/`prune`. 4-arm FSM `running\|completed\|failed\|cancelled` (`:61`). Pure in-memory store. `maxConcurrent` default 3 (`:172`). |
| **scheduler** (ADR-0161) | `src/scheduler/runtime.ts:80` (`createSchedulerRuntime`) | **Periodic prompt enqueuer.** `setInterval` tick (`:117`, default 60s `:40`), each due RRULE automation `enqueueUserMessage` onto the agent loop (`:253`). `cron` = fresh thread; `heartbeat` = routed onto a target thread (`src/scheduler/types.ts:126`). Default-OFF via `QUANTA_SCHEDULER` (`runtime.ts:44`). |
| **bash background** (ADR-0296) | `src/runtime/bash-bg-registry.ts:123` (`BashBgRegistry`) + `src/tool/bash/{await,kill}.ts` | **Detached OS shell.** `bash` with `timeout_behavior:"background"` (`src/tool/bash/index.ts:49`) spawns a child process, returns `shell_id`; `bash_await` blocks on exit/regex, `bash_kill` SIGTERM→SIGKILL. Status `running\|completed\|killed\|aborted` (`:51`). Not an *agent* — a raw subprocess. |
| **subagent-mailbox** (ADR-0416) | `src/agent/subagent-mailbox/store.ts` + `types.ts` | Inter-agent inbox: `send`/`pendingFor`/per-recipient `deliveredAt`/broadcast cursor. The **report-back channel** N1 reuses. |
| **auto-background** | `src/agent/auto-background/stuck-detector.ts` | Heuristic "should I background this?" detector — a *trigger*, not a runner. Orthogonal. |

### 3.2 The axis-distinction table (N1 vs the three existing background axes)

| Axis | Lifetime | Cadence | Runs | Result surfacing | quanta today |
|---|---|---|---|---|---|
| **subagent-bg** (ADR-0130) | **One-shot** — dies on completion | Runs once, immediately | An LLM agent pass | `await`/`poll` (pull) | `subagent-background.ts` |
| **scheduler-automation** (ADR-0161) | Definition persists; each fire is a **fresh** (cron) or thread-routed (heartbeat) one-shot | Periodic (RRULE, ≥daily) | Enqueues a **user prompt** onto the *main* loop | Becomes main-loop turns (no side channel) | `scheduler/runtime.ts` |
| **bg-bash** (ADR-0296) | Until process exits/killed | Continuous (it's a process) | A **raw shell command** (no LLM) | `bash_await` (pull) / `bash_kill` | `bash-bg-registry.ts` |
| **N1 side-agent daemon** (this RFC) | **Persistent** — resident across many main turns until `stop()` | Event-driven **and/or** sub-minute periodic | An LLM agent pass **per wake**, on its **own** thread (NOT the main loop) | **Push** to mailbox + stream event, drained at turn boundary | **(gap)** |

**Why N1 is NOT subagent-bg:** ADR-0130's `fork()` is *terminal* — it runs the
runner exactly once (`startRun`, `subagent-background.ts:449`) and the handle
reaches a terminal status forever. There is no re-wake, no cadence, no
event-subscription, no periodic monitoring loop. To "keep monitoring", a caller
would have to re-`fork()` in a loop themselves — which is precisely the
supervisor logic N1 owns. N1's daemon **wraps** ADR-0130's runner inside a
**supervise loop**: each wake is one ADR-0130-style bounded pass.

**Why N1 is NOT scheduler-automation:** the scheduler's only effect is
`enqueueUserMessage` onto the **main** agent loop (`runtime.ts:253`) — it
*drives the main conversation*, blocking-by-design (the prompt becomes a turn).
N1 runs on a **separate** thread and never enqueues onto the main loop; it
reports *asynchronously*. Also: the scheduler's minimum cadence is daily-ish
(RRULE `DAILY|WEEKLY|MONTHLY`, `scheduler/types.ts:30`), unfit for a
tee/monitor that needs sub-minute reaction.

**Why N1 is NOT bg-bash:** bg-bash runs a *shell command*, no model. N1 runs an
*agent* (reasoning + tools) each wake. (A monitor daemon may *use* bg-bash
internally to tail a log, then reason over it — composition, not duplication.)

### 3.3 Honest framing — extension vs new slice

N1 is **a new axis** but **not from-scratch**. The right framing:

> **N1 = a persistent supervisor built ON TOP OF the ADR-0130 runner + FSM,
> reporting THROUGH the ADR-0416 mailbox, ticking with the ADR-0161 cadence
> pattern.** It is a *composition* slice. We do NOT re-implement the
> fork/cancel/handle FSM (reuse `BackgroundSubagentScheduler` internally), and
> we do NOT re-implement an inbox (reuse `SubagentMailboxPort`).

This keeps N1 small: the genuinely new code is the **supervise loop** (wake →
run one bounded pass → publish findings → sleep/reschedule → reap) and its
bounds/lifecycle, plus a thin tool/CLI surface.

---

## 4. 설계 (Design)

### 4.1 The daemon model

```
spawn(spec) ──► SideAgentHandle (id: "sa-<hex>")
                   │
                   ▼
            ┌─ supervise loop (own thread, NON-blocking) ─┐
            │  wake  ◄── tick (sub-minute) OR subscribed   │
            │         │   event (file change / stream evt) │
            │         ▼                                     │
            │   run ONE bounded subagent pass ──► SubagentRunner (ADR-0130)
            │         │  (per-wake turn budget, abort signal)│
            │         ▼                                     │
            │   publish finding ──► mailbox (ADR-0416)      │
            │         │              + stream event (opt)   │
            │         ▼                                     │
            │   sleep until next wake / stop / idle-reap    │
            └───────────────────────────────────────────────┘
                   │
        list() / findings() / stop() / stopAll()
```

### 4.2 Closed port (proposed `@/side-agent`)

```ts
// src/side-agent/types.ts — plain TS (hot-path convention), pure leaf
export type SideAgentStatus = "running" | "stopped" | "failed" | "idle-reaped"

export interface SideAgentSpec {
  /** Charter prompt the daemon re-runs each wake (with accumulated context). */
  readonly task: string
  /** What wakes it. Closed union — no free-form scheduling. */
  readonly trigger:
    | { readonly kind: "interval"; readonly everyMs: number }   // sub-minute OK
    | { readonly kind: "event"; readonly topic: string }         // stream-bus topic
  /** Hard ceiling on total wakes before auto-stop (runaway guard). */
  readonly maxWakes: number
  /** Per-wake model-turn budget (each pass is bounded like an ADR-0130 fork). */
  readonly maxTurnsPerWake: number
  /** Optional: auto-stop after this much wall-idle with no finding. */
  readonly idleReapMs?: number
  readonly metadata?: Readonly<Record<string, string>>
}

export interface SideAgentFinding {
  readonly daemonId: string
  readonly wake: number              // 1-based wake index
  readonly summary: string           // one-liner for status bar
  readonly detail?: string
  readonly at: number
}

export interface SideAgentSnapshot {
  readonly id: string
  readonly status: SideAgentStatus
  readonly spec: SideAgentSpec
  readonly wakesDone: number
  readonly lastFindingAt?: number
  readonly startedAt: number
  readonly stoppedAt?: number
}

export interface SideAgentDaemonRegistry {
  /** Spawn a resident daemon. Returns id immediately; the loop runs detached.
   *  Throws SideAgentError("cap-exceeded") when at maxConcurrent (mirrors
   *  ADR-0130 fork's ONLY throw). */
  spawn(spec: SideAgentSpec): string
  /** Drain NEW findings since the last drain (pull from mailbox). NO-THROW. */
  findings(opts?: { since?: number }): ReadonlyArray<SideAgentFinding>
  /** Enumerate daemons, newest-first. NO-THROW. */
  list(): ReadonlyArray<SideAgentSnapshot>
  /** Request stop. Idempotent. Conversation/findings KEPT (Claude posture).
   *  Returns true when the id exists. */
  stop(id: string): boolean
  /** Stop every running daemon (session shutdown). Returns count stopped. */
  stopAll(): number
}
```

### 4.3 DI seam (what the host injects)

```ts
export interface SideAgentDaemonOpts {
  /** REUSE ADR-0130 — how to run one bounded pass. Same SubagentRunner the
   *  background scheduler already injects. */
  readonly runner: SubagentRunner
  /** REUSE ADR-0416 — where findings are published. */
  readonly mailbox: MailboxPort
  /** Optional stream bus for live "· daemon found X" events. */
  readonly sink?: SideAgentSinkPort
  /** Event source for trigger.kind === "event" (subscribe/unsubscribe). */
  readonly events?: SideAgentEventSourcePort
  /** Caps (runaway guards). */
  readonly maxConcurrent?: number        // default 2 (lower than subagent-bg's 3)
  /** Injected timers (tests fake them — same shape as scheduler runtime). */
  readonly setInterval?: (h: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
  readonly now?: () => number            // default Date.now
  readonly idGen?: () => string
}
```

All effects are ports → the slice imports nothing concrete (matches
`@/scheduler` and `@/subagent` discipline). The supervise loop owns a per-daemon
`AbortController`; `stop()` fires it, and an in-flight pass observes the signal
(ADR-0130's runner already threads `signal` through `specToRequest`).

### 4.4 How findings reach the main session (NON-blocking, two channels)

1. **Mailbox (authoritative, pull).** Each wake's finding is
   `mailbox.send({ from: daemonId, to: mainSessionId, kind: "finding", body })`.
   The main loop drains `mailbox.pendingFor(mainSessionId)` **at turn
   boundaries** (a natural existing seam — the loop already has turn-start/
   turn-end hooks). Drained findings are injected as a system-context note
   ("a background daemon reported: …"), never interrupting an in-flight turn.
2. **Stream event (optional, push, observability only).** When a `sink` is
   injected, a `side-agent.finding` event is emitted on the `@/stream` bus for
   live UI ("· daemon X: 2 findings"). This is render-only; it carries no
   control authority.

This dual model copies Claude's "conversation is **kept**; reattach to read"
posture: the mailbox is the durable record (read on demand), the stream event
is the ambient signal.

### 4.5 Resource bounds + abort (runaway-daemon defense)

- **maxConcurrent** (default 2): `spawn()` throws `cap-exceeded` past it (only
  throw on the surface — ADR-0130 voice).
- **maxWakes**: hard per-daemon wake ceiling → auto-`stop` (`status:"stopped"`).
- **maxTurnsPerWake**: each pass is a bounded ADR-0130 fork (turn budget).
- **idleReapMs**: a daemon producing no finding for N ms auto-stops
  (`status:"idle-reaped"`) — copies Claude's `respawnIfIdleStale`/idle-reaper.
- **AbortController per daemon**: `stop`/`stopAll`/session-shutdown fire it; an
  in-flight pass resolves cancelled. `stopAll()` is wired to the same
  session-shutdown hook `BashBgRegistry.killAll` uses
  (`bash-bg-registry.ts:142`).
- **No overlapping wakes**: a daemon never starts wake N+1 while wake N's pass
  is in flight (interval ticks that land during a pass are coalesced/dropped) —
  prevents fan-out amplification.
- **Global accounting**: daemon passes count against the same subagent
  concurrency ceiling so N1 + inline subagents can't jointly exceed the model
  budget (the host injects a shared `SubagentRunner` already subject to caps).

### 4.6 What N1 does NOT do (negative invariants)

- **No OS service** (launchctl/systemd/`com.anthropic.claude-daemon`). The
  daemon is an **in-process** supervise loop, dead when the process exits.
  Cross-restart persistence = Phase 3 (Claude's `daemon.json` + named pipe).
- **No worktree isolation** in Phase 1. A side-agent shares the main FS-jail
  and is, like a subagent, subject to the same permission gate. (Claude's
  worktree `bgIsolation` is a Phase-3 follow-up; until then a side-agent that
  *writes* must go through the normal permission/HARD_DENY path — and the
  recommended Phase-1 charters are **read-only monitors/observers**.)
- **No cross-process IPC / attach-from-another-terminal.** `attach` semantics
  (Claude `claude attach <id>`) require the durable supervisor; deferred.
- **No autonomous self-respawn of *new* daemons.** A daemon may not `spawn`
  another daemon (no recursion); only the main agent / CLI spawns. (Claude's
  self-respawning finder pool is explicitly out of scope — runaway risk.)
- **Daemon passes are READ-biased by default.** The spawn tool defaults the
  child to a read-only tool surface unless the spawner explicitly opts into a
  write-capable charter (and even then, every write re-enters the main
  permission gate).

### 4.7 Code shape

```
src/side-agent/
  types.ts        # closed ports + SideAgentSpec/Finding/Snapshot (pure leaf)
  registry.ts     # createSideAgentDaemonRegistry(opts) — the supervise loop
  index.ts        # barrel (only allowed import path)
src/agent/side-agent-runner.ts   # @/agent-side bridge: wraps runAgent → SubagentRunner
                                 #   (mirrors subagent-runner.ts) + mailbox/stream wiring
src/tool/side-agent/             # spawn/list/stop tools (default-OFF in surface manifest)
src/apps/cli/...                 # /sideagent slash + `quanta sideagent {spawn,list,stop}`
```

`@/side-agent` is a **pure library leaf** (imports `@/shared` + `@/subagent`
types + `@/agent/subagent-mailbox` types only). The `@/agent`-side bridge
(`side-agent-runner.ts`) is the sole place that touches `runAgent`, exactly as
`subagent-runner.ts:` bridges ADR-0130.

---

## 5. 통합 (Integration)

### 5.1 Default-OFF, byte-identical

- Env flag `QUANTA_SIDE_AGENT` (same shape/discipline as
  `SCHEDULER_ENV_FLAG = "QUANTA_SCHEDULER"`, `runtime.ts:44`). Absent ⇒ the
  registry is **never constructed**, the spawn tool is **not** added to the
  ToolRegistry, and the CLI verbs are hidden. Importing `@/side-agent`
  allocates nothing.
- The tool-surface manifest (`src/tool/surface/manifest.ts`) adds
  `side_agent_spawn` / `side_agent_list` / `side_agent_stop` as **GATED**
  entries (gate = `QUANTA_SIDE_AGENT`, default-OFF per surface, `risk` tagged).
  Drift guards in `tests/unit/tool-surface-manifest-*.test.ts` keep the SSOT
  honest.

### 5.2 CLI / slash surface (mirrors Claude verbs)

| Verb | Maps to | Claude analog |
|---|---|---|
| `quanta sideagent spawn --task … --every 30s --max-wakes 20` | `registry.spawn` | `claude --bg` / `/background` |
| `quanta sideagent list` | `registry.list` | `claude agents` |
| `quanta sideagent stop <id>` | `registry.stop` (conversation kept) | `claude stop <id>` |
| `/sideagent` (in-session) | spawn/list/stop inline | `/background` |

(`attach`/`rm` deferred with the durable-supervisor Phase 3.)

### 5.3 Tool to spawn from the agent?

Yes — a `side_agent_spawn` LLM-facing tool, **default-OFF**, `risk: high`,
`isConcurrencySafe: () => false`. It lets the model say "keep an eye on the test
suite while I work." Guardrails: bounded by `maxConcurrent`/`maxWakes`, no
daemon-spawns-daemon recursion (§4.6), read-biased child surface (§4.6). The
tool returns the handle id immediately (never blocks the parent turn) — the
parent reads findings later via a `side_agent_findings` drain tool or at
turn-boundary mailbox drain.

### 5.4 Feature catalog

Add a `대` "Background side-agent (daemon)" node under the background-execution
family in `docs/10.feature-catalog.md` (built via `bun fc build` from
`tools/feature-catalog/`). Initial maturity **L1 ●○○○○** (types/API only, loop
unwired) at seam-land, promotable to L3 once wired + unit-tested. Mark `⚙️`
(env-gated, behavior-preserving). Cross-reference the new ADR.

---

## 6. 테스트 계획 (Test Plan)

### 6.1 Hellgate batteries (`tests/unit/side-agent-*-hellgate.test.ts`)

- **Lifecycle FSM**: spawn→running; stop→stopped (idempotent, double-stop
  no-op); maxWakes reached→auto-stopped; idleReapMs elapsed→idle-reaped;
  runner-throw mid-pass→`failed` not propagated.
- **Bounds**: `spawn` past `maxConcurrent`→`SideAgentError("cap-exceeded")`
  (only throw); per-wake turn budget actually caps the child pass; maxWakes is
  a HARD ceiling (no off-by-one over-run); overlapping ticks during an in-flight
  pass are coalesced (no double-fire).
- **No-block-main (the headline invariant)**: `spawn()` returns synchronously
  while the runner is artificially slow (fake runner that never resolves) —
  assert the call site is not awaited; a concurrent main-loop tick proceeds.
- **Result-surfacing**: each wake publishes exactly one mailbox message to the
  main recipient; `findings({since})` returns only new ones; broadcast never
  delivered to the daemon's own id; stream `side-agent.finding` emitted iff a
  sink is injected.
- **Abort/teardown**: `stopAll()` cancels every in-flight pass; an aborted pass
  resolves `cancelled` (no leaked timer, `clearInterval` called); session
  shutdown drains cleanly.
- **Default-OFF**: with `QUANTA_SIDE_AGENT` unset, registry construction is a
  no-op and the tool surface is byte-identical (diff the manifest).
- **Runaway defense**: daemon-spawns-daemon is rejected; a charter that loops
  forever is bounded by maxWakes; idle reaper fires on a no-finding daemon.

### 6.2 Integration / e2e (`tests/integration/side-agent-e2e.test.ts`)

- Real `runAgent` + mock LLM: spawn an interval monitor that runs 3 wakes,
  asserts 3 findings land in the mailbox, main loop runs N turns in parallel
  unaffected, then `stop` and assert no further wakes.
- Event-trigger daemon: publish a stream-bus event, assert exactly one wake +
  one finding; unsubscribe on stop.
- Resource sharing: daemon passes + inline subagents jointly respect the shared
  concurrency ceiling (no over-budget fan-out).

### 6.3 Smoke (optional, tier-1 live)

Add a `tests/smoke/` declarative fixture: a "watch the build" daemon that tees
a bg-bash log and reports failures — exercises N1 ∘ bg-bash composition end to
end.

---

## 7. 단계 (Phases)

1. **Seam (L1).** `@/side-agent` types + `registry.ts` supervise loop over an
   injected fake runner + fake mailbox. Hellgate batteries §6.1. No host wiring.
   Default-OFF by construction (nothing imports it). New ADR.
2. **Wire (L3).** `src/agent/side-agent-runner.ts` bridge (`runAgent` →
   `SubagentRunner`) + mailbox + stream sink; turn-boundary findings drain in
   the main loop (guarded by `config.sideAgent?` — absent ⇒ byte-identical).
   Integration tests §6.2.
3. **Tool + CLI (L3→L4).** `side_agent_{spawn,list,stop,findings}` tools +
   manifest GATED entries + drift guards; `quanta sideagent` verbs + `/sideagent`
   slash; feature-catalog node.
4. **(Backlog, Phase 3) Durable supervisor.** Cross-restart persistence
   (serialize/hydrate like ADR-0130's `serialize()`), worktree isolation,
   `attach`/`rm`, OS-service install — the heavy Claude-parity layer, gated
   separately and only if demand is proven.

Each phase is independently default-OFF and regression-verified before the
next (per the hot-path-wiring-is-surgery lesson).

---

## 8. 리스크 / 대안 (Risks / Alternatives)

**A. "Just use subagent-bg in a loop."** Rejected as the *primary* mechanism:
re-`fork()`-in-a-loop scatters the supervisor logic (cadence, idle-reap, wake
coalescing, findings publication, bounds) across every caller and gives no
unified `list`/`stop`/accounting surface. N1 *is* that loop, owned once.
**However** — N1 reuses subagent-bg's runner + FSM internally (§3.3), so this
"alternative" is in fact the substrate, not a competitor.

**B. Runaway daemons** (the top risk). Mitigations: `maxConcurrent` (default 2,
lower than subagent-bg's 3), hard `maxWakes`, `idleReapMs`, no
daemon-spawns-daemon recursion, no overlapping wakes, shared global concurrency
ceiling, and `stopAll()` on session shutdown. A side-agent cannot outlive its
host process (no OS service in Phase 1) — the strongest backstop.

**C. Resource accounting / double-spend.** Daemon passes draw from the *same*
injected `SubagentRunner` subject to the host's concurrency + token caps, so a
daemon cannot create budget out of band. Findings publication is O(1) per wake
(one mailbox send). The mailbox's own eviction (`maxRetained`/`retentionMs`,
ADR-0416) bounds finding memory.

**D. Permission/safety drift.** A persistent agent writing to the repo while the
user works is dangerous. Mitigation: Phase-1 charters are **read-biased**
(§4.6); any write re-enters the *same* permission/HARD_DENY gate the main loop
uses (no bypass). Worktree isolation (Claude's real answer) is Phase 3.

**E. Surfacing noise.** A chatty monitor could flood the session. Mitigation:
findings are drained at **turn boundaries** (not mid-turn interrupts), injected
as a single coalesced system note, and the stream event is render-only. The
idle-reaper kills daemons that aren't producing signal.

**F. Alternative: extend the scheduler instead of a new slice.** Rejected: the
scheduler's effect is hard-wired to `enqueueUserMessage` onto the **main** loop
(`runtime.ts:253`) and its RRULE cadence floor is daily — wrong on both the
*target* (main thread vs side thread) and the *cadence* (daily vs sub-minute)
axes. N1 needs a side thread + sub-minute/event triggers + a push-findings
channel, none of which the scheduler offers without distorting it.

---

## 9. 코드 위치 요약 (Code-location summary)

**New (proposed):**
- `src/side-agent/types.ts` — closed ports `SideAgentDaemonRegistry`,
  `SideAgentSpec/Finding/Snapshot`, `SideAgentError` (pure leaf).
- `src/side-agent/registry.ts` — `createSideAgentDaemonRegistry(opts)`: the
  supervise loop, bounds, abort, mailbox/stream publication.
- `src/side-agent/index.ts` — barrel.
- `src/agent/side-agent-runner.ts` — `@/agent` bridge (`runAgent` →
  `SubagentRunner`); mirror of `src/agent/subagent-runner.ts`.
- `src/tool/side-agent/{spawn,list,stop,findings}.ts` — LLM-facing tools.
- `tests/unit/side-agent-*-hellgate.test.ts`,
  `tests/integration/side-agent-e2e.test.ts`.
- `docs/decisions/NNNN-side-agent-daemon.md` — the ADR (next free number).

**Reused (cited, unchanged):**
- `src/agent/subagent-background.ts:99,449` — ADR-0130 runner + FSM substrate.
- `src/agent/subagent-mailbox/{store,types}.ts` — ADR-0416 findings channel.
- `src/scheduler/runtime.ts:44,117` — cadence + default-OFF env-gate pattern
  (copied, not imported — keeps slice isolation).
- `src/runtime/bash-bg-registry.ts:142` — `killAll`/session-shutdown teardown
  pattern (and the optional internal compose target for log-tail monitors).
- `src/tool/surface/manifest.ts` — GATED tool entries + drift-guard SSOT.

**Modified (Phase 2/3 only, all guarded by `config.sideAgent?`):**
- main loop turn-boundary hook — drain `mailbox.pendingFor(main)` (absent
  config ⇒ byte-identical).
- `biome.json` — add the `@/side-agent` slice fence (library leaf: importable
  only by `@/agent`, like the other library slices at `biome.json:66-77`).
- `tools/feature-catalog/` — the new feature node.
