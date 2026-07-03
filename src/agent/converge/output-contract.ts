/**
 * `@/apps/terminal/verify-gate/output-contract` — OC1: did the deliverable run END-TO-END to a
 * CLEAN exit? Distinct from L0 exercise (which counts an `ok:false`/non-zero run as an honest
 * observation) and from L1 compare (which can pass on a PARTIAL output match while the full
 * deliverable is broken or leaves stray artifacts — the polyglot `cmain` / sam-cell-seg `exit 2`
 * class). PURE / LEAF.
 */

import type { AgentEvent } from "@/stream"
import { isExerciseCommand, resultRanClean } from "./exercise"
import { CONTAINER_EXEC, containerExecCommand } from "./tokenize"

export interface OutputContractVerdict {
  readonly ranClean: boolean
  readonly evidence?: string
}

/**
 * OC1 inspector (RFC 07). Returns `ranClean:true` iff a `container_exec` ran an EXERCISE command
 * (per {@link isExerciseCommand}) whose paired `tool_result` was a CLEAN success ({@link resultRanClean}).
 * Fail-closed: a non-zero/`ok:false` run, a bare-shell round-trip, or install/build/probe never count —
 * so a deliverable that crashes at invocation (exit 2) or was never run to completion yields `false`,
 * which the gate turns into the OC1 follow-up. No-leak: reads only the model's own commands/results.
 */
export const outputContractVerdict = (events: readonly AgentEvent[]): OutputContractVerdict => {
  const cleanById = new Map<string, boolean>()
  for (const ev of events) {
    if (ev.type === "tool_result") cleanById.set(ev.id, resultRanClean(ev))
  }
  for (const ev of events) {
    if (ev.type !== "tool_call" || ev.name !== CONTAINER_EXEC) continue
    const command = containerExecCommand(ev)
    if (command === undefined || !isExerciseCommand(command)) continue
    if (cleanById.get(ev.id) === true) {
      return {
        ranClean: true,
        evidence: `ran the deliverable end-to-end to a clean exit: \`${command.trim().slice(0, 160)}\``,
      }
    }
  }
  return {
    ranClean: false,
    evidence:
      "output contract unmet: the deliverable was never run end-to-end to a CLEAN exit (it crashed on invocation, exited non-zero, or was never run as the task specifies) — required outputs / a stray-artifact-free workdir are unconfirmed",
  }
}
