/**
 * ADR-0296 — `bash_kill`. Terminate a background shell (handle returned by
 * `bash` with `timeout_behavior:"background"`). Sends SIGTERM, escalating to
 * SIGKILL after the registry's grace window, then waits for reap and returns
 * the final stdout/stderr/exitCode.
 *
 * `isConcurrencySafe: () => false` — sends an OS signal to a child process, a
 * mutating side effect.
 *
 * Output contract (NEVER throws):
 *  - unknown shell_id ⇒ ok:false with typed `not_found` failure.
 *  - successful kill ⇒ ok:true (even when exit code is non-zero — the kill
 *    itself succeeded; the model can read `evidence.exitCode` to learn the
 *    process state).
 */

import { z } from "zod"
import { type BashBgRegistry, getBashBgRegistry } from "@/runtime/bash-bg-registry"
import type { Tool, ToolContext, ToolEvent, ToolResultEvidence } from "../types"

export const bashKillInputSchema = z.object({
  shell_id: z
    .string()
    .min(1)
    .describe("Background shell id (returned by bash with timeout_behavior=background)."),
})
export type BashKillInput = z.infer<typeof bashKillInputSchema>

const STDERR_CAP = 4_000
const MAX_OUTPUT = 30_000

const tail = (s: string): string => (s.length > MAX_OUTPUT ? s.slice(-MAX_OUTPUT) : s)

export const makeBashKillTool = (
  registry: BashBgRegistry = getBashBgRegistry(),
): Tool<BashKillInput> => ({
  name: "bash_kill",
  description:
    "Terminate a background bash shell (handle from bash with timeout_behavior=background). " +
    "Sends SIGTERM, escalates to SIGKILL after the grace window, then returns the final " +
    "stdout/stderr/exitCode. `not_found` for an unknown shell_id.",
  inputSchema: bashKillInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(input, _ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = bashKillInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `bash_kill: invalid input — ${parsed.error.message}`,
          failure: { mode: "error", modelVisibleError: parsed.error.message },
        },
      }
      return
    }
    const { shell_id } = parsed.data
    const snap = await registry.kill(shell_id)
    if (snap === null) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `bash_kill: unknown shell_id=${shell_id}`,
          failure: { mode: "not_found" },
        },
      }
      return
    }
    const evidence: ToolResultEvidence = {
      ...(snap.stderr ? { stderr: snap.stderr.slice(-STDERR_CAP) } : {}),
      ...(snap.exitCode !== null ? { exitCode: snap.exitCode } : {}),
    }
    const body = [tail(snap.stdout), tail(snap.stderr)]
      .filter((s) => s.length > 0)
      .join("\n")
      .trimEnd()
    yield {
      type: "result",
      result: {
        ok: true,
        output:
          `[bash_kill ${snap.status}] shellId=${snap.id} exitCode=${snap.exitCode ?? "n/a"}\n` +
          `${body || "(no output)"}`,
        evidence,
      },
    }
  },
})

/** Default-instance tool. */
export const bashKillTool: Tool<BashKillInput> = makeBashKillTool()
