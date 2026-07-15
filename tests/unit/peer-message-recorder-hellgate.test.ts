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
import { JsonlRecorder } from "@/stream"
import type { AgentEvent } from "@/stream"

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
