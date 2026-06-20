import type { StopReason } from "@/agent"

/** Selection candidate generation should throw ONLY on hard terminal run
 *  failures that produced no scorable candidate. Model misses such as empty
 *  `max_turns` / `completed` candidates must still flow into selection
 *  scoring/telemetry as real no-patch candidates, not generation failures. */
export const selectionGenerationErrorOf = (args: {
  stopReason: StopReason | undefined
  agentError?: string
}): string | undefined => {
  if (args.stopReason === "error") {
    return args.agentError ?? "agent stopped with error before verification"
  }
  if (args.stopReason === "refusal") {
    return "agent stopped with refusal before verification"
  }
  return undefined
}
