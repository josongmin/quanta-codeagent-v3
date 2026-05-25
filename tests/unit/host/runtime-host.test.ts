import { describe, expect, test } from "bun:test"
import { assertCapabilityExpectation, buildCapabilityManifestFromSessionDeps } from "@/host/runtime"
import { SessionProtocolValidationError } from "@/protocol/session"
import type { SessionDeps } from "@/runner/assemble"

const baseDeps = (): SessionDeps =>
  ({
    llm: {} as never,
    registry: {
      all: () => [{ name: "write_file" }],
    } as never,
    stream: {} as never,
    permission: { mode: "default" },
    system: "",
    cwd: "/tmp",
    maxTurns: 5,
    signal: new AbortController().signal,
    onConfirm: async () => false,
    store: undefined,
    sessionId: "s1",
    embedder: undefined,
    memoryConfig: undefined,
    planMode: false,
    metrics: undefined,
    run: undefined,
    subagentConfig: undefined,
    skillsConfig: undefined,
    compactionBreakerConfig: undefined,
    verifyGuardConfig: undefined,
    summarizerLlm: undefined,
    onShellEvent: undefined,
    workMetricsSink: undefined,
  }) satisfies SessionDeps

describe("@/host/runtime capabilities", () => {
  test("derives capability manifest from session deps", () => {
    const manifest = buildCapabilityManifestFromSessionDeps(baseDeps())
    expect(manifest.tools).toBe(true)
    expect(manifest.approvals).toBe("operator")
    expect(manifest.transport).toBe("inproc")
  })

  test("fails closed on expected capability mismatch", () => {
    const manifest = buildCapabilityManifestFromSessionDeps(baseDeps())
    expect(() => assertCapabilityExpectation({ tools: false }, manifest)).toThrow(
      SessionProtocolValidationError,
    )
  })
})
