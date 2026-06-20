import type { StopReason } from "@/agent"

/** Selection candidate generation should throw ONLY on hard terminal run
 *  failures that produced no scorable candidate. Model misses such as empty
 *  `max_turns` / `budget_exhausted` / `completed` candidates must still flow into selection
 *  scoring/telemetry as real no-patch candidates, not generation failures.
 *
 *  Contract: callers must thread the agent's TYPED terminal `stopReason`.
 *  A NON-EMPTY patch is already a scorable candidate, even if the model/stream
 *  died afterwards; only empty-patch error/refusal terminals are true generation
 *  failures. */
export const selectionGenerationErrorOf = (args: {
  stopReason: StopReason | undefined
  patch: string
  agentError?: string
}): string | undefined => {
  const hasPatch = args.patch.trim() !== ""
  if (
    args.stopReason === "completed" ||
    args.stopReason === "max_turns" ||
    args.stopReason === "budget_exhausted" ||
    args.stopReason === "aborted"
  ) {
    return undefined
  }
  if (args.stopReason === "refusal") {
    if (hasPatch) return undefined
    return "agent stopped with refusal before verification"
  }
  if (args.stopReason === "error") {
    if (hasPatch) return undefined
    return args.agentError ?? "agent stopped with error before verification"
  }
  return undefined
}
