import { z } from "zod"

/** Versioned verifier execution contract persisted with checked completion. */
export const persistedVerifierExecutionPostureSchema = z.discriminatedUnion("contractVersion", [
  z.object({
    contractVersion: z.literal(1),
    profile: z.literal("workspace-write"),
    network: z.literal("deny"),
    sandboxApplied: z.literal(true),
    runnerVersion: z.string().min(1).max(128),
  }),
  z.object({
    contractVersion: z.literal(0),
    profile: z.literal("unknown"),
    network: z.literal("unknown"),
    sandboxApplied: z.literal(false),
    runnerVersion: z.literal("unknown"),
  }),
])
