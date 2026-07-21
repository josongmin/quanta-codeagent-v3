/**
 * W2-1 (jul-15) HELLGATE — peer_message is RECORDED to the trajectory.
 *
 * Unlike the transient render-only signals (item_*, output_progress,
 * subagent_spawn/status) the recorder SKIPS, a `peer_message` is content-bearing
 * and its durable copy is otherwise CONDITIONAL on the recipient later draining it
 * into working memory — so the trajectory is the only guaranteed record. It rides
 * the `recovery` kind family (greppable via `reason:"peer_message"`), same posture
 * as `progress_update` / `plan_*`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunContext, TrajectoryEvent } from "@/shared"
import type { AgentEvent } from "@/stream"
import { JsonlRecorder } from "@/stream"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "peer-rec-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const CTX: RunContext = { runId: "r1", instanceId: "i1", attempt: 0 }
const clocks = () => ({ now: () => 1_700_000_000_000, monotonic: () => 42 })

const readLines = (path: string): TrajectoryEvent[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as TrajectoryEvent)

describe("W2-1 — peer_message trajectory recording", () => {
  test("a peer_message is recorded as a recovery-kind line tagged reason:peer_message with full attribution", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...clocks() })
    const ev: AgentEvent = {
      type: "peer_message",
      from: "root/1",
      to: "root",
      kind: "response",
      body: "the answer is 42",
      correlationId: "c9",
      sentAt: 123,
      provenance: { source: "side-agent", daemonId: "sa-3" },
    }
    rec.emit(ev)
    rec.close()

    const lines = readLines(path)
    const line = lines.find(
      (l) => (l.data as { reason?: string } | undefined)?.reason === "peer_message",
    )
    expect(line).toBeDefined()
    expect(line?.kind).toBe("recovery")
    const data = line?.data as Record<string, unknown>
    expect(data.from).toBe("root/1")
    expect(data.to).toBe("root")
    expect(data.messageKind).toBe("response")
    expect(data.body).toBe("the answer is 42")
    expect(data.provenance).toBe("side-agent")
    expect(data.daemonId).toBe("sa-3")
    expect(data.correlationId).toBe("c9")
  })

  test("the recorder's OWN redaction scrubs a secret in the body (defense-in-depth)", () => {
    const path = join(dir, "i2.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...clocks() })
    // A secret that reaches the recorder even if the emit-boundary redactor were
    // bypassed — the recorder's own redaction policy must still scrub it.
    rec.emit({
      type: "peer_message",
      from: "root/1",
      to: "root",
      kind: "request",
      body: "aws key AKIAIOSFODNN7EXAMPLE embedded",
      sentAt: 1,
      provenance: { source: "peer" },
    })
    rec.close()
    const raw = readFileSync(path, "utf8")
    expect(raw).not.toContain("AKIAIOSFODNN7EXAMPLE")
  })
})

describe("subagent_delivery trajectory recording", () => {
  test("admission and finalization are durable correlated recovery records", () => {
    const path = join(dir, "delivery.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...clocks() })
    rec.emit({
      type: "subagent_delivery",
      phase: "admitted",
      deliveryId: "del-record",
      requestedMode: "steer",
      status: "accepted",
      targetTaskId: "task-record",
      targetTurnId: "turn-record",
    })
    rec.emit({
      type: "subagent_delivery",
      phase: "finalized",
      deliveryId: "del-record",
      requestedMode: "steer",
      status: "failed",
      reason: "mailbox_error",
    })
    rec.close()

    const delivery = readLines(path).filter(
      (line) => (line.data as { reason?: string } | undefined)?.reason === "subagent_delivery",
    )
    expect(delivery).toHaveLength(2)
    expect(delivery.map((line) => line.data)).toEqual([
      expect.objectContaining({
        deliveryId: "del-record",
        phase: "admitted",
        status: "accepted",
        targetTaskId: "task-record",
      }),
      expect.objectContaining({
        deliveryId: "del-record",
        phase: "finalized",
        status: "failed",
        deliveryReason: "mailbox_error",
      }),
    ])
  })
})
