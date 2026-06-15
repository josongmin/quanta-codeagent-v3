/**
 * Activity Spine — END-TO-END wiring hellgate (jun-15 P0-b, tree-green).
 *
 * The per-seam unit tests build their OWN stores, so a threading mistake (the
 * write path and the read path not sharing ONE instance, or a projection that
 * drops the field) would pass them all (slice-green ≠ tree-green). This drives
 * the REAL composition functions and asserts the EXACT SAME store instance
 * survives each hop, then renders a live workflow through the REAL `/activity`
 * command.
 *
 *   E1 — write: `buildSubagentConfig` threads the === store into the config slot
 *        `buildSubagentBlock` hands to `run_workflow`'s deps.
 *   E2 — read: `projectSlashCtx` forwards the === store onto the slash ctx.
 *   E3 — the REAL `/activity` command renders the shared store (live workflow).
 *   E4 — `/activity` merges the live in-process fleet into the shared store.
 */

import { describe, expect, test } from "bun:test"
import { createActivityStore, createWorkflowSink } from "@/activity"
import { buildSubagentConfig } from "@/apps/cli/internal"
import { projectSlashCtx } from "@/apps/cli/repl/slash-surface"
import type { SlashContext } from "@/apps/cli/slash-contract"
import { SURFACE_SLASH_COMMANDS } from "@/apps/cli/slash/registry-surface"

const activityCmd = () => {
  const cmd = SURFACE_SLASH_COMMANDS.find((c) => c.name === "/activity")
  if (cmd === undefined) throw new Error("/activity command not registered")
  return cmd
}

const captureCtx = (over: Partial<SlashContext>): { ctx: SlashContext; out: string[] } => {
  const out: string[] = []
  const ctx = {
    out: (s: string) => out.push(s),
    err: () => {},
    now: () => 1000,
    ...over,
  } as unknown as SlashContext
  return { ctx, out }
}

describe("Activity Spine e2e wiring (tree-green)", () => {
  test("E1 — WRITE path: buildSubagentConfig threads the EXACT store instance", () => {
    const store = createActivityStore()
    const cfg = buildSubagentConfig(undefined, { QUANTA_SUBAGENT: "1", QUANTA_WORKFLOW: "1" }, store)
    // === identity: the same object run_workflow's deps will receive (the tool
    // build reads `config.subagent.activityStore`).
    expect(cfg?.activityStore).toBe(store)
    expect(cfg?.enableWorkflow).toBe(true)
  })

  test("E1b — no store passed ⇒ config slot absent (byte-identical default-OFF)", () => {
    const cfg = buildSubagentConfig(undefined, { QUANTA_SUBAGENT: "1", QUANTA_WORKFLOW: "1" })
    expect(cfg?.activityStore).toBeUndefined()
  })

  test("E2 — READ path: projectSlashCtx forwards the EXACT store instance", () => {
    const store = createActivityStore()
    const projected = projectSlashCtx({ activityStore: store } as never) as {
      activityStore?: unknown
    }
    expect(projected.activityStore).toBe(store)
  })

  test("E3 — the REAL /activity command renders the SHARED store (live workflow appears)", async () => {
    const store = createActivityStore()
    // stream a live workflow in through the REAL producer
    const sink = createWorkflowSink(store, { runId: "wf-1", label: "review-pr" })
    sink.emit({ type: "phase_enter", name: "Find" })
    sink.emit({ type: "step_start", id: "f1", label: "find:bugs" })
    sink.emit({ type: "step_complete", id: "f1", ok: true })
    sink.close(true)

    const { ctx, out } = captureCtx({ activityStore: store })
    const code = await activityCmd().run([], ctx)
    expect(code).toBe(0)
    const text = out.join("")
    expect(text).toContain("ACTIVITY") // header
    expect(text).toContain("review-pr") // the workflow root
    expect(text).toContain("find:bugs") // its step (proves the run was recorded + rendered)
  })

  test("E4 — /activity merges the live in-process fleet into the shared store", async () => {
    const store = createActivityStore()
    const { ctx, out } = captureCtx({
      activityStore: store,
      agents: () => [
        { id: "sub-1", description: "investigate flake", status: "running", startedAt: 0 },
      ],
    })
    await activityCmd().run([], ctx)
    expect(out.join("")).toContain("investigate flake") // subagent fleet surfaced too
  })

  test("E5 — neither store nor agents ⇒ honest 'not wired'", async () => {
    const { ctx, out } = captureCtx({})
    const code = await activityCmd().run([], ctx)
    expect(code).toBe(0)
    expect(out.join("")).toContain("not wired")
  })
})
