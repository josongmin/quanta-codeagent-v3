import type { StopReason } from "@/agent"

/** Selection candidate generation should throw ONLY on hard terminal run
 *  failures that produced no scorable candidate. Model misses such as empty
 *  `max_turns` / `budget_exhausted` / `completed` candidates must still flow into selection
 *  scoring/telemetry as real no-patch candidates, not generation failures. */
export const selectionGenerationErrorOf = (args: {
  stopReason: StopReason | undefined
  agentError?: string
}): string | undefined => {
  if (
    args.agentError !== undefined &&
    /max[\s_-]turns|turns[\s_-]exhausted|token budget exhausted|exhausted token budget|no_patch_exhausted/i.test(
      args.agentError,
    )
  ) {
    return undefined
  }
  if (args.stopReason === "error") {
    return args.agentError ?? "agent stopped with error before verification"
  }
  if (args.stopReason === "refusal") {
    return "agent stopped with refusal before verification"
  }
  return undefined
}
