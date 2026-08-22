/**
 * B2 — `threads_handoff` tool.
 *
 * A minimal, PURE leaf tool that produces a cross-surface `quanta://threads/{id}`
 * deeplink for a conversation thread. The model calls it to hand the current
 * work off to another Quanta surface (CLI ↔ Web-Tauri ↔ embedded browser): the
 * emitted deeplink is the surface-agnostic ADDRESS the receiving surface opens,
 * and the actual session state travels over the EXISTING spot-resume
 * cassette/replay transport (per-turn cassette → shared store → replay on the
 * other box) — this tool does not serialize a session, it only names the target.
 *
 * Registered ONLY when `DefaultToolPorts.automationEngine` is wired (same
 * `QUANTA_AUTOMATION` gate as `automation_update`) — absent ⇒ the model never
 * sees the tool (byte-identical default set).
 *
 * NO-THROW: the only failure is an empty threadId, surfaced as `ok:false`.
 * The deeplink builder/parser live in `@/scheduler/deeplink` (pure); this tool
 * is a thin, engine-free wrapper so it has no I/O of its own.
 */

import { z } from "zod"
import { buildThreadDeeplink } from "@/scheduler/deeplink"
import { defineTool } from "./factory"
import type { Tool, ToolEvent } from "./types"

const inputSchema = z.object({
  threadId: z
    .string()
    .min(1)
    .max(400)
    .describe("Id of the conversation thread to hand off to another surface."),
  note: z
    .string()
    .max(2000)
    .optional()
    .describe("Optional human-facing note echoed alongside the deeplink."),
})

type Input = z.infer<typeof inputSchema>

/** Build the `threads_handoff` tool. Pure (no ports) — the composition root
 *  appends it under the automation-engine gate so its availability tracks the
 *  automation feature without adding a second flag. */
export const threadsHandoffTool = (): Tool<Input> =>
  defineTool({
    name: "threads_handoff",
    description:
      "Hand the current work off to another Quanta surface: returns a " +
      "quanta://threads/{id} deeplink the receiving surface opens to resume the " +
      "thread. NO-THROW; session state travels over the existing resume transport.",
    inputSchema,
    // Read-only: emits a link, mutates nothing.
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    // biome-ignore lint/correctness/useYield: single-result generator by design.
    async *execute(input: Input): AsyncIterable<ToolEvent> {
      const deeplink = buildThreadDeeplink(input.threadId)
      const output =
        input.note !== undefined && input.note.length > 0
          ? `handoff ready: ${deeplink} — ${input.note}`
          : `handoff ready: ${deeplink}`
      yield {
        type: "result",
        result: {
          ok: true,
          output,
          structured: {
            deeplink,
            threadId: input.threadId,
            ...(input.note !== undefined ? { note: input.note } : {}),
          },
        },
      }
    },
  })
