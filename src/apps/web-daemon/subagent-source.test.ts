/**
 * QUANTA_WEB_SUBAGENTS — subagent-source hellgate (web-daemon side).
 *
 * FAITHFUL PARALLEL of the agent-state source pins. Drives the source's
 * `onSubagentEvent` sink with a spawn then a status observation and asserts a
 * subscribed fake connection receives two `subagent` frames carrying the
 * projected observation (correct taskId / parentTaskId / depth / status).
 *
 * MUTATIONS (red-on-injection):
 *   - knob unset ⇒ the composition helper wires NO sink ⇒ NO frames
 *     (byte-identical).
 *   - a secret in `description` / `finalTextPreview` ⇒ redacted in the delivered
 *     frame (defense-in-depth: the source re-scrubs even a raw producer).
 */

import { describe, expect, it } from "bun:test"
import type { SubagentSpawnObservation } from "@/protocol/subagent"
import { decodeSubagentFrame } from "@/protocol/subagent-frame"
import {
  createSubagentSource,
  installSubagentSource,
  SUBAGENT_WS_TOPIC,
  wireSubagentSourceIfGated,
} from "./subagent-source"

/** A fake Bun-`Server`-like publisher recording every broadcast frame. */
const fakePublisher = () => {
  const frames: string[] = []
  return {
    frames,
    publish: (topic: string, data: string | Uint8Array): number => {
      if (topic === SUBAGENT_WS_TOPIC && typeof data === "string") frames.push(data)
      return 1
    },
  }
}

const spawn = (over: Partial<SubagentSpawnObservation> = {}): SubagentSpawnObservation => ({
  type: "subagent_spawn",
  taskId: "t-child",
  parentTaskId: "t-root",
  depth: 1,
  description: "investigate the flake",
  agentType: "explorer",
  at: 100,
  ...over,
})

describe("subagent-source — spawn + status fan-out to a subscribed connection", () => {
  it("delivers two subagent frames with the projected observation", () => {
    const source = createSubagentSource()
    const pub = fakePublisher()
    installSubagentSource(source, pub)

    // The registry emit boundary hands ALREADY-PROJECTED observations to the
    // sink (mirror of `onAgentState`).
    source.sink.capture(spawn())
    source.sink.capture({
      type: "subagent_status",
      taskId: "t-child",
      status: "completed",
      at: 200,
      turns: 4,
      finalTextPreview: "found the race in the reaper",
    })

    expect(pub.frames.length).toBe(2)
    const first = decodeSubagentFrame(pub.frames[0])
    const second = decodeSubagentFrame(pub.frames[1])
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    if (first?.type !== "subagent_spawn") throw new Error("expected spawn frame")
    expect(first.taskId).toBe("t-child")
    expect(first.parentTaskId).toBe("t-root")
    expect(first.depth).toBe(1)
    expect(first.agentType).toBe("explorer")
    if (second?.type !== "subagent_status") throw new Error("expected status frame")
    expect(second.taskId).toBe("t-child")
    expect(second.status).toBe("completed")
    expect(second.turns).toBe(4)
  })

  it("MUTATION knob unset ⇒ no sink wired ⇒ NO frames (byte-identical)", () => {
    // The composition helper only builds a source when the gate is present. With
    // the knob absent there is no source, so a capture is impossible and no frame
    // is ever published.
    const gatedOff = wireSubagentSourceIfGated({}, fakePublisher())
    expect(gatedOff).toBeUndefined()

    const gatedOn = wireSubagentSourceIfGated({ QUANTA_WEB_SUBAGENTS: "1" }, fakePublisher())
    expect(gatedOn).not.toBeUndefined()
  })

  it("MUTATION secret in description/finalTextPreview ⇒ redacted in the delivered frame", () => {
    const source = createSubagentSource()
    const pub = fakePublisher()
    installSubagentSource(source, pub)

    const secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    source.sink.capture(spawn({ description: `leaked ${secret} here` }))
    source.sink.capture({
      type: "subagent_status",
      taskId: "t-child",
      status: "failed",
      at: 300,
      finalTextPreview: `token is ${secret}`,
      error: `boom ${secret}`,
    })

    const spawnFrame = decodeSubagentFrame(pub.frames[0])
    const statusFrame = decodeSubagentFrame(pub.frames[1])
    if (spawnFrame?.type !== "subagent_spawn") throw new Error("expected spawn frame")
    if (statusFrame?.type !== "subagent_status") throw new Error("expected status frame")
    expect(spawnFrame.description).not.toContain(secret)
    expect(statusFrame.finalTextPreview ?? "").not.toContain(secret)
    expect(statusFrame.error ?? "").not.toContain(secret)
  })
})
