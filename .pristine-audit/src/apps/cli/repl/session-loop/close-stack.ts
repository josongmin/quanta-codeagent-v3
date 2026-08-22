import { errMessage, logger } from "@/shared"

/** A single LIFO teardown entry on the session close stack. */
export interface CloseStackEntry {
  readonly label: string
  readonly dispose: () => void | Promise<void>
}

/** The close-stack controller: the LIFO disposer registry + its idempotent
 *  drain + the init guard that drains on throw. Extracted verbatim from
 *  `runSessionLoop` so the loop stays under the god-function budget; the
 *  behavior is byte-identical (the `closeStackDrained` latch, the newest-first
 *  pop, the surfaced-not-rethrown disposer failure, and the drain-on-throw
 *  guard all move together, unchanged). */
export interface CloseStackController {
  /** L5 H-7 — the raw LIFO stack. Each resource registers its compensating
   *  teardown IMMEDIATELY after construction. */
  readonly closeStack: Array<CloseStackEntry>
  /** Run every disposer exactly once, newest-first. Surfaces (does not rethrow)
   *  disposer failures so one leaky teardown cannot mask the others. */
  readonly drainCloseStack: () => Promise<void>
  /** Wrap an awaited/throwing INIT step so a throw drains the close stack
   *  before rethrowing (an already-registered facade/session/watcher would
   *  otherwise leak). Idempotent drain ⇒ the branch finallys still compose. */
  readonly guardInit: <T>(step: () => T | Promise<T>) => Promise<T>
}

/** L5 H-7 — single close stack (LIFO disposer registry). Each resource
 *  registers its compensating teardown IMMEDIATELY after construction, so a
 *  throw during the REST of session init can never leave a runtimeFacade,
 *  session, or playbook watcher alive. `drainCloseStack` runs every disposer
 *  exactly once, newest-first, and surfaces (does not rethrow) disposer
 *  failures so one leaky teardown cannot mask the others (L5 M-1: MCP stop
 *  failure is no longer swallowed silently — it lands as a warn here). */
export const createCloseStackController = (): CloseStackController => {
  const closeStack: Array<CloseStackEntry> = []
  let closeStackDrained = false
  const drainCloseStack = async (): Promise<void> => {
    if (closeStackDrained) return
    closeStackDrained = true
    while (closeStack.length > 0) {
      const entry = closeStack.pop()
      if (entry === undefined) break
      try {
        await entry.dispose()
      } catch (e) {
        logger.warn(`session-loop teardown "${entry.label}" failed: ${errMessage(e)}`)
      }
    }
  }
  // Audit R1 C-F1 + R2 #2: every awaited/throwing INIT step that runs in the gap
  // between a close-stack registration and the branch try/finally blocks must
  // drain on throw — otherwise an already-registered facade/session/watcher
  // leaks. Wrapping each such step in `guardInit` closes the whole class (R1
  // missed `createSession`, which R2 then found). Drain is idempotent, so the
  // branch finallys still compose. Sync steps (e.g. attachPlaybookHandle) work
  // too — `await step()` accepts a non-promise return.
  const guardInit = async <T>(step: () => T | Promise<T>): Promise<T> => {
    try {
      return await step()
    } catch (e) {
      await drainCloseStack()
      throw e
    }
  }
  return { closeStack, drainCloseStack, guardInit }
}
