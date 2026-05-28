/**
 * ADR-0397 — Hook handler closure that drives the run ledger.
 *
 * The subscriber is the ONLY runtime-side surface in this slice. The
 * composition root subscribes it to the `post_tool_use` event on the
 * `HookBus`; the bus then calls the closure once per tool result. The
 * subscriber:
 *
 *   1. Validates the inbound event shape (NO-THROW; malformed ⇒ silent no-op).
 *   2. Runs the configured matcher (default = {@link createDefaultLedgerMatcher}).
 *   3. Best-effort invokes the ledger (`start` / `touch` / `settle`).
 *
 * NO-THROW is the load-bearing invariant: a `HookBus` handler that throws
 * would be caught by the bus, but a throw at the subscriber would log an
 * error and pollute the host's error stream. We do the catch ourselves to
 * keep the legacy bus-error log channel quiet on a misbehaving ledger.
 */

import { createDefaultLedgerMatcher } from "./matchers"
import type {
  LedgerAction,
  ObservedToolEvent,
  RunLedgerHookHandler,
  RunLedgerHookSubscriberDeps,
} from "./types"

const isObservedEvent = (e: unknown): e is ObservedToolEvent => {
  if (typeof e !== "object" || e === null) return false
  const rec = e as Record<string, unknown>
  return typeof rec.name === "string" && typeof rec.ok === "boolean"
}

/** Apply a single `LedgerAction` to the ledger. NO-THROW: a misbehaving
 *  ledger adapter (e.g. a stub in tests, a future remote-IPC store) MUST
 *  NOT bring down the hook bus. */
const applyAction = (ledger: RunLedgerHookSubscriberDeps["ledger"], action: LedgerAction): void => {
  try {
    if (action.kind === "start") {
      ledger.start({
        id: action.id,
        kind: action.runKind,
        owner: action.owner,
        title: action.title,
        ...(action.resumeAction !== undefined ? { resumeAction: action.resumeAction } : {}),
      })
      return
    }
    if (action.kind === "touch") {
      const patch: Parameters<typeof ledger.touch>[1] = {}
      if (action.status !== undefined) patch.status = action.status
      if (action.waitingOn !== undefined) patch.waitingOn = action.waitingOn
      ledger.touch(action.id, patch)
      return
    }
    // settle
    const opts: Parameters<typeof ledger.settle>[2] =
      action.error !== undefined ? { error: action.error } : undefined
    ledger.settle(action.id, action.status, opts)
  } catch {
    // Swallow — see file-level NO-THROW invariant.
  }
}

/** Build the hook handler closure. The caller subscribes it to the
 *  `post_tool_use` event of the `HookBus` (composition root). The closure
 *  itself imports NOTHING from `@/agent/hooks` — only its event SHAPE is
 *  used (validated defensively at the entry). */
export const createRunLedgerHookSubscriber = (
  deps: RunLedgerHookSubscriberDeps,
): RunLedgerHookHandler => {
  const matcher =
    deps.matcher ??
    createDefaultLedgerMatcher(deps.owner !== undefined ? { owner: deps.owner } : {})
  return (event: ObservedToolEvent): void => {
    try {
      if (!isObservedEvent(event)) return
      const action = matcher.match(event)
      if (action === null) return
      applyAction(deps.ledger, action)
    } catch {
      // Belt + braces — every interior path is already no-throw, but a future
      // matcher implementation may not be. The hook bus contract is preserved.
    }
  }
}
