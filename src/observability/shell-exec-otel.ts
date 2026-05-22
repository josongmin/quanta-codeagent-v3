import type { ShellExecEvent, ShellExecObserver } from "@/tool"
import type { Metrics } from "./metrics"

/**
 * OTel-bound observer for ADR-0081 shell exec events — fans the typed stream
 * into the existing `Metrics` registry so the `handle_tool_call{name=bash}`
 * span (or any later aggregator) can read accurate chunk + byte counters
 * without re-buffering the child's output.
 *
 * Counter vocabulary (stable, snake_case to match Codex otel attribute keys):
 *   - `shell.exec.runs`                  total runs observed (one start ⇒ +1)
 *   - `shell.exec.stdout.chunks`         per-stream chunk counts
 *   - `shell.exec.stderr.chunks`
 *   - `shell.exec.stdout.bytes`          per-stream byte totals
 *   - `shell.exec.stderr.bytes`
 *   - `shell.exec.exits.{code|null}`     terminal disposition tally
 *   - `shell.exec.aborts.{user_abort|timeout}`
 *
 * Wire pattern: `composeShellObservers(buildShellOtelObserver(metrics),
 * buildShellStreamPainter())` for a CLI run, or just the OTel one in
 * non-interactive (bench/ci-bot) modes.
 *
 * Default-OFF posture: `Metrics` is itself opt-in (`AgentConfig.metrics`).
 * Hosts that don't wire `metrics` simply don't build this observer — the
 * runShell event allocation is gated on `AgentConfig.onShellEvent` being
 * present at all.
 */
export const buildShellOtelObserver = (metrics: Metrics): ShellExecObserver => {
  return (event: ShellExecEvent): void => {
    switch (event.kind) {
      case "start":
        metrics.counter("shell.exec.runs").inc()
        return
      case "stdout":
        metrics.counter("shell.exec.stdout.chunks").inc()
        metrics.counter("shell.exec.stdout.bytes").inc(event.chunk.byteLength)
        return
      case "stderr":
        metrics.counter("shell.exec.stderr.chunks").inc()
        metrics.counter("shell.exec.stderr.bytes").inc(event.chunk.byteLength)
        return
      case "exit":
        metrics.counter(`shell.exec.exits.${event.code ?? "null"}`).inc()
        return
      case "aborted":
        metrics.counter(`shell.exec.aborts.${event.reason}`).inc()
        return
      default: {
        // Exhaustive: a new ShellExecEvent variant breaks this at compile
        // time and forces a counter decision (ADR-0081 invariant). We do NOT
        // `return` the value (biome forbids returning from a void function).
        const _exhaustive: never = event
        void _exhaustive
      }
    }
  }
}
