/**
 * WS-F store hygiene (UUX-5-15) — tool-progress completion cleanup.
 *
 * The `toolProgress` Map was only FIFO-capped (memory backstop); a finished
 * tool's progress line lingered until 256 NEW tool calls evicted it. The
 * session channel's `tool.completed` event carries the `toolCallId`, so the
 * reducer now supports an explicit completion-cleanup action the App wires
 * from that event.
 */

import { describe, expect, it } from "vitest"
import type { ToolProgressMessage } from "../types/protocol"
import { agentStateReducer, EMPTY_FULL_AGENT_STATE } from "./agent-state-hooks"

const progress = (toolCallId: string): ToolProgressMessage => ({
  kind: "tool.progress",
  toolCallId,
  toolName: "bash",
  message: "running…",
  emittedAt: 0,
})

describe("agentStateReducer — tool.completed cleanup (UUX-5-15)", () => {
  it("removes the completed tool's progress entry", () => {
    let state = agentStateReducer(EMPTY_FULL_AGENT_STATE, {
      type: "message",
      msg: progress("t-1"),
    })
    state = agentStateReducer(state, { type: "message", msg: progress("t-2") })
    expect(state.toolProgress.size).toBe(2)

    state = agentStateReducer(state, { type: "tool.completed", toolCallId: "t-1" })
    expect(state.toolProgress.has("t-1")).toBe(false)
    expect(state.toolProgress.has("t-2")).toBe(true)
    expect(state.toolProgress.size).toBe(1)
  })

  it("completion for an unknown toolCallId is an identity no-op (same reference)", () => {
    const state = agentStateReducer(EMPTY_FULL_AGENT_STATE, {
      type: "message",
      msg: progress("t-1"),
    })
    const next = agentStateReducer(state, { type: "tool.completed", toolCallId: "ghost" })
    expect(next).toBe(state)
  })

  it("a late progress frame after completion re-registers (latest-wins is preserved)", () => {
    let state = agentStateReducer(EMPTY_FULL_AGENT_STATE, {
      type: "message",
      msg: progress("t-1"),
    })
    state = agentStateReducer(state, { type: "tool.completed", toolCallId: "t-1" })
    state = agentStateReducer(state, { type: "message", msg: progress("t-1") })
    expect(state.toolProgress.has("t-1")).toBe(true)
  })
})
