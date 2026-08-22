/**
 * RFC-06 F5 — the kernel-side SKILL enable/disable front-door application (split
 * out of `scheduler.ts` to keep that module under the god-code cap).
 *
 * Routes `session.skill.set_enabled` through the SINGLE host projection
 * (`host.setSkillEnabled`, which applies the CAS `setEnabled` on the shared F1
 * authority). The typed-negative contract (RFC-06 F5 hard rule): `setSkillEnabled`
 * being ABSENT is NOT a silent success — it throws
 * {@link SessionSkillUnsupportedError}. A `stale_revision` / `unknown_skill` /
 * `policy_denied` / `persist_failed` outcome throws its typed
 * conflict/denied/persist error BEFORE any success echo is appended. Only a clean
 * `ok` returns; the scheduler then emits the reducer's session revision echo.
 */

import type { SessionSkillSetEnabledCommand } from "@/protocol/session"
import {
  SessionSkillConflictError,
  SessionSkillDeniedError,
  SessionSkillPersistError,
  SessionSkillUnsupportedError,
} from "@/protocol/session"
import type { KernelDispatchContext } from "./ports"

export const applySkillCommand = async (
  ctx: KernelDispatchContext,
  command: SessionSkillSetEnabledCommand,
): Promise<void> => {
  if (ctx.host.setSkillEnabled === undefined) {
    throw new SessionSkillUnsupportedError()
  }
  const outcome = await ctx.host.setSkillEnabled({
    name: command.name,
    enabled: command.enabled,
    ...(command.expectedSkillRevision !== undefined
      ? { expectedRevision: command.expectedSkillRevision }
      : {}),
  })
  if (outcome.ok) return
  switch (outcome.kind) {
    case "stale_revision":
      throw new SessionSkillConflictError(outcome.expected, outcome.actual)
    case "unknown_skill":
      throw new SessionSkillDeniedError(outcome.name, "unknown")
    case "policy_denied":
      throw new SessionSkillDeniedError(outcome.name, outcome.reason)
    case "persist_failed":
      throw new SessionSkillPersistError(outcome.detail)
  }
}
