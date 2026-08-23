/**
 * RFC-03 M7 — the kernel-side OBJECTIVE mutate front-door application (split out
 * of `scheduler.ts` to keep that module under the god-code cap, mirroring
 * `posture-command.ts` / `skill-command.ts`).
 *
 * Routes `session.objective.mutate` through the SINGLE host projection
 * (`host.mutateObjective`, which applies the CAS `prepare`/`commit` on the shared
 * objective authority as actor `user`). The typed-negative contract (M7 hard
 * rule): a `stale_revision` outcome throws {@link SessionObjectiveConflictError}
 * and any other `rejected` arm throws {@link SessionObjectiveRejectedError}
 * BEFORE the reducer's success echo is appended — a stale/policy-rejected wire
 * mutate must CONFLICT, never a silent `session.state.updated`.
 *
 * UNLIKE posture/skill, the host method being ABSENT is NOT an unsupported error:
 * the objective domain is optional and a host that wired no authority is a benign
 * no-op echo (the reducer already emitted the revision bump) — so an absent
 * `mutateObjective` simply returns, preserving the legacy byte-identical path.
 */

import type { SessionObjectiveMutateCommand } from "@/protocol/session"
import { SessionObjectiveConflictError, SessionObjectiveRejectedError } from "@/protocol/session"
import type { KernelDispatchContext } from "./ports"

export const applyObjectiveCommand = async (
  ctx: KernelDispatchContext,
  command: SessionObjectiveMutateCommand,
): Promise<void> => {
  // Absent host projection ⇒ benign no-op (the reducer already echoed the
  // revision bump) — byte-identical to the legacy `?.` fire-and-forget path.
  if (ctx.host.mutateObjective === undefined) return
  const outcome = await ctx.host.mutateObjective({
    mutation: command.mutation,
    ...(command.expectedObjectiveRevision !== undefined
      ? { expectedRevision: command.expectedObjectiveRevision }
      : {}),
  })
  if (outcome.ok) return
  if (outcome.kind === "stale_revision") {
    throw new SessionObjectiveConflictError(outcome.expected, outcome.actual)
  }
  throw new SessionObjectiveRejectedError(outcome.reason)
}
