import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { bindTurnUserInput } from "../context-binding/turn-user-input-bind"

describe("G-F12 host bindTurnUserInput", () => {
  test("attaches session/turn/signal without changing the tool request shape", async () => {
    const seen: unknown[] = []
    const ac = new AbortController()
    const cfg = bindTurnUserInput(
      {
        userInputPort: async (req) => {
          seen.push(req)
          return { decision: "cancelled" }
        },
      } as AgentConfig,
      { sessionId: "sess-1", turnId: "turn-1", signal: ac.signal },
    )
    await cfg.userInputPort?.({ promptId: "p1", prompt: "continue?" })
    expect(seen).toEqual([
      {
        promptId: "p1",
        prompt: "continue?",
        sessionId: "sess-1",
        turnId: "turn-1",
        signal: ac.signal,
      },
    ])
  })

  test("leaves config unchanged when no userInputPort is wired", () => {
    const cfg = { cwd: "/tmp" } as AgentConfig
    expect(bindTurnUserInput(cfg, { sessionId: "s", turnId: "t", signal: undefined })).toBe(cfg)
  })
})

describe("G-F12 runRuntimeTurn wires bind + originating signal", () => {
  test("turn-runner binds args.signal and does not call cancelAll", () => {
    const src = readFileSync(
      join(process.cwd(), "src/host/runtime/internal/context-binding/turn-runner.ts"),
      "utf8",
    )
    expect(src).toMatch(/bindTurnUserInput\s*\(/)
    expect(src).toMatch(/signal:\s*args\.signal/)
    expect(src).toMatch(/turnId:\s*turnIdentity\(args\.turnId\)/)
    expect(src).not.toContain("cancelAll")
  })

  test("ws close owns cancelAll; turn abort is not that path", () => {
    const src = readFileSync(
      join(process.cwd(), "src/apps/web-daemon/server/ws-handlers.ts"),
      "utf8",
    )
    expect(src).toContain("handle.cancelAll()")
    expect(src).not.toContain("cancelTurn")
    const closeIdx = src.indexOf("async close(ws: ServerWebSocket")
    const cancelIdx = src.indexOf("handle.cancelAll()")
    expect(closeIdx).toBeGreaterThan(0)
    expect(cancelIdx).toBeGreaterThan(closeIdx)
  })
})
