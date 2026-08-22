/**
 * WS-G (jul-10 uiux) — OperatorNotice bus (kernel).
 *
 * Root cause: silent degrade — surface/infra code swallows failures in
 * `catch {}` with ZERO operator signal (tee degrade, memory write-guard block,
 * hook held, preflight internal failure, replay row skip, MCP server death…).
 * This module is the ONE seam those sites emit through.
 *
 * Design (mirrors the fs-jail decision-sink precedent, see
 * `apps/cli/repl/session-setup.ts#setFsJailDecisionSink`): a module-level sink
 * slot the COMPOSITION ROOT fills once (the CLI REPL installs a stderr
 * renderer — `apps/cli/operator-notice.ts`); emitters anywhere call
 * {@link emitOperatorNotice} unconditionally. Lives in `@/shared` (the
 * universal leaf, like `logger`) so `@/agent` / `@/stream` / `@/runner`
 * emitters never need an upward import into `apps/**`.
 *
 * SAFETY CONTRACT (pinned by `tests/unit/cli/operator-notice-bus-hellgate.test.ts`):
 *   - no sink installed ⇒ emit is a total no-op (headless / bench / web
 *     surfaces that never install stay byte-identical);
 *   - a THROWING sink can never crash the emitter (notice = observation only);
 *   - install returns a disposer; a STALE disposer (superseded install) never
 *     clobbers the newer sink.
 */

export interface OperatorNotice {
  readonly severity: "info" | "warn" | "error"
  /** Short origin tag rendered before the message (e.g. `"/replay"`, `"mcp"`,
   *  `"memory"`, `"command-hooks"`). */
  readonly source: string
  readonly message: string
  /** Optional remediation / consequence hint, rendered in parens. */
  readonly hint?: string
}

export type OperatorNoticeSink = (notice: OperatorNotice) => void

let installedSink: OperatorNoticeSink | undefined

/** Install the process-wide operator-notice sink (composition root only —
 *  call ONCE per surface). A second install replaces the first (last-wins).
 *  Returns a disposer that uninstalls ONLY if this sink is still the active
 *  one (a stale disposer never clobbers a newer install). */
export const installOperatorNoticeSink = (sink: OperatorNoticeSink): (() => void) => {
  installedSink = sink
  return () => {
    if (installedSink === sink) installedSink = undefined
  }
}

/** Emit an operator notice. NO-THROW + no-op without a sink — surface code
 *  may call this unconditionally from any slice. */
export const emitOperatorNotice = (notice: OperatorNotice): void => {
  const sink = installedSink
  if (sink === undefined) return
  try {
    sink(notice)
  } catch {
    // A broken sink must never poison the emitting code path (the emitter is
    // usually already inside a degrade/catch branch).
  }
}

/** Test hygiene — clear the module-level slot between tests. */
export const __resetOperatorNoticeSinkForTest = (): void => {
  installedSink = undefined
}
