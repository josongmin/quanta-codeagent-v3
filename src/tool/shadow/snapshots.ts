/** `shadow_snapshots` — ADR-0119 read-only enumerator wrapping
 *  `ShadowOdb.listSnapshots`. Used by the model (or a human operator via CLI)
 *  to inspect the shadow store BEFORE / AFTER a `shadow_rewind` call so the
 *  pre-rewind safety-net history is visible.
 *
 *  Output is deterministic: `for-each-ref` already orders newest-first; we
 *  cap the rendered list at `limit` (input) and truncate the joined text at
 *  `MAX_OUTPUT` chars so a misconfigured store cannot blow the model context.
 *
 *  Plane-clean: imports only `@/storage/shadow-odb`, `../types`, and `zod`. */

import { z } from "zod"
import { type ShadowOdb, ShadowOdbError } from "@/storage/shadow-odb"
import type { Tool, ToolContext, ToolEvent } from "../types"

export const shadowSnapshotsInputSchema = z.object({
  limit: z.number().int().positive().max(200).optional().describe("Cap on entries (default: all)"),
})
export type ShadowSnapshotsInput = z.infer<typeof shadowSnapshotsInputSchema>

const MAX_OUTPUT = 50_000

const truncate = (s: string): string => {
  if (s.length <= MAX_OUTPUT) return s
  return `${s.slice(0, MAX_OUTPUT)}\n… (truncated, ${s.length - MAX_OUTPUT} more chars)`
}

/** Format a unix timestamp as a deterministic UTC ISO string (no ms suffix). */
const fmtTs = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")

/** Render a non-empty snapshot list to the model-facing output text. Extracted
 *  from `execute` so the generator body stays under the cognitive-complexity
 *  cap (biome `noExcessiveCognitiveComplexity`). */
const renderSnapshotList = (
  snaps: readonly { ref: string; sha: string; timestampSec: number }[],
  limit: number | undefined,
): string => {
  const cap = limit ?? snaps.length
  const shown = snaps.slice(0, cap)
  const plural = snaps.length === 1 ? "" : "s"
  const showing = cap < snaps.length ? ` (showing ${cap})` : ""
  const header = `${snaps.length} snapshot${plural}${showing}:`
  const lines = shown.map(
    (s, i) => `  ${i + 1}. ${s.ref}  ${s.sha.slice(0, 12)}  ${fmtTs(s.timestampSec)}`,
  )
  return truncate([header, ...lines].join("\n"))
}

export const shadowSnapshotsTool = (odb: ShadowOdb): Tool<ShadowSnapshotsInput> => ({
  name: "shadow_snapshots",
  description:
    "List all shadow-store snapshot refs (last-registered + pre-rewind-*), newest-first. " +
    "Use to inspect the safety-net history before / after shadow_rewind.",
  inputSchema: shadowSnapshotsInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = shadowSnapshotsInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    if (ctx.signal.aborted) {
      yield { type: "result", result: { ok: false, output: "aborted before start" } }
      return
    }
    let snaps: readonly { ref: string; sha: string; timestampSec: number }[]
    try {
      snaps = await odb.listSnapshots(ctx.cwd)
    } catch (e) {
      if (!(e instanceof ShadowOdbError)) throw e
      yield { type: "result", result: { ok: false, output: `${e.code}: ${e.message}` } }
      return
    }
    if (snaps.length === 0) {
      yield {
        type: "result",
        result: { ok: true, output: "(no snapshots — shadow store empty)" },
      }
      return
    }
    yield {
      type: "result",
      result: { ok: true, output: renderSnapshotList(snaps, parsed.data.limit) },
    }
  },
})
