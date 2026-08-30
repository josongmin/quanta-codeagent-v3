/**
 * A7 hellgate — the kernel CARRIES the cumulative cost view to the wire.
 *
 * The host attaches `costView` (the usage authority's cumulative snapshot) to
 * its turn result; the scheduler must copy it into state and onto the very
 * next `turn.completed`, exactly the tokenUsage discipline. Absent on the
 * result ⇒ absent on the wire (accounting off stays byte-identical).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { AgentOutcome } from "@/agent"
import {
  createKernelSessionState,
  dispatchSessionCommand,
  InMemorySessionEventLog,
} from "@/kernel/session"
import type { Message } from "@/llm"
import type { CostSurfaceViewWire } from "@/protocol/session"
import { capabilitiesFor } from "../../support/session-fixtures"

const manifest = capabilitiesFor({ approvals: "operator", tools: true, artifacts: true })

const makeClock = (...timestamps: string[]) => {
  const queue = [...timestamps]
  const last = queue.at(-1) ?? "2026-08-30T00:00:00.000Z"
  return { now: () => new Date(queue.shift() ?? last) }
}

const messagesOf = (userText: string, assistantText: string): readonly Message[] => [
  { role: "user", content: [{ type: "text", text: userText }] },
  { role: "assistant", content: [{ type: "text", text: assistantText }] },
]

const VIEW: CostSurfaceViewWire = {
  totalUsd: 4.975,
  estimatedUsd: 0,
  unpricedCalls: 1,
  promptTokens: 3_000_000,
  outputTokens: 0,
  cacheReadTokens: 400_000,
  cacheWriteTokens: 100_000,
  calls: 4,
  rootUsd: 3.375,
  subagentUsd: 1.6,
  modelSlug: "claude-sonnet-4-6",
}

const runOneTurn = async (costView: CostSurfaceViewWire | undefined) => {
  let state = createKernelSessionState({
    sessionId: "s-cost",
    permissionMode: "default",
    capabilityManifest: manifest,
  })
  const host = {
    describe: () => ({
      sessionId: "s-cost",
      permissionMode: "default",
      capabilityManifest: manifest,
    }),
    runTurn: async () => {
      const messages = messagesOf("ping", "pong")
      return {
        outcome: { reason: "completed", turns: 1, messages } as AgentOutcome,
        messages,
        ...(costView !== undefined ? { costView } : {}),
      }
    },
    close: async () => undefined,
  }
  const eventLog = new InMemorySessionEventLog()
  state = (
    await dispatchSessionCommand(
      state,
      {
        sessionId: "s-cost",
        commandId: "c1",
        issuedAt: "2026-08-30T00:00:00.000Z",
        type: "input.append",
        text: "ping",
      },
      { clock: makeClock("2026-08-30T00:00:00.000Z"), eventLog, host },
    )
  ).state
  const turn = await dispatchSessionCommand(
    state,
    {
      sessionId: "s-cost",
      commandId: "c2",
      issuedAt: "2026-08-30T00:00:01.000Z",
      expectedRevision: state.revision,
      type: "turn.run",
    },
    { clock: makeClock("2026-08-30T00:00:01.000Z"), eventLog, host },
  )
  return turn.events.find((e) => e.type === "turn.completed") as
    | { costView?: CostSurfaceViewWire }
    | undefined
}

describe("A7 — turn.completed carries the host's cumulative cost view", () => {
  test("a host-supplied view rides the wire verbatim", async () => {
    const completed = await runOneTurn(VIEW)
    expect(completed).toBeDefined()
    expect(completed?.costView).toEqual(VIEW)
  })

  test("no view on the result ⇒ no field on the wire (byte-identical off)", async () => {
    const completed = await runOneTurn(undefined)
    expect(completed).toBeDefined()
    expect(completed !== undefined && "costView" in completed).toBe(false)
  })
})

describe("A7 — the HOST side of the carry (static tripwire)", () => {
  test("context-binding attaches the shared wire mapper to the turn result", () => {
    // The kernel arm above proves result→wire; this pins the producer half —
    // the host attaching `costSurfaceViewWire(base.usageAccounting)` — as a
    // source-level tripwire, because no cheap harness drives
    // runSessionHostTurn with a live authority. Deleting the attach or
    // swapping in a second hand-built mapping breaks this by name.
    const src = readFileSync(
      resolve(__dirname, "../../../src/host/runtime/internal/context-binding.ts"),
      "utf8",
    )
    expect(src).toContain("costView: costSurfaceViewWire(accounting)")
    expect(src).toContain('from "@/observability/usage-accounting"')
  })
})
