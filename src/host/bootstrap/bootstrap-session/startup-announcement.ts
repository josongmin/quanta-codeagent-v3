/**
 * `@/host/bootstrap/bootstrap-session/startup-announcement` — WHAT the session
 * says on the way up, and WHICH session it comes up as.
 *
 * SINGLE RESPONSIBILITY: the startup announcement surface. One predicate
 * ({@link inInteractiveBanner}) decides whether the interactive welcome banner
 * will paint, and everything else here is downstream of that single decision:
 * the human "quanta ready" / "session:" lines are suppressed when the banner
 * duplicates them, the structured (JSONL) logger floor is raised so `info`
 * events do not spray above the box, and {@link resolveSessionResume} — the sole
 * emitter of those lines — runs the resume FSM and switches to the resumed
 * session's cwd between them. Pipe / one-shot / CI paths (no banner) stay
 * byte-identical.
 *
 * Split out of `bootstrap-session.ts` (god-module cap) — VERBATIM relocation, no
 * behavior delta. One-way edges: it imports `./bootstrap-fault` only; the
 * prologue and `assembleBootstrapResult` import it.
 */

import type { Message } from "@/llm"
import type { StructuredLogger } from "@/observability"
import { isPathLikeToken } from "@/runner/orchestrate"
import { type Logger, logger } from "@/shared"
import type { BootstrapFeatures, SessionBootstrapDeps, SessionRuntimeConfigShape } from "../types"
import { failSessionBootstrap } from "./bootstrap-fault"

/**
 * jun-10 — gate the legacy stderr startup lines on whether the interactive
 * welcome banner (repl.ts) will paint. The banner is the surface's first frame
 * and already shows provider/model/mode/cwd/session, so when it renders the
 * three legacy lines ("[info] quanta ready", "[info] session: <id>", and the
 * structured `session.id_mode.on` JSONL) are pure duplication noise above the
 * box. The banner renders on exactly this condition: no positional prompt +
 * stderr is a TTY. Return `undefined` (⇒ a no-op `?.info`, suppressing the
 * human lines) in that case; otherwise the live `logger` (pipe / one-shot /
 * CI — the banner never shows there, so the lines remain the ONLY ready
 * signal, byte-identical). Finishes the migration the welcome-banner docblock
 * describes ("Replaces the bare `[info] quanta ready` + JSONL config dumps").
 */
const inInteractiveBanner = (runtime: SessionRuntimeConfigShape): boolean =>
  runtime.argPrompt === undefined && runtime.stderrIsTTY === true

const startupReadyLogger = (runtime: SessionRuntimeConfigShape): Logger | undefined =>
  inInteractiveBanner(runtime) ? undefined : logger

/** Floor for the session's structured (JSONL) logger. The same feature-on
 *  startup events (`lsp.nav.on`, `lsp.diagnostics.on`, `mcp.tools.loaded`, …)
 *  that the human lines duplicate are also emitted as `slog.info` JSONL, and in
 *  the interactive surface they spray raw JSON above the welcome box (stderr is
 *  the same TTY the banner paints to). When the banner renders AND the user has
 *  not explicitly pinned `QUANTA_LOG_LEVEL`, raise the floor to `warn` so those
 *  info events fall silent while real warn/error JSONL still surfaces. An
 *  explicit level (incl. `debug` for troubleshooting) is honored verbatim, and
 *  pipe / one-shot / CI (no banner) stay byte-identical (`undefined` ⇒ live
 *  `runtimeConfig().logLevel`). */
export const interactiveStructuredLogLevel = (
  runtime: SessionRuntimeConfigShape,
): "warn" | undefined =>
  inInteractiveBanner(runtime) && runtime.env.QUANTA_LOG_LEVEL === undefined ? "warn" : undefined

/** Emit a human startup line through the gated logger — a no-op when the
 *  welcome banner renders (`log` is then `undefined`). Wrapping the `?.` here
 *  keeps it out of `bootstrapSession`'s body so its cognitive complexity stays
 *  at the pre-jun-10 baseline. */
const emitStartupLine = (log: Logger | undefined, msg: string): void => {
  log?.info(msg)
}

/** Emit the gated startup lines, run the resume FSM, and switch to the resumed
 *  session's cwd. Returns the resolved `{ cwd, idMeta, history, sessionId }`.
 *  Verbatim relocation of the inline resume cluster — same conditional logs,
 *  same `failSessionBootstrap` short-circuits, same cwd-switch order. */
export const resolveSessionResume = async (
  deps: SessionBootstrapDeps,
  runtime: SessionRuntimeConfigShape,
  slog: StructuredLogger,
  features: BootstrapFeatures,
  initialSessionId: string,
): Promise<{
  readonly cwd: string
  readonly idMeta: Awaited<ReturnType<SessionBootstrapDeps["resolveResume"]>>["idMeta"]
  readonly history: Message[]
  readonly sessionId: string
  /** RFC-03 C2 — the reopened session's durable objective snapshot (id-mode
   *  resume only). Threaded onto the bootstrap result so the surface restores the
   *  goal authority. Absent on fresh/legacy/no-objective sessions. */
  readonly objective: Awaited<ReturnType<SessionBootstrapDeps["resolveResume"]>>["objective"]
}> => {
  let cwd = runtime.cwd
  // `startupLog` is `undefined` when the welcome banner will render (see
  // `startupReadyLogger`), so the `?.info` below no-ops the redundant
  // "quanta ready" / "session:" lines; `quietIdModeLog` likewise suppresses
  // the structured `session.id_mode.on` echo. Non-interactive ⇒ live logger.
  const startupLog = startupReadyLogger(runtime)
  const inIdModeAtStart =
    runtime.newSession || (features.resume !== undefined && !isPathLikeToken(features.resume))
  if (!inIdModeAtStart) {
    emitStartupLine(
      startupLog,
      `quanta ready (provider=${runtime.provider}, model=${runtime.model}, mode=${runtime.mode}, cwd=${cwd})`,
    )
  }
  const resolved = await deps.resolveResume({
    resume: features.resume,
    newSession: runtime.newSession,
    title: runtime.title,
    cwd,
    initialSessionId,
    slog,
    quietIdModeLog: startupLog === undefined,
    onSessionMinted: (id) => emitStartupLine(startupLog, `session: ${id}`),
  })
  if (resolved.conflictError !== undefined) {
    failSessionBootstrap("resume_conflict", resolved.conflictError)
  }
  if (resolved.missingIdError !== undefined) {
    failSessionBootstrap(
      "resume_missing_id",
      `--resume: session id not found: ${resolved.missingIdError}`,
    )
  }
  const { idMeta } = resolved
  const history: Message[] = resolved.history
  const sessionId = resolved.sessionId
  if (idMeta) cwd = deps.switchToSessionCwd(cwd, idMeta.cwd, slog)
  if (inIdModeAtStart && idMeta) {
    emitStartupLine(
      startupLog,
      `quanta ready (provider=${runtime.provider}, model=${runtime.model}, mode=${runtime.mode}, cwd=${cwd}, session=${idMeta.id})`,
    )
  }
  return { cwd, idMeta, history, sessionId, objective: resolved.objective }
}
