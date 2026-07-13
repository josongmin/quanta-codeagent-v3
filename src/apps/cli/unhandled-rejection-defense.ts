import { errMessage, logger as defaultLogger } from "@/shared"
import type { Logger } from "@/shared"

/** Minimal surface of the process-level rejection listener target we need. Kept
 *  narrow so the CRITICAL contract (register EXACTLY once, never exit) can be
 *  exercised against a fake in unit tests without a live `process`. */
export interface RejectionListenerTarget {
  on(event: "unhandledRejection", handler: (reason: unknown) => void): unknown
  listenerCount?(event: "unhandledRejection"): number
}

/** Deps for the defense handler. `logger` defaults to the shared CLI logger.
 *
 *  There is DELIBERATELY no `exit` dep: the last-resort safety net must never
 *  end process lifetime (the loop owns that + owes trajectory finalisation).
 *  Omitting the seam entirely makes "never exit" a STRUCTURAL guarantee — a
 *  future edit that wanted to exit here would have to add a new dep, which the
 *  hellgate red-on-injection check pins. */
export interface UnhandledRejectionDefenseDeps {
  logger?: Pick<Logger, "error">
}

/** Pure factory for the R-Phase4 P3-1 defense-in-depth `unhandledRejection`
 *  handler. Byte-identical behaviour to the prior inline closure: it names the
 *  escaped rejection in a SINGLE stderr diagnostic line via `logger.error` and
 *  returns — it does NOT `process.exit`. */
export const makeUnhandledRejectionHandler = (
  deps: UnhandledRejectionDefenseDeps = {},
): ((reason: unknown) => void) => {
  const log = deps.logger ?? defaultLogger
  return (reason: unknown) => {
    const msg = errMessage(reason)
    log.error(`unhandled rejection (defense-in-depth): ${msg}`)
  }
}

/** Idempotent registration of the defense handler onto `target` (default:
 *  `process`). Registers the handler EXACTLY once per target; repeat calls are
 *  no-ops. Returns the handler that is (or was already) installed so callers /
 *  tests can verify wiring. */
const INSTALLED = new WeakSet<RejectionListenerTarget>()

export const installUnhandledRejectionDefense = (
  target: RejectionListenerTarget = process as unknown as RejectionListenerTarget,
  deps: UnhandledRejectionDefenseDeps = {},
): ((reason: unknown) => void) => {
  const handler = makeUnhandledRejectionHandler(deps)
  if (INSTALLED.has(target)) return handler
  INSTALLED.add(target)
  target.on("unhandledRejection", handler)
  return handler
}
