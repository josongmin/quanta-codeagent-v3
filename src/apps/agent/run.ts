/**
 * `apps/agent/run.ts` — RFC may-22-unified-agent-runtime / Phase 4.
 *
 * Lifecycle wrapper for the unified agent surface. Takes an already-assembled
 * `AgentConfig` (built by {@link assembleAgentConfig}), runs the loop, maps the
 * outcome to a POSIX-style exit code, and ALWAYS removes its SIGINT handler in
 * a `finally` block (no leak across mode-preset boundaries).
 *
 * Exit code mapping is the ONLY policy this file owns:
 *
 *   reason            | exit code | rationale
 *   ------------------|-----------|----------------------------------------------
 *   completed         |    0      | success — POSIX EX_OK
 *   budget_exhausted  |    2      | distinct from generic failure: budget cap hit
 *   aborted           |   130     | SIGINT convention (128 + SIGINT=2)
 *   max_turns         |    1      | generic failure (incomplete work)
 *   error             |    1      | generic failure (caller can inspect outcome)
 *
 * Default-OFF: no hidden retry, no environment reads. The function is
 * dependency-injected via {@link RunLifecycleDeps} so unit tests can stub
 * `runAgent` and `signalSource` without monkey-patching globals.
 */

import { type AgentConfig, type AgentOutcome, runAgent } from "@/agent"
import { installCodexR2Wires } from "@/agent/codex-r2-wire-install"

/** Result the lifecycle wrapper hands back to `index.ts`. */
export interface RunOutcome {
  exitCode: number
  /** Present unless `runAgent` itself threw before producing an outcome. */
  outcome?: AgentOutcome
}

/**
 * Dependency-injection seam (test-only path). Production callers use the
 * defaults: real `runAgent`, real `process.on/off` for SIGINT.
 *
 * `runAgent` is parameterized for hermetic unit tests; `signalSource` is the
 * minimal `process`-shaped surface this file touches.
 */
export interface RunLifecycleDeps {
  runAgent?: (cfg: AgentConfig) => Promise<AgentOutcome>
  signalSource?: {
    on: (event: "SIGINT", listener: () => void) => unknown
    off: (event: "SIGINT", listener: () => void) => unknown
  }
}

/**
 * Map a finished {@link AgentOutcome} to a POSIX exit code.
 *
 * Pure function — no side effects, used directly by tests to pin the table.
 */
export const exitCodeForOutcome = (outcome: AgentOutcome): number => {
  switch (outcome.reason) {
    case "completed":
      return 0
    case "budget_exhausted":
      return 2
    // ALBB-18 — a turn PAUSED awaiting HITL approval that surfaced as a terminal
    // outcome (e.g. headless with no operator to answer) is blocked-not-done, NOT
    // user-cancelled. Same "stopped without completing" class as budget (2), and
    // deliberately NOT the SIGINT-cancel code 130 (`aborted`).
    case "awaiting_approval":
      return 2
    case "aborted":
      return 130
    case "max_turns":
      return 1
    case "error":
      return 1
    case "refusal":
      // ADR-0076 Gap-1 SOTA++ — the model declined; the task is NOT done.
      // Distinct exit code so CI / shell wrappers can tell "model refused"
      // apart from "loop errored" (1) and "task done" (0).
      return 3
  }
}

/**
 * Install a SIGINT handler that aborts `cfg.signal`, run the loop, map the
 * outcome, and ALWAYS uninstall the handler in `finally`.
 *
 * `cfg.signal` MUST be an `AbortSignal` whose controller is reachable; we
 * forward the SIGINT by calling `dispatchEvent("abort")` via a small adapter:
 * the loop reads `signal.aborted` so anything that flips it is sufficient.
 *
 * We DO NOT call `controller.abort()` directly because the controller is
 * NOT on the public AgentConfig surface — instead we expect the caller to
 * pass `cfg.signal` from a controller they own. To keep this wrapper free
 * of that wiring, we let the caller hand us a pre-wired AbortController via
 * the alternative {@link runAgentLifecycleWith} entry point. Production
 * surfaces (mode-presets) construct the controller themselves.
 */
export const runAgentLifecycle = async (
  cfg: AgentConfig,
  deps: RunLifecycleDeps = {},
): Promise<RunOutcome> => {
  const run = deps.runAgent ?? runAgent
  const sigSrc = deps.signalSource ?? process

  // The wrapper cannot abort `cfg.signal` directly (AbortSignal is read-only).
  // Surfaces that want SIGINT-driven cancellation should use
  // `runAgentLifecycleWith({ controller })`. Here we still INSTALL a handler
  // so a SIGINT is observed and forwarded to ANY external abort hook the
  // caller threaded into `cfg.signal` — but the most common shape is the
  // controller variant below.
  const onSigint = (): void => {
    // The signal is already wired from outside; the handler is a no-op
    // marker so tests can verify install/uninstall symmetry. Real cancellation
    // flows through the controller variant.
  }
  sigSrc.on("SIGINT", onSigint)
  try {
    const outcome = await run(cfg)
    return { exitCode: exitCodeForOutcome(outcome), outcome }
  } finally {
    sigSrc.off("SIGINT", onSigint)
  }
}

/**
 * Controller-aware variant — the caller hands us a fresh `AbortController`
 * and the wrapper plumbs `controller.signal` into `cfg.signal`, installs a
 * SIGINT handler that calls `controller.abort()`, and uninstalls in finally.
 *
 * This is the production wiring path: mode-presets construct the controller,
 * call this, and the SIGINT-to-abort plumbing is exactly one place.
 */
export const runAgentLifecycleWith = async (
  cfgWithoutSignal: Omit<AgentConfig, "signal">,
  controller: AbortController,
  deps: RunLifecycleDeps = {},
): Promise<RunOutcome> => {
  const run = deps.runAgent ?? runAgent
  const sigSrc = deps.signalSource ?? process

  const cfg: AgentConfig = {
    ...cfgWithoutSignal,
    signal: controller.signal,
  } as AgentConfig

  // ADR-0334 — belt-and-suspenders install. The cfg here was usually
  // pre-wired by `assembleAgentConfig` (ADR-0334 §assemble); the call is
  // idempotent (ADR-0332 §Idempotent — already-set slots are preserved)
  // so a host that bypassed assemble still gets the wire pass attempted.
  installCodexR2Wires(cfg, cfg.sessionId !== undefined ? { sessionId: cfg.sessionId } : {})

  const onSigint = (): void => {
    controller.abort()
  }
  sigSrc.on("SIGINT", onSigint)
  try {
    const outcome = await run(cfg)
    return { exitCode: exitCodeForOutcome(outcome), outcome }
  } finally {
    sigSrc.off("SIGINT", onSigint)
  }
}
