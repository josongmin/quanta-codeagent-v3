import type { Message } from "@/llm"
import type { StructuredLogger } from "@/observability"
import { logger } from "@/shared"
import { isPathLikeToken, newSessionFlag, resolveResume, titleFlag } from "../internal"
import { switchToSessionCwd } from "../session-io"

/** Resolve the resume FSM and chdir into the resumed session's cwd if needed.
 *  Emits the "quanta ready" log line at the correct point in the sequence
 *  (BEFORE the FSM for legacy/path-mode, AFTER for id-mode). Fatal-exits on
 *  `--new-session --resume <id>` conflict or missing-id.
 *
 *  Extracted from `assembleReplContext` so the host stays small + the FSM
 *  ordering (which depends on flag combinations) is reviewable in isolation. */
export const driveResumeFsm = async (args: {
  readonly slog: StructuredLogger
  readonly provider: string
  readonly model: string
  readonly mode: string
  readonly cwd: string
  readonly initialSessionId: string
  readonly resume: string | undefined
}): Promise<{
  readonly cwd: string
  readonly sessionId: string
  readonly history: Message[]
  readonly idMeta: Awaited<ReturnType<typeof resolveResume>>["idMeta"]
}> => {
  const { slog, provider, model, mode, initialSessionId, resume } = args
  let cwd = args.cwd
  const newSession = newSessionFlag()
  const inIdModeAtStart = newSession || (resume !== undefined && !isPathLikeToken(resume))
  if (!inIdModeAtStart) {
    logger.info(`quanta ready (provider=${provider}, model=${model}, mode=${mode}, cwd=${cwd})`)
  }
  const resolved = await resolveResume({
    resume,
    newSession,
    title: titleFlag(),
    cwd,
    initialSessionId,
    slog,
    onSessionMinted: (id) => logger.info(`session: ${id}`),
  })
  if (resolved.conflictError !== undefined) {
    logger.error(resolved.conflictError)
    process.exit(1)
  }
  if (resolved.missingIdError !== undefined) {
    logger.error(`--resume: session id not found: ${resolved.missingIdError}`)
    process.exit(1)
  }
  const { idMeta } = resolved
  const history: Message[] = resolved.history
  const sessionId = resolved.sessionId
  if (idMeta) cwd = switchToSessionCwd(cwd, idMeta.cwd, slog)
  if (inIdModeAtStart && idMeta) {
    logger.info(
      `quanta ready (provider=${provider}, model=${model}, mode=${mode}, cwd=${cwd}, session=${idMeta.id})`,
    )
  }
  return { cwd, sessionId, history, idMeta }
}
