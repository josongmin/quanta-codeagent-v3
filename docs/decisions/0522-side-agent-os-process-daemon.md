# ADR-0522: Side-agent OS-PROCESS daemon V1 — a forked, supervised child with exponential-backoff respawn

- **상태**: Proposed
- **날짜**: 2026-06-09
- **관련**:
  - ADR-0483 (background side-agent daemon — the IN-PROCESS resident registry this V1 is the OS-process counterpart of; ADR-0483 explicitly scoped its daemon to the MAIN thread and named "spawned as a separate OS process" a Phase-1 NON-GOAL / HIGH OS-integration follow-up — THIS ADR is that follow-up's V1 core)
  - ADR-0130 (one-shot background subagent — the per-wake fork substrate the in-process registry reuses; the OS-process daemon is a DIFFERENT axis: a resident forked child supervised across crashes, not a one-shot pass)
- **참조**:
  - `src/side-agent/process.ts` — the PURE-LEAF V1 core: `SideAgentIpcMessage` (closed union: `charter`/`shutdown` parent→child, `ready`/`finding` child→parent), `ProcessForkSpec`, `ChildProcessHandle` (`send`/`onMessage`/`onExit`/`kill`, NO-THROW), `ProcessForkPort` (the single OS seam), `DelayScheduler` (injected backoff timer), `backoffForAttempt` (pure exponential `base*2^(n-1)` clamped to cap, exponent clamped at 30 so a large `n` never overflows to Infinity), and `createSupervisedProcessDaemon` (the supervisor: fork → `ready` → hand charter → `running`; UNEXPECTED exit ⇒ exponential-backoff respawn bounded by `maxRestarts` ⇒ `crashed-permanently`; clean `stop()` ⇒ no respawn; `stop()` mid-backoff cancels the pending respawn). No `Date.now`/`setTimeout`/`RNG`/concrete import of its own — every effect is an injected port (slice isolation: `@/side-agent` reaches nothing).
  - `src/host/runtime/side-agent-fork-port.ts` — the REAL OS adapter `nodeProcessForkPort: ProcessForkPort` over `node:child_process.fork` (the SINGLE place coupling the pure supervisor to `fork`). `serialization:"advanced"` preserves structured-clone fidelity of the typed IPC messages; `stdio:["ignore","inherit","inherit","ipc"]` opens the IPC channel; `wrapChild` swallows `ERR_IPC_CHANNEL_CLOSED`/EPIPE on a racing exit (the `onExit` path is the authoritative liveness signal, not a thrown send) and trust-boundary-filters inbound messages to well-formed `{kind}` objects from our own worker.
  - `src/side-agent/index.ts` — the slice barrel re-exporting the V1 core (`createSupervisedProcessDaemon`, `backoffForAttempt`, the IPC + port types).
  - `src/shared/runtime-config.ts` — `runtimeConfig().sideAgentProcess = gateOn(env, "QUANTA_SIDE_AGENT_PROCESS")` (default false ⇒ the side-agent registry runs in-process, byte-identical).
  - `src/shared/runtime-config-knobs.ts` — the `QUANTA_SIDE_AGENT_PROCESS` bool knob (group `subagent`, default false).
  - Tests: `tests/unit/side-agent-process-supervisor-hellgate.test.ts` (the supervisor FSM over a FAKE fork + a MANUAL scheduler — ready/charter/finding/crash-respawn/backoff-clamp/stop-no-respawn/stop-mid-backoff-cancel), `tests/integration/side-agent-process-os-fork-e2e.test.ts` (the REAL `nodeProcessForkPort` forking `tests/fixtures/side-agent-worker.mjs` — a finding crossing the real OS IPC boundary + a real respawn after a real crash).
  - Feature catalog: `tools/feature-catalog/features/09-integration/side-agent-process.yaml`.

## 맥락

ADR-0483 landed the side-agent daemon as an **in-process** resident registry: every side-agent runs on the MAIN thread via an injected per-wake `runner`. That is correct for cheap monitors, but it has two structural ceilings the audit (§4.3) and the Codex side-agent fleet flagged:

1. **No fault isolation.** A side-agent pass that hangs, leaks, or hard-crashes takes down the main agent process with it — there is no OS boundary to contain a runaway child.
2. **No supervised respawn.** A resident monitor that should survive a transient child crash (OOM, a flaky tool, a panic in a forked tool) has no respawn discipline in-process; the registry's per-wake `maxWakes` is a count guard, not a crash-recovery loop.

The competitor baseline (Codex's side-agent fleet) runs each side-agent as a **separate OS process** with socket/pipe IPC and a supervisor that respawns on unexpected exit with exponential backoff. ADR-0483 named exactly this — "a daemon SPAWNED AS A SEPARATE OS PROCESS … supervised crash-respawn" — a Phase-1 **non-goal**, deferred as a HIGH OS-integration item.

This ADR ships the **V1 core** of that follow-up: the fork / supervise / respawn / give-up cycle, fully mockable end-to-end, behind a default-OFF gate.

## 결정

Add a PURE-LEAF supervisor (`src/side-agent/process.ts`) over an injected `ProcessForkPort`, with the REAL `node:child_process.fork` adapter isolated at the host composition root (`src/host/runtime/side-agent-fork-port.ts`). Specifically:

- **Port-injected OS layer.** The supervisor depends only on `ProcessForkPort.fork(spec) → ChildProcessHandle` and a `DelayScheduler`. No `Date.now`/`setTimeout`/`fork`/`RNG` of its own ⇒ the full fork → run → crash → backoff → respawn → give-up cycle is driven DETERMINISTICALLY in unit tests over a fake fork + manual scheduler. The real OS adapter is exercised by a separate integration test that forks a genuine child module.
- **Closed typed IPC.** `SideAgentIpcMessage` is a closed union (`charter`/`shutdown` parent→child, `ready`/`finding` child→parent) so the wire format is auditable; the adapter trust-boundary-filters inbound messages to well-formed `{kind}` objects.
- **NO-THROW handle.** `send`/`kill` on a dead child are swallowed; `onExit` is the authoritative liveness signal (a racing `ERR_IPC_CHANNEL_CLOSED` never propagates as an uncaught throw).
- **Bounded exponential-backoff respawn.** An UNEXPECTED exit ⇒ respawn after `backoffForAttempt(n) = min(base*2^(n-1), cap)` (exponent clamped at 30 so a large `n` never overflows to Infinity), up to `maxRestarts`, past which the daemon is `crashed-permanently` and stays down (the runaway guard). A clean `stop()` is EXPECTED — no respawn — and `stop()` mid-backoff cancels the pending respawn.
- **Default-OFF, byte-identical.** Gated behind `QUANTA_SIDE_AGENT_PROCESS` (`runtimeConfig().sideAgentProcess`, default false). Absent the gate, NOTHING constructs the supervisor — the side-agent registry runs in-process exactly as ADR-0483 (byte-identical).

**V1 scope intentionally EXCLUDES**: launchctl/systemd unit generation, a multi-daemon OS MANAGER (a registry over many processes), and a dedicated unix-socket transport (the default Node IPC pipe satisfies the audit's "socket IPC" via the structured-message channel). Those are the named depth follow-ups.

**Wiring posture (V1).** The V1 core + the real OS adapter ship LIVE-tested (the integration test forks a real child), but the host composition root does NOT yet construct the supervisor in the live CLI: `maybeWireSideAgent` (the `QUANTA_SIDE_AGENT` bind in `src/host/runtime/agent-config-assembler.ts`) still mints only the in-process registry and does not yet read `sideAgentProcess`. Promoting `QUANTA_SIDE_AGENT_PROCESS` to a live composition-root branch (fork-backed registry behind the gate) is the explicit promotion path; until then this slice is an export-/test-only seam (recorded as a `deliberate_hold` in the feature catalog).

## 결과

- **(+) Fault isolation + supervised recovery** become expressible: a side-agent can run as a contained OS child that the supervisor respawns across transient crashes, bounded so a hard-failing child cannot spin forever.
- **(+) Deterministic testability**: the supervisor is the ONLY stateful piece and every effect is injected, so the crash/backoff/respawn schedule is asserted exactly (unit) and proven over a real fork (integration).
- **(+) Zero default cost**: default-OFF ⇒ byte-identical to the in-process daemon; no new OS process is ever spawned unless the operator opts in.
- **(−) Not yet live-wired**: the gate flips a `runtimeConfig` boolean that no composition-root branch reads yet — so turning `QUANTA_SIDE_AGENT_PROCESS` on today has no runtime effect beyond the config value. The promotion path (host bind in `maybeWireSideAgent`) is owned by the side-agent host-wiring lane and tracked as the slice's `deliberate_hold`.
- **(−) V1 transport is the Node IPC pipe**, not a dedicated unix socket; the structured-message channel covers the audit requirement but a socket transport remains a depth follow-up.

### 대안

- **Keep everything in-process (status quo).** Rejected: no fault isolation, no supervised respawn — the two ceilings the audit flagged.
- **Generate launchctl/systemd units now.** Rejected for V1: platform-specific, heavy, and orthogonal to the core fork/supervise/respawn discipline; deferred as a depth follow-up once the core is proven.
- **Couple the supervisor directly to `node:child_process.fork`.** Rejected: it would make the supervisor untestable without spawning real processes on every run and would violate the slice-isolation posture (`@/side-agent` must reach nothing). The `ProcessForkPort` seam keeps the OS coupling at the single host adapter.
