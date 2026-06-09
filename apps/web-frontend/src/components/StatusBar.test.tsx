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
