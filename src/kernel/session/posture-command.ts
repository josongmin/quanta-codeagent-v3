/**
 * RFC-05 E4 — the kernel-side posture front-door application (split out of
 * `scheduler.ts` to keep that module under the god-code cap).
 *
 * Routes BOTH the posture front door (`session.posture.set`, patch+scope
 * verbatim) and the legacy `session.permission.set` COMPATIBILITY ADAPTER (a
 * `{ mode }` patch at `scope: "current"`) through the SINGLE host projection
 * (`host.setPosture`) — one code path, no both-old-and-new arm.
 *
 * The typed-negative contract (RFC-05 E4 RED (b) / hard rule): `host.setPosture`
 * being ABSENT is NOT a silent success — it throws
 * {@link SessionPostureUnsupportedError}. A `stale_revision` / `persist_failed`
 * outcome throws its typed conflict/persist error. Only a clean `ok` returns; the
 * scheduler then reconciles the fresh posture echo from `describe()`.
 */

import type { SessionPermissionSetCommand, SessionPostureSetCommand } from "@/protocol/session"
import {
  SessionPostureConflictError,
  SessionPosturePersistError,
  SessionPostureUnsupportedError,
} from "@/protocol/session"
import type { KernelDispatchContext } from "./ports"

export const applyPostureCommand = async (
  ctx: KernelDispatchContext,
  command: SessionPostureSetCommand | SessionPermissionSetCommand,
): Promise<void> => {
  if (ctx.host.setPosture === undefined) {
    throw new SessionPostureUnsupportedError()
  }
  const args =
    command.type === "session.posture.set"
      ? {
          patch: command.patch,
          scope: command.scope,
          ...(command.expectedPostureRevision !== undefined
            ? { expectedRevision: command.expectedPostureRevision }
            : {}),
        }
      : // Compatibility adapter: mode-only patch, current-thread scope, no CAS
        // (the legacy verb carried no posture-domain revision).
        { patch: { mode: command.mode }, scope: "current" as const }
  const outcome = await ctx.host.setPosture(args)
  if (outcome.ok) return
  if (outcome.kind === "stale_revision") {
    throw new SessionPostureConflictError(outcome.expected, outcome.actual)
  }
  throw new SessionPosturePersistError(outcome.detail)
}
