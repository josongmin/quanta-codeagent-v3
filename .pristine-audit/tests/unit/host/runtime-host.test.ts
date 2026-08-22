import { describe, expect, test } from "bun:test"
import { assertCapabilityExpectation, buildCapabilityManifest } from "@/host/runtime"
import { SessionProtocolValidationError } from "@/protocol/session"

describe("@/host/runtime capabilities", () => {
  test("normalizes a capability manifest", () => {
    const manifest = buildCapabilityManifest({
      approvals: "operator",
      tools: true,
      transport: "inproc",
    })
    expect(manifest.tools).toBe(true)
    expect(manifest.approvals).toBe("operator")
    expect(manifest.transport).toBe("inproc")
  })

  test("fails closed on expected capability mismatch", () => {
    const manifest = buildCapabilityManifest({
      approvals: "operator",
      tools: true,
      transport: "inproc",
    })
    expect(() => assertCapabilityExpectation({ tools: false }, manifest)).toThrow(
      SessionProtocolValidationError,
    )
  })
})
