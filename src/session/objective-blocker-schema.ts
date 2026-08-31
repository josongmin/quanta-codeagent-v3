import { z } from "zod"

export const persistedObjectiveBlockerSchema = z.object({
  id: z.string(),
  dependencyId: z.string().min(1).max(512).optional(),
  reason: z.string(),
  waitingOn: z.string(),
  since: z.number().finite(),
})

export const persistedBlockerObservationSchema = z.object({
  observationId: z.string().min(1),
  waitingOn: z.enum(["user", "tool", "network", "child_agent"]),
  dependencyId: z.string().min(1).max(512).optional(),
  occurrences: z
    .array(
      z.object({
        attemptId: z.string().min(1).max(512),
        occurrenceEvidenceId: z.string().min(1).max(512),
        observedAt: z.number().finite().nonnegative(),
      }),
    )
    .min(1)
    .max(2)
    .optional(),
  // Legacy model-derived identity remains loadable only so the objective
  // adapter can discard it without rejecting the entire saved session.
  dependencyRef: z.string().min(1).max(2_100).optional(),
  distinctAttemptIds: z.array(z.string().min(1).max(512)).min(1).max(2).optional(),
  lastObservedAt: z.number().finite().nonnegative().optional(),
})
