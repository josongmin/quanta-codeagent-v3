import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { ConnectionState } from "../types/protocol"
import { StatusBar } from "./StatusBar"

const connected: ConnectionState = { kind: "connected" }

describe("StatusBar — Stop (turn.cancel) affordance", () => {
  it("renders the 정지 button while a turn is running and onCancel is provided", () => {
    const markup = renderToStaticMarkup(
      <StatusBar connection={connected} sessionStatus="running" onCancel={() => {}} />,
    )
    expect(markup).toContain("정지")
  })

  it("UUX-3-18: shows 정지 during awaiting_approval too (a blocked turn must be abortable)", () => {
    const markup = renderToStaticMarkup(
      <StatusBar connection={connected} sessionStatus="awaiting_approval" onCancel={() => {}} />,
    )
    expect(markup).toContain("정지")
  })

  it("HIDES 정지 when the session is not running (idle)", () => {
    const markup = renderToStaticMarkup(
      <StatusBar connection={connected} sessionStatus="idle" onCancel={() => {}} />,
    )
    expect(markup).not.toContain("정지")
  })

  it("HIDES 정지 when no onCancel is wired even if running (byte-identical legacy)", () => {
    const markup = renderToStaticMarkup(
      <StatusBar connection={connected} sessionStatus="running" />,
    )
    expect(markup).not.toContain("정지")
  })
})

describe("context warning (P2, UUX-4-18)", () => {
  it("renders the warning chip at/above the CLI ratio", () => {
    const markup = renderToStaticMarkup(
      <StatusBar
        connection={{ kind: "connected" }}
        sessionStatus="idle"
        contextUsage={{ total: 85, max: 100 }}
      />,
    )
    expect(markup).toContain('data-testid="context-warning"')
    expect(markup).toContain("85%")
  })

  it("renders NOTHING below the ratio or at unknown max", () => {
    for (const usage of [{ total: 10, max: 100 }, { total: 999, max: 0 }, null]) {
      const markup = renderToStaticMarkup(
        <StatusBar connection={{ kind: "connected" }} sessionStatus="idle" contextUsage={usage} />,
      )
      expect(markup).not.toContain("context-warning")
    }
  })
})
